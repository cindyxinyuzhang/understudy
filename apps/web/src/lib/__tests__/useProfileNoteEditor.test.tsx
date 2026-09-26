import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProfileNotesPatch, ProfileRead } from "@understudy/api-types";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as api from "../api";
import { keys, useProfileNoteEditor } from "../queries";

const SCORE_ID = "score-1";
const PROFILE_ID = "profile-1";

function seedProfile(noteIds: string[] = []): ProfileRead {
  return {
    id: PROFILE_ID,
    scoreId: SCORE_ID,
    ownerId: "user-1",
    name: "Elphaba",
    color: "#e11d48",
    isShared: false,
    noteIds,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  } as ProfileRead;
}

function setup(initial: string[] = []) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(keys.profiles(SCORE_ID), [seedProfile(initial)]);

  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const view = renderHook(() => useProfileNoteEditor(SCORE_ID, PROFILE_ID), { wrapper });

  const current = () =>
    (client.getQueryData(keys.profiles(SCORE_ID)) as ProfileRead[])[0]!.noteIds;

  return { ...view, client, current };
}

// Declared via a factory so the spy keeps its argument types; a bare
// `ReturnType<typeof vi.spyOn>` erases them to unknown[].
const spyOnPatch = () => vi.spyOn(api, "patchProfileNotes");
let patch: ReturnType<typeof spyOnPatch>;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  patch = spyOnPatch().mockImplementation(
    async (_scoreId: string, _profileId: string, body: ProfileNotesPatch) =>
      seedProfile(body.add ?? []),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useProfileNoteEditor", () => {
  it("shows the selection immediately, before anything reaches the server", () => {
    const { result, current } = setup();

    act(() => result.current.setMembership(["n1"], true));

    // The notehead must recolour on the same frame as the click; waiting for a round
    // trip makes selection feel broken.
    expect(current()).toEqual(["n1"]);
    expect(patch).not.toHaveBeenCalled();
  });

  it("coalesces a drag into one request", async () => {
    const { result } = setup();

    act(() => {
      for (const id of ["n1", "n2", "n3", "n4", "n5"]) {
        result.current.setMembership([id], true);
      }
    });
    await act(async () => {
      vi.advanceTimersByTime(400);
    });

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch.mock.calls[0]?.[2]).toEqual({
      add: ["n1", "n2", "n3", "n4", "n5"],
      remove: [],
    });
  });

  it("cancels a note added and removed inside the same window", async () => {
    const { result, current } = setup();

    act(() => {
      result.current.setMembership(["n1", "n2"], true);
      result.current.setMembership(["n1"], false);
    });
    await act(async () => {
      vi.advanceTimersByTime(400);
    });

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    // n1 never existed as far as the server is concerned, so it appears in neither list.
    expect(patch.mock.calls[0]?.[2]).toEqual({ add: ["n2"], remove: [] });
    expect(current()).toEqual(["n2"]);
  });

  it("sends a removal for a note the server already knows about", async () => {
    const { result } = setup(["n1", "n2"]);

    act(() => result.current.setMembership(["n1"], false));
    await act(async () => {
      vi.advanceTimersByTime(400);
    });

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch.mock.calls[0]?.[2]).toEqual({ add: [], remove: ["n1"] });
  });

  it("does not send an empty patch when nothing is pending", async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.flush();
    });
    expect(patch).not.toHaveBeenCalled();
  });

  it("flushes pending edits when the component unmounts mid-gesture", async () => {
    const { result, unmount } = setup();

    act(() => result.current.setMembership(["n1"], true));
    unmount();

    // Navigating away a beat after the last click must not silently drop it.
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch.mock.calls[0]?.[2]).toEqual({ add: ["n1"], remove: [] });
  });

  it("falls back to the server's view when a write fails", async () => {
    patch.mockRejectedValueOnce(new Error("network down"));
    const list = vi.spyOn(api, "listProfiles").mockResolvedValue([seedProfile([])]);

    const { result, current } = setup();
    act(() => result.current.setMembership(["n1"], true));
    expect(current()).toEqual(["n1"]); // optimistic

    await act(async () => {
      vi.advanceTimersByTime(400);
    });

    // The whole batch rolls back together, without depending on something else being
    // mounted to observe the query.
    await waitFor(() => expect(current()).toEqual([]));
    expect(list).toBeDefined();
  });
});
