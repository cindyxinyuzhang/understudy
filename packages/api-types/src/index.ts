/**
 * The typed API contract.
 *
 * `schema.d.ts` is generated — never edit it. This file is the hand-written façade that
 * gives the generated shapes readable names, so application code says `ScoreDoc` rather
 * than `components["schemas"]["ScoreDoc"]` and a rename in the backend surfaces as a
 * type error in exactly one place.
 */
import type { components, operations, paths } from "./schema";

export type { components, operations, paths };

type S = components["schemas"];

export type UserRead = S["UserRead"];

export type ScoreSummary = S["ScoreSummary"];
export type ScoreDetail = S["ScoreDetail"];
export type ScoreVersionSummary = S["ScoreVersionSummary"];
export type ScoreDocResponse = S["ScoreDocResponse"];
export type ScoreCreateResponse = S["ScoreCreateResponse"];
export type ScoreDoc = S["ScoreDoc"];
export type Note = S["Note"];
export type Part = S["Part"];
export type Page = S["Page"];
export type Tempo = S["Tempo"];
export type TimeSignature = S["TimeSignature"];

export type JobRead = S["JobRead"];
export type JobStatus = S["JobStatus"];
export type VersionStatus = S["VersionStatus"];

export type ProfileRead = S["ProfileRead"];
export type ProfileCreate = S["ProfileCreate"];
export type ProfileUpdate = S["ProfileUpdate"];
export type ProfileNotesPatch = S["ProfileNotesPatch"];

export type AnnotationRead = S["AnnotationRead"];
export type AnnotationUpsert = S["AnnotationUpsert"];
export type TargetType = S["TargetType"];

export type ShareRead = S["ShareRead"];
export type ShareCreate = S["ShareCreate"];
export type ShareRole = S["ShareRole"];

export type MigrationReport = S["MigrationReport"];
export type ProfileMigration = S["ProfileMigration"];

/** A job that has stopped moving — the client can stop polling. */
export const TERMINAL_JOB_STATUSES = ["succeeded", "failed", "cancelled"] as const;
export type TerminalJobStatus = (typeof TERMINAL_JOB_STATUSES)[number];

export function isJobFinished(status: JobStatus): status is TerminalJobStatus {
  return (TERMINAL_JOB_STATUSES as readonly string[]).includes(status);
}
