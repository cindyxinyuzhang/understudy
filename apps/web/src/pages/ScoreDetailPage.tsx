import type { AnnotationRead, ProfileRead, ScoreDocResponse } from "@understudy/api-types";
import { useMemo } from "react";
import { Link, useParams } from "react-router-dom";

import { usePlayback, usePlaybackHighlight } from "../audio/usePlayback";
import JobProgress from "../components/JobProgress";
import NoteInspector from "../components/NoteInspector";
import PartsPanel from "../components/PartsPanel";
import ProfilesPanel from "../components/ProfilesPanel";
import ScoreSheet from "../components/ScoreSheet";
import Transport from "../components/Transport";
import { ApiError } from "../lib/api";
import {
  useAnnotations,
  useJobCompletionEffect,
  useMe,
  useProfileNoteEditor,
  useProfiles,
  useScore,
  useScoreDoc,
  useScoreJobs,
} from "../lib/queries";
import { buildScoreIndex, type ScoreIndex } from "../lib/scoreIndex";
import { audiblePartIds, useViewer } from "../state/viewer";

/**
 * Loads a score and hands off to the workspace once there is something to render.
 *
 * Split in two because the workspace needs a real ScoreIndex to build its playback
 * engine, and hooks cannot be called conditionally — the alternative is threading nulls
 * through the audio layer, which would put "is there a score yet" checks in the
 * scheduler.
 */
export default function ScoreDetailPage() {
  const { scoreId = "" } = useParams();
  const score = useScore(scoreId);
  const doc = useScoreDoc(scoreId);
  const profiles = useProfiles(scoreId);
  const annotations = useAnnotations(scoreId);
  const me = useMe();

  const index = useMemo(() => (doc.data ? buildScoreIndex(doc.data.doc) : null), [doc.data]);

  if (score.error) {
    const error = score.error as ApiError;
    return (
      <div className="stack">
        <Link to="/">← All scores</Link>
        <div className="error-banner">
          {error.status === 404
            ? "This score does not exist, or is not shared with you."
            : error.message}
        </div>
      </div>
    );
  }

  return (
    <div className="stack" style={{ gap: 16 }}>
      <Link to="/">← All scores</Link>

      <header className="stack" style={{ gap: 2 }}>
        <h2 style={{ margin: 0 }}>{score.data?.title ?? "…"}</h2>
        <span className="muted">{score.data?.show}</span>
      </header>

      <PendingRecognition scoreId={scoreId} />

      {doc.isPending && <p className="muted">Loading score…</p>}
      {doc.error && (doc.error as ApiError).status === 409 && (
        <p className="muted">Recognition has not finished for this score yet.</p>
      )}

      {index && doc.data && (
        <ScoreWorkspace
          scoreId={scoreId}
          index={index}
          doc={doc.data}
          profiles={profiles.data ?? []}
          annotations={annotations.data ?? []}
          currentUserId={me.data?.id ?? null}
        />
      )}
    </div>
  );
}

function ScoreWorkspace({
  scoreId,
  index,
  doc,
  profiles,
  annotations,
  currentUserId,
}: {
  scoreId: string;
  index: ScoreIndex;
  doc: ScoreDocResponse;
  profiles: ProfileRead[];
  annotations: AnnotationRead[];
  currentUserId: string | null;
}) {
  const {
    activeProfileId,
    inspectedNoteId,
    inspectNote,
    zoom,
    setZoom,
    mutedPartIds,
    soloPartIds,
    playSelectionOnly,
    setPlaySelectionOnly,
    tempoScale,
    setTempoScale,
    metronome,
    setMetronome,
  } = useViewer();

  const editor = useProfileNoteEditor(scoreId, activeProfileId);
  const activeProfile = profiles.find((p) => p.id === activeProfileId) ?? null;

  const allPartIds = useMemo(() => (index.doc.parts ?? []).map((p) => p.id), [index]);
  const audible = useMemo(
    () => audiblePartIds(allPartIds, mutedPartIds, soloPartIds),
    [allPartIds, mutedPartIds, soloPartIds],
  );

  const selection = useMemo(
    () => (activeProfile ? new Set(activeProfile.noteIds) : null),
    [activeProfile],
  );

  /**
   * When practising a part, the rest of the score still plays — quietly. Singing a
   * line in silence is a different and much harder exercise than singing it against
   * the other voices, and the latter is what rehearsal actually is.
   */
  const playbackConfig = useMemo(() => {
    const focusOnly = playSelectionOnly && selection !== null && selection.size > 0;
    return {
      noteIds: focusOnly ? selection : null,
      audiblePartIds: focusOnly ? new Set<string>() : audible,
      backgroundPartIds: focusOnly ? audible : new Set<string>(),
      tempoScale,
      metronome,
      loop: null,
    };
  }, [playSelectionOnly, selection, audible, tempoScale, metronome]);

  const { engine, status } = usePlayback(index, playbackConfig);
  usePlaybackHighlight(engine, status === "playing");

  const partColors = useMemo(() => {
    const colors = new Map<string, string>();
    for (const part of index.doc.parts ?? []) {
      if (part.defaultColor) colors.set(part.id, part.defaultColor);
    }
    for (const annotation of annotations) {
      if (annotation.targetType === "part" && annotation.kind === "color") {
        const color = (annotation.payload as { color?: string }).color;
        if (color) colors.set(annotation.targetId, color);
      }
    }
    return colors;
  }, [index, annotations]);

  const noteCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const [partId, notes] of index.notesByPart) counts.set(partId, notes.length);
    return counts;
  }, [index]);

  const inspected = inspectedNoteId ? index.notesById.get(inspectedNoteId) : undefined;

  return (
    <>
      <Transport
        engine={engine}
        status={status}
        index={index}
        tempoScale={tempoScale}
        onTempoScaleChange={setTempoScale}
        metronome={metronome}
        onMetronomeChange={setMetronome}
        selectionSize={selection?.size ?? 0}
        playSelectionOnly={playSelectionOnly}
        onPlaySelectionOnlyChange={setPlaySelectionOnly}
      />

      <div className="score-layout">
        <div className="score-sidebar stack">
          <ProfilesPanel scoreId={scoreId} profiles={profiles} currentUserId={currentUserId} />
          <PartsPanel
            scoreId={scoreId}
            parts={index.doc.parts ?? []}
            partColors={partColors}
            noteCounts={noteCounts}
          />
          {activeProfileId === null && (
            <p className="muted" style={{ fontSize: 12, margin: 0 }}>
              Pick a part above to start selecting notes. Double-click any notehead to
              annotate it.
            </p>
          )}
          {inspected && (
            <NoteInspector
              scoreId={scoreId}
              note={inspected}
              annotations={annotations}
              onClose={() => inspectNote(null)}
            />
          )}
        </div>

        <div className="score-main stack">
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button onClick={() => setZoom(zoom - 0.15)} title="Zoom out">
              −
            </button>
            <span className="muted mono">{Math.round(zoom * 100)}%</span>
            <button onClick={() => setZoom(zoom + 0.15)} title="Zoom in">
              +
            </button>
          </div>
          <ScoreSheet
            index={index}
            pageUrls={doc.pageUrls}
            profiles={profiles}
            annotations={annotations}
            activeProfile={activeProfile}
            onPaint={editor.setMembership}
          />
        </div>
      </div>
    </>
  );
}

/**
 * If recognition is still running for this score, show it.
 *
 * Driven by the score's own job list rather than something handed down from the upload
 * form, because the common way to arrive here is a link or a reload — the upload may
 * have happened in another tab, or on a castmate's machine.
 */
function PendingRecognition({ scoreId }: { scoreId: string }) {
  const jobs = useScoreJobs(scoreId);
  const active = jobs.data?.find(
    (job) => job.status === "queued" || job.status === "running" || job.status === "failed",
  );
  useJobCompletionEffect(scoreId, active);

  if (!active) return null;
  return (
    <div className="card">
      <JobProgress job={active} />
    </div>
  );
}
