import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import electronPath from "electron";

const PKG = path.resolve(import.meta.dirname, "..");
const SAMPLE = path.resolve(PKG, "../../samples/alex-example");
const at = (user: string, domain: string) => user + "@" + domain;
const ALEX = at("alex", "example.com");
const TALENT = at("talent", "example.org");
const PASSWORD = "abcd efgh ijkl mnop";
const JOB = "companies/acme-corp/jobs/2026-01-12-ai-engineer";

let app: ElectronApplication | null = null;
let page: Page;
let tmp: string;
let ws: string;
let sentDir: string;
let ipcLog: string;
let env: Record<string, string>;
let server: http.Server;
let hits: string[] = [];
let wsId: string;

function interviewEmail(beacon: string): string {
  return [
    `From: "Acme Talent" <${TALENT}>`, `To: <${ALEX}>`, "Subject: Interview for AI Engineer", "Date: Wed, 14 Jan 2026 09:00:00 +0000",
    `Message-ID: <${at("e2e-interview", "example.org")}>`, "MIME-Version: 1.0", 'Content-Type: multipart/mixed; boundary="outer"', "",
    "--outer", "Content-Type: text/html; charset=utf-8", "",
    [
      "<p>Hi Alex, could you talk on Friday?</p>",
      '<img src="https://images.example.com/p.gif" alt="logo">',
      `<img src="${beacon}/direct-image">`,
      `<script>fetch("${beacon}/script")</script>`,
      `<img src="x" onerror="fetch('${beacon}/onerror')">`,
      `<link rel="stylesheet" href="${beacon}/stylesheet">`,
      `<div style="background:url(${beacon}/css-url)">styled</div>`,
      '<a href="https://jobs.example.com/apply">Apply here</a>',
    ].join(""),
    "--outer", 'Content-Type: application/pdf; name="Interview details.pdf"', 'Content-Disposition: attachment; filename="Interview details.pdf"',
    "Content-Transfer-Encoding: base64", "", Buffer.from("%PDF-1.4 fictional").toString("base64"),
    "--outer--", "",
  ].join("\r\n");
}

function personalEmail(): string {
  return [
    `From: <${at("friend", "example.net")}>`, `To: <${ALEX}>`, "Subject: Dinner on Saturday?", "Date: Wed, 14 Jan 2026 10:00:00 +0000",
    `Message-ID: <${at("e2e-dinner", "example.net")}>`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "", "See you at 7.", "",
  ].join("\r\n");
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  server = http.createServer((req, res) => { hits.push(req.url ?? ""); res.end(); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const beacon = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "careeros-mail-e2e-")));
  ws = path.join(tmp, "CareerOS");
  fs.cpSync(SAMPLE, ws, { recursive: true });
  const companyFile = path.join(ws, "companies", "acme-corp", "company.json");
  const company = JSON.parse(fs.readFileSync(companyFile, "utf8")) as { recruiter: { name: string; email: string } };
  company.recruiter = { name: "Acme Talent", email: TALENT };
  fs.writeFileSync(companyFile, JSON.stringify(company, null, 2) + "\n");

  const yesterday = new Date(Date.now() - 86_400_000).toISOString();
  const fixture = path.join(tmp, "gmail.json");
  fs.writeFileSync(fixture, JSON.stringify({ inbox: [{ raw: interviewEmail(beacon), internalDate: yesterday }, { raw: personalEmail(), internalDate: yesterday }], sent: [] }));
  sentDir = path.join(tmp, "sent");
  ipcLog = path.join(tmp, "ipc.log");
  env = {
    ...(process.env as Record<string, string>),
    CAREEROS_USER_DATA: path.join(tmp, "user-data"), CAREEROS_HOME_OVERRIDE: path.join(tmp, "home"), CAREEROS_E2E_PICK: JSON.stringify([ws]),
    CAREEROS_E2E_MAIL: JSON.stringify({ fixture, sentDir }), CAREEROS_E2E_SECRETS: "memory", CAREEROS_E2E_IPC_LOG: ipcLog,
  };
  app = await electron.launch({ args: [PKG], env });
  page = await app.firstWindow();
  await page.getByRole("button", { name: /Open existing/ }).click();
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
  // Opening gives the workspace its id; the mail log and lock are kept per id.
  wsId = (JSON.parse(fs.readFileSync(path.join(ws, "workspace.json"), "utf8")) as { workspace_id: string }).workspace_id;
  expect(wsId).toMatch(/^[0-9a-f-]{36}$/);
});

test.afterAll(async () => {
  await app?.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tmp, { recursive: true, force: true });
});

const mailLog = (id?: string) => path.join(tmp, "user-data", "logs", id ? `mail-sync-${id}.log` : "mail-sync.log");

const nav = (name: RegExp) => page.getByRole("navigation", { name: "Main" }).getByRole("button", { name });

test("connects Gmail only after a passing test", async () => {
  // Settings > Connections is an accordion; the Email (Gmail) row holds the wizard.
  await nav(/Settings/).click();
  await page.getByRole("tab", { name: "Connections" }).click();
  const row = page.getByRole("button", { name: /^Email \(Gmail\)/ });
  if ((await row.getAttribute("aria-expanded")) !== "true") await row.click();
  const card = page.locator("#conn-email-panel");
  await card.getByLabel("Gmail address").fill(ALEX);
  await card.getByLabel("Your name, as people will see it").fill("Alex Example");
  await card.getByLabel("App password (16 letters)").fill(PASSWORD);
  await expect(card.getByRole("button", { name: "Save & connect" })).toHaveCount(0);
  await card.getByRole("button", { name: "Test connection" }).click();
  await expect(card.getByRole("list", { name: "Connection test" }).getByText("Passed")).toHaveCount(3);
  await expect(card.getByLabel("App password (16 letters)")).toHaveValue("");
  await card.getByRole("button", { name: "Save & connect" }).click();
  await expect(card.getByText(`Connected as ${ALEX}`)).toBeVisible();
});

test("syncs job mail and leaves personal mail out", async () => {
  await nav(/Mail/).click();
  await page.getByRole("button", { name: "Sync now" }).click();
  const list = page.getByRole("list", { name: "Job mail" });
  await expect(list.getByRole("button", { name: /Interview for AI Engineer/ })).toBeVisible();
  await expect(list.getByRole("button", { name: /Dinner on Saturday/ })).toHaveCount(0);
  const stored = fs.readdirSync(path.join(ws, ...JOB.split("/"), "emails")).filter((n) => n.endsWith(".eml"));
  expect(stored).toHaveLength(1);
  expect(JSON.stringify(fs.readdirSync(ws, { recursive: true }))).not.toContain("dinner");
});

test("shows the body in a sandboxed frame that can't run script or reach the network", async () => {
  await page.getByRole("list", { name: "Job mail" }).getByRole("button", { name: /Interview for AI Engineer/ }).click();
  const viewer = page.getByRole("region", { name: "Message" });
  const frameEl = viewer.locator('iframe[title="Email body"]');
  await expect(frameEl).toHaveAttribute("sandbox", "");
  await expect(frameEl).toHaveAttribute("src", /^careeros-mail:\/\/msg\//);
  const frame = page.frameLocator('iframe[title="Email body"]');
  await expect(frame.getByText("Hi Alex, could you talk on Friday?")).toBeVisible();
  await expect(frame.locator("script")).toHaveCount(0);
  await expect(frame.locator("[onerror]")).toHaveCount(0);
  await expect(viewer.getByText("Images are blocked to protect your privacy.")).toBeVisible();
  await viewer.getByRole("button", { name: "Load images" }).click();
  await expect(viewer.getByText("Images are blocked to protect your privacy.")).toHaveCount(0);
  await expect(page.frameLocator('iframe[title="Email body"]').locator('img[src^="careeros-mail://img/"]')).toHaveCount(1);
  await page.waitForTimeout(1000);
  expect(hits).toEqual([]);
});

test("saves an attachment into the job folder only when asked", async () => {
  const dest = path.join(ws, ...JOB.split("/"), "emails", "attachments", "interview-details.pdf");
  expect(fs.existsSync(dest)).toBe(false);
  const chip = page.getByRole("group", { name: "Interview details.pdf" });
  await chip.getByRole("button", { name: "Save to job folder" }).click();
  await expect(chip.getByRole("button", { name: /^Show file/ })).toBeVisible();
  expect(fs.readFileSync(dest, "utf8")).toBe("%PDF-1.4 fictional");
});

test("replies through an approval, and sends exactly once", async () => {
  await page.evaluate(() => { window.location.hash = "#/job/acme-corp/2026-01-12-ai-engineer?tab=mail"; });
  await page.getByRole("list", { name: "Threads" }).getByRole("button", { name: /Interview for AI Engineer/ }).click();
  await page.getByRole("button", { name: "Reply" }).click();
  const editor = page.getByRole("form", { name: "Email draft" });
  await editor.getByLabel("Message").fill("Hi,\n\nFriday works.\n\nRegards,\nAlex");
  await editor.getByRole("button", { name: "Review and send" }).click();
  await expect(page.getByText("The email is waiting in Approvals. Nothing is sent until you approve it.")).toBeVisible();
  expect(fs.existsSync(sentDir)).toBe(false);

  await nav(/Approvals/).click();
  const card = page.getByRole("region", { name: 'Send "Re: Interview for AI Engineer"' });
  await expect(card.getByText("This exact message will be sent.")).toBeVisible();
  await expect(card.getByLabel("Message as sent")).toContainText("Friday works.");
  await card.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByRole("status", { name: "Email sent" })).toContainText("Sent to 1 recipient");

  const sent = fs.readdirSync(sentDir);
  expect(sent).toEqual(["1.eml"]);
  const raw = fs.readFileSync(path.join(sentDir, "1.eml"), "latin1");
  expect(raw).toContain("Friday works.");
  expect(raw).toContain(`In-Reply-To: <${at("e2e-interview", "example.org")}>`);
  expect(raw.split("\r\n\r\n")[0]).not.toMatch(/^bcc:/im);
  const job = JSON.parse(fs.readFileSync(path.join(ws, ...JOB.split("/"), "job.json"), "utf8")) as { timeline: { event: string }[] };
  expect(job.timeline.at(-1)?.event).toBe("Email sent");
});

test("the app password never comes back to the renderer", async () => {
  const log = fs.readFileSync(ipcLog, "utf8");
  expect(log.split("\n").filter(Boolean).length).toBeGreaterThan(10);
  expect(log).toContain('"method":"mail.testConnection"');
  for (const secret of [PASSWORD, PASSWORD.replace(/\s+/g, "")]) expect(log).not.toContain(secret);
  const log2 = fs.readFileSync(mailLog(wsId), "utf8");
  expect(log2.trim().length).toBeGreaterThan(0);
  expect(log2).not.toContain(ALEX);
  expect(log2).not.toContain(PASSWORD.replace(/\s+/g, ""));
});

test("the background entry point runs without a window and logs one line", async () => {
  await app?.close();
  app = null;
  const r = spawnSync(electronPath as unknown as string, [PKG, "--background-sync", "--workspace", ws], { env, timeout: 60_000 });
  expect(r.status).toBe(0);
  const lines = fs.readFileSync(mailLog(wsId), "utf8").trim().split("\n");
  expect(lines.at(-1)).toMatch(/Background sync is off\. Nothing to do\.$/);
});
