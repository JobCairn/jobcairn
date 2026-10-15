import { expect, test } from "@playwright/test";

test("guide loads only local files and the bundled fonts", async ({ page }) => {
  const external: string[] = [];
  page.on("request", (r) => { if (!r.url().startsWith("http://127.0.0.1:4179/")) external.push(r.url()); });
  await page.goto("/");
  await page.evaluate(() => document.fonts.ready);
  expect(external).toEqual([]);
  const families = await page.evaluate(() => [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family.replace(/"/g, "")));
  expect(families).toEqual(expect.arrayContaining(["Instrument Serif", "Geist", "Geist Mono"]));
});

for (const theme of ["graphite", "paper"] as const) {
  test(`brand guide snapshot: ${theme}`, async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => document.fonts.ready);
    await expect(page.locator(`[data-theme="${theme}"]`)).toHaveScreenshot(`guide-${theme}.png`);
  });
}
