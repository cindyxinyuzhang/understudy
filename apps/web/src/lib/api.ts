/**
 * The API client.
 *
 * Every signature here is built from `@understudy/api-types`, which is generated from
 * the FastAPI OpenAPI schema. Nothing in this file restates a shape the backend already
 * describes — if a response model changes in Python, the regenerated types make this
 * file fail to compile rather than making the app fail at runtime.
 */
import type {
  AnnotationRead,
  AnnotationUpsert,
  JobRead,
  MigrationReport,
  ProfileCreate,
  ProfileNotesPatch,
  ProfileRead,
  ProfileUpdate,
  ScoreCreateResponse,
  ScoreDetail,
  ScoreDocResponse,
  ScoreSummary,
  ShareCreate,
  ShareRead,
} from "@understudy/api-types";

import { authHeaders } from "./auth";

const BASE = import.meta.env.VITE_API_BASE ?? "/api";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    readonly requestId: string | null,
  ) {
    super(detail);
    this.name = "ApiError";
  }

  /** 4xx other than 408/429 will fail again the same way; retrying is just noise. */
  get isRetryable(): boolean {
    return this.status >= 500 || this.status === 408 || this.status === 429;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  for (const [key, value] of Object.entries(await authHeaders())) {
    headers.set(key, value);
  }
  if (init.body && !(init.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(`${BASE}${path}`, { ...init, headers });

  if (!response.ok) {
    // FastAPI puts the message in `detail`; fall back to the status line for anything
    // that did not come from the app (a proxy 502, say).
    let detail = response.statusText;
    try {
      const body = await response.json();
      if (typeof body?.detail === "string") detail = body.detail;
      else if (Array.isArray(body?.detail)) detail = body.detail.map(validationMessage).join("; ");
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(response.status, detail, response.headers.get("X-Request-ID"));
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function validationMessage(item: { loc?: unknown[]; msg?: string }): string {
  const field = Array.isArray(item.loc) ? item.loc.slice(1).join(".") : "";
  return field ? `${field}: ${item.msg}` : (item.msg ?? "invalid");
}

// --- scores -----------------------------------------------------------------
export const listScores = () => request<ScoreSummary[]>("/scores");

export const getScore = (scoreId: string) => request<ScoreDetail>(`/scores/${scoreId}`);

export const getScoreDoc = (scoreId: string, versionId?: string) =>
  request<ScoreDocResponse>(
    `/scores/${scoreId}/doc${versionId ? `?versionId=${versionId}` : ""}`,
  );

export function uploadScore(input: {
  file: File;
  title: string;
  show?: string;
  idempotencyKey: string;
}): Promise<ScoreCreateResponse> {
  const form = new FormData();
  form.set("file", input.file);
  form.set("title", input.title);
  if (input.show) form.set("show", input.show);
  return request<ScoreCreateResponse>("/scores", {
    method: "POST",
    body: form,
    // Generated client-side so a retried upload after a dropped response reuses the
    // job the server already created instead of starting a second recognition run.
    headers: { "Idempotency-Key": input.idempotencyKey },
  });
}

export function uploadVersion(scoreId: string, file: File, idempotencyKey: string) {
  const form = new FormData();
  form.set("file", file);
  return request<JobRead>(`/scores/${scoreId}/versions`, {
    method: "POST",
    body: form,
    headers: { "Idempotency-Key": idempotencyKey },
  });
}

export const previewMigration = (scoreId: string, versionId: string) =>
  request<MigrationReport>(`/scores/${scoreId}/versions/${versionId}/migration`);

export const activateVersion = (scoreId: string, versionId: string) =>
  request<MigrationReport>(`/scores/${scoreId}/versions/${versionId}/activate`, {
    method: "POST",
  });

export const deleteScore = (scoreId: string) =>
  request<void>(`/scores/${scoreId}`, { method: "DELETE" });

// --- jobs -------------------------------------------------------------------
export const getJob = (jobId: string) => request<JobRead>(`/jobs/${jobId}`);

// --- profiles ---------------------------------------------------------------
export const listProfiles = (scoreId: string) =>
  request<ProfileRead[]>(`/scores/${scoreId}/profiles`);

export const createProfile = (scoreId: string, body: ProfileCreate) =>
  request<ProfileRead>(`/scores/${scoreId}/profiles`, {
    method: "POST",
    body: JSON.stringify(body),
  });

export const updateProfile = (scoreId: string, profileId: string, body: ProfileUpdate) =>
  request<ProfileRead>(`/scores/${scoreId}/profiles/${profileId}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });

export const deleteProfile = (scoreId: string, profileId: string) =>
  request<void>(`/scores/${scoreId}/profiles/${profileId}`, { method: "DELETE" });

export const patchProfileNotes = (
  scoreId: string,
  profileId: string,
  body: ProfileNotesPatch,
) =>
  request<ProfileRead>(`/scores/${scoreId}/profiles/${profileId}/notes`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });

// --- annotations ------------------------------------------------------------
export const listAnnotations = (scoreId: string) =>
  request<AnnotationRead[]>(`/scores/${scoreId}/annotations`);

export const upsertAnnotations = (scoreId: string, body: AnnotationUpsert[]) =>
  request<AnnotationRead[]>(`/scores/${scoreId}/annotations`, {
    method: "PUT",
    body: JSON.stringify(body),
  });

export const deleteAnnotation = (scoreId: string, annotationId: string) =>
  request<void>(`/scores/${scoreId}/annotations/${annotationId}`, { method: "DELETE" });

// --- sharing ----------------------------------------------------------------
export const listShares = (scoreId: string) => request<ShareRead[]>(`/scores/${scoreId}/shares`);

export const addShare = (scoreId: string, body: ShareCreate) =>
  request<ShareRead>(`/scores/${scoreId}/shares`, {
    method: "POST",
    body: JSON.stringify(body),
  });

export const removeShare = (scoreId: string, userId: string) =>
  request<void>(`/scores/${scoreId}/shares/${userId}`, { method: "DELETE" });
