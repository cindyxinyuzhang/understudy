/**
 * Server state, owned by TanStack Query.
 *
 * The split this app leans on: anything the API is the source of truth for lives here
 * (scores, documents, profiles, annotations, jobs). Anything that is purely a property
 * of *this browser tab right now* — which notes are lassoed, where playback is, which
 * tool is active — lives in `state/` and never touches this file. Mixing the two is
 * what produces the classic bug where a refetch stomps on the user's in-progress
 * selection, or where a transient UI flag gets cached and replayed after a reload.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import {
  isJobFinished,
  type AnnotationRead,
  type AnnotationUpsert,
  type JobRead,
  type ProfileRead,
  type ScoreDocResponse,
} from "@understudy/api-types";
import { useCallback, useEffect, useRef } from "react";

import * as api from "./api";
import { ApiError } from "./api";

export const keys = {
  scores: ["scores"] as const,
  score: (id: string) => ["scores", id] as const,
  doc: (id: string, versionId?: string) => ["scores", id, "doc", versionId ?? "current"] as const,
  profiles: (id: string) => ["scores", id, "profiles"] as const,
  annotations: (id: string) => ["scores", id, "annotations"] as const,
  shares: (id: string) => ["scores", id, "shares"] as const,
  job: (id: string) => ["jobs", id] as const,
};

export function useScores() {
  return useQuery({ queryKey: keys.scores, queryFn: api.listScores });
}

export function useScore(scoreId: string) {
  return useQuery({ queryKey: keys.score(scoreId), queryFn: () => api.getScore(scoreId) });
}

/**
 * The score document. Cached hard and never refetched on its own, because a version is
 * immutable by construction — its key includes the version ID, so the only way to see
 * different content is to ask for a different version.
 */
export function useScoreDoc(
  scoreId: string,
  versionId?: string,
): UseQueryResult<ScoreDocResponse, ApiError> {
  return useQuery<ScoreDocResponse, ApiError>({
    queryKey: keys.doc(scoreId, versionId),
    queryFn: () => api.getScoreDoc(scoreId, versionId),
    staleTime: Infinity,
    gcTime: 30 * 60 * 1000,
    // 409 means "not recognised yet", which polling the document will not fix — the
    // job poller is what drives that transition.
    retry: (count, error) => error.isRetryable && count < 3,
  });
}

/**
 * Poll a job until it settles.
 *
 * The interval widens while queued and tightens once work actually starts, and polling
 * stops dead on a terminal status so a finished import does not keep a tab chattering.
 */
export function useJob(jobId: string | null) {
  return useQuery({
    queryKey: keys.job(jobId ?? "none"),
    queryFn: () => api.getJob(jobId as string),
    enabled: Boolean(jobId),
    refetchInterval: (query) => {
      const job = query.state.data as JobRead | undefined;
      if (!job || isJobFinished(job.status)) return false;
      return job.status === "running" ? 1000 : 3000;
    },
  });
}

/** Invalidate everything a finished OMR run could have changed. */
export function useJobCompletionEffect(scoreId: string, job: JobRead | undefined) {
  const client = useQueryClient();
  const settled = useRef<string | null>(null);

  useEffect(() => {
    if (!job || !isJobFinished(job.status) || settled.current === job.id) return;
    settled.current = job.id;
    void client.invalidateQueries({ queryKey: keys.score(scoreId) });
    void client.invalidateQueries({ queryKey: keys.scores });
    void client.invalidateQueries({ queryKey: ["scores", scoreId, "doc"] });
  }, [client, job, scoreId]);
}

export function useProfiles(scoreId: string) {
  return useQuery({ queryKey: keys.profiles(scoreId), queryFn: () => api.listProfiles(scoreId) });
}

export function useCreateProfile(scoreId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: Parameters<typeof api.createProfile>[1]) =>
      api.createProfile(scoreId, body),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.profiles(scoreId) }),
  });
}

export function useUpdateProfile(scoreId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      profileId,
      ...body
    }: Parameters<typeof api.updateProfile>[2] & { profileId: string }) =>
      api.updateProfile(scoreId, profileId, body),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.profiles(scoreId) }),
  });
}

export function useDeleteProfile(scoreId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (profileId: string) => api.deleteProfile(scoreId, profileId),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.profiles(scoreId) }),
  });
}

const FLUSH_DELAY_MS = 300;

/**
 * Toggling notes into and out of a profile.
 *
 * Selecting a part is a rapid click-drag gesture over hundreds of noteheads, so this
 * does two things a plain mutation would not:
 *
 * 1. Updates the cache synchronously, so the notehead recolours on the same frame as
 *    the click. Waiting for a round trip makes selection feel broken.
 * 2. Coalesces the resulting writes. Pending adds and removes accumulate in a ref and
 *    flush as one PATCH after a short idle, and a note toggled on then off inside the
 *    window cancels out and is never sent. Dragging across 200 notes is one request,
 *    not 200.
 *
 * On failure the accumulated batch is rolled back wholesale and the server's view is
 * refetched — with a diff-shaped endpoint there is no partial-application case to
 * reason about, which is most of why the endpoint takes a diff.
 */
export function useProfileNoteEditor(scoreId: string, profileId: string | null) {
  const client = useQueryClient();
  const pending = useRef({ add: new Set<string>(), remove: new Set<string>() });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(async () => {
    timer.current = null;
    if (!profileId) return;
    const add = [...pending.current.add];
    const remove = [...pending.current.remove];
    pending.current = { add: new Set(), remove: new Set() };
    if (add.length === 0 && remove.length === 0) return;

    try {
      const updated = await api.patchProfileNotes(scoreId, profileId, { add, remove });
      client.setQueryData<ProfileRead[]>(keys.profiles(scoreId), (old) =>
        old?.map((p) => (p.id === updated.id ? updated : p)),
      );
    } catch {
      await client.invalidateQueries({ queryKey: keys.profiles(scoreId) });
    }
  }, [client, profileId, scoreId]);

  const schedule = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), FLUSH_DELAY_MS);
  }, [flush]);

  // A navigation or unmount mid-gesture must not silently drop the last few clicks.
  useEffect(() => {
    return () => {
      if (timer.current) {
        clearTimeout(timer.current);
        void flush();
      }
    };
  }, [flush]);

  const setMembership = useCallback(
    (noteIds: string[], shouldBelong: boolean) => {
      if (!profileId || noteIds.length === 0) return;

      client.setQueryData<ProfileRead[]>(keys.profiles(scoreId), (old) =>
        old?.map((p) => {
          if (p.id !== profileId) return p;
          const next = new Set(p.noteIds);
          for (const id of noteIds) shouldBelong ? next.add(id) : next.delete(id);
          return { ...p, noteIds: [...next] };
        }),
      );

      for (const id of noteIds) {
        const [into, outOf] = shouldBelong
          ? [pending.current.add, pending.current.remove]
          : [pending.current.remove, pending.current.add];
        // An add cancelling a queued remove (or vice versa) collapses to nothing.
        if (outOf.delete(id)) continue;
        into.add(id);
      }
      schedule();
    },
    [client, profileId, schedule, scoreId],
  );

  return { setMembership, flush };
}

export function useAnnotations(scoreId: string) {
  return useQuery({
    queryKey: keys.annotations(scoreId),
    queryFn: () => api.listAnnotations(scoreId),
  });
}

export function useUpsertAnnotations(scoreId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: AnnotationUpsert[]) => api.upsertAnnotations(scoreId, body),
    onSuccess: (rows) => {
      client.setQueryData<AnnotationRead[]>(keys.annotations(scoreId), (old) => {
        const byKey = new Map(
          (old ?? []).map((a) => [`${a.targetType}:${a.targetId}:${a.kind}`, a]),
        );
        for (const row of rows) byKey.set(`${row.targetType}:${row.targetId}:${row.kind}`, row);
        return [...byKey.values()];
      });
    },
  });
}

export function useDeleteAnnotation(scoreId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (annotationId: string) => api.deleteAnnotation(scoreId, annotationId),
    onSuccess: (_void, annotationId) => {
      client.setQueryData<AnnotationRead[]>(keys.annotations(scoreId), (old) =>
        old?.filter((a) => a.id !== annotationId),
      );
    },
  });
}

export function useShares(scoreId: string) {
  return useQuery({ queryKey: keys.shares(scoreId), queryFn: () => api.listShares(scoreId) });
}

export function useAddShare(scoreId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: Parameters<typeof api.addShare>[1]) => api.addShare(scoreId, body),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.shares(scoreId) }),
  });
}

export function useUploadScore() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.uploadScore,
    onSuccess: () => client.invalidateQueries({ queryKey: keys.scores }),
  });
}

export function useActivateVersion(scoreId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (versionId: string) => api.activateVersion(scoreId, versionId),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.score(scoreId) });
      void client.invalidateQueries({ queryKey: ["scores", scoreId, "doc"] });
      void client.invalidateQueries({ queryKey: keys.profiles(scoreId) });
    },
  });
}
