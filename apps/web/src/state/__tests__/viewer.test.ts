import { describe, expect, it } from "vitest";

import { audiblePartIds } from "../viewer";

describe("audiblePartIds", () => {
  const all = ["P1", "P2", "P3"];

  it("plays everything by default", () => {
    expect([...audiblePartIds(all, new Set(), new Set())]).toEqual(all);
  });

  it("drops muted parts", () => {
    expect([...audiblePartIds(all, new Set(["P2"]), new Set())]).toEqual(["P1", "P3"]);
  });

  it("lets solo win over mute, the way every DAW does", () => {
    // P2 is both soloed and muted. Soloing it is the more recent, more specific
    // intent; resolving the other way would make the solo button appear broken.
    expect([...audiblePartIds(all, new Set(["P2"]), new Set(["P2"]))]).toEqual(["P2"]);
  });

  it("restricts to the soloed set even when several are soloed", () => {
    expect([...audiblePartIds(all, new Set(), new Set(["P1", "P3"]))]).toEqual(["P1", "P3"]);
  });
});
