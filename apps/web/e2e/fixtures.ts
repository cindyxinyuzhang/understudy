import { expect, test as base, type Page } from "@playwright/test";

/**
 * A PDF only in the sense that it starts with `%PDF` — which is all the upload
 * endpoint checks and all the fake OMR engine needs, since it hashes the bytes to seed
 * a synthetic score. Keeping real sheet music out of the repo is deliberate: it is
 * copyrighted, and the tests are about our behaviour, not a vendor's model accuracy.
 */
export function fakePdf(marker: string): Buffer {
  return Buffer.from(`%PDF-1.7\n${marker}\n%%EOF\n`);
}

export const test = base.extend<{ asAlice: Page }>({
  asAlice: async ({ page }, use) => {
    await page.goto("/");
    await use(page);
  },
});

export { expect };

/** Upload a score and wait until it is recognised and openable. */
export async function uploadScore(page: Page, title: string, marker = title): Promise<void> {
  await page.goto("/");
  await page.setInputFiles('input[type="file"]', {
    name: `${marker}.pdf`,
    mimeType: "application/pdf",
    buffer: fakePdf(marker),
  });
  await page.getByPlaceholder("Song title").fill(title);
  await page.getByRole("button", { name: "Upload" }).click();
  await expect(page.getByRole("link", { name: new RegExp(title) })).toBeVisible({
    timeout: 20_000,
  });
}

export async function openScore(page: Page, title: string): Promise<void> {
  await page.getByRole("link", { name: new RegExp(title) }).click();
  await page.waitForSelector(".sheet-page img");
}
