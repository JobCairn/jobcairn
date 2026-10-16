import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const PKG = path.resolve(import.meta.dirname, "..");
const SAMPLE = path.resolve(PKG, "../../samples/alex-example");
const JOB_DIR = "companies/acme-corp/jobs/2026-01-12-ai-engineer";

let app: ElectronApplication;
let page: Page;
let ws: string;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "careeros-e2e-video-")));
  ws = path.join(tmp, "CareerOS");
  fs.cpSync(SAMPLE, ws, { recursive: true });
  const jobFile = path.join(ws, JOB_DIR, "job.json");
  const job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  job.scores.fit.must_haves = [{ skill: "LLM agents", met: true }];
  fs.writeFileSync(jobFile, JSON.stringify(job, null, 2));
  app = await electron.launch({
    args: [PKG],
    env: { ...process.env, CAREEROS_USER_DATA: path.join(tmp, "user-data"), CAREEROS_E2E_PICK: JSON.stringify([ws]), CAREEROS_E2E_FAKE_VIDEO: "1" },
  });
  page = await app.firstWindow();
  await page.getByRole("button", { name: /Open existing/ }).click();
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
});

test.afterAll(async () => { await app?.close(); });

test("makes a JD walkthrough from a job, reviews it and makes the final video", async () => {
  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: /Jobs/ }).click();
  await page.getByText("AI Engineer", { exact: true }).first().click();
  await page.getByRole("button", { name: "Make video" }).click();
  const dialog = page.getByRole("dialog", { name: "Make a video" });
  await dialog.getByRole("radio", { name: /JD walkthrough/ }).check();
  await dialog.getByRole("button", { name: "Start" }).click();

  await expect(page.getByRole("heading", { name: "Review the script", level: 2 })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Approve script" })).toBeEnabled();
  await page.getByRole("button", { name: "Approve script" }).click();
  await expect(page.getByRole("heading", { name: "Preview", level: 2 })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Make final" }).click();
  await expect(page.getByText("Final video saved")).toBeVisible({ timeout: 20_000 });

  const folder = path.join(ws, JOB_DIR, "videos", "jd-walkthrough-1");
  expect(fs.existsSync(path.join(folder, "renders", "final.mp4"))).toBe(true);
  expect(JSON.parse(fs.readFileSync(path.join(folder, "video.json"), "utf8")).status).toBe("done");
});

test("Learn lists the video under Jobs", async () => {
  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: /Learn/ }).click();
  const jobs = page.getByRole("region", { name: "Job videos" });
  await expect(jobs.getByText("AI Engineer at Acme Corp")).toBeVisible();
});

test("a script edit that breaks a cue blocks Approve (Review Focus 1)", async () => {
  await page.getByRole("region", { name: "Job videos" }).getByRole("button", { name: /Open/ }).first().click();
  // A scene opens for editing when clicked.
  await page.getByRole("button", { name: "Edit scene 2" }).click();
  const scene2 = page.getByRole("textbox", { name: "Scene 2 script" });
  await scene2.fill("Nothing here matches.");
  await page.getByRole("button", { name: "Save edits" }).click();
  // The problem shows twice by design: summed up above the scenes, and in full on Scene 2 itself.
  await expect(page.getByText("Scene 2 needs a change. It's marked below.")).toBeVisible();
  await expect(page.getByRole("list", { name: "Scene 2: what needs a change" }).getByText(/highlights "On one side", but those words aren't in its script/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve script" })).toBeDisabled();
});
