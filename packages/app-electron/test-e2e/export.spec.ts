import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const PKG = path.resolve(import.meta.dirname, "..");
const SAMPLE = path.resolve(PKG, "../../samples/alex-example");
const SLUG = "example-labs";
const ID = "2026-01-12-backend-engineer-llm";

let app: ElectronApplication;
let page: Page;
let exportDir: string;
let tmp: string;

test.describe.configure({ mode: "serial" });

const printDirs = () => new Set(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("careeros-print-")));

test.beforeAll(async () => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "careeros-export-")));
  const ws = path.join(tmp, "CareerOS");
  fs.cpSync(SAMPLE, ws, { recursive: true });
  const appDir = path.join(ws, "companies", SLUG, "jobs", ID, "application");
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, "resume.md"), [
    "# Alex Example", "", "Sampletown NSW · " + "alex" + "@" + "example.com", "", "## Experience", "",
    "- Built retrieval pipelines (fictional)", "", "![tracker](https://tracker.example.com/p.png)", "",
    // Hostile bits: none of these may run, load or become a link in the PDF.
    "<script>document.title = 'ran'</script>", "", "<img src=\"https://tracker.example.com/x.png\" onerror=\"alert(1)\">", "",
    "[click](javascript:alert(2)) and [site](https://portfolio.example.com)", "",
  ].join("\n"));
  exportDir = path.join(appDir, "export");
  app = await electron.launch({
    args: [PKG],
    env: { ...process.env, CAREEROS_USER_DATA: path.join(tmp, "user-data"), CAREEROS_HOME_OVERRIDE: path.join(tmp, "home"), CAREEROS_E2E_PICK: JSON.stringify([ws]) },
  });
  page = await app.firstWindow();
  await page.getByRole("button", { name: /Open existing/ }).click();
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
});

test.afterAll(async () => { await app?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

/** Calls the bridge from the page; returns "ok" or the error message. */
const call = (method: string, args: unknown[]) => page.evaluate(async ([m, a]) => {
  const t = (window as unknown as { careerosTransport: { call(m: string, a: unknown[]): Promise<unknown> } }).careerosTransport;
  try { await t.call(m, a); return "ok"; } catch (e) { return (e as Error).message; }
}, [method, args] as [string, unknown[]]);

test("exports an ATS-safe PDF with embedded, extractable text, and a Word file", async () => {
  const before = printDirs();
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  expect(await call("docs.export", [SLUG, ID, ["resume"], ["pdf", "docx"], false])).toBe("ok");
  const pdf = fs.readFileSync(path.join(exportDir, "resume.pdf")).toString("latin1");
  expect(pdf.startsWith("%PDF-")).toBe(true);
  expect(pdf).toMatch(/\/FontFile[23]?\b/); // the font is embedded
  expect(pdf).toContain("/ToUnicode"); // glyphs map back to characters, so the text can be extracted
  expect(pdf).not.toMatch(/\/Subtype\s*\/Image/); // no images
  expect(pdf).not.toMatch(/\/URI\s*\(/); // no links out
  expect(pdf).not.toMatch(/\/(JavaScript|JS|Launch|OpenAction)\b/); // nothing that runs
  expect(fs.readFileSync(path.join(exportDir, "resume.docx")).subarray(0, 2).toString("latin1")).toBe("PK");
  expect((fs.statSync(path.join(exportDir, "resume.pdf")).mode & 0o777)).toBe(0o600);
  // The hidden print window and its temp folder are gone.
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(windows);
  expect([...printDirs()].filter((d) => !before.has(d))).toEqual([]);
});

test("asks before overwriting, then replaces", async () => {
  expect(await call("docs.export", [SLUG, ID, ["resume"], ["pdf"], false])).toMatch(/Already exported: resume\.pdf/);
  expect(await call("docs.export", [SLUG, ID, ["resume"], ["pdf"], true])).toBe("ok");
});
