import { type JobRead, isJobFinished } from "@understudy/api-types";

const STAGE_LABELS: Record<string, string> = {
  starting: "Starting up",
  rasterising: "Rendering pages",
  layout: "Reading layout",
  positioning: "Placing notes",
  "rendering-pages": "Drawing pages",
  "uploading-pages": "Saving pages",
  finalising: "Finishing",
  "retry-pending": "Retrying",
  "requeued-after-stall": "Requeued after a stall",
  done: "Done",
};

/**
 * Recognition status.
 *
 * Shows the attempt counter whenever a job has retried. A silent retry looks identical
 * to a stuck job from the outside, and "attempt 2 of 3" is the difference between a
 * user waiting and a user refreshing.
 */
export default function JobProgress({ job }: { job: JobRead }) {
  const label = job.stage ? (STAGE_LABELS[job.stage] ?? job.stage) : "Queued";

  if (job.status === "failed") {
    return (
      <div className="error-banner stack">
        <strong>Recognition failed after {job.attempts} attempts.</strong>
        {job.error && <span className="mono">{job.error}</span>}
      </div>
    );
  }

  if (isJobFinished(job.status)) return null;

  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row muted" style={{ fontSize: 12, justifyContent: "space-between" }}>
        <span>{label}…</span>
        <span>
          {job.attempts > 1 && `attempt ${job.attempts} of ${job.maxAttempts} · `}
          {job.progress}%
        </span>
      </div>
      <div className="progress">
        <span style={{ width: `${Math.max(job.progress, 4)}%` }} />
      </div>
    </div>
  );
}
