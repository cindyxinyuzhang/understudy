/**
 * What colour a notehead should be.
 *
 * Several things want to tint the same note — the voice part it belongs to, the profile
 * you are building, other people's published profiles, and a per-note override you
 * painted yourself — so precedence has to be decided in one place rather than argued
 * over by competing CSS rules. Most specific wins:
 *
 *   1. a per-note colour annotation you made
 *   2. membership of the profile you are actively editing
 *   3. membership of someone else's published profile (dimmed, opt-in)
 *   4. the voice part's colour (a wash, opt-in)
 *   5. nothing — the note stays an invisible hit target over the engraving
 *
 * Computed as one Map per render rather than per-note inside the render loop: a dense
 * vocal score is a few thousand noteheads and this runs on every selection change.
 */
import type { AnnotationRead, Part, ProfileRead } from "@understudy/api-types";

export interface NoteStyle {
  fill: string;
  stroke: string;
  strokeWidth: number;
  /** In the profile currently being edited — drives the "click removes it" affordance. */
  selected: boolean;
  /** Has a text annotation, so the overlay draws a marker. */
  annotated: boolean;
}

const TRANSPARENT: NoteStyle = {
  fill: "transparent",
  stroke: "transparent",
  strokeWidth: 0,
  selected: false,
  annotated: false,
};

export interface StyleInputs {
  activeProfile: ProfileRead | null;
  otherProfiles: ProfileRead[];
  annotations: AnnotationRead[];
  parts: Part[];
  colorByPart: boolean;
  showOtherProfiles: boolean;
}

/** `#rrggbb` plus an alpha byte. Cheaper and more predictable than colour-mix here. */
function withAlpha(hex: string, alpha: number): string {
  const clean = hex.length === 9 ? hex.slice(0, 7) : hex;
  const byte = Math.round(Math.max(0, Math.min(1, alpha)) * 255)
    .toString(16)
    .padStart(2, "0");
  return `${clean}${byte}`;
}

export function buildNoteStyles(
  noteIds: Iterable<string>,
  notePartId: (noteId: string) => string | undefined,
  inputs: StyleInputs,
): Map<string, NoteStyle> {
  const { activeProfile, otherProfiles, annotations, parts, colorByPart, showOtherProfiles } =
    inputs;

  const partColors = new Map<string, string>();
  for (const part of parts) {
    if (part.defaultColor) partColors.set(part.id, part.defaultColor);
  }

  const noteColorOverride = new Map<string, string>();
  const annotatedNotes = new Set<string>();
  for (const annotation of annotations) {
    if (annotation.targetType === "part") {
      const color = (annotation.payload as { color?: string }).color;
      if (annotation.kind === "color" && color) partColors.set(annotation.targetId, color);
      continue;
    }
    if (annotation.kind === "color") {
      const color = (annotation.payload as { color?: string }).color;
      if (color) noteColorOverride.set(annotation.targetId, color);
    } else {
      annotatedNotes.add(annotation.targetId);
    }
  }

  const activeMembers = new Set(activeProfile?.noteIds ?? []);
  const otherMembership = new Map<string, string>();
  if (showOtherProfiles) {
    for (const profile of otherProfiles) {
      for (const noteId of profile.noteIds) {
        if (!otherMembership.has(noteId)) otherMembership.set(noteId, profile.color);
      }
    }
  }

  const styles = new Map<string, NoteStyle>();
  for (const noteId of noteIds) {
    const annotated = annotatedNotes.has(noteId);
    const selected = activeMembers.has(noteId);

    const override = noteColorOverride.get(noteId);
    if (override) {
      styles.set(noteId, {
        fill: withAlpha(override, 0.55),
        stroke: override,
        strokeWidth: 1.5,
        selected,
        annotated,
      });
      continue;
    }

    if (selected && activeProfile) {
      styles.set(noteId, {
        fill: withAlpha(activeProfile.color, 0.45),
        stroke: activeProfile.color,
        strokeWidth: 2,
        selected: true,
        annotated,
      });
      continue;
    }

    const other = otherMembership.get(noteId);
    if (other) {
      styles.set(noteId, {
        fill: withAlpha(other, 0.18),
        stroke: withAlpha(other, 0.5),
        strokeWidth: 1,
        selected: false,
        annotated,
      });
      continue;
    }

    const partColor = colorByPart ? partColors.get(notePartId(noteId) ?? "") : undefined;
    if (partColor) {
      styles.set(noteId, {
        fill: withAlpha(partColor, 0.16),
        stroke: "transparent",
        strokeWidth: 0,
        selected: false,
        annotated,
      });
      continue;
    }

    styles.set(noteId, annotated ? { ...TRANSPARENT, annotated } : TRANSPARENT);
  }

  return styles;
}
