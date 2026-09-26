import { useMemo } from "react";
import { Link, useParams } from "react-router-dom";

import JobProgress from "../components/JobProgress";
import NoteInspector from "../components/NoteInspector";
import PartsPanel from "../components/PartsPanel";
import ProfilesPanel from "../components/ProfilesPanel";
import ScoreSheet from "../components/ScoreSheet";
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
import { buildScoreIndex } from "../lib/scoreIndex";
import { useViewer } from "../state/viewer";

export default function ScoreDetailPage() {
  const { scoreId = "" } = useParams();
  const me = useMe();
  const score = useScore(scoreId);
  const doc = useScoreDoc(scoreId);
  const profiles = useProfiles(scoreId);
  const annotations = useAnnotations(scoreId);
  const { activeProfileId, inspectedNoteId, inspectNote, zoom, setZoom } = useViewer();

  const editor = useProfileNoteEditor(scoreId, activeProfileId);

  const index = useMemo(() => (doc.data ? buildScoreIndex(doc.data.doc) : null), [doc.data]);

  const activeProfile = profiles.data?.find((p) => p.id === activeProfileId) ?? null;

  const partColors = useMemo(() => {
    const colors = new Map<string, string>();
    for (const part of index?.doc.parts ?? []) {
      if (part.defaultColor) colors.set(part.id, part.defaultColor);
    }
    for (const annotation of annotations.data ?? []) {
      if (annotation.targetType === "part" && annotation.kind === "color") {
        const color = (annotation.payload as { color?: string }).color;
        if (color) colors.set(annotation.targetId, color);
      }
    }
    return colors;
  }, [index, annotations.data]);

  const noteCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const [partId, notes] of index?.notesByPart ?? []) counts.set(partId, notes.length);
    return counts;
  }, [index]);

  if (score.error) {
    const error = score.error as ApiError;
    return (
      <div className="stack">
        <Link to="/">← All scores</Link>
        <div className="error-banner">
          {error.status === 404 ? "This score does not exist, or is not shared with you." : error.message}
        </div>
      </div>
    );
  }

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="row">
        <Link to="/">← All scores</Link>
        <div className="spacer" />
        {index && (
          <div className="row">
            <button onClick={() => setZoom(zoom - 0.15)} title="Zoom out">
              −
            </button>
            <span className="muted mono">{Math.round(zoom * 100)}%</span>
            <button onClick={() => setZoom(zoom + 0.15)} title="Zoom in">
              +
            </button>
          </div>
        )}
      </div>

      <header className="stack" style={{ gap: 2 }}>
        <h2 style={{ margin: 0 }}>{score.data?.title ?? "…"}</h2>
        <span className="muted">{score.data?.show}</span>
      </header>

      <PendingRecognition scoreId={scoreId} />

      {doc.error && (doc.error as ApiError).status === 409 && (
        <p className="muted">Recognition has not finished for this score yet.</p>
      )}

      {index && doc.data && (
        <div className="score-layout">
          <div className="score-sidebar stack">
            <ProfilesPanel
              scoreId={scoreId}
              profiles={profiles.data ?? []}
              currentUserId={me.data?.id ?? null}
            />
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
            {inspectedNoteId && index.notesById.has(inspectedNoteId) && (
              <NoteInspector
                scoreId={scoreId}
                note={index.notesById.get(inspectedNoteId)!}
                annotations={annotations.data ?? []}
                onClose={() => inspectNote(null)}
              />
            )}
          </div>

          <div className="score-main">
            <ScoreSheet
              index={index}
              pageUrls={doc.data.pageUrls}
              profiles={profiles.data ?? []}
              annotations={annotations.data ?? []}
              activeProfile={activeProfile}
              onPaint={editor.setMembership}
            />
          </div>
        </div>
      )}
    </div>
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
