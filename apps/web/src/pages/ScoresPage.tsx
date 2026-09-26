import { type JobRead } from "@understudy/api-types";
import { useState } from "react";
import { Link } from "react-router-dom";

import JobProgress from "../components/JobProgress";
import { ApiError } from "../lib/api";
import { useJob, useJobCompletionEffect, useScores, useUploadScore } from "../lib/queries";

export default function ScoresPage() {
  const scores = useScores();
  const [activeJob, setActiveJob] = useState<{ scoreId: string; job: JobRead } | null>(null);

  return (
    <div className="stack" style={{ gap: 24 }}>
      <UploadPanel onQueued={(scoreId, job) => setActiveJob({ scoreId, job })} />

      {activeJob && <RecognitionWatcher scoreId={activeJob.scoreId} jobId={activeJob.job.id} />}

      {scores.isPending && <p className="muted">Loading scores…</p>}
      {scores.error && (
        <div className="error-banner">{(scores.error as ApiError).message}</div>
      )}

      {scores.data?.length === 0 && (
        <p className="muted">No scores yet. Upload a PDF vocal score to get started.</p>
      )}

      <div className="score-grid">
        {scores.data?.map((score) => (
          <Link key={score.id} to={`/scores/${score.id}`} className="score-card">
            <h3>{score.title}</h3>
            <div className="muted" style={{ fontSize: 12 }}>
              {score.show ?? "—"}
            </div>
            <div className="row" style={{ marginTop: 10, gap: 6 }}>
              <span className={`badge ${score.status ?? "pending"}`}>
                {score.status ?? "pending"}
              </span>
              {score.status === "ready" && (
                <span className="muted" style={{ fontSize: 12 }}>
                  {score.noteCount} notes · {score.pageCount} pages
                </span>
              )}
              {score.myRole !== "owner" && <span className="badge">{score.myRole}</span>}
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

function UploadPanel({
  onQueued,
}: {
  onQueued: (scoreId: string, job: JobRead) => void;
}) {
  const upload = useUploadScore();
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [show, setShow] = useState("");

  const canSubmit = Boolean(file && title.trim()) && !upload.isPending;

  return (
    <form
      className="card stack"
      onSubmit={(event) => {
        event.preventDefault();
        if (!file || !canSubmit) return;
        upload.mutate(
          {
            file,
            title: title.trim(),
            show: show.trim() || undefined,
            // Generated once per submission, not per attempt, so React Query's retry
            // and a user's double-click both land on the same server-side job.
            idempotencyKey: crypto.randomUUID(),
          },
          {
            onSuccess: (result) => {
              onQueued(result.score.id, result.job);
              setFile(null);
              setTitle("");
              setShow("");
            },
          },
        );
      }}
    >
      <strong>Add a score</strong>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <input
          type="file"
          accept="application/pdf"
          onChange={(event) => {
            const chosen = event.target.files?.[0] ?? null;
            setFile(chosen);
            if (chosen && !title) setTitle(chosen.name.replace(/\.pdf$/i, ""));
          }}
        />
        <input
          placeholder="Song title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <input
          placeholder="Show (optional)"
          value={show}
          onChange={(event) => setShow(event.target.value)}
        />
        <button className="primary" type="submit" disabled={!canSubmit}>
          {upload.isPending ? "Uploading…" : "Upload"}
        </button>
      </div>
      {upload.error && (
        <div className="error-banner">{(upload.error as ApiError).message}</div>
      )}
    </form>
  );
}

function RecognitionWatcher({ scoreId, jobId }: { scoreId: string; jobId: string }) {
  const job = useJob(jobId);
  useJobCompletionEffect(scoreId, job.data);
  if (!job.data) return null;
  return (
    <div className="card">
      <JobProgress job={job.data} />
    </div>
  );
}
