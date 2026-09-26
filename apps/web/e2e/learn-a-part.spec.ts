import { expect, openScore, test, uploadScore } from "./fixtures";

/**
 * The one flow that has to work: upload a score, build a part out of it, and have that
 * part still be there afterwards.
 *
 * Kept to a small number of long tests rather than many short ones. Each one pays the
 * cost of an upload and a recognition pass, and what is actually worth protecting is
 * the sequence — selection surviving a reload is a different claim from selection
 * appearing on click, and only the sequence catches a persistence bug.
 */
test("upload a score, select a part, and keep it across a reload", async ({ page }) => {
  await uploadScore(page, "Defying Gravity");
  await openScore(page, "Defying Gravity");

  // Recognition produced something clickable.
  const noteheads = page.locator("[data-note-id]");
  await expect(noteheads.first()).toBeVisible();
  const totalNotes = await noteheads.count();
  expect(totalNotes).toBeGreaterThan(50);

  // Notes are inert until a part is being edited — otherwise a stray click while
  // reading the score would silently alter someone's saved work.
  await expect(page.locator(".hit-layer.interactive")).toHaveCount(0);

  await page.getByPlaceholder("New part (e.g. Elphaba)").fill("Elphaba");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.locator(".profile.active")).toContainText("Elphaba");
  await expect(page.locator(".hit-layer.interactive").first()).toBeVisible();

  const picked = noteheads.nth(2);
  const noteId = await picked.getAttribute("data-note-id");
  await picked.locator(".note-hit").click();
  await expect(page.locator(".profile.active")).toContainText("· 1");

  // Clicking the same note again takes it back out.
  await picked.locator(".note-hit").click();
  await expect(page.locator(".profile.active")).toContainText("· 0");
  await picked.locator(".note-hit").click();
  await expect(page.locator(".profile.active")).toContainText("· 1");

  // The write is debounced, so give it a moment to reach the server before reloading.
  await page.waitForTimeout(700);
  await page.reload();
  await page.waitForSelector(".sheet-page img");
  // ".profile" is the profiles panel; the voices panel uses ".voice". A singer naming
  // their part after the voice part is the normal case, so the two must not collide.
  await expect(page.locator(".profile", { hasText: "Elphaba" })).toContainText("· 1");

  // And it is the same note, not merely the same count.
  await page.locator(".profile .profile-name", { hasText: "Elphaba" }).click();
  await expect(page.locator(`[data-note-id="${noteId}"] .note-hit`)).toHaveAttribute(
    "stroke",
    /#/,
  );
});

test("drag across noteheads to select a phrase", async ({ page }) => {
  await uploadScore(page, "Popular");
  await openScore(page, "Popular");

  await page.getByPlaceholder("New part (e.g. Elphaba)").fill("Glinda");
  await page.getByRole("button", { name: "Add", exact: true }).click();

  // Trace the line of notes, the way a finger or a mouse actually follows a phrase:
  // through each notehead in turn, not in a straight line between the first and last
  // (successive notes are at different pitches, so a straight line misses them).
  const noteheads = page.locator("[data-note-id] .note-hit");
  const boxes = [];
  for (let i = 0; i < 6; i += 1) {
    const box = await noteheads.nth(i).boundingBox();
    if (!box) throw new Error(`notehead ${i} has no layout`);
    boxes.push({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
  }

  await page.mouse.move(boxes[0]!.x, boxes[0]!.y);
  await page.mouse.down();
  for (const point of boxes.slice(1)) await page.mouse.move(point.x, point.y);
  await page.mouse.up();

  await expect(page.locator(".profile.active")).toContainText("· 6");

  // Within one gesture, dragging back over notes already painted must not flip them:
  // the direction is fixed by the note the drag started on. Without this, any wobble
  // in a hand-drawn trace would erase half of what it just selected.
  await page.mouse.move(boxes[0]!.x, boxes[0]!.y);
  await page.mouse.down();
  for (const point of boxes.slice(1)) await page.mouse.move(point.x, point.y);
  for (const point of [...boxes].reverse()) await page.mouse.move(point.x, point.y);
  await page.mouse.up();
  await expect(page.locator(".profile.active")).toContainText("· 0");

  // That gesture started on an already-selected note, so it erased — the toggle
  // working, not a bug. Starting again on an unselected note paints once more.
  await page.mouse.move(boxes[0]!.x, boxes[0]!.y);
  await page.mouse.down();
  for (const point of boxes.slice(1)) await page.mouse.move(point.x, point.y);
  await page.mouse.up();
  await expect(page.locator(".profile.active")).toContainText("· 6");
});

test("playback starts and the transport reports progress", async ({ page }) => {
  await uploadScore(page, "For Good");
  await openScore(page, "For Good");

  await expect(page.locator(".transport")).toBeVisible();
  await page.getByRole("button", { name: /Play/ }).click();
  await expect(page.getByRole("button", { name: /Pause/ })).toBeVisible();

  // The readout is driven by the audio clock, so it should have moved off bar 1.
  await expect(page.locator(".transport .mono").first()).not.toHaveText(/bar 1 · 0:00/, {
    timeout: 8000,
  });

  await page.getByRole("button", { name: /Pause/ }).click();
  await expect(page.getByRole("button", { name: /Play/ })).toBeVisible();
});

test("a score is private until it is shared", async ({ page, context }) => {
  await uploadScore(page, "No One Mourns");
  await openScore(page, "No One Mourns");
  const scoreUrl = page.url();

  // Switch identity. Bob has never seen this score.
  const bob = await context.newPage();
  await bob.goto("/");
  await bob.locator("select").selectOption("bob@example.com");
  await bob.waitForLoadState("networkidle");
  await expect(bob.getByRole("link", { name: /No One Mourns/ })).toHaveCount(0);

  await bob.goto(scoreUrl);
  await expect(bob.locator(".error-banner")).toContainText(/does not exist, or is not shared/);
});
