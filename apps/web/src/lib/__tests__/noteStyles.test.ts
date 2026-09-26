import type { AnnotationRead, Part, ProfileRead } from "@understudy/api-types";
import { describe, expect, it } from "vitest";

import { buildNoteStyles, type StyleInputs } from "../noteStyles";

const PARTS: Part[] = [
  { id: "P1", name: "Elphaba", index: 0, isVocal: true, defaultColor: "#e11d48" },
  { id: "P2", name: "Glinda", index: 1, isVocal: true, defaultColor: "#0ea5e9" },
];

function profile(over: Partial<ProfileRead> = {}): ProfileRead {
  return {
    id: "prof-1",
    scoreId: "s",
    ownerId: "u",
    name: "Elphaba",
    color: "#16a34a",
    isShared: false,
    noteIds: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...over,
  } as ProfileRead;
}

function annotation(over: Partial<AnnotationRead>): AnnotationRead {
  return {
    id: "a",
    scoreId: "s",
    authorId: "u",
    targetType: "note",
    targetId: "n1",
    kind: "color",
    payload: {},
    isShared: false,
    updatedAt: "2026-01-01T00:00:00Z",
    ...over,
  } as AnnotationRead;
}

const partOf = (id: string) => (id === "n2" ? "P2" : "P1");

function styles(inputs: Partial<StyleInputs>, ids = ["n1", "n2"]) {
  return buildNoteStyles(ids, partOf, {
    activeProfile: null,
    otherProfiles: [],
    annotations: [],
    parts: PARTS,
    colorByPart: false,
    showOtherProfiles: false,
    ...inputs,
  });
}

describe("buildNoteStyles precedence", () => {
  it("leaves notes transparent when nothing applies", () => {
    expect(styles({}).get("n1")).toMatchObject({ fill: "transparent", selected: false });
  });

  it("tints by part only when colour-by-part is on", () => {
    expect(styles({ colorByPart: false }).get("n1")?.fill).toBe("transparent");
    expect(styles({ colorByPart: true }).get("n1")?.fill).toMatch(/^#e11d48/);
    expect(styles({ colorByPart: true }).get("n2")?.fill).toMatch(/^#0ea5e9/);
  });

  it("lets a part colour annotation override the part's default", () => {
    const result = styles({
      colorByPart: true,
      annotations: [
        annotation({ targetType: "part", targetId: "P1", payload: { color: "#ffffff" } }),
      ],
    });
    expect(result.get("n1")?.fill).toMatch(/^#ffffff/);
  });

  it("puts the active profile above the part tint", () => {
    const result = styles({
      colorByPart: true,
      activeProfile: profile({ noteIds: ["n1"], color: "#16a34a" }),
    });
    expect(result.get("n1")).toMatchObject({ selected: true });
    expect(result.get("n1")?.stroke).toBe("#16a34a");
    // n2 is not in the profile, so it falls through to its part colour.
    expect(result.get("n2")?.selected).toBe(false);
    expect(result.get("n2")?.fill).toMatch(/^#0ea5e9/);
  });

  it("puts a per-note colour above the active profile", () => {
    const result = styles({
      activeProfile: profile({ noteIds: ["n1"], color: "#16a34a" }),
      annotations: [annotation({ targetId: "n1", payload: { color: "#ffaa00" } })],
    });
    expect(result.get("n1")?.stroke).toBe("#ffaa00");
    // Still reported as selected — the colour changed, the membership did not.
    expect(result.get("n1")?.selected).toBe(true);
  });

  it("shows other people's parts only when asked, and below your own", () => {
    const others = [profile({ id: "p2", noteIds: ["n1", "n2"], color: "#a855f7" })];

    expect(styles({ otherProfiles: others }).get("n2")?.fill).toBe("transparent");

    const shown = styles({
      otherProfiles: others,
      showOtherProfiles: true,
      activeProfile: profile({ noteIds: ["n1"], color: "#16a34a" }),
    });
    expect(shown.get("n1")?.stroke).toBe("#16a34a"); // mine wins
    expect(shown.get("n2")?.fill).toMatch(/^#a855f7/); // theirs shows through
  });

  it("flags notes carrying a text annotation at every precedence level", () => {
    const text = annotation({ targetId: "n1", kind: "text", payload: { text: "breathe" } });
    expect(styles({ annotations: [text] }).get("n1")?.annotated).toBe(true);
    expect(
      styles({ annotations: [text], activeProfile: profile({ noteIds: ["n1"] }) }).get("n1")
        ?.annotated,
    ).toBe(true);
    expect(styles({ annotations: [text], colorByPart: true }).get("n1")?.annotated).toBe(true);
  });
});
