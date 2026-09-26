# Decisions

One entry per choice that could reasonably have gone another way: what was picked,
what was rejected, and what would change the answer. Entries are append-only — when a
decision is reversed, the original stays and a new entry supersedes it.

---

## 1. Own FastAPI service, with Supabase for Postgres and auth

**Picked.** Supabase provides Postgres and the credential flow. Everything else —
business logic, the job pipeline, authorization — lives in a FastAPI service the
browser talks to exclusively.

**Rejected:** Supabase alone, with the client hitting its auto-generated REST API and
edge functions for the rest. It is less code and genuinely faster to ship.

**Why not:** two reasons, one structural and one about this project specifically.
Structurally, the interesting work here — versioned scores, note-ID migration, an async
recognition pipeline with retries — is exactly the work that has nowhere to live in a
BaaS-only design; it would end up smeared across edge functions and client code.
Specifically, the ML side is Python, and sharing the score document model
(`app/scoredoc.py`) between the API and the OMR worker is free when both are Python and
awkward otherwise.

**Would switch if:** the app stayed CRUD-shaped. If recognition were a vendor API call
rather than a pipeline we operate, the service would be a layer of indirection around
Supabase and should be deleted.

---

## 2. Generated TypeScript types, committed and diffed in CI

**Picked.** `openapi-typescript` turns the FastAPI schema into `schema.d.ts`. Both it
and `openapi.json` are committed, and CI reruns the generator and fails on any diff.

**Rejected:** hand-written interfaces on the frontend; generating at build time without
committing; a full generated client (Orval, openapi-fetch).

**Why:** hand-written types drift, and they drift silently — they still compile, they
just describe an API that no longer exists. Generating without committing means the
drift is invisible in review. Committing plus a CI diff makes it impossible to change a
Pydantic response model without either updating the generated file in the same commit
or breaking the build. A full generated client was rejected as more machinery than 20
endpoints need; `lib/api.ts` is one small typed `fetch` wrapper, and the types it uses
are generated.

**This has already paid for itself once.** The generated types showed that response
models with Pydantic defaults become optional on the wire, so the frontend was writing
`?? []` for arrays the server always sends. The fix went into the Python schema rather
than into defensive TypeScript.

**Would switch if:** the API surface grew past what a hand-written client is pleasant to
maintain, or a second client (mobile) appeared.

---

## 3. Deterministic note IDs derived from musical identity

**Picked.** A note's ID is `blake2s(part, measure, offset-in-measure, voice, staff,
duration, pitch)`.

**Rejected:** UUIDs assigned at ingest; `(version_id, index)` pairs.

**Why:** the hard problem in this app is that OMR is wrong and scores get re-recognised.
A singer's saved part must survive that. With random IDs every re-run orphans every
selection, and reconciling means fuzzy-matching notes across versions — a heuristic
with no right answer. Deriving the ID from musical identity turns migration into a set
operation: notes that did not change keep their IDs and keep their selections for free,
and the notes that dropped out are precisely the ones worth telling the user about.

The position component is `(measure, offset-in-measure)` rather than an absolute tick
count, so correcting bar 3 does not renumber bar 40.

**Costs, accepted:** two musically identical notes in the same voice hash the same and
need an order-dependent suffix. Changing the hash input is a data migration, which is
why `SCHEMA_VERSION` is in the hashed material and there is a test pinning the scheme.

**Would switch if:** we added a score editor where notes are *moved* rather than
re-recognised. Dragging a note to a new pitch would silently destroy its annotations
under this scheme, and stable identity would have to become explicit.

---

## 4. `profile_notes` join table, not an array column

**Picked.** One row per (profile, note).

**Rejected:** `note_ids text[]` on `profiles`.

**Why:** the array is one table fewer and a single-row read, and for a few thousand
notes it would perform fine. It loses on everything else. "Which profiles contain this
note" — needed to paint the overlay — becomes a sequential scan with array containment.
Concurrent edits become a lost-update race: two tabs each read the array, each append,
last writer wins and silently discards the other's work. And diffing moves into
application code, where the write endpoint would have to reconstruct what changed.

Rows give set operations in SQL, a real index for the reverse lookup, and per-note
provenance (`added_at`) for free.

**Would switch if:** profiles became large enough that row count mattered — hundreds of
thousands of notes per profile — which for musical theatre vocal parts it will not.

---

## 5. Immutable score versions, explicitly activated

**Picked.** Each OMR run creates a new `score_versions` row. The score points at a
current version. A new version does not become current until someone activates it, and
activation returns a report of what every profile lost.

**Rejected:** mutating the score in place; auto-activating the newest successful run.

**Why:** re-recognition is a correction, and corrections can be worse than what they
replace. Auto-activating means a background job can change what a singer is looking at
mid-rehearsal, with no warning and no way back. Immutable versions make the previous
score still exist, make the migration report computable as a set difference, and make
the document safely cacheable forever on the client because a version's content can
never change.

**Cost:** storage grows per run, and orphaned profile rows accumulate (see 6).

---

## 6. Orphaned annotations are kept, not deleted

**Picked.** When a note disappears from a new version, its profile membership and
annotations stay in the database.

**Rejected:** cascade-deleting on activation.

**Why:** the common reason a note disappears is that OMR got it wrong this time, not
that the music changed. A later correction plausibly brings it back, and if the rows
were deleted the user's work is gone for good. Keeping them makes restoration automatic.

**Cost:** dead rows accumulate. Acceptable at this scale; a periodic sweep of rows
orphaned across N consecutive versions is the fix when it stops being.

---

## 7. Authorization in the API layer, not Postgres RLS

**Picked.** `app/authz.py`, a dependency on every route.

**Rejected:** row-level security policies in Postgres.

**Why:** the browser never talks to Postgres. Every read and write goes through FastAPI
holding one service-role connection, so an RLS policy would be evaluated against a role
permitted to do everything — it would protect nothing while adding a second place for
rules to live and a much harder debugging story.

**Would switch if:** any table were exposed through Supabase's auto-generated REST or
Realtime API. The moment a browser can issue its own query, the database has to be the
one saying no, and these checks become a duplicate of the policy rather than the policy
itself. That is a plausible future — Realtime is the natural upgrade for job status —
so the check is one function, not scattered `if` statements.

**Detail:** a score the caller cannot see returns 404, not 403, so a response cannot
confirm that an ID exists.

---

## 8. Job state in Postgres, Redis only as transport

**Picked.** A `jobs` row is the record of a job. RQ carries the ID to a worker. Retries
are driven by an `attempts` counter in Postgres, not RQ's retry support.

**Rejected:** RQ's job registry as the source of truth.

**Why:** Redis is configured for speed, not durability. A flush or an eviction would
erase job history and leave the UI unable to say what happened to an upload. In
Postgres, the status endpoint is an indexed read, history survives, and a `running` row
with a stale `started_at` is durable evidence that a GPU worker was OOM-killed — which
is what `reap_stalled_jobs` keys off.

**Ordering detail:** the job row is committed *before* the ID is enqueued. The other
order lets a worker pick up a job whose row is not visible yet, which is the classic
dual-write bug in this shape of system.

---

## 9. Polling for job status, not websockets

**Picked.** The client polls `/jobs/{id}`; the interval widens while queued, tightens
while running, and stops on a terminal status.

**Rejected:** websockets; Supabase Realtime; server-sent events.

**Why:** an OMR run takes minutes and has a handful of watchers. At that ratio a 1–3
second poll is a rounding error, and it removes a whole class of connection-lifecycle
bugs — reconnection, missed messages during a drop, state that is only correct if you
saw every event.

**Would switch if:** many people watched one score at once, or jobs got short enough
that polling latency became a visible fraction of the wait. Supabase Realtime is the
upgrade path and needs no schema change.

---

## 10. PDF page images with an SVG overlay, not re-engraved MusicXML

**Picked.** Render the actual page, put a transparent SVG hit layer on top using
normalised note bounding boxes.

**Rejected:** re-engraving the recognised MusicXML with VexFlow or OpenSheetMusicDisplay.

**Why:** the singer already knows this score — the page layout, the page turns, the
pencil marks their director referenced by bar number. Re-engraving throws that away and
replaces it with a rendering whose every OMR error is visible as mangled notation.
Overlaying keeps the real engraving and degrades gracefully: a note OMR missed is a note
you cannot click, not a hole in the page.

**Cost, and it is a real one:** it needs per-note geometry, and `oemer` does not expose
it. That gap is the main outstanding piece of work (see 11), and it is why the engine
interface returns geometry rather than just MusicXML.

**Would switch if:** we needed transposition, or to show a part extracted onto its own
staff. Both require engraving, and at that point the overlay becomes the fallback view.

---

## 11. Pluggable OMR behind an interface, with a deterministic fake

**Picked.** A three-method interface. Two implementations: `oemer` for real
recognition, and `fake`, which synthesises a plausible three-part vocal score from a
hash of the uploaded file and draws it as SVG with bounding boxes matching the glyphs.

**Rejected:** calling `oemer` directly; mocking it only in tests.

**Why:** the open-source OMR engines are all mediocre on dense musical-theatre vocal
scores, so swapping one is the likely next move rather than a hypothetical. And a fake
that produces a *real, clickable, playable* score means the entire frontend, the whole
test suite, and a contributor's first five minutes need no GPU, no model weights, and no
copyrighted sheet music in the repository.

**Known gap:** `oemer` returns MusicXML without per-note pixel geometry, which the
overlay needs. Real-engine scores currently have no bounding boxes. Extracting geometry
from the model's intermediate symbol map is the next substantial ML task.

---

## 12. Note edits as diffs, coalesced on the client

**Picked.** `PATCH .../notes` takes `{add, remove}`. The client updates its cache
immediately and flushes a coalesced batch after 300ms of idle.

**Rejected:** `PUT` the whole note set; one request per click.

**Why:** selecting a part is a click-drag gesture over hundreds of noteheads. One
request per click is hundreds of requests. `PUT`ting the whole set makes every request
carry the entire part and makes two concurrent editors a last-writer-wins race. A diff
is small, commutative between editors working on different bars, and idempotent for
adds — so a retry after a dropped response is safe.

The optimistic update is not a nicety: a notehead that recolours a round trip after the
click reads as a broken control.

**Detail:** a note toggled on and then off inside the flush window cancels and is never
sent. On failure the batch's inverse is applied explicitly rather than relying on a
query invalidation, which only refetches while something is observing it.

---

## 13. Lookahead scheduling for audio

**Picked.** A 25ms `setInterval` that schedules 120ms ahead onto the Web Audio clock.

**Rejected:** `setTimeout` per note; scheduling everything up front.

**Why:** `setTimeout` is not a musical clock. It drifts, it is throttled in background
tabs, and it competes with React reconciling thousands of SVG nodes — notes land audibly
late and unevenly. Handing notes to Web Audio with an explicit `currentTime` offset
moves timing onto the audio thread, where it is sample-accurate; timer jitter is
inaudible as long as it stays under the lookahead. Scheduling everything up front is
sample-accurate too but makes tempo changes, seeking and part toggling require tearing
down and rebuilding the whole timeline.

**Consequence:** playback position is read from `AudioContext.currentTime`, the only
clock that matches what the user hears, and it is read from `requestAnimationFrame` and
written to the DOM directly rather than through React state.

---

## 14. Synthesised tone, not sampled voices

**Picked.** A filtered triangle wave with a soft envelope.

**Rejected:** a sampled voice or piano soundfont.

**Why:** a rehearsal tool needs pitch and rhythm to be unmistakable, not a convincing
timbre. Samples mean tens of megabytes to ship and decode before the first note, and
they still sound wrong on vowels. A synth costs nothing and is clearer in dense
passages.

**Would switch if:** the tool were used for performance-style playback rather than
learning notes.

---

## 15. Dev-only backends so the app runs from a clone

**Picked.** `JOB_MODE=inline` runs OMR in the request thread; `STORAGE_BACKEND=local`
serves objects from a directory. With SQLite and the fake engine, `uvicorn` alone is a
complete working system. Startup refuses all three when `ENV=prod`.

**Rejected:** requiring Docker Compose for any local work.

**Why:** the compose stack mirrors production and should stay that way, but a
contributor should be able to run the app before they can run Docker, and an e2e suite
that needs five services is one nobody runs locally and that flakes in CI.

**Cost:** three code paths that production never exercises. Kept behind the same
interfaces as the real ones, so nothing downstream knows which is in use, and refused
outright in prod rather than left to a deploy checklist.

---

## 16. What is deliberately not here

- **Kubernetes.** Two stateless services and a worker for a cast of ten. Compose
  locally, any container host in production. It would be worth it at the point where
  we need autoscaling GPU workers on spot capacity.
- **Microservices.** The worker is already a separate deployable because its image is
  heavy and its scaling profile is different. Splitting further would add network calls
  between things that share a transaction.
- **GraphQL.** The client makes a handful of well-known requests; the over-fetching
  GraphQL solves is not a problem we have, and it would cost the free OpenAPI-to-
  TypeScript pipeline that is doing real work here.
- **A CRDT for collaborative selection.** Diff-shaped note edits already commute for
  the case that matters (two people editing different parts). Two people editing the
  *same* profile simultaneously is not a workflow this app has.
