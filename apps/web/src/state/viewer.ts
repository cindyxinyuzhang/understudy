/**
 * UI state: what this tab is doing right now.
 *
 * Nothing in here is persisted or sent anywhere. It is deliberately separate from the
 * TanStack Query cache in lib/queries.ts — the rule is that if a refetch could
 * plausibly overwrite it, it does not belong here, and if a reload should forget it, it
 * does not belong there.
 *
 * Playback position is the notable absentee. It changes ~60 times a second, and putting
 * it in a store would re-render every notehead on the page for each frame. The audio
 * engine owns it and the playhead reads it directly; see audio/scheduler.ts.
 */
import { create } from "zustand";

export type Tool = "select" | "annotate";

interface ViewerState {
  /** Profile that clicks add to and remove from. Null means "just browsing". */
  activeProfileId: string | null;
  tool: Tool;
  /** Tint every note by its voice part, underneath any profile or per-note colour. */
  colorByPart: boolean;
  /** Show notes belonging to other people's published profiles, dimmed. */
  showOtherProfiles: boolean;
  inspectedNoteId: string | null;
  /** Parts silenced during playback. Separate from visibility — you still see them. */
  mutedPartIds: Set<string>;
  /** When non-empty, only these parts sound. */
  soloPartIds: Set<string>;
  zoom: number;
  /** Play only the notes in the active profile, with other parts as a quiet guide. */
  playSelectionOnly: boolean;
  tempoScale: number;
  metronome: boolean;

  setActiveProfile: (id: string | null) => void;
  setTool: (tool: Tool) => void;
  toggleColorByPart: () => void;
  toggleShowOtherProfiles: () => void;
  inspectNote: (id: string | null) => void;
  togglePartMuted: (partId: string) => void;
  togglePartSolo: (partId: string) => void;
  setZoom: (zoom: number) => void;
  setPlaySelectionOnly: (value: boolean) => void;
  setTempoScale: (value: number) => void;
  setMetronome: (value: boolean) => void;
}

function toggleIn(set: Set<string>, value: string): Set<string> {
  const next = new Set(set);
  if (!next.delete(value)) next.add(value);
  return next;
}

export const useViewer = create<ViewerState>((set) => ({
  activeProfileId: null,
  tool: "select",
  colorByPart: true,
  showOtherProfiles: false,
  inspectedNoteId: null,
  mutedPartIds: new Set(),
  soloPartIds: new Set(),
  zoom: 1,
  playSelectionOnly: true,
  tempoScale: 1,
  metronome: false,

  setActiveProfile: (activeProfileId) => set({ activeProfileId }),
  setTool: (tool) => set({ tool }),
  toggleColorByPart: () => set((s) => ({ colorByPart: !s.colorByPart })),
  toggleShowOtherProfiles: () => set((s) => ({ showOtherProfiles: !s.showOtherProfiles })),
  inspectNote: (inspectedNoteId) => set({ inspectedNoteId }),
  togglePartMuted: (partId) => set((s) => ({ mutedPartIds: toggleIn(s.mutedPartIds, partId) })),
  togglePartSolo: (partId) => set((s) => ({ soloPartIds: toggleIn(s.soloPartIds, partId) })),
  setZoom: (zoom) => set({ zoom: Math.min(3, Math.max(0.4, zoom)) }),
  setPlaySelectionOnly: (playSelectionOnly) => set({ playSelectionOnly }),
  setTempoScale: (tempoScale) => set({ tempoScale }),
  setMetronome: (metronome) => set({ metronome }),
}));

/** Which parts should actually sound, given mute and solo. */
export function audiblePartIds(
  allPartIds: string[],
  muted: Set<string>,
  solo: Set<string>,
): Set<string> {
  // Solo wins over mute, which is what every DAW does and therefore what people expect.
  if (solo.size > 0) return new Set([...allPartIds].filter((id) => solo.has(id)));
  return new Set(allPartIds.filter((id) => !muted.has(id)));
}
