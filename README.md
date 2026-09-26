# Understudy

A tool for learning your part from a PDF vocal score.

Upload the score, click or drag across the noteheads that are yours, and play them back
— alone, or against the other voices at a lower volume. Colour the voice parts, mark up
individual notes, and share the score with the rest of the cast so everyone builds
their own part from the same pages.

Built for a cast of about ten sharing ten songs.

---

## Running it

**No dependencies beyond Python and Node.** The API can run on SQLite, execute
recognition jobs inline, keep page images on local disk, and synthesise a score instead
of doing real OMR. That is enough for the whole app.

```bash
# API — http://localhost:8000
cd apps/api
python -m venv .venv && .venv/bin/pip install -e ".[dev]"
cp ../../.env.example .env
.venv/bin/alembic upgrade head
.venv/bin/uvicorn app.main:app --reload

# Web — http://localhost:5173
npm install
npm run dev
```

Upload any PDF. The `fake` recognition engine ignores its musical content and
synthesises a deterministic three-part score, drawn as SVG with note positions that
line up with the overlay, so every feature works without a GPU or model weights.

**The real topology**, mirroring production — Postgres, Redis, MinIO, an API and a
separate GPU-shaped worker:

```bash
docker compose up
```

---

## How it fits together

```
 browser ──┬── React + Vite, TanStack Query for server state
           │
           └── FastAPI ──┬── Postgres      scores, versions, profiles, annotations, jobs
                         ├── Redis / RQ    job transport
                         ├── S3 / MinIO    source PDFs, rendered page images
                         └── OMR worker    PDF ──► score document + page images
```

A **score** is the thing you share. Every recognition run produces an immutable
**version** holding a canonical score document. Your **profile** — the notes you sing —
attaches to the score rather than to any version, and refers to notes by IDs derived
from their musical identity, so it survives the score being re-recognised.

That last point is the one that shapes everything else; see
[`docs/DECISIONS.md`](docs/DECISIONS.md) §3.

---

## Layout

```
apps/api/            FastAPI service
  app/scoredoc.py      canonical score document + deterministic note IDs
  app/models.py        relational schema
  app/authz.py         who may read and write what
  app/jobs.py          job creation and enqueueing
  app/worker/omr/      the OMR seam: base.py, fake.py, oemer_engine.py, musicxml.py
apps/web/            React app
  src/lib/api.ts       typed client, built from the generated contract
  src/lib/queries.ts   server state
  src/state/viewer.ts  UI state — selection, mute/solo, zoom
  src/audio/           lookahead scheduler and synth
  src/components/      the sheet, its overlay, and the panels
packages/api-types/  generated TypeScript view of the API
docs/DECISIONS.md    what was chosen, what was rejected, and what would change it
```

---

## The typed contract

The frontend does not restate any shape the backend already describes:

```
FastAPI route signatures ──► openapi.json ──► schema.d.ts ──► the React app
```

```bash
npm run gen:api         # regenerate
npm run gen:api:check   # regenerate and fail if anything changed — this runs in CI
```

Both generated files are committed. Changing a Pydantic response model without
regenerating breaks the build, which is what makes the contract real rather than
aspirational.

---

## Tests

```bash
cd apps/api && .venv/bin/pytest      # 41 tests: pipeline, authz, versioning, parsing
npm test                             # 26 tests: tempo map, colour precedence, batching
npm run test:e2e                     # 4 Playwright flows against a live stack
```

The backend suite runs on SQLite with an in-memory object store and no queue, so it
needs no containers; CI additionally applies the migrations to a real Postgres and
checks that the models have not drifted from them. Playwright boots the API in its
dependency-free mode, so the e2e suite needs no services either.

---

## Configuration

See [`.env.example`](.env.example). The switches that matter:

| Variable | Values | Notes |
| --- | --- | --- |
| `JOB_MODE` | `queue`, `inline` | `inline` runs OMR in the request. Dev only. |
| `STORAGE_BACKEND` | `s3`, `local` | `local` serves objects from a directory. Dev only. |
| `OMR_ENGINE` | `fake`, `oemer` | `oemer` needs the `omr` extra and realistically a GPU. |
| `AUTH_DEV_MODE` | `true`, `false` | When on, `X-Dev-User: a@b.com` is accepted as identity. |

Startup refuses `inline`, `local` and `AUTH_DEV_MODE` when `ENV=prod`, rather than
leaving it to a deploy checklist.

---

## Status

Working: upload and recognition with retries and idempotency, the score viewer with
paint and marquee selection, per-part and per-note colouring, note annotations,
profiles, sharing with viewer/editor roles, score versioning with a migration report,
and playback with tempo control, mute/solo and a metronome.

The significant gap is real OMR. `oemer` returns MusicXML but no per-note pixel
geometry, and the overlay needs bounding boxes to be clickable — so real-engine scores
do not yet render hit targets. Extracting geometry from the model's intermediate symbol
map is the next substantial piece of work. See [`docs/DECISIONS.md`](docs/DECISIONS.md)
§10 and §11.
