# CareerOS Workspace Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@careeros/core`: a TypeScript library and `careeros` CLI that create, read, write, validate, index, migrate and import CareerOS candidate workspaces, plus the privacy guard that keeps personal data out of the product repo, plus the one-click setup pattern (component manifests, runner, double-click installer) that every later dependency plugs into.

**Architecture:** Files are the source of truth (JSON records + markdown), validated against JSON Schemas that allow unknown fields. Every write goes through one store module (validate, temp file, rename). A generated SQLite index (`node:sqlite`, no native build) serves fast reads for the future UI. A thin CLI exposes every operation to Claude Code, shell and Python.

**Tech Stack:** Node.js 22.13+, TypeScript 5 (NodeNext ESM), Ajv 8 (JSON Schema 2020-12), `node:sqlite`, Vitest 3, tsx. Git hooks in plain shell + Node. GitHub Actions + gitleaks (Docker image).

**Spec:** `docs/specs/2026-10-08-workspace-design.md` (approved) and `docs/dependencies.md`.

## Global Constraints

- Node `>=22.13` (built-in `node:sqlite` without a flag). No native npm modules.
- Workspace and product repo are separate folders, never nested.
- Folder and file names: lowercase ASCII, hyphens, no spaces, produced only by `slugify()`.
- Records: JSON, UTF-8, 2-space indent, trailing newline, each with `schema` (integer) and `custom` (object).
- Schemas allow unknown properties; rewrites preserve unknown fields.
- Work-rights labels: `sponsorship_offered` | `visa_ok` | `silent` | `citizen_pr_only` | `clearance`.
- Candidate work-rights status: `citizen` | `pr` | `full_visa` | `limited_visa` | `needs_sponsorship` | `unknown`.
- Job statuses: Found | Saved | Applying | Applied | Interview | Offer | Rejected | Skipped.
- Job sources: `ats` | `adzuna` | `browser` | `pasted`.
- Locked folders: `me/identity`, `me/employment` (Claude read/edit denied in generated workspace settings).
- Generated workspace `.claude/settings.json` declares no third-party plugins (own-skills rule).
- No real personal data anywhere in this repo. Samples use only: name "Alex Example", employers "Acme Corp" / "Example Labs" / "Acme Recruiting", email `alex@example.com`, phone `0491 570 006`, address "1 Example Street, Sampletown NSW 2000".
- Tests must never contain real-looking emails or phones as literals; build them by concatenation (`"someone" + "@" + "gmail.com"`).
- One-click setup: every dependency is one `setup/components/<id>.json` file plus a row in `docs/dependencies.md`. Setup is idempotent (check first, install only what is missing). Never add a dependency any other way.

## Review Focus

1. Company names with punctuation, accents, emoji or only symbols ("Café & Co", "🚀", "(client X)"): slug must be stable and non-empty, and the client split out. Pinned in Task 2.
2. A hand-edited job.json with a trailing comma: `validate` lists that file, `index` skips it and still indexes the rest, nothing crashes. Pinned in Tasks 8 and 9.
3. A crash between writing the temp file and renaming it: the original record is intact and no `.tmp` file remains. Pinned in Task 4.
4. Path traversal through an inbox file name or a company/job id (`../../etc/passwd`): rejected with an error. Pinned in Tasks 6 and 11.
5. Re-running the legacy import, and adding the same job URL with tracking parameters: no duplicate jobs or files. Pinned in Tasks 6 and 12.
6. Re-running setup on a machine that already has everything: nothing is reinstalled, and a failed optional component never blocks the rest. Pinned in Task 17.

---

## File map

```
package.json                       root: npm workspaces, scripts, dev deps
vitest.config.ts                   test discovery
README.md, CLAUDE.md               repo guide (dev rules, privacy rules)
packages/core/
  package.json, tsconfig.json
  schemas/*.schema.json            workspace, profile, company, job, search, integrations, sponsors
  src/version.ts                   PRODUCT_VERSION
  src/types.ts                     enums + record interfaces
  src/paths.ts                     slugify, splitClient, layout(), insideRoot, assertSegment
  src/schema.ts                    Ajv load, check(), defaults()
  src/fields.ts                    fieldsFor(kind): UI field definitions from x-ui
  src/store.ts                     readJson, readRecord, writeRecord, updateRecord, writeFileAtomic
  src/clock.ts                     Clock type + iso()
  src/migrations/index.ts          Migration interface, MIGRATIONS, LATEST_DATA_VERSION
  src/workspace.ts                 initWorkspace, isWorkspace, claudeSettings, claudeMd
  src/jobs.ts                      ensureCompany, newJob, findJobByUrl, addEvent, setStatus, attachFile, listJobs
  src/eligibility.ts               isEligible, pinRank
  src/knowledge.ts                 appendSearch, readSearches, ranRecently
  src/index-db.ts                  buildIndex, openIndex
  src/validate.ts                  validateWorkspace
  src/migrate.ts                   pendingMigrations, migrate
  src/inbox.ts                     listInbox, fileInboxItem
  src/legacy.ts                    importLegacy
  src/sample-pdf.ts                samplePdf
  src/cli.ts                       run(argv) + main
  src/index.ts                     public exports
  scripts/make-samples.ts          builds samples/alex-example
  test/*.test.ts                   unit tests
samples/alex-example/              committed fictional workspace
scripts/privacy/rules.mjs          scan rules
scripts/privacy/scan.mjs           scan CLI (--staged, --range, --all, --history)
tests/privacy.test.ts              rules tests
.githooks/pre-commit, pre-push
.github/workflows/checks.yml
setup.sh                           one-click bootstrap (Homebrew, Node, npm ci, runner)
Setup CareerOS.command             double-click wrapper for setup.sh (macOS)
setup/components/*.json            one manifest per dependency
scripts/setup/lib.mjs              load + validate components, run checks/installs
scripts/setup/run.mjs              CLI: install | doctor [--only id] [--json] [--dry-run]
tests/setup.test.ts                runner + manifest tests
```

---

### Task 1: Repo scaffold

**Files:**
- Create: `package.json`, `vitest.config.ts`, `README.md`, `CLAUDE.md`, `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/version.ts`, `packages/core/src/index.ts`, `packages/core/test/helpers.ts`, `packages/core/test/smoke.test.ts`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `PRODUCT_VERSION: string` from `src/version.ts`; test helpers `tmpDir(prefix?: string): string`, `FIXED: Date`.

- [ ] **Step 1: Write root `package.json`**

```json
{
  "name": "careeros",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*"],
  "engines": { "node": ">=22.13" },
  "scripts": {
    "prepare": "git config core.hooksPath .githooks || true",
    "typecheck": "tsc -p packages/core/tsconfig.json --noEmit",
    "test": "vitest run",
    "build": "npm run build -w @careeros/core",
    "careeros": "tsx packages/core/src/cli.ts",
    "samples": "tsx packages/core/scripts/make-samples.ts",
    "scan": "node scripts/privacy/scan.mjs --all"
  },
  "devDependencies": {
    "@types/node": "^22.13.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 2: Write `packages/core/package.json` and `packages/core/tsconfig.json`**

```json
{
  "name": "@careeros/core",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "bin": { "careeros": "dist/cli.js" },
  "files": ["dist", "schemas"],
  "scripts": { "build": "tsc -p tsconfig.json" },
  "dependencies": { "ajv": "^8.17.0", "ajv-formats": "^3.0.1" }
}
```

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "skipLibCheck": true,
    "esModuleInterop": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Write `vitest.config.ts`, `src/version.ts`, `src/index.ts`, test helpers**

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["packages/*/test/**/*.test.ts", "tests/**/*.test.ts"], environment: "node" },
});
```

```ts
// packages/core/src/version.ts
export const PRODUCT_VERSION = "0.1.0";
```

```ts
// packages/core/src/index.ts
export * from "./version.js";
```

```ts
// packages/core/test/helpers.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
export function tmpDir(prefix = "careeros-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
export const FIXED = new Date("2026-01-15T09:30:00.000Z");
```

- [ ] **Step 4: Write the smoke test**

```ts
// packages/core/test/smoke.test.ts
import { describe, expect, it } from "vitest";
import { PRODUCT_VERSION } from "../src/index.js";
describe("package", () => {
  it("exposes a semver version", () => {
    expect(PRODUCT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
```

- [ ] **Step 5: Append to `.gitignore`**

```
dist/
coverage/
samples/*/.index/
samples/*/settings/.env
```

- [ ] **Step 6: Write `README.md` and `CLAUDE.md`**

`README.md`:

```markdown
# CareerOS

Local-first job-hunt assistant. Runs on the candidate's laptop with Claude Code.

- Spec: docs/specs/2026-10-08-workspace-design.md
- Dependencies and the own-skills rule: docs/dependencies.md
- Dev: `npm install`, `npm test`, `npm run typecheck`, `npm run careeros -- --help`
- Sample workspace (fictional): samples/alex-example
```

`CLAUDE.md`:

```markdown
# CareerOS repo guide

- Never commit real personal data. Samples use only Alex Example, Acme Corp, Example Labs,
  Acme Recruiting, alex@example.com, 0491 570 006, 1 Example Street, Sampletown NSW 2000.
- In tests, build email/phone strings by concatenation so the privacy scan stays meaningful.
- All record writes go through packages/core/src/store.ts. Never hand-roll fs writes of records.
- Add every new tool, model or copied skill to docs/dependencies.md (and NOTICE.md if copied).
- Run `npm run typecheck && npm test` before every commit. The pre-commit hook runs the privacy scan.
```

- [ ] **Step 7: Install and run**

Run: `npm install && npm test && npm run typecheck`
Expected: 1 test passes; typecheck exits 0.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: scaffold careeros monorepo with @careeros/core"
```

---

### Task 2: Paths and slugs

**Files:**
- Create: `packages/core/src/paths.ts`, `packages/core/test/paths.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces:
  - `slugify(input: string, fallback?: string): string`
  - `splitClient(name: string): { company: string; client: string | null }`
  - `ME_DIRS` (`readonly ["resumes","history","identity","employment","education","projects"]`), `type MeDir`
  - `LOCKED_DIRS` (`readonly ["me/identity","me/employment"]`)
  - `layout(root: string)` returning `{ root, workspaceFile, profile, search, integrations, env, inbox, companiesDir, learning, sponsors, searchLog, indexDb, backupDir, me(d: MeDir): string, companyDir(slug): string, companyFile(slug): string, jobsDir(slug): string, jobDir(slug, id): string, jobFile(slug, id): string }`
  - `insideRoot(root: string, p: string): boolean`
  - `assertSegment(s: string, what: string): void` (throws on `/`, `\`, `..`, empty)

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/test/paths.test.ts
import { describe, expect, it } from "vitest";
import path from "node:path";
import { assertSegment, insideRoot, layout, slugify, splitClient } from "../src/paths.js";

describe("slugify", () => {
  it("lowercases, strips accents, turns & into and", () => {
    expect(slugify("Café & Co")).toBe("cafe-and-co");
  });
  it("collapses punctuation and trims hyphens", () => {
    expect(slugify("  AI Engineer -- (Senior)!! ")).toBe("ai-engineer-senior");
  });
  it("falls back when nothing usable is left", () => {
    expect(slugify("🚀🚀", "company")).toBe("company");
    expect(slugify("", "job")).toBe("job");
  });
  it("caps length at 60 without a trailing hyphen", () => {
    const s = slugify("word ".repeat(40));
    expect(s.length).toBeLessThanOrEqual(60);
    expect(s.endsWith("-")).toBe(false);
  });
  it("is stable", () => {
    expect(slugify("Example Labs")).toBe(slugify("example   labs"));
  });
});

describe("splitClient", () => {
  it("splits a recruiter name with a client in brackets", () => {
    expect(splitClient("Acme Recruiting (client Example University)")).toEqual({
      company: "Acme Recruiting", client: "Example University",
    });
    expect(splitClient("Acme Recruiting (client: Example University)").client).toBe("Example University");
  });
  it("keeps plain names", () => {
    expect(splitClient("Acme Corp")).toEqual({ company: "Acme Corp", client: null });
  });
  it("does not split when the name is only brackets", () => {
    expect(splitClient("(client X)")).toEqual({ company: "(client X)", client: null });
  });
});

describe("layout and guards", () => {
  it("builds job paths under companies/<slug>/jobs/<id>", () => {
    const L = layout("/w");
    expect(L.jobFile("acme-corp", "2026-01-15-ai-engineer")).toBe(
      path.join("/w", "companies", "acme-corp", "jobs", "2026-01-15-ai-engineer", "job.json"));
    expect(L.me("resumes")).toBe(path.join("/w", "me", "resumes"));
  });
  it("detects paths outside the root", () => {
    expect(insideRoot("/w", "/w/a/b")).toBe(true);
    expect(insideRoot("/w", "/w")).toBe(true);
    expect(insideRoot("/w", "/w/../etc")).toBe(false);
    expect(insideRoot("/w", "/wx/a")).toBe(false);
  });
  it("rejects unsafe path segments", () => {
    for (const bad of ["../x", "a/b", "a\\b", "..", ""]) {
      expect(() => assertSegment(bad, "id")).toThrow(/unsafe id/);
    }
    expect(() => assertSegment("2026-01-15-ai-engineer", "id")).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/core/test/paths.test.ts`
Expected: FAIL, cannot resolve `../src/paths.js`.

- [ ] **Step 3: Implement `src/paths.ts`**

```ts
import path from "node:path";

export const ME_DIRS = ["resumes", "history", "identity", "employment", "education", "projects"] as const;
export type MeDir = (typeof ME_DIRS)[number];
export const LOCKED_DIRS = ["me/identity", "me/employment"] as const;

export function slugify(input: string, fallback = "item"): string {
  const s = input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return s || fallback;
}

export function splitClient(name: string): { company: string; client: string | null } {
  const m = name.match(/^(.*?)\s*\((?:client:?\s*)?([^)]*)\)\s*$/i);
  if (m && m[1] && m[1].trim()) {
    const client = (m[2] ?? "").trim();
    return { company: m[1].trim(), client: client || null };
  }
  return { company: name.trim(), client: null };
}

export function insideRoot(root: string, p: string): boolean {
  const r = path.resolve(root);
  const t = path.resolve(p);
  return t === r || t.startsWith(r + path.sep);
}

export function assertSegment(s: string, what: string): void {
  if (!s || s === "." || s === ".." || s.includes("/") || s.includes("\\") || s.includes("..")) {
    throw new Error(`unsafe ${what}: "${s}"`);
  }
}

export function layout(root: string) {
  const j = (...p: string[]) => path.join(root, ...p);
  return {
    root,
    workspaceFile: j("workspace.json"),
    profile: j("settings", "profile.json"),
    search: j("settings", "search.json"),
    integrations: j("settings", "integrations.json"),
    env: j("settings", ".env"),
    inbox: j("inbox"),
    companiesDir: j("companies"),
    learning: j("learning"),
    sponsors: j("knowledge", "sponsors.json"),
    searchLog: j("knowledge", "search-log.jsonl"),
    indexDb: j(".index", "careeros.sqlite"),
    backupDir: j(".backup"),
    me: (d: MeDir) => j("me", d),
    companyDir: (slug: string) => j("companies", slug),
    companyFile: (slug: string) => j("companies", slug, "company.json"),
    jobsDir: (slug: string) => j("companies", slug, "jobs"),
    jobDir: (slug: string, id: string) => j("companies", slug, "jobs", id),
    jobFile: (slug: string, id: string) => j("companies", slug, "jobs", id, "job.json"),
  };
}
export type Layout = ReturnType<typeof layout>;
```

Add to `src/index.ts`: `export * from "./paths.js";`

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run packages/core/test/paths.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/paths.ts packages/core/src/index.ts packages/core/test/paths.test.ts
git commit -m "feat(core): slugs, client split, workspace layout and path guards"
```

---

### Task 3: Types, schemas, schema checker and UI field definitions

**Files:**
- Create: `packages/core/src/types.ts`, `packages/core/src/schema.ts`, `packages/core/src/fields.ts`, `packages/core/schemas/{workspace,profile,company,job,search,integrations,sponsors}.schema.json`, `packages/core/test/schema.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces:
  - Constants `JOB_STATUSES`, `WR_LABELS`, `WR_STATUSES`, `JOB_SOURCES`, `KINDS`, `CURRENT_SCHEMA = 1`; types `JobStatus`, `WorkRightsLabel`, `WorkRightsStatus`, `JobSource`, `Kind`, `KindMap`, `Job`, `Company`, `Profile`, `WorkspaceMeta`, `SearchSettings`, `Integrations`, `Sponsors`, `TimelineEvent`, `FileRef`.
  - `check<K extends Kind>(kind: K, data: unknown): { ok: boolean; value: KindMap[K]; problems: string[] }` (fills defaults on a copy; never mutates input)
  - `defaults<K extends Kind>(kind: K, seed: Record<string, unknown>): KindMap[K]` (throws if seed invalid)
  - `loadSchema(kind: Kind): Record<string, unknown>`
  - `fieldsFor(kind: Kind): FieldDef[]` where `FieldDef = { path: string; label: string; type: string; options: string[]; help: string }`

- [ ] **Step 1: Write `src/types.ts`**

```ts
export const JOB_STATUSES = ["Found", "Saved", "Applying", "Applied", "Interview", "Offer", "Rejected", "Skipped"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const WR_LABELS = ["sponsorship_offered", "visa_ok", "silent", "citizen_pr_only", "clearance"] as const;
export type WorkRightsLabel = (typeof WR_LABELS)[number];
export const WR_STATUSES = ["citizen", "pr", "full_visa", "limited_visa", "needs_sponsorship", "unknown"] as const;
export type WorkRightsStatus = (typeof WR_STATUSES)[number];
export const JOB_SOURCES = ["ats", "adzuna", "browser", "pasted"] as const;
export type JobSource = (typeof JOB_SOURCES)[number];
export const CURRENT_SCHEMA = 1;

type Extra = { [key: string]: unknown };
export interface TimelineEvent extends Extra { at: string; event: string; note: string }
export interface FileRef extends Extra { path: string; label: string; at: string }

export interface Job extends Extra {
  schema: number; id: string; company_slug: string; client: string | null; title: string;
  source: JobSource; source_site: string; url: string; apply_via: string; posted: string; found_at: string;
  location: string; work_mode: string; job_type: string;
  salary: { min: number | null; max: number | null; currency: string; period: string; text: string } & Extra;
  work_rights: { label: WorkRightsLabel; quotes: string[]; decided_by: "none" | "scan" | "claude" | "user" } & Extra;
  scores: {
    fit: { value: number | null; must_haves: unknown[]; nice_to_haves: unknown[] } & Extra;
    sponsor: { value: number | null; tier: string; reasons: string[] } & Extra;
    career: { match: number | null; odds: number | null; tier: string; scored_at: string } & Extra;
  } & Extra;
  status: JobStatus; timeline: TimelineEvent[]; files: FileRef[]; custom: Record<string, unknown>;
}
export interface SponsorEvidence extends Extra { date: string; note: string; url: string }
export interface Company extends Extra {
  schema: number; name: string; slug: string; aliases: string[]; website: string; size: string;
  type: "employer" | "recruiter" | "consultancy" | "government" | "unknown"; big_tech: boolean;
  sponsor: { status: "verified" | "to_verify" | "checked_none" | "sanctioned" | "unknown"; evidence: SponsorEvidence[]; last_checked: string } & Extra;
  custom: Record<string, unknown>;
}
export interface Profile extends Extra {
  schema: number;
  contact: { name: string; email: string; phone: string; city: string; links: string[] } & Extra;
  work_rights: { status: WorkRightsStatus; visa_subclass: string; visa_expiry: string; notes: string } & Extra;
  targets: { roles: string[]; keywords: string[]; seniority: string; job_types: string[] } & Extra;
  locations: ({ place: string; modes: ("onsite" | "hybrid" | "remote")[]; will_relocate: boolean } & Extra)[];
  salary: { min: number | null; currency: string; includes_super: boolean } & Extra;
  industries: { include: string[]; exclude: string[] } & Extra;
  skip_companies: string[]; skip_big_tech: boolean; custom: Record<string, unknown>;
}
export interface WorkspaceMeta extends Extra { schema: number; data_version: number; product_version: string; created_at: string; custom: Record<string, unknown> }
export interface SearchSettings extends Extra { schema: number; filters: Record<string, unknown>; sources: Record<string, boolean>; sweep: { every_hours: number | null } & Extra; custom: Record<string, unknown> }
export interface Integrations extends Extra {
  schema: number;
  email: { method: "none" | "smtp" | "gmail_connector"; address: string } & Extra;
  chrome: { profile: string; port: number } & Extra;
  voice: { engine: "supertonic" | "macos_say" | "elevenlabs"; voice: string; lang: string; expressions: boolean; per_type: { guide: string; interview: string; slides: string } & Extra } & Extra;
  custom: Record<string, unknown>;
}
export interface Sponsors extends Extra { schema: number; employers: Extra[]; custom: Record<string, unknown> }

export interface KindMap {
  workspace: WorkspaceMeta; profile: Profile; company: Company; job: Job;
  search: SearchSettings; integrations: Integrations; sponsors: Sponsors;
}
export type Kind = keyof KindMap;
export const KINDS: Kind[] = ["workspace", "profile", "company", "job", "search", "integrations", "sponsors"];
```

- [ ] **Step 2: Write the schemas**

Every schema: draft 2020-12, `type: object`, no `additionalProperties: false`. `x-ui` holds UI metadata (`label`, `help`, `options` labels). Defaults make additive fields safe.

`packages/core/schemas/workspace.schema.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "careeros/workspace",
  "type": "object",
  "required": ["schema"],
  "properties": {
    "schema": { "type": "integer", "minimum": 1 },
    "data_version": { "type": "integer", "minimum": 0, "default": 0 },
    "product_version": { "type": "string", "default": "" },
    "created_at": { "type": "string", "default": "" },
    "custom": { "type": "object", "default": {} }
  }
}
```

`packages/core/schemas/profile.schema.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "careeros/profile",
  "type": "object",
  "required": ["schema"],
  "properties": {
    "schema": { "type": "integer", "minimum": 1 },
    "contact": {
      "type": "object", "default": {},
      "properties": {
        "name": { "type": "string", "default": "", "x-ui": { "label": "Full name" } },
        "email": { "type": "string", "default": "", "x-ui": { "label": "Email for applications" } },
        "phone": { "type": "string", "default": "", "x-ui": { "label": "Phone" } },
        "city": { "type": "string", "default": "", "x-ui": { "label": "City" } },
        "links": { "type": "array", "items": { "type": "string" }, "default": [], "x-ui": { "label": "Links (LinkedIn, GitHub, portfolio)" } }
      }
    },
    "work_rights": {
      "type": "object", "default": {},
      "properties": {
        "status": {
          "enum": ["citizen", "pr", "full_visa", "limited_visa", "needs_sponsorship", "unknown"], "default": "unknown",
          "x-ui": { "label": "Work rights", "help": "Used to hide jobs you can't apply for and rank sponsors first.",
            "options": { "citizen": "Citizen", "pr": "Permanent resident", "full_visa": "Visa with full work rights", "limited_visa": "Visa with limited work rights", "needs_sponsorship": "Need visa sponsorship", "unknown": "Not set" } }
        },
        "visa_subclass": { "type": "string", "default": "", "x-ui": { "label": "Visa subclass" } },
        "visa_expiry": { "type": "string", "pattern": "^(\\d{4}-\\d{2}-\\d{2})?$", "default": "", "x-ui": { "label": "Visa expiry (YYYY-MM-DD)" } },
        "notes": { "type": "string", "default": "", "x-ui": { "label": "Notes" } }
      }
    },
    "targets": {
      "type": "object", "default": {},
      "properties": {
        "roles": { "type": "array", "items": { "type": "string" }, "default": [], "x-ui": { "label": "Target roles" } },
        "keywords": { "type": "array", "items": { "type": "string" }, "default": [], "x-ui": { "label": "Keywords" } },
        "seniority": { "type": "string", "default": "", "x-ui": { "label": "Seniority" } },
        "job_types": {
          "type": "array", "default": ["full_time"],
          "items": { "enum": ["full_time", "contract", "part_time", "casual", "internship"] },
          "x-ui": { "label": "Job types" }
        }
      }
    },
    "locations": {
      "type": "array", "default": [],
      "x-ui": { "label": "Preferred locations (first = most preferred)" },
      "items": {
        "type": "object", "required": ["place"],
        "properties": {
          "place": { "type": "string", "minLength": 1 },
          "modes": { "type": "array", "items": { "enum": ["onsite", "hybrid", "remote"] }, "default": ["onsite", "hybrid", "remote"] },
          "will_relocate": { "type": "boolean", "default": false }
        }
      }
    },
    "salary": {
      "type": "object", "default": {},
      "properties": {
        "min": { "type": ["number", "null"], "minimum": 0, "default": null, "x-ui": { "label": "Minimum salary" } },
        "currency": { "type": "string", "default": "AUD", "x-ui": { "label": "Currency" } },
        "includes_super": { "type": "boolean", "default": true, "x-ui": { "label": "Includes super" } }
      }
    },
    "industries": {
      "type": "object", "default": {},
      "properties": {
        "include": { "type": "array", "items": { "type": "string" }, "default": [], "x-ui": { "label": "Industries to include" } },
        "exclude": { "type": "array", "items": { "type": "string" }, "default": [], "x-ui": { "label": "Industries to exclude" } }
      }
    },
    "skip_companies": { "type": "array", "items": { "type": "string" }, "default": [], "x-ui": { "label": "Companies to skip" } },
    "skip_big_tech": { "type": "boolean", "default": false, "x-ui": { "label": "Skip big tech" } },
    "custom": { "type": "object", "default": {} }
  }
}
```

`packages/core/schemas/company.schema.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "careeros/company",
  "type": "object",
  "required": ["schema", "name", "slug"],
  "properties": {
    "schema": { "type": "integer", "minimum": 1 },
    "name": { "type": "string", "minLength": 1, "x-ui": { "label": "Company" } },
    "slug": { "type": "string", "pattern": "^[a-z0-9]+(-[a-z0-9]+)*$" },
    "aliases": { "type": "array", "items": { "type": "string" }, "default": [] },
    "website": { "type": "string", "default": "", "x-ui": { "label": "Website" } },
    "size": { "type": "string", "default": "", "x-ui": { "label": "Size" } },
    "type": { "enum": ["employer", "recruiter", "consultancy", "government", "unknown"], "default": "unknown", "x-ui": { "label": "Type" } },
    "big_tech": { "type": "boolean", "default": false },
    "sponsor": {
      "type": "object", "default": {},
      "properties": {
        "status": { "enum": ["verified", "to_verify", "checked_none", "sanctioned", "unknown"], "default": "unknown", "x-ui": { "label": "Sponsor status" } },
        "evidence": {
          "type": "array", "default": [],
          "items": { "type": "object", "required": ["date", "note"], "properties": { "date": { "type": "string" }, "note": { "type": "string" }, "url": { "type": "string", "default": "" } } }
        },
        "last_checked": { "type": "string", "default": "" }
      }
    },
    "custom": { "type": "object", "default": {} }
  }
}
```

`packages/core/schemas/job.schema.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "careeros/job",
  "type": "object",
  "required": ["schema", "id", "company_slug", "title"],
  "properties": {
    "schema": { "type": "integer", "minimum": 1 },
    "id": { "type": "string", "pattern": "^[a-z0-9]+(-[a-z0-9]+)*$" },
    "company_slug": { "type": "string", "pattern": "^[a-z0-9]+(-[a-z0-9]+)*$" },
    "client": { "type": ["string", "null"], "default": null, "x-ui": { "label": "Client (via recruiter)" } },
    "title": { "type": "string", "minLength": 1, "x-ui": { "label": "Role" } },
    "source": { "enum": ["ats", "adzuna", "browser", "pasted"], "default": "pasted" },
    "source_site": { "type": "string", "default": "", "x-ui": { "label": "Found on" } },
    "url": { "type": "string", "default": "", "x-ui": { "label": "Job ad" } },
    "apply_via": { "type": "string", "default": "", "x-ui": { "label": "Apply via" } },
    "posted": { "type": "string", "default": "", "x-ui": { "label": "Posted" } },
    "found_at": { "type": "string", "default": "" },
    "location": { "type": "string", "default": "", "x-ui": { "label": "Location" } },
    "work_mode": { "type": "string", "default": "", "x-ui": { "label": "Work mode" } },
    "job_type": { "type": "string", "default": "", "x-ui": { "label": "Job type" } },
    "salary": {
      "type": "object", "default": {},
      "properties": {
        "min": { "type": ["number", "null"], "default": null },
        "max": { "type": ["number", "null"], "default": null },
        "currency": { "type": "string", "default": "" },
        "period": { "type": "string", "default": "" },
        "text": { "type": "string", "default": "", "x-ui": { "label": "Salary" } }
      }
    },
    "work_rights": {
      "type": "object", "default": {},
      "properties": {
        "label": {
          "enum": ["sponsorship_offered", "visa_ok", "silent", "citizen_pr_only", "clearance"], "default": "silent",
          "x-ui": { "label": "Work rights in the ad", "options": { "sponsorship_offered": "Sponsorship offered", "visa_ok": "Open to visa holders", "silent": "Not mentioned", "citizen_pr_only": "Citizens/PR only", "clearance": "Security clearance" } }
        },
        "quotes": { "type": "array", "items": { "type": "string" }, "default": [] },
        "decided_by": { "enum": ["none", "scan", "claude", "user"], "default": "none" }
      }
    },
    "scores": {
      "type": "object", "default": {},
      "properties": {
        "fit": { "type": "object", "default": {}, "properties": { "value": { "type": ["number", "null"], "default": null }, "must_haves": { "type": "array", "default": [] }, "nice_to_haves": { "type": "array", "default": [] } } },
        "sponsor": { "type": "object", "default": {}, "properties": { "value": { "type": ["number", "null"], "default": null }, "tier": { "type": "string", "default": "" }, "reasons": { "type": "array", "items": { "type": "string" }, "default": [] } } },
        "career": { "type": "object", "default": {}, "properties": { "match": { "type": ["number", "null"], "default": null }, "odds": { "type": ["number", "null"], "default": null }, "tier": { "type": "string", "default": "" }, "scored_at": { "type": "string", "default": "" } } }
      }
    },
    "status": { "enum": ["Found", "Saved", "Applying", "Applied", "Interview", "Offer", "Rejected", "Skipped"], "default": "Found", "x-ui": { "label": "Status" } },
    "timeline": {
      "type": "array", "default": [],
      "items": { "type": "object", "required": ["at", "event"], "properties": { "at": { "type": "string" }, "event": { "type": "string" }, "note": { "type": "string", "default": "" } } }
    },
    "files": {
      "type": "array", "default": [],
      "items": { "type": "object", "required": ["path"], "properties": { "path": { "type": "string" }, "label": { "type": "string", "default": "" }, "at": { "type": "string", "default": "" } } }
    },
    "custom": { "type": "object", "default": {} }
  }
}
```

`packages/core/schemas/search.schema.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "careeros/search",
  "type": "object",
  "required": ["schema"],
  "properties": {
    "schema": { "type": "integer", "minimum": 1 },
    "filters": { "type": "object", "default": {} },
    "sources": { "type": "object", "default": { "ats": true, "adzuna": false, "browser": true, "pasted": true }, "additionalProperties": { "type": "boolean" } },
    "sweep": { "type": "object", "default": {}, "properties": { "every_hours": { "type": ["number", "null"], "default": null } } },
    "custom": { "type": "object", "default": {} }
  }
}
```

`packages/core/schemas/integrations.schema.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "careeros/integrations",
  "type": "object",
  "required": ["schema"],
  "properties": {
    "schema": { "type": "integer", "minimum": 1 },
    "email": { "type": "object", "default": {}, "properties": { "method": { "enum": ["none", "smtp", "gmail_connector"], "default": "none" }, "address": { "type": "string", "default": "" } } },
    "chrome": { "type": "object", "default": {}, "properties": { "profile": { "type": "string", "default": "" }, "port": { "type": "integer", "default": 9222 } } },
    "voice": {
      "type": "object", "default": {},
      "x-ui": { "label": "Video narration", "help": "Voice used for learning guides and interview videos. Use Preview to listen before choosing." },
      "properties": {
        "engine": { "enum": ["supertonic", "macos_say", "elevenlabs"], "default": "supertonic",
          "x-ui": { "label": "Voice engine", "options": { "supertonic": "Supertonic (on your Mac, free)", "macos_say": "Mac built-in voice", "elevenlabs": "ElevenLabs (needs your API key)" } } },
        "voice": { "enum": ["F4", "M3", "F1", "F2", "F3", "F5", "M1", "M2", "M4", "M5"], "default": "F4", "x-ui": { "label": "Voice", "help": "Recommended: F4 (female) or M3 (male), the most natural-sounding Supertonic voices." } },
        "lang": { "type": "string", "default": "en", "x-ui": { "label": "Language" } },
        "expressions": { "type": "boolean", "default": true, "x-ui": { "label": "Natural expressions (breaths, light laughs)" } },
        "per_type": {
          "type": "object", "default": {},
          "properties": {
            "guide": { "type": "string", "default": "", "x-ui": { "label": "Voice for learning guides (blank = default)" } },
            "interview": { "type": "string", "default": "", "x-ui": { "label": "Voice for interview prep (blank = default)" } },
            "slides": { "type": "string", "default": "", "x-ui": { "label": "Voice for slide recaps (blank = default)" } }
          }
        }
      }
    },
    "custom": { "type": "object", "default": {} }
  }
}
```

`packages/core/schemas/sponsors.schema.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "careeros/sponsors",
  "type": "object",
  "required": ["schema"],
  "properties": {
    "schema": { "type": "integer", "minimum": 1 },
    "employers": { "type": "array", "items": { "type": "object", "required": ["name"] }, "default": [] },
    "custom": { "type": "object", "default": {} }
  }
}
```

- [ ] **Step 3: Write the failing tests**

```ts
// packages/core/test/schema.test.ts
import { describe, expect, it } from "vitest";
import { check, defaults } from "../src/schema.js";
import { fieldsFor } from "../src/fields.js";

describe("schema check", () => {
  it("fills defaults for a minimal job without mutating the input", () => {
    const input = { schema: 1, id: "2026-01-15-ai-engineer", company_slug: "acme-corp", title: "AI Engineer" };
    const r = check("job", input);
    expect(r.ok).toBe(true);
    expect(r.value.status).toBe("Found");
    expect(r.value.work_rights.label).toBe("silent");
    expect(r.value.scores.career.match).toBeNull();
    expect(r.value.custom).toEqual({});
    expect(input).not.toHaveProperty("status");
  });
  it("keeps unknown fields", () => {
    const r = check("job", { schema: 1, id: "x", company_slug: "y", title: "T", referee_called: true, salary: { bonus: "10%" } });
    expect(r.ok).toBe(true);
    expect(r.value.referee_called).toBe(true);
    expect(r.value.salary.bonus).toBe("10%");
  });
  it("reports bad enum values with the field path", () => {
    const r = check("job", { schema: 1, id: "x", company_slug: "y", title: "T", status: "Ghosted" });
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toContain("/status");
  });
  it("rejects unsafe ids", () => {
    expect(check("job", { schema: 1, id: "../x", company_slug: "y", title: "T" }).ok).toBe(false);
  });
  it("builds full defaults from a seed", () => {
    const p = defaults("profile", { contact: { name: "Alex Example" } });
    expect(p.contact.name).toBe("Alex Example");
    expect(p.contact.email).toBe("");
    expect(p.work_rights.status).toBe("unknown");
    expect(p.targets.job_types).toEqual(["full_time"]);
  });
  it("throws on an invalid seed", () => {
    expect(() => defaults("company", { name: "", slug: "acme" })).toThrow(/bad seed/);
  });
});

describe("fieldsFor", () => {
  it("lists labelled profile fields with options", () => {
    const f = fieldsFor("profile");
    const wr = f.find((x) => x.path === "work_rights.status");
    expect(wr?.label).toBe("Work rights");
    expect(wr?.options).toContain("needs_sponsorship");
    expect(f.some((x) => x.path === "contact.name")).toBe(true);
  });
});
```

- [ ] **Step 4: Run to verify failure**

Run: `npx vitest run packages/core/test/schema.test.ts`
Expected: FAIL, cannot resolve `../src/schema.js`.

- [ ] **Step 5: Implement `src/schema.ts` and `src/fields.ts`**

```ts
// packages/core/src/schema.ts
import fs from "node:fs";
import { createRequire } from "node:module";
import { KINDS, type Kind, type KindMap } from "./types.js";

const require = createRequire(import.meta.url);
// CommonJS packages loaded through require to avoid ESM default-export interop issues.
const Ajv2020 = require("ajv/dist/2020") as typeof import("ajv/dist/2020.js").default;
const addFormats = require("ajv-formats") as typeof import("ajv-formats").default;

const SCHEMA_DIR = new URL("../schemas/", import.meta.url);

export function loadSchema(kind: Kind): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(new URL(`${kind}.schema.json`, SCHEMA_DIR), "utf8"));
}

const ajv = new Ajv2020({ allErrors: true, strict: false, useDefaults: true });
addFormats(ajv);
const validators = new Map(KINDS.map((k) => [k, ajv.compile(loadSchema(k))]));

export interface CheckResult<T> { ok: boolean; value: T; problems: string[] }

export function check<K extends Kind>(kind: K, data: unknown): CheckResult<KindMap[K]> {
  const copy = structuredClone(data);
  const validate = validators.get(kind);
  if (!validate) throw new Error(`unknown record kind: ${kind}`);
  const ok = validate(copy) as boolean;
  const problems = ok ? [] : (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "is invalid"}`);
  return { ok, value: copy as KindMap[K], problems };
}

export function defaults<K extends Kind>(kind: K, seed: Record<string, unknown>): KindMap[K] {
  const r = check(kind, { schema: 1, ...seed });
  if (!r.ok) throw new Error(`bad seed for ${kind}: ${r.problems.join("; ")}`);
  return r.value;
}
```

```ts
// packages/core/src/fields.ts
import { loadSchema } from "./schema.js";
import type { Kind } from "./types.js";

export interface FieldDef { path: string; label: string; type: string; options: string[]; help: string }

type Node = { type?: string | string[]; enum?: string[]; properties?: Record<string, Node>; items?: Node; "x-ui"?: { label?: string; help?: string } };

export function fieldsFor(kind: Kind): FieldDef[] {
  const out: FieldDef[] = [];
  const walk = (node: Node, prefix: string) => {
    for (const [key, child] of Object.entries(node.properties ?? {})) {
      const path = prefix ? `${prefix}.${key}` : key;
      const ui = child["x-ui"];
      if (ui?.label) {
        const type = child.enum ? "enum" : Array.isArray(child.type) ? child.type.join("|") : child.type ?? (child.items?.enum ? "enum[]" : "unknown");
        out.push({ path, label: ui.label, type, options: child.enum ?? child.items?.enum ?? [], help: ui.help ?? "" });
      }
      if (child.properties) walk(child, path);
    }
  };
  walk(loadSchema(kind) as Node, "");
  return out;
}
```

Add to `src/index.ts`:

```ts
export * from "./types.js";
export * from "./schema.js";
export * from "./fields.js";
```

- [ ] **Step 6: Run to verify pass**

Run: `npx vitest run packages/core/test/schema.test.ts && npm run typecheck`
Expected: PASS; typecheck exits 0.

- [ ] **Step 7: Commit**

```bash
git add packages/core
git commit -m "feat(core): record types, JSON schemas with defaults, schema checker, UI field defs"
```

---

### Task 4: Record store (atomic writes, unknown-field preservation)

**Files:**
- Create: `packages/core/src/store.ts`, `packages/core/src/clock.ts`, `packages/core/test/store.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `check` from Task 3.
- Produces:
  - `class RecordError extends Error { file: string; problems: string[] }`
  - `readJson(file: string): unknown` (throws `RecordError` on read/parse failure)
  - `readRecord<K>(kind: K, file: string): KindMap[K]`
  - `writeRecord<K>(kind: K, file: string, data: KindMap[K] | Record<string, unknown>): KindMap[K]`
  - `updateRecord<K>(kind: K, file: string, fn: (cur: KindMap[K]) => KindMap[K] | void): KindMap[K]`
  - `writeFileAtomic(file: string, content: string | Uint8Array, mode?: number): void`
  - `interface Clock { now?: Date }`, `iso(c?: Clock): string`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/test/store.test.ts
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readRecord, RecordError, updateRecord, writeFileAtomic, writeRecord } from "../src/store.js";
import { iso } from "../src/clock.js";
import { FIXED, tmpDir } from "./helpers.js";

const job = { schema: 1, id: "2026-01-15-ai-engineer", company_slug: "acme-corp", title: "AI Engineer" };

afterEach(() => vi.restoreAllMocks());

describe("store", () => {
  it("writes formatted JSON with a trailing newline and defaults filled", () => {
    const f = path.join(tmpDir(), "a", "job.json");
    writeRecord("job", f, job);
    const text = fs.readFileSync(f, "utf8");
    expect(text.endsWith("}\n")).toBe(true);
    expect(text).toContain('\n  "status": "Found"');
  });
  it("refuses to write an invalid record and leaves no file", () => {
    const f = path.join(tmpDir(), "job.json");
    expect(() => writeRecord("job", f, { ...job, status: "Nope" })).toThrow(RecordError);
    expect(fs.existsSync(f)).toBe(false);
  });
  it("preserves unknown fields across update", () => {
    const f = path.join(tmpDir(), "job.json");
    writeRecord("job", f, { ...job, referee_called: true, custom: { notice: "4 weeks" } });
    updateRecord("job", f, (j) => { j.status = "Applied"; });
    const back = readRecord("job", f);
    expect(back.status).toBe("Applied");
    expect(back.referee_called).toBe(true);
    expect(back.custom).toEqual({ notice: "4 weeks" });
  });
  it("reports invalid JSON as a RecordError naming the file", () => {
    const f = path.join(tmpDir(), "job.json");
    fs.writeFileSync(f, '{ "schema": 1, }');
    try { readRecord("job", f); throw new Error("expected failure"); }
    catch (e) { expect(e).toBeInstanceOf(RecordError); expect((e as RecordError).file).toBe(f); expect((e as RecordError).problems[0]).toMatch(/invalid JSON/); }
  });
  it("keeps the original intact when the rename step crashes", () => {
    const dir = tmpDir();
    const f = path.join(dir, "job.json");
    writeRecord("job", f, job);
    const before = fs.readFileSync(f, "utf8");
    vi.spyOn(fs, "renameSync").mockImplementationOnce(() => { throw new Error("disk gone"); });
    expect(() => writeRecord("job", f, { ...job, status: "Applied" })).toThrow("disk gone");
    expect(fs.readFileSync(f, "utf8")).toBe(before);
    expect(fs.readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });
  it("writes files with a mode", () => {
    const f = path.join(tmpDir(), ".env");
    writeFileAtomic(f, "A=1\n", 0o600);
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
  });
  it("formats clock time as ISO", () => {
    expect(iso({ now: FIXED })).toBe("2026-01-15T09:30:00.000Z");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/core/test/store.test.ts`
Expected: FAIL, cannot resolve `../src/store.js`.

- [ ] **Step 3: Implement**

```ts
// packages/core/src/clock.ts
export interface Clock { now?: Date }
export function iso(c?: Clock): string {
  return (c?.now ?? new Date()).toISOString();
}
```

```ts
// packages/core/src/store.ts
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { check } from "./schema.js";
import type { Kind, KindMap } from "./types.js";

export class RecordError extends Error {
  constructor(public readonly file: string, public readonly problems: string[]) {
    super(`${file}: ${problems.join("; ")}`);
    this.name = "RecordError";
  }
}

export function readJson(file: string): unknown {
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); }
  catch (e) { throw new RecordError(file, [`cannot read: ${(e as Error).message}`]); }
  try { return JSON.parse(text); }
  catch (e) { throw new RecordError(file, [`invalid JSON: ${(e as Error).message}`]); }
}

export function readRecord<K extends Kind>(kind: K, file: string): KindMap[K] {
  const r = check(kind, readJson(file));
  if (!r.ok) throw new RecordError(file, r.problems);
  return r.value;
}

export function writeFileAtomic(file: string, content: string | Uint8Array, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, content, mode === undefined ? undefined : { mode });
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

export function writeRecord<K extends Kind>(kind: K, file: string, data: KindMap[K] | Record<string, unknown>): KindMap[K] {
  const r = check(kind, data);
  if (!r.ok) throw new RecordError(file, r.problems);
  writeFileAtomic(file, JSON.stringify(r.value, null, 2) + "\n");
  return r.value;
}

export function updateRecord<K extends Kind>(kind: K, file: string, fn: (cur: KindMap[K]) => KindMap[K] | void): KindMap[K] {
  const cur = readRecord(kind, file);
  const next = fn(cur) ?? cur;
  return writeRecord(kind, file, next);
}
```

Add to `src/index.ts`: `export * from "./store.js"; export * from "./clock.js";`

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run packages/core/test/store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): atomic record store that preserves unknown fields"
```

---

### Task 5: Workspace init

**Files:**
- Create: `packages/core/src/migrations/index.ts`, `packages/core/src/workspace.ts`, `packages/core/test/workspace.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `layout`, `ME_DIRS`, `LOCKED_DIRS`, `defaults`, `writeRecord`, `writeFileAtomic`, `iso`, `PRODUCT_VERSION`.
- Produces:
  - `interface Migration { id: number; name: string; files(root: string): string[]; run(root: string): void }`
  - `MIGRATIONS: Migration[]` (empty), `LATEST_DATA_VERSION: number`
  - `isWorkspace(root: string): boolean`
  - `initWorkspace(root: string, opts?: { name?: string; now?: Date }): void`
  - `claudeSettings(): { permissions: { deny: string[] } }`
  - `claudeMd(): string`, `WORKSPACE_GITIGNORE: string`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/test/workspace.test.ts
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initWorkspace, isWorkspace } from "../src/workspace.js";
import { readRecord } from "../src/store.js";
import { layout } from "../src/paths.js";
import { FIXED, tmpDir } from "./helpers.js";

describe("initWorkspace", () => {
  it("creates the full layout with valid records", () => {
    const root = path.join(tmpDir(), "ws");
    initWorkspace(root, { name: "Alex Example", now: FIXED });
    const L = layout(root);
    for (const d of ["settings", "inbox", "companies", "learning", "knowledge", ".index", "me/resumes", "me/history", "me/identity", "me/employment", "me/education", "me/projects"]) {
      expect(fs.statSync(path.join(root, d)).isDirectory()).toBe(true);
    }
    expect(readRecord("workspace", L.workspaceFile).created_at).toBe("2026-01-15T09:30:00.000Z");
    expect(readRecord("profile", L.profile).contact.name).toBe("Alex Example");
    expect(readRecord("integrations", L.integrations).voice).toMatchObject({ engine: "supertonic", voice: "F4", lang: "en", expressions: true, per_type: { guide: "" } });
    expect(readRecord("sponsors", L.sponsors).employers).toEqual([]);
    expect(fs.readFileSync(L.searchLog, "utf8")).toBe("");
    expect(fs.statSync(L.env).mode & 0o777).toBe(0o600);
    expect(isWorkspace(root)).toBe(true);
  });
  it("locks identity and employment folders and loads no third-party plugins", () => {
    const root = path.join(tmpDir(), "ws");
    initWorkspace(root, { now: FIXED });
    const s = JSON.parse(fs.readFileSync(path.join(root, ".claude", "settings.json"), "utf8"));
    expect(s.permissions.deny).toContain("Read(./me/identity/**)");
    expect(s.permissions.deny).toContain("Read(./me/employment/**)");
    expect(s.permissions.deny).toContain("Read(./settings/.env)");
    expect(s.enabledPlugins).toBeUndefined();
    expect(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8")).toContain("me/identity");
    expect(fs.readFileSync(path.join(root, ".gitignore"), "utf8")).toContain("me/identity/");
  });
  it("refuses an existing workspace or a non-empty folder", () => {
    const root = path.join(tmpDir(), "ws");
    initWorkspace(root, { now: FIXED });
    expect(() => initWorkspace(root)).toThrow(/already a CareerOS workspace/);
    const other = tmpDir();
    fs.writeFileSync(path.join(other, "notes.txt"), "x");
    expect(() => initWorkspace(other)).toThrow(/not empty/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/core/test/workspace.test.ts`
Expected: FAIL, cannot resolve `../src/workspace.js`.

- [ ] **Step 3: Implement**

```ts
// packages/core/src/migrations/index.ts
export interface Migration {
  id: number;
  name: string;
  /** Absolute paths of files this migration may change; they are backed up first. */
  files(root: string): string[];
  run(root: string): void;
}

// Append new migrations here with increasing ids. Never edit or remove a shipped one.
export const MIGRATIONS: Migration[] = [];

export const LATEST_DATA_VERSION = MIGRATIONS.reduce((m, x) => Math.max(m, x.id), 0);
```

```ts
// packages/core/src/workspace.ts
import fs from "node:fs";
import path from "node:path";
import { iso } from "./clock.js";
import { LATEST_DATA_VERSION } from "./migrations/index.js";
import { layout, LOCKED_DIRS, ME_DIRS } from "./paths.js";
import { defaults } from "./schema.js";
import { writeFileAtomic, writeRecord } from "./store.js";
import { PRODUCT_VERSION } from "./version.js";

export const WORKSPACE_GITIGNORE = [
  "# Local-only history. Never add a remote unless you mean to.",
  ".env", "settings/.env", "me/identity/", "me/employment/", "me/resumes/", ".index/", ".backup/", "",
].join("\n");

export function isWorkspace(root: string): boolean {
  return fs.existsSync(layout(root).workspaceFile);
}

export function claudeSettings(): { permissions: { deny: string[] } } {
  const deny = LOCKED_DIRS.flatMap((d) => [`Read(./${d}/**)`, `Edit(./${d}/**)`, `Write(./${d}/**)`])
    .concat(["Read(./settings/.env)", "Edit(./settings/.env)"]);
  return { permissions: { deny } };
}

export function claudeMd(): string {
  return `# CareerOS workspace

This folder holds one candidate's job hunt. Rules for Claude:

- Read and write records only through the \`careeros\` CLI (job new, job status, job event,
  job attach, inbox file, search add, index, validate). Never hand-edit .index/.
- me/identity and me/employment are locked. Do not open them. If a task needs one fact
  (for example visa expiry), ask the candidate.
- settings/.env holds secrets. Never print or copy it.
- Applying for a job or sending an email needs the candidate's OK for that exact item.
- Files dropped in inbox/ get filed with \`careeros inbox file\`. If unsure where a file
  belongs, leave it and ask.
- No fabrication: every claim in a resume or letter must trace to me/history or me/resumes.
`;
}

export function initWorkspace(root: string, opts: { name?: string; now?: Date } = {}): void {
  if (isWorkspace(root)) throw new Error(`${root} is already a CareerOS workspace`);
  if (fs.existsSync(root) && fs.readdirSync(root).some((n) => !n.startsWith("."))) {
    throw new Error(`${root} is not empty; choose an empty folder`);
  }
  const L = layout(root);
  const dirs = ["settings", "inbox", "companies", "learning", "knowledge", ".index", ...ME_DIRS.map((d) => `me/${d}`)];
  for (const d of dirs) fs.mkdirSync(path.join(root, d), { recursive: true });
  writeRecord("workspace", L.workspaceFile, defaults("workspace", {
    data_version: LATEST_DATA_VERSION, product_version: PRODUCT_VERSION, created_at: iso(opts),
  }));
  writeRecord("profile", L.profile, defaults("profile", { contact: { name: opts.name ?? "" } }));
  writeRecord("search", L.search, defaults("search", {}));
  writeRecord("integrations", L.integrations, defaults("integrations", {}));
  writeRecord("sponsors", L.sponsors, defaults("sponsors", {}));
  writeFileAtomic(L.searchLog, "");
  writeFileAtomic(L.env, "# Secrets only. Never share or commit this file.\n", 0o600);
  fs.chmodSync(L.env, 0o600);
  writeFileAtomic(path.join(root, ".claude", "settings.json"), JSON.stringify(claudeSettings(), null, 2) + "\n");
  writeFileAtomic(path.join(root, "CLAUDE.md"), claudeMd());
  writeFileAtomic(path.join(root, ".gitignore"), WORKSPACE_GITIGNORE);
}
```

Add to `src/index.ts`: `export * from "./workspace.js"; export * from "./migrations/index.js";`

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run packages/core/test/workspace.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): initWorkspace with locked folders and generated Claude settings"
```

---

### Task 6: Companies and jobs

**Files:**
- Create: `packages/core/src/jobs.ts`, `packages/core/test/jobs.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `layout`, `slugify`, `splitClient`, `insideRoot`, `assertSegment`, `defaults`, `readJson`, `writeRecord`, `updateRecord`, `writeFileAtomic`, `Clock`, `iso`, `JOB_STATUSES`.
- Produces:
  - `normalizeUrl(u: string): string`
  - `ensureCompany(root: string, rawName: string): { slug: string; created: boolean; client: string | null }`
  - `listJobs(root: string): { company_slug: string; id: string; file: string }[]`
  - `findJobByUrl(root: string, url: string): { company_slug: string; id: string } | null`
  - `interface NewJobInput { company: string; title: string; url?: string; source?: JobSource; source_site?: string; apply_via?: string; posted?: string; location?: string; work_mode?: string; job_type?: string; salary_text?: string; jd_text?: string }`
  - `newJob(root: string, input: NewJobInput, c?: Clock): { company_slug: string; id: string; created: boolean }`
  - `jobFilePath(root: string, slug: string, id: string): string` (validates segments, throws if missing)
  - `addEvent(root, slug, id, event: string, note?: string, c?: Clock): Job`
  - `setStatus(root, slug, id, status: string, note?: string, c?: Clock): Job`
  - `JOB_SUBDIRS = ["", "application", "emails", "interview"]`, `type JobSubdir`
  - `attachFile(root, slug, id, src: string, opts: { label: string; subdir?: JobSubdir; move?: boolean }, c?: Clock): string` (returns path relative to job folder)
  - `uniquePath(p: string): string`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/test/jobs.test.ts
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initWorkspace } from "../src/workspace.js";
import { addEvent, attachFile, ensureCompany, findJobByUrl, listJobs, newJob, normalizeUrl, setStatus } from "../src/jobs.js";
import { readRecord } from "../src/store.js";
import { layout } from "../src/paths.js";
import { FIXED, tmpDir } from "./helpers.js";

function ws() { const root = path.join(tmpDir(), "ws"); initWorkspace(root, { now: FIXED }); return root; }

describe("normalizeUrl", () => {
  it("drops tracking params, hash and trailing slash", () => {
    expect(normalizeUrl("https://Jobs.Example.com/view/123/?utm_source=x&refId=9&id=4#top")).toBe("https://jobs.example.com/view/123?id=4");
  });
  it("returns non-URLs trimmed", () => {
    expect(normalizeUrl("  not a url ")).toBe("not a url");
  });
});

describe("companies and jobs", () => {
  it("creates a company once and splits recruiter clients", () => {
    const root = ws();
    expect(ensureCompany(root, "Acme Recruiting (client Example University)")).toEqual({ slug: "acme-recruiting", created: true, client: "Example University" });
    expect(ensureCompany(root, "Acme Recruiting").created).toBe(false);
    expect(readRecord("company", layout(root).companyFile("acme-recruiting")).name).toBe("Acme Recruiting");
  });
  it("creates a job with a Found event and jd.md", () => {
    const root = ws();
    const r = newJob(root, { company: "Acme Corp", title: "AI Engineer", url: "https://jobs.example.com/1", source: "ats", source_site: "Greenhouse", jd_text: "Build agents." }, { now: FIXED });
    expect(r).toEqual({ company_slug: "acme-corp", id: "2026-01-15-ai-engineer", created: true });
    const j = readRecord("job", layout(root).jobFile(r.company_slug, r.id));
    expect(j.timeline).toEqual([{ at: "2026-01-15T09:30:00.000Z", event: "Found", note: "Greenhouse" }]);
    expect(j.files.map((f) => f.path)).toEqual(["jd.md"]);
    expect(fs.readFileSync(path.join(layout(root).jobDir(r.company_slug, r.id), "jd.md"), "utf8")).toBe("Build agents.\n");
  });
  it("dedupes by URL even with tracking params", () => {
    const root = ws();
    newJob(root, { company: "Acme Corp", title: "AI Engineer", url: "https://jobs.example.com/1" }, { now: FIXED });
    const again = newJob(root, { company: "Acme Corp", title: "AI Engineer", url: "https://jobs.example.com/1/?utm_source=mail" }, { now: FIXED });
    expect(again.created).toBe(false);
    expect(listJobs(root)).toHaveLength(1);
    expect(findJobByUrl(root, "https://jobs.example.com/1#x")?.id).toBe("2026-01-15-ai-engineer");
  });
  it("suffixes same-day same-title jobs with different URLs", () => {
    const root = ws();
    newJob(root, { company: "Acme Corp", title: "AI Engineer", url: "https://jobs.example.com/1" }, { now: FIXED });
    const b = newJob(root, { company: "Acme Corp", title: "AI Engineer", url: "https://jobs.example.com/2" }, { now: FIXED });
    expect(b.id).toBe("2026-01-15-ai-engineer-2");
  });
  it("records events and status changes, rejecting unknown statuses", () => {
    const root = ws();
    const { company_slug, id } = newJob(root, { company: "Acme Corp", title: "AI Engineer" }, { now: FIXED });
    addEvent(root, company_slug, id, "Email sent", "asked about sponsorship", { now: FIXED });
    const j = setStatus(root, company_slug, id, "Applied", "", { now: FIXED });
    expect(j.status).toBe("Applied");
    expect(j.timeline.map((e) => e.event)).toEqual(["Found", "Email sent", "Status: Applied"]);
    expect(() => setStatus(root, company_slug, id, "Ghosted")).toThrow(/unknown status/);
  });
  it("attaches files into allowed subfolders without overwriting", () => {
    const root = ws();
    const { company_slug, id } = newJob(root, { company: "Acme Corp", title: "AI Engineer" }, { now: FIXED });
    const src = path.join(tmpDir(), "resume.md");
    fs.writeFileSync(src, "# Alex Example\n");
    expect(attachFile(root, company_slug, id, src, { label: "Tailored resume", subdir: "application" }, { now: FIXED })).toBe("application/resume.md");
    expect(attachFile(root, company_slug, id, src, { label: "Tailored resume v2", subdir: "application" }, { now: FIXED })).toBe("application/resume-2.md");
    expect(fs.existsSync(src)).toBe(true);
  });
  it("rejects path traversal in company or job ids", () => {
    const root = ws();
    expect(() => addEvent(root, "../..", "etc", "x")).toThrow(/unsafe/);
    expect(() => setStatus(root, "acme-corp", "../../../passwd", "Applied")).toThrow(/unsafe/);
    expect(() => attachFile(root, "acme-corp", "a/b", "/tmp/x", { label: "x" })).toThrow(/unsafe/);
  });
  it("rejects a blank title", () => {
    expect(() => newJob(ws(), { company: "Acme Corp", title: "   " })).toThrow(/title is required/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/core/test/jobs.test.ts`
Expected: FAIL, cannot resolve `../src/jobs.js`.

- [ ] **Step 3: Implement `src/jobs.ts`**

```ts
import fs from "node:fs";
import path from "node:path";
import { type Clock, iso } from "./clock.js";
import { assertSegment, insideRoot, layout, slugify, splitClient } from "./paths.js";
import { defaults } from "./schema.js";
import { readJson, updateRecord, writeFileAtomic, writeRecord } from "./store.js";
import { JOB_STATUSES, type Job, type JobSource, type JobStatus } from "./types.js";

export function normalizeUrl(u: string): string {
  try {
    const x = new URL(u.trim());
    x.hash = "";
    for (const k of [...x.searchParams.keys()]) {
      if (/^(utm_|ref$|refid$|trk|trackingid$)/i.test(k)) x.searchParams.delete(k);
    }
    x.hostname = x.hostname.toLowerCase();
    let s = x.toString();
    s = s.replace(/\/(\?|$)/, "$1");
    return s;
  } catch {
    return u.trim();
  }
}

export function ensureCompany(root: string, rawName: string): { slug: string; created: boolean; client: string | null } {
  const { company, client } = splitClient(rawName);
  const slug = slugify(company, "company");
  const file = layout(root).companyFile(slug);
  if (fs.existsSync(file)) return { slug, created: false, client };
  writeRecord("company", file, defaults("company", { name: company || slug, slug }));
  return { slug, created: true, client };
}

export function listJobs(root: string): { company_slug: string; id: string; file: string }[] {
  const L = layout(root);
  const out: { company_slug: string; id: string; file: string }[] = [];
  if (!fs.existsSync(L.companiesDir)) return out;
  for (const c of fs.readdirSync(L.companiesDir).sort()) {
    const jd = L.jobsDir(c);
    if (!fs.existsSync(jd)) continue;
    for (const id of fs.readdirSync(jd).sort()) {
      const file = L.jobFile(c, id);
      if (fs.existsSync(file)) out.push({ company_slug: c, id, file });
    }
  }
  return out;
}

export function findJobByUrl(root: string, url: string): { company_slug: string; id: string } | null {
  const want = normalizeUrl(url);
  for (const j of listJobs(root)) {
    try {
      const raw = readJson(j.file) as { url?: unknown };
      if (typeof raw.url === "string" && raw.url && normalizeUrl(raw.url) === want) return { company_slug: j.company_slug, id: j.id };
    } catch {
      // Invalid files are reported by validateWorkspace; skip them here.
    }
  }
  return null;
}

export interface NewJobInput {
  company: string; title: string; url?: string; source?: JobSource; source_site?: string; apply_via?: string;
  posted?: string; location?: string; work_mode?: string; job_type?: string; salary_text?: string; jd_text?: string;
}

export function newJob(root: string, input: NewJobInput, c?: Clock): { company_slug: string; id: string; created: boolean } {
  const title = input.title.trim();
  if (!title) throw new Error("job title is required");
  if (input.url) {
    const hit = findJobByUrl(root, input.url);
    if (hit) return { ...hit, created: false };
  }
  const { slug, client } = ensureCompany(root, input.company);
  const at = iso(c);
  const L = layout(root);
  const base = `${at.slice(0, 10)}-${slugify(title, "job")}`;
  let id = base;
  for (let n = 2; fs.existsSync(L.jobDir(slug, id)); n++) id = `${base}-${n}`;
  const file = L.jobFile(slug, id);
  writeRecord("job", file, defaults("job", {
    id, company_slug: slug, client, title,
    source: input.source ?? "pasted", source_site: input.source_site ?? "",
    url: input.url ? normalizeUrl(input.url) : "", apply_via: input.apply_via ?? "", posted: input.posted ?? "",
    found_at: at, location: input.location ?? "", work_mode: input.work_mode ?? "", job_type: input.job_type ?? "",
    salary: { text: input.salary_text ?? "" },
    timeline: [{ at, event: "Found", note: input.source_site || input.source || "pasted" }],
  }));
  if (input.jd_text) {
    writeFileAtomic(path.join(L.jobDir(slug, id), "jd.md"), input.jd_text.endsWith("\n") ? input.jd_text : `${input.jd_text}\n`);
    updateRecord("job", file, (j) => { j.files.push({ path: "jd.md", label: "Job description", at }); });
  }
  return { company_slug: slug, id, created: true };
}

export function jobFilePath(root: string, slug: string, id: string): string {
  assertSegment(slug, "company slug");
  assertSegment(id, "job id");
  const f = layout(root).jobFile(slug, id);
  if (!fs.existsSync(f)) throw new Error(`no job ${slug}/${id}`);
  return f;
}

export function addEvent(root: string, slug: string, id: string, event: string, note = "", c?: Clock): Job {
  return updateRecord("job", jobFilePath(root, slug, id), (j) => { j.timeline.push({ at: iso(c), event, note }); });
}

export function setStatus(root: string, slug: string, id: string, status: string, note = "", c?: Clock): Job {
  if (!(JOB_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`unknown status "${status}". Use one of: ${JOB_STATUSES.join(", ")}`);
  }
  return updateRecord("job", jobFilePath(root, slug, id), (j) => {
    j.status = status as JobStatus;
    j.timeline.push({ at: iso(c), event: `Status: ${status}`, note });
  });
}

export const JOB_SUBDIRS = ["", "application", "emails", "interview"] as const;
export type JobSubdir = (typeof JOB_SUBDIRS)[number];

export function uniquePath(p: string): string {
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(p);
  const stem = p.slice(0, p.length - ext.length);
  for (let n = 2; ; n++) {
    const q = `${stem}-${n}${ext}`;
    if (!fs.existsSync(q)) return q;
  }
}

export function attachFile(root: string, slug: string, id: string, src: string, opts: { label: string; subdir?: JobSubdir; move?: boolean }, c?: Clock): string {
  const jf = jobFilePath(root, slug, id);
  const subdir = opts.subdir ?? "";
  if (!(JOB_SUBDIRS as readonly string[]).includes(subdir)) throw new Error(`unknown subdir "${subdir}"`);
  const jobDir = path.dirname(jf);
  const dir = path.join(jobDir, subdir);
  const dest = uniquePath(path.join(dir, path.basename(src)));
  if (!insideRoot(jobDir, dest)) throw new Error("refusing to write outside the job folder");
  fs.mkdirSync(dir, { recursive: true });
  if (opts.move) fs.renameSync(src, dest); else fs.copyFileSync(src, dest);
  const rel = path.relative(jobDir, dest).split(path.sep).join("/");
  updateRecord("job", jf, (j) => { j.files.push({ path: rel, label: opts.label, at: iso(c) }); });
  return rel;
}
```

Add to `src/index.ts`: `export * from "./jobs.js";`

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run packages/core/test/jobs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): companies, jobs, events, status, attachments with dedupe and path guards"
```

---

### Task 7: Eligibility rules and search log

**Files:**
- Create: `packages/core/src/eligibility.ts`, `packages/core/src/knowledge.ts`, `packages/core/test/eligibility.test.ts`, `packages/core/test/knowledge.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces:
  - `isEligible(status: WorkRightsStatus, label: WorkRightsLabel): boolean`
  - `pinRank(label: WorkRightsLabel): number` (0 for `sponsorship_offered`, else 1)
  - `interface SearchEntry { at: string; site: string; query: string; location: string; results: string; kept: string; notes: string }`
  - `appendSearch(root: string, e: { site: string; query: string; location: string; at?: string; results?: string | number; kept?: string | number; notes?: string }, c?: Clock): SearchEntry`
  - `readSearches(root: string): { entries: SearchEntry[]; badLines: number[] }`
  - `ranRecently(root: string, site: string, query: string, location: string, days?: number, c?: Clock): SearchEntry | null`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/test/eligibility.test.ts
import { describe, expect, it } from "vitest";
import { isEligible, pinRank } from "../src/eligibility.js";
import { WR_LABELS } from "../src/types.js";

describe("isEligible", () => {
  it("shows every job to citizens, PR and unknown", () => {
    for (const s of ["citizen", "pr", "unknown"] as const) for (const l of WR_LABELS) expect(isEligible(s, l)).toBe(true);
  });
  it("hides citizen/PR-only and clearance jobs from visa holders and sponsorship seekers", () => {
    for (const s of ["full_visa", "limited_visa", "needs_sponsorship"] as const) {
      expect(isEligible(s, "citizen_pr_only")).toBe(false);
      expect(isEligible(s, "clearance")).toBe(false);
      expect(isEligible(s, "silent")).toBe(true);
      expect(isEligible(s, "visa_ok")).toBe(true);
      expect(isEligible(s, "sponsorship_offered")).toBe(true);
    }
  });
  it("pins sponsorship-offered first", () => {
    expect(pinRank("sponsorship_offered")).toBe(0);
    expect(pinRank("silent")).toBe(1);
  });
});
```

```ts
// packages/core/test/knowledge.test.ts
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initWorkspace } from "../src/workspace.js";
import { appendSearch, ranRecently, readSearches } from "../src/knowledge.js";
import { layout } from "../src/paths.js";
import { FIXED, tmpDir } from "./helpers.js";

function ws() { const root = path.join(tmpDir(), "ws"); initWorkspace(root, { now: FIXED }); return root; }

describe("search log", () => {
  it("appends entries with time and reads them back", () => {
    const root = ws();
    appendSearch(root, { site: "Greenhouse", query: "ai engineer", location: "Sampletown", results: 12, kept: 2 }, { now: FIXED });
    const { entries, badLines } = readSearches(root);
    expect(badLines).toEqual([]);
    expect(entries[0]).toEqual({ at: "2026-01-15T09:30:00.000Z", site: "Greenhouse", query: "ai engineer", location: "Sampletown", results: "12", kept: "2", notes: "" });
  });
  it("detects a repeat within 7 days, ignoring case and punctuation", () => {
    const root = ws();
    appendSearch(root, { site: "Greenhouse", query: '"AI Engineer"', location: "Sampletown" }, { now: FIXED });
    const later = { now: new Date("2026-01-20T00:00:00Z") };
    expect(ranRecently(root, "greenhouse", "ai engineer", "sampletown", 7, later)).not.toBeNull();
    const muchLater = { now: new Date("2026-02-01T00:00:00Z") };
    expect(ranRecently(root, "greenhouse", "ai engineer", "sampletown", 7, muchLater)).toBeNull();
  });
  it("reports bad lines instead of throwing", () => {
    const root = ws();
    fs.appendFileSync(layout(root).searchLog, "not json\n");
    appendSearch(root, { site: "x", query: "y", location: "z" }, { now: FIXED });
    const r = readSearches(root);
    expect(r.badLines).toEqual([1]);
    expect(r.entries).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/core/test/eligibility.test.ts packages/core/test/knowledge.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

```ts
// packages/core/src/eligibility.ts
import type { WorkRightsLabel, WorkRightsStatus } from "./types.js";

/** Whether a candidate with this work-rights status can apply to a job with this ad label. */
export function isEligible(status: WorkRightsStatus, label: WorkRightsLabel): boolean {
  if (status === "citizen" || status === "pr" || status === "unknown") return true;
  return label !== "citizen_pr_only" && label !== "clearance";
}

/** Sort key: ads that offer sponsorship always come first. */
export function pinRank(label: WorkRightsLabel): number {
  return label === "sponsorship_offered" ? 0 : 1;
}
```

```ts
// packages/core/src/knowledge.ts
import fs from "node:fs";
import { type Clock, iso } from "./clock.js";
import { layout } from "./paths.js";

export interface SearchEntry { at: string; site: string; query: string; location: string; results: string; kept: string; notes: string }

export function appendSearch(
  root: string,
  e: { site: string; query: string; location: string; at?: string; results?: string | number; kept?: string | number; notes?: string },
  c?: Clock,
): SearchEntry {
  const entry: SearchEntry = {
    at: e.at ?? iso(c), site: e.site, query: e.query, location: e.location,
    results: e.results === undefined ? "" : String(e.results), kept: e.kept === undefined ? "" : String(e.kept), notes: e.notes ?? "",
  };
  fs.appendFileSync(layout(root).searchLog, JSON.stringify(entry) + "\n");
  return entry;
}

export function readSearches(root: string): { entries: SearchEntry[]; badLines: number[] } {
  const file = layout(root).searchLog;
  const entries: SearchEntry[] = [];
  const badLines: number[] = [];
  if (!fs.existsSync(file)) return { entries, badLines };
  fs.readFileSync(file, "utf8").split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    try {
      const v = JSON.parse(line) as SearchEntry;
      if (typeof v.site !== "string" || typeof v.query !== "string") throw new Error("missing fields");
      entries.push(v);
    } catch {
      badLines.push(i + 1);
    }
  });
  return { entries, badLines };
}

const key = (site: string, q: string, loc: string) =>
  [site.toLowerCase().trim(), q.toLowerCase().replace(/\W+/g, " ").trim(), loc.toLowerCase().trim()].join("|");

export function ranRecently(root: string, site: string, query: string, location: string, days = 7, c?: Clock): SearchEntry | null {
  const cutoff = new Date((c?.now ?? new Date()).getTime() - days * 86_400_000).toISOString();
  const want = key(site, query, location);
  const hits = readSearches(root).entries.filter((e) => e.at >= cutoff && key(e.site, e.query, e.location) === want);
  return hits.at(-1) ?? null;
}
```

Add to `src/index.ts`: `export * from "./eligibility.js"; export * from "./knowledge.js";`

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run packages/core/test/eligibility.test.ts packages/core/test/knowledge.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): work-rights eligibility, sponsorship pinning, search log"
```

---

### Task 8: SQLite index

**Files:**
- Create: `packages/core/src/index-db.ts`, `packages/core/test/index-db.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `layout`, `listJobs`, `readRecord`, `RecordError`, `isEligible`, `pinRank`, `readSearches`.
- Produces:
  - `interface IndexReport { jobs: number; companies: number; events: number; searches: number; skipped: { file: string; problems: string[] }[] }`
  - `buildIndex(root: string): IndexReport` (full rebuild into a temp DB, then rename)
  - `openIndex(root: string): import("node:sqlite").DatabaseSync`
  - Tables: `jobs(company_slug, id, company_name, client, title, source, source_site, url, posted, found_at, location, work_mode, job_type, salary_text, wr_label, fit, sponsor, career_match, career_odds, career_tier, status, eligible, pinned, last_activity, json)`, `companies(slug, name, type, big_tech, sponsor_status)`, `events(company_slug, job_id, at, event, note)`, `searches(at, site, query, location, results, kept, notes)`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/test/index-db.test.ts
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initWorkspace } from "../src/workspace.js";
import { newJob, setStatus } from "../src/jobs.js";
import { buildIndex, openIndex } from "../src/index-db.js";
import { updateRecord } from "../src/store.js";
import { layout } from "../src/paths.js";
import { appendSearch } from "../src/knowledge.js";
import { FIXED, tmpDir } from "./helpers.js";

function seeded() {
  const root = path.join(tmpDir(), "ws");
  initWorkspace(root, { now: FIXED });
  updateRecord("profile", layout(root).profile, (p) => { p.work_rights.status = "needs_sponsorship"; });
  const a = newJob(root, { company: "Acme Corp", title: "AI Engineer", url: "https://jobs.example.com/1" }, { now: FIXED });
  updateRecord("job", layout(root).jobFile(a.company_slug, a.id), (j) => { j.work_rights.label = "sponsorship_offered"; });
  const b = newJob(root, { company: "Example Labs", title: "Backend Engineer", url: "https://jobs.example.com/2" }, { now: FIXED });
  updateRecord("job", layout(root).jobFile(b.company_slug, b.id), (j) => { j.work_rights.label = "citizen_pr_only"; });
  setStatus(root, b.company_slug, b.id, "Skipped", "", { now: FIXED });
  appendSearch(root, { site: "Greenhouse", query: "ai engineer", location: "Sampletown" }, { now: FIXED });
  return { root, a, b };
}

describe("buildIndex", () => {
  it("indexes jobs, companies, events and searches with eligibility and pinning", () => {
    const { root } = seeded();
    const r = buildIndex(root);
    expect(r).toMatchObject({ jobs: 2, companies: 2, events: 3, searches: 1, skipped: [] });
    const db = openIndex(root);
    const rows = db.prepare("SELECT company_slug, wr_label, eligible, pinned, status FROM jobs ORDER BY pinned, company_slug").all();
    db.close();
    expect(rows).toEqual([
      { company_slug: "acme-corp", wr_label: "sponsorship_offered", eligible: 1, pinned: 0, status: "Found" },
      { company_slug: "example-labs", wr_label: "citizen_pr_only", eligible: 0, pinned: 1, status: "Skipped" },
    ]);
  });
  it("skips a broken job file and still indexes the rest", () => {
    const { root, b } = seeded();
    fs.writeFileSync(layout(root).jobFile(b.company_slug, b.id), '{ "schema": 1, }');
    const r = buildIndex(root);
    expect(r.jobs).toBe(1);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]?.file).toContain("example-labs");
  });
  it("can be deleted and rebuilt", () => {
    const { root } = seeded();
    buildIndex(root);
    fs.rmSync(layout(root).indexDb);
    expect(buildIndex(root).jobs).toBe(2);
    expect(fs.readdirSync(path.dirname(layout(root).indexDb)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/core/test/index-db.test.ts`
Expected: FAIL, cannot resolve `../src/index-db.js`.

- [ ] **Step 3: Implement `src/index-db.ts`**

```ts
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { isEligible, pinRank } from "./eligibility.js";
import { listJobs } from "./jobs.js";
import { readSearches } from "./knowledge.js";
import { layout } from "./paths.js";
import { readRecord, RecordError } from "./store.js";
import type { Company, WorkRightsStatus } from "./types.js";

const require = createRequire(import.meta.url);
// Loaded through require so test runners that don't know node:sqlite as a builtin still work.
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

export interface IndexReport { jobs: number; companies: number; events: number; searches: number; skipped: { file: string; problems: string[] }[] }

const DDL = `
CREATE TABLE jobs (company_slug TEXT, id TEXT, company_name TEXT, client TEXT, title TEXT, source TEXT, source_site TEXT,
  url TEXT, posted TEXT, found_at TEXT, location TEXT, work_mode TEXT, job_type TEXT, salary_text TEXT, wr_label TEXT,
  fit REAL, sponsor REAL, career_match REAL, career_odds REAL, career_tier TEXT, status TEXT, eligible INTEGER,
  pinned INTEGER, last_activity TEXT, json TEXT, PRIMARY KEY (company_slug, id));
CREATE TABLE companies (slug TEXT PRIMARY KEY, name TEXT, type TEXT, big_tech INTEGER, sponsor_status TEXT);
CREATE TABLE events (company_slug TEXT, job_id TEXT, at TEXT, event TEXT, note TEXT);
CREATE TABLE searches (at TEXT, site TEXT, query TEXT, location TEXT, results TEXT, kept TEXT, notes TEXT);
CREATE INDEX jobs_status ON jobs(status);
CREATE INDEX events_at ON events(at);
`;

export function openIndex(root: string): InstanceType<typeof DatabaseSync> {
  return new DatabaseSync(layout(root).indexDb);
}

export function buildIndex(root: string): IndexReport {
  const L = layout(root);
  const report: IndexReport = { jobs: 0, companies: 0, events: 0, searches: 0, skipped: [] };
  const rel = (f: string) => path.relative(root, f);
  const skip = (e: unknown) => {
    if (e instanceof RecordError) report.skipped.push({ file: rel(e.file), problems: e.problems });
    else throw e;
  };

  let status: WorkRightsStatus = "unknown";
  try { status = readRecord("profile", L.profile).work_rights.status; } catch (e) { skip(e); }

  fs.mkdirSync(path.dirname(L.indexDb), { recursive: true });
  const tmp = `${L.indexDb}.${process.pid}.tmp`;
  fs.rmSync(tmp, { force: true });
  const db = new DatabaseSync(tmp);
  try {
    db.exec(DDL);
    db.exec("BEGIN");
    const names = new Map<string, string>();
    const insCompany = db.prepare("INSERT INTO companies VALUES (?, ?, ?, ?, ?)");
    if (fs.existsSync(L.companiesDir)) {
      for (const slug of fs.readdirSync(L.companiesDir).sort()) {
        const f = L.companyFile(slug);
        if (!fs.existsSync(f)) continue;
        let c: Company;
        try { c = readRecord("company", f); } catch (e) { skip(e); continue; }
        names.set(slug, c.name);
        insCompany.run(slug, c.name, c.type, c.big_tech ? 1 : 0, c.sponsor.status);
        report.companies++;
      }
    }
    const insJob = db.prepare(`INSERT INTO jobs VALUES (${Array(25).fill("?").join(", ")})`);
    const insEvent = db.prepare("INSERT INTO events VALUES (?, ?, ?, ?, ?)");
    for (const ref of listJobs(root)) {
      let j;
      try { j = readRecord("job", ref.file); } catch (e) { skip(e); continue; }
      const last = j.timeline.reduce((m, ev) => (ev.at > m ? ev.at : m), j.found_at);
      insJob.run(
        ref.company_slug, ref.id, names.get(ref.company_slug) ?? ref.company_slug, j.client, j.title, j.source, j.source_site,
        j.url, j.posted, j.found_at, j.location, j.work_mode, j.job_type, j.salary.text, j.work_rights.label,
        j.scores.fit.value, j.scores.sponsor.value, j.scores.career.match, j.scores.career.odds, j.scores.career.tier,
        j.status, isEligible(status, j.work_rights.label) ? 1 : 0, pinRank(j.work_rights.label), last, JSON.stringify(j),
      );
      report.jobs++;
      for (const ev of j.timeline) { insEvent.run(ref.company_slug, ref.id, ev.at, ev.event, ev.note ?? ""); report.events++; }
    }
    const insSearch = db.prepare("INSERT INTO searches VALUES (?, ?, ?, ?, ?, ?, ?)");
    const { entries, badLines } = readSearches(root);
    for (const s of entries) { insSearch.run(s.at, s.site, s.query, s.location, s.results, s.kept, s.notes); report.searches++; }
    if (badLines.length) report.skipped.push({ file: rel(L.searchLog), problems: badLines.map((n) => `line ${n} is not valid JSON`) });
    db.exec("COMMIT");
  } catch (e) {
    db.close();
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  db.close();
  fs.renameSync(tmp, L.indexDb);
  return report;
}
```

Add to `src/index.ts`: `export * from "./index-db.js";`

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run packages/core/test/index-db.test.ts && npm run typecheck`
Expected: PASS; typecheck exits 0. (Node may print an ExperimentalWarning for `node:sqlite`; that is expected.)

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): rebuildable SQLite index with eligibility and pinning"
```

---

### Task 9: Workspace validator

**Files:**
- Create: `packages/core/src/validate.ts`, `packages/core/test/validate.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `layout`, `listJobs`, `readRecord`, `RecordError`, `readSearches`, `KINDS`.
- Produces: `interface Issue { file: string; problems: string[] }`, `validateWorkspace(root: string): Issue[]` (file paths relative to root).

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/test/validate.test.ts
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initWorkspace } from "../src/workspace.js";
import { newJob } from "../src/jobs.js";
import { validateWorkspace } from "../src/validate.js";
import { layout } from "../src/paths.js";
import { FIXED, tmpDir } from "./helpers.js";

function ws() { const root = path.join(tmpDir(), "ws"); initWorkspace(root, { now: FIXED }); return root; }

describe("validateWorkspace", () => {
  it("passes a fresh workspace with a job", () => {
    const root = ws();
    newJob(root, { company: "Acme Corp", title: "AI Engineer", jd_text: "x" }, { now: FIXED });
    expect(validateWorkspace(root)).toEqual([]);
  });
  it("names the broken file and keeps checking the rest", () => {
    const root = ws();
    const a = newJob(root, { company: "Acme Corp", title: "AI Engineer" }, { now: FIXED });
    fs.writeFileSync(layout(root).jobFile(a.company_slug, a.id), '{ "schema": 1, }');
    fs.writeFileSync(layout(root).profile, '{ "schema": 1, "work_rights": { "status": "alien" } }');
    const issues = validateWorkspace(root);
    expect(issues.map((i) => i.file).sort()).toEqual([
      path.join("companies", "acme-corp", "jobs", "2026-01-15-ai-engineer", "job.json"),
      path.join("settings", "profile.json"),
    ]);
  });
  it("flags records that disagree with their folder, missing files and missing company.json", () => {
    const root = ws();
    const a = newJob(root, { company: "Acme Corp", title: "AI Engineer" }, { now: FIXED });
    const f = layout(root).jobFile(a.company_slug, a.id);
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    j.id = "2026-01-15-other"; j.files = [{ path: "gone.pdf", label: "x", at: "" }];
    fs.writeFileSync(f, JSON.stringify(j));
    fs.mkdirSync(path.join(root, "companies", "orphan"));
    const problems = validateWorkspace(root).flatMap((i) => i.problems).join(" | ");
    expect(problems).toContain("folder name and record disagree");
    expect(problems).toContain("listed file is missing: gone.pdf");
    expect(problems).toContain("missing company.json");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/core/test/validate.test.ts`
Expected: FAIL, cannot resolve `../src/validate.js`.

- [ ] **Step 3: Implement `src/validate.ts`**

```ts
import fs from "node:fs";
import path from "node:path";
import { listJobs } from "./jobs.js";
import { readSearches } from "./knowledge.js";
import { layout } from "./paths.js";
import { readRecord, RecordError } from "./store.js";
import type { Kind, KindMap } from "./types.js";

export interface Issue { file: string; problems: string[] }

export function validateWorkspace(root: string): Issue[] {
  const L = layout(root);
  const issues: Issue[] = [];
  const rel = (f: string) => path.relative(root, f);
  const add = (file: string, problem: string) => issues.push({ file: rel(file), problems: [problem] });
  function tryRead<K extends Kind>(kind: K, file: string): KindMap[K] | null {
    try { return readRecord(kind, file); }
    catch (e) {
      if (e instanceof RecordError) { issues.push({ file: rel(e.file), problems: e.problems }); return null; }
      throw e;
    }
  }

  tryRead("workspace", L.workspaceFile);
  tryRead("profile", L.profile);
  tryRead("search", L.search);
  tryRead("integrations", L.integrations);
  tryRead("sponsors", L.sponsors);

  if (fs.existsSync(L.companiesDir)) {
    for (const slug of fs.readdirSync(L.companiesDir).sort()) {
      if (!fs.statSync(L.companyDir(slug)).isDirectory()) continue;
      const f = L.companyFile(slug);
      if (!fs.existsSync(f)) { add(L.companyDir(slug), "missing company.json"); continue; }
      const c = tryRead("company", f);
      if (c && c.slug !== slug) add(f, `folder name and record disagree (slug "${c.slug}")`);
    }
  }
  for (const ref of listJobs(root)) {
    const j = tryRead("job", ref.file);
    if (!j) continue;
    if (j.company_slug !== ref.company_slug || j.id !== ref.id) add(ref.file, "folder name and record disagree");
    for (const fr of j.files) {
      if (!fs.existsSync(path.join(path.dirname(ref.file), fr.path))) add(ref.file, `listed file is missing: ${fr.path}`);
    }
  }
  const { badLines } = readSearches(root);
  if (badLines.length) issues.push({ file: rel(L.searchLog), problems: badLines.map((n) => `line ${n} is not valid JSON`) });
  return issues;
}
```

Add to `src/index.ts`: `export * from "./validate.js";`

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run packages/core/test/validate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): workspace validator that reports every bad file without stopping"
```

---

### Task 10: Migrations runner

**Files:**
- Create: `packages/core/src/migrate.ts`, `packages/core/test/migrate.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `Migration`, `MIGRATIONS` (Task 5), `readRecord`, `updateRecord`, `layout`, `Clock`, `iso`.
- Produces:
  - `pendingMigrations(root: string, list?: Migration[]): Migration[]`
  - `migrate(root: string, list?: Migration[], c?: Clock): { applied: number[]; backup: string | null }`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/test/migrate.test.ts
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initWorkspace } from "../src/workspace.js";
import { migrate, pendingMigrations } from "../src/migrate.js";
import type { Migration } from "../src/migrations/index.js";
import { readRecord, updateRecord } from "../src/store.js";
import { layout } from "../src/paths.js";
import { FIXED, tmpDir } from "./helpers.js";

function ws() { const root = path.join(tmpDir(), "ws"); initWorkspace(root, { now: FIXED }); return root; }

const renameCity: Migration = {
  id: 1, name: "move contact.city to contact.location",
  files: (root) => [layout(root).profile],
  run: (root) => updateRecord("profile", layout(root).profile, (p) => { p.contact.location = p.contact.city; p.contact.city = ""; }),
};
const boom: Migration = { id: 2, name: "fails", files: () => [], run: () => { throw new Error("bad data"); } };

describe("migrate", () => {
  it("runs pending migrations once, backs up files and bumps data_version", () => {
    const root = ws();
    updateRecord("profile", layout(root).profile, (p) => { p.contact.city = "Sampletown"; });
    expect(pendingMigrations(root, [renameCity]).map((m) => m.id)).toEqual([1]);
    const r = migrate(root, [renameCity], { now: FIXED });
    expect(r.applied).toEqual([1]);
    expect(readRecord("profile", layout(root).profile).contact.location).toBe("Sampletown");
    const backedUp = JSON.parse(fs.readFileSync(path.join(r.backup!, "settings", "profile.json"), "utf8"));
    expect(backedUp.contact.city).toBe("Sampletown");
    expect(readRecord("workspace", layout(root).workspaceFile).data_version).toBe(1);
    expect(migrate(root, [renameCity]).applied).toEqual([]);
  });
  it("stops at a failing migration, keeps the earlier version and names the backup", () => {
    const root = ws();
    expect(() => migrate(root, [renameCity, boom], { now: FIXED })).toThrow(/migration 2 \(fails\) failed: bad data\. Files backed up in/);
    expect(readRecord("workspace", layout(root).workspaceFile).data_version).toBe(1);
  });
  it("new workspaces start at the latest version", () => {
    expect(pendingMigrations(ws())).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/core/test/migrate.test.ts`
Expected: FAIL, cannot resolve `../src/migrate.js`.

- [ ] **Step 3: Implement `src/migrate.ts`**

```ts
import fs from "node:fs";
import path from "node:path";
import { type Clock, iso } from "./clock.js";
import { type Migration, MIGRATIONS } from "./migrations/index.js";
import { layout } from "./paths.js";
import { readRecord, updateRecord } from "./store.js";

export function pendingMigrations(root: string, list: Migration[] = MIGRATIONS): Migration[] {
  const meta = readRecord("workspace", layout(root).workspaceFile);
  return [...list].sort((a, b) => a.id - b.id).filter((m) => m.id > meta.data_version);
}

export function migrate(root: string, list: Migration[] = MIGRATIONS, c?: Clock): { applied: number[]; backup: string | null } {
  const todo = pendingMigrations(root, list);
  if (!todo.length) return { applied: [], backup: null };
  const L = layout(root);
  const backup = path.join(L.backupDir, iso(c).replace(/[:.]/g, "-"));
  const applied: number[] = [];
  for (const m of todo) {
    for (const f of m.files(root)) {
      if (!fs.existsSync(f)) continue;
      const dest = path.join(backup, path.relative(root, f));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(f, dest);
    }
    try {
      m.run(root);
    } catch (e) {
      throw new Error(`migration ${m.id} (${m.name}) failed: ${(e as Error).message}. Files backed up in ${backup}`);
    }
    updateRecord("workspace", L.workspaceFile, (w) => { w.data_version = m.id; });
    applied.push(m.id);
  }
  return { applied, backup };
}
```

Add to `src/index.ts`: `export * from "./migrate.js";`

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run packages/core/test/migrate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): numbered migrations with backups and version tracking"
```

---

### Task 11: Inbox filing

**Files:**
- Create: `packages/core/src/inbox.ts`, `packages/core/test/inbox.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `layout`, `ME_DIRS`, `MeDir`, `insideRoot`, `uniquePath`, `jobFilePath`, `updateRecord`, `JobSubdir`, `JOB_SUBDIRS`, `Clock`, `iso`.
- Produces:
  - `type InboxTarget = { kind: "me"; dir: MeDir; sub?: string } | { kind: "job"; company_slug: string; id: string; subdir?: JobSubdir }`
  - `listInbox(root: string): string[]` (excludes dotfiles and `_filed.md`)
  - `fileInboxItem(root: string, name: string, target: InboxTarget, note?: string, c?: Clock): { to: string }` (`to` relative to root)
  - Log line format in `inbox/_filed.md`: `- <ISO time> | <name> -> <to> | <note>`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/test/inbox.test.ts
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initWorkspace } from "../src/workspace.js";
import { fileInboxItem, listInbox } from "../src/inbox.js";
import { newJob } from "../src/jobs.js";
import { readRecord } from "../src/store.js";
import { layout } from "../src/paths.js";
import { FIXED, tmpDir } from "./helpers.js";

function ws() { const root = path.join(tmpDir(), "ws"); initWorkspace(root, { now: FIXED }); return root; }
const drop = (root: string, name: string) => fs.writeFileSync(path.join(layout(root).inbox, name), "x");

describe("inbox", () => {
  it("lists dropped files only", () => {
    const root = ws();
    drop(root, "cv.pdf"); drop(root, ".DS_Store");
    expect(listInbox(root)).toEqual(["cv.pdf"]);
  });
  it("files into me/ folders, avoids overwrite, and logs it", () => {
    const root = ws();
    fs.writeFileSync(path.join(layout(root).me("resumes"), "cv.pdf"), "old");
    drop(root, "cv.pdf");
    const r = fileInboxItem(root, "cv.pdf", { kind: "me", dir: "resumes" }, "resume from 2025", { now: FIXED });
    expect(r.to).toBe(path.join("me", "resumes", "cv-2.pdf"));
    expect(listInbox(root)).toEqual([]);
    expect(fs.readFileSync(path.join(layout(root).inbox, "_filed.md"), "utf8")).toContain("cv.pdf -> me/resumes/cv-2.pdf | resume from 2025");
  });
  it("files into a sub-folder of me/ and into a job", () => {
    const root = ws();
    drop(root, "visa-grant.pdf");
    expect(fileInboxItem(root, "visa-grant.pdf", { kind: "me", dir: "identity", sub: "visa" }).to).toBe(path.join("me", "identity", "visa", "visa-grant.pdf"));
    const j = newJob(root, { company: "Acme Corp", title: "AI Engineer" }, { now: FIXED });
    drop(root, "offer.pdf");
    fileInboxItem(root, "offer.pdf", { kind: "job", company_slug: j.company_slug, id: j.id, subdir: "emails" }, "", { now: FIXED });
    expect(readRecord("job", layout(root).jobFile(j.company_slug, j.id)).files.map((f) => f.path)).toContain("emails/offer.pdf");
  });
  it("rejects traversal, hidden names, the log file and missing files", () => {
    const root = ws();
    for (const bad of ["../workspace.json", "a/b.pdf", ".env", "_filed.md"]) {
      expect(() => fileInboxItem(root, bad, { kind: "me", dir: "resumes" })).toThrow(/not an inbox file/);
    }
    expect(() => fileInboxItem(root, "nope.pdf", { kind: "me", dir: "resumes" })).toThrow(/not in the inbox/);
    drop(root, "x.pdf");
    expect(() => fileInboxItem(root, "x.pdf", { kind: "me", dir: "resumes", sub: "../../.." })).toThrow(/unsafe/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/core/test/inbox.test.ts`
Expected: FAIL, cannot resolve `../src/inbox.js`.

- [ ] **Step 3: Implement `src/inbox.ts`**

```ts
import fs from "node:fs";
import path from "node:path";
import { type Clock, iso } from "./clock.js";
import { JOB_SUBDIRS, type JobSubdir, jobFilePath, uniquePath } from "./jobs.js";
import { assertSegment, insideRoot, layout, ME_DIRS, type MeDir } from "./paths.js";
import { updateRecord } from "./store.js";

export type InboxTarget =
  | { kind: "me"; dir: MeDir; sub?: string }
  | { kind: "job"; company_slug: string; id: string; subdir?: JobSubdir };

const LOG = "_filed.md";

export function listInbox(root: string): string[] {
  const dir = layout(root).inbox;
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => !n.startsWith(".") && n !== LOG && fs.statSync(path.join(dir, n)).isFile()).sort();
}

export function fileInboxItem(root: string, name: string, target: InboxTarget, note = "", c?: Clock): { to: string } {
  const L = layout(root);
  if (name !== path.basename(name) || name.startsWith(".") || name === LOG || name.includes("..")) {
    throw new Error(`"${name}" is not an inbox file name`);
  }
  const src = path.join(L.inbox, name);
  if (!fs.existsSync(src)) throw new Error(`"${name}" is not in the inbox`);

  let destDir: string;
  if (target.kind === "me") {
    if (!(ME_DIRS as readonly string[]).includes(target.dir)) throw new Error(`unknown me/ folder "${target.dir}"`);
    destDir = L.me(target.dir);
    if (target.sub) {
      for (const seg of target.sub.split("/")) assertSegment(seg, "sub-folder");
      destDir = path.join(destDir, target.sub);
    }
  } else {
    const subdir = target.subdir ?? "";
    if (!(JOB_SUBDIRS as readonly string[]).includes(subdir)) throw new Error(`unknown subdir "${subdir}"`);
    destDir = path.join(path.dirname(jobFilePath(root, target.company_slug, target.id)), subdir);
  }
  const dest = uniquePath(path.join(destDir, name));
  if (!insideRoot(root, dest) || insideRoot(L.inbox, dest)) throw new Error("refusing to file outside the workspace");
  fs.mkdirSync(destDir, { recursive: true });
  fs.renameSync(src, dest);

  const at = iso(c);
  const to = path.relative(root, dest);
  if (target.kind === "job") {
    const jf = jobFilePath(root, target.company_slug, target.id);
    const relToJob = path.relative(path.dirname(jf), dest).split(path.sep).join("/");
    updateRecord("job", jf, (j) => { j.files.push({ path: relToJob, label: note || name, at }); });
  }
  fs.appendFileSync(path.join(L.inbox, LOG), `- ${at} | ${name} -> ${to.split(path.sep).join("/")} | ${note}\n`);
  return { to };
}
```

Add to `src/index.ts`: `export * from "./inbox.js";`

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run packages/core/test/inbox.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): inbox filing into me/ or a job, with log and traversal guards"
```

---

### Task 12: Legacy import

**Files:**
- Create: `packages/core/src/legacy.ts`, `packages/core/test/legacy.test.ts`, `packages/core/test/fixtures/make-legacy.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `initWorkspace`, `isWorkspace`, `newJob`, `listJobs`, `readJson`, `readRecord`, `writeRecord`, `updateRecord`, `defaults`, `slugify`, `splitClient`, `layout`, `appendSearch`, `readSearches`, `validateWorkspace`, `JOB_STATUSES`.
- Produces:
  - `interface LegacyAction { kind: "job" | "copy" | "sponsors" | "searches" | "skip"; from: string; to: string; note?: string }`
  - `interface LegacyReport { actions: LegacyAction[]; unmapped: string[]; skipped: string[]; issues: Issue[] }`
  - `importLegacy(src: string, dest: string, opts?: { dryRun?: boolean; now?: Date }): LegacyReport`
  - Test fixture `makeLegacy(dir: string): void` builds a fake legacy tree.

Legacy layout handled (all names from the founder's old folder; fixture data is fictional):
- `Company/<Name>/application.json` (+ `JD-*.md`, `score-*.md`, `resume-*`, `cover-*`, recruiter email folders, other files)
- `Job-Hunt-Sponsorship/sponsors.json` (`{ "employers": [...] }`), `Job-Hunt-Sponsorship/SEARCH-LOG.md` (markdown table: Date | Site | Query / filters | Location | Results | Kept | Notes)
- `resume-docs/` → `me/history/`, `Resume/` → `me/resumes/`, `Visa/` → `me/identity/visa/`, `Current-company/` → `me/employment/`, `Current Address/` → `me/identity/address/`, `Personal Projects/` → `me/projects/`
- Everything else at top level → `unmapped`. Dotfiles (including `.env`) → `skipped`, never copied.

- [ ] **Step 1: Write the fixture builder**

```ts
// packages/core/test/fixtures/make-legacy.ts
import fs from "node:fs";
import path from "node:path";

const w = (root: string, rel: string, text: string) => {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};

export function makeLegacy(dir: string): void {
  w(dir, "Company/Acme Corp/application.json", JSON.stringify({
    company: "Acme Corp", role: "AI Engineer", source: "SEEK", source_url: "https://jobs.example.com/77?utm_source=x",
    location: "Sampletown NSW", work_mode: "Hybrid", salary: "$150k", posted: "2026-01-10", apply_via: "careers page",
    status: "Applied", sponsorship: "Explicit", sponsor_score: 95, sponsor_tier: "Very high", sponsor_reasons: ["ad says sponsorship"],
    score: { match: 80, odds: 60, tier: "Good Fit" }, fit: "High", must_haves: ["Python"],
    rights_scan: { positive: ["Visa sponsorship available"], hard: [] },
    date_found: "2026-01-12", timeline: [{ date: "2026-01-12", event: "Found", note: "SEEK" }, { date: "2026-01-14", event: "Applied", note: "" }],
    files: [{ label: "Job description", path: "JD-ai-engineer.md", date: "2026-01-12" }],
  }));
  w(dir, "Company/Acme Corp/JD-ai-engineer.md", "# AI Engineer\n");
  w(dir, "Company/Acme Corp/score-2026-01-12.md", "Match 80\n");
  w(dir, "Company/Acme Corp/resume-2026-01-13-ai-engineer.md", "# Alex Example\n");
  w(dir, "Company/Acme Corp/Recruiter-email/thread.md", "Hi Alex\n");
  w(dir, "Company/Acme Recruiting (client Example University)/application.json", JSON.stringify({
    company: "Acme Recruiting (client Example University)", role: "AI Developer", source: "LinkedIn", sponsorship: "No", status: "Found", date_found: "2026-01-13",
  }));
  w(dir, "Company/_TEMPLATE/application.json", "{}");
  w(dir, "Company/README.md", "how to\n");
  w(dir, "Company/No Record Co/notes.md", "orphan\n");
  w(dir, "Job-Hunt-Sponsorship/sponsors.json", JSON.stringify({ employers: [{ name: "Acme Corp", status: "verified" }] }));
  w(dir, "Job-Hunt-Sponsorship/SEARCH-LOG.md", [
    "| Date | Site | Query / filters | Location | Results | Kept | Notes |",
    "|------|------|-----------------|----------|--------:|-----:|-------|",
    "| 2026-01-12 14:05 | SEEK | ai engineer | Sampletown | 31 | 2 | kept Acme |",
    "| 2026-01-11 | LinkedIn | llm engineer | Remote | 10 | 0 | none |",
  ].join("\n"));
  w(dir, "resume-docs/profile.md", "# Profile\nAlex Example\n");
  w(dir, "Resume/Alex_Example_Resume.pdf", "%PDF-1.4 SAMPLE\n");
  w(dir, "Visa/26-27/grant.pdf", "%PDF-1.4 SAMPLE\n");
  w(dir, "Current-company/contract.pdf", "%PDF-1.4 SAMPLE\n");
  w(dir, "Current Address/lease.pdf", "%PDF-1.4 SAMPLE\n");
  w(dir, "Personal Projects/side-app/README.md", "# Side app\n");
  w(dir, "Personal Projects/side-app/node_modules/pkg/index.js", "x\n");
  w(dir, "scripts/tool.py", "print(1)\n");
  w(dir, ".env", "SECRET=1\n");
}
```

- [ ] **Step 2: Write the failing tests**

```ts
// packages/core/test/legacy.test.ts
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { importLegacy } from "../src/legacy.js";
import { listJobs } from "../src/jobs.js";
import { readRecord } from "../src/store.js";
import { readSearches } from "../src/knowledge.js";
import { layout } from "../src/paths.js";
import { makeLegacy } from "./fixtures/make-legacy.js";
import { FIXED, tmpDir } from "./helpers.js";

function setup() {
  const src = tmpDir("legacy-"); makeLegacy(src);
  const dest = path.join(tmpDir(), "ws");
  return { src, dest };
}

describe("importLegacy", () => {
  it("dry run plans everything and writes nothing", () => {
    const { src, dest } = setup();
    const r = importLegacy(src, dest, { dryRun: true, now: FIXED });
    expect(fs.existsSync(dest)).toBe(false);
    expect(r.actions.filter((a) => a.kind === "job").map((a) => a.to)).toEqual([
      "companies/acme-corp/jobs/2026-01-12-ai-engineer",
      "companies/acme-recruiting/jobs/2026-01-13-ai-developer",
    ]);
    expect(r.unmapped).toEqual(expect.arrayContaining(["scripts", "Company/No Record Co"]));
    expect(r.skipped).toContain(".env");
  });
  it("imports jobs with mapped status, work rights, scores, timeline and files", () => {
    const { src, dest } = setup();
    const r = importLegacy(src, dest, { now: FIXED });
    expect(r.issues).toEqual([]);
    const L = layout(dest);
    const j = readRecord("job", L.jobFile("acme-corp", "2026-01-12-ai-engineer"));
    expect(j.status).toBe("Applied");
    expect(j.url).toBe("https://jobs.example.com/77");
    expect(j.source).toBe("browser");
    expect(j.source_site).toBe("SEEK");
    expect(j.work_rights).toMatchObject({ label: "sponsorship_offered", quotes: ["Visa sponsorship available"], decided_by: "scan" });
    expect(j.scores.sponsor.value).toBe(95);
    expect(j.scores.career).toMatchObject({ match: 80, odds: 60, tier: "Good Fit" });
    expect(j.timeline.map((e) => e.event)).toEqual(["Found", "Applied"]);
    expect(j.custom.legacy_folder).toBe("Company/Acme Corp");
    const dir = L.jobDir("acme-corp", "2026-01-12-ai-engineer");
    expect(fs.existsSync(path.join(dir, "jd.md"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "score.md"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "application", "resume-2026-01-13-ai-engineer.md"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "emails", "thread.md"))).toBe(true);
    const rec = readRecord("job", L.jobFile("acme-recruiting", "2026-01-13-ai-developer"));
    expect(rec.client).toBe("Example University");
    expect(rec.work_rights.label).toBe("citizen_pr_only");
  });
  it("imports sponsors, the search log and personal folders, never .env or node_modules", () => {
    const { src, dest } = setup();
    importLegacy(src, dest, { now: FIXED });
    const L = layout(dest);
    expect(readRecord("sponsors", L.sponsors).employers).toEqual([{ name: "Acme Corp", status: "verified" }]);
    expect(readSearches(dest).entries.map((e) => [e.at, e.site])).toEqual([["2026-01-12T14:05:00", "SEEK"], ["2026-01-11T00:00:00", "LinkedIn"]]);
    expect(fs.existsSync(path.join(dest, "me", "identity", "visa", "26-27", "grant.pdf"))).toBe(true);
    expect(fs.existsSync(path.join(dest, "me", "identity", "address", "lease.pdf"))).toBe(true);
    expect(fs.existsSync(path.join(dest, "me", "employment", "contract.pdf"))).toBe(true);
    expect(fs.existsSync(path.join(dest, "me", "history", "profile.md"))).toBe(true);
    expect(fs.existsSync(path.join(dest, "me", "projects", "side-app", "README.md"))).toBe(true);
    expect(fs.existsSync(path.join(dest, "me", "projects", "side-app", "node_modules"))).toBe(false);
    expect(fs.readFileSync(L.env, "utf8")).not.toContain("SECRET");
  });
  it("is idempotent and never touches the source", () => {
    const { src, dest } = setup();
    const before = fs.readdirSync(src).sort();
    importLegacy(src, dest, { now: FIXED });
    const again = importLegacy(src, dest, { now: FIXED });
    expect(listJobs(dest)).toHaveLength(2);
    expect(again.actions.filter((a) => a.kind === "job")).toEqual([]);
    expect(readSearches(dest).entries).toHaveLength(2);
    expect(fs.readdirSync(src).sort()).toEqual(before);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run packages/core/test/legacy.test.ts`
Expected: FAIL, cannot resolve `../src/legacy.js`.

- [ ] **Step 4: Implement `src/legacy.ts`**

```ts
import fs from "node:fs";
import path from "node:path";
import { appendSearch, readSearches } from "./knowledge.js";
import { listJobs, newJob } from "./jobs.js";
import { layout, slugify, splitClient } from "./paths.js";
import { defaults } from "./schema.js";
import { readJson, readRecord, updateRecord, writeRecord } from "./store.js";
import { JOB_STATUSES, type JobStatus, type WorkRightsLabel } from "./types.js";
import { type Issue, validateWorkspace } from "./validate.js";
import { initWorkspace, isWorkspace } from "./workspace.js";

export interface LegacyAction { kind: "job" | "copy" | "sponsors" | "searches" | "skip"; from: string; to: string; note?: string }
export interface LegacyReport { actions: LegacyAction[]; unmapped: string[]; skipped: string[]; issues: Issue[] }

const ME_MAP: [string, string][] = [
  ["Resume", "me/resumes"], ["Visa", "me/identity/visa"], ["Current-company", "me/employment"],
  ["Current Address", "me/identity/address"], ["Personal Projects", "me/projects"], ["resume-docs", "me/history"],
];
const HANDLED_TOP = new Set(["Company", "Job-Hunt-Sponsorship", ...ME_MAP.map((m) => m[0])]);
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", ".wrangler", ".turbo", ".vercel", "__pycache__", ".claude"]);
const MAX_BYTES = 25 * 1024 * 1024;
const STATUS_MAP: Record<string, JobStatus> = { Screening: "Interview", Interviewing: "Interview", Withdrawn: "Skipped", Closed: "Skipped" };

type Legacy = Record<string, unknown> & {
  company?: string; role?: string; source?: string; source_url?: string; apply_via?: string; posted?: string; location?: string;
  work_mode?: string; salary?: string; status?: string; sponsorship?: string; sponsor_score?: number; sponsor_tier?: string;
  sponsor_reasons?: string[]; score?: { match?: number | null; odds?: number | null; tier?: string };
  must_haves?: unknown[]; must_haves_check?: unknown[]; nice_to_haves?: unknown[]; nice_to_haves_check?: unknown[];
  rights_scan?: Record<string, unknown>; date_found?: string; timeline?: { date?: string; event?: string; note?: string }[];
  files?: { label?: string; path?: string }[];
};

function copyTree(from: string, to: string, report: LegacyReport, dry: boolean, src: string, dest: string): void {
  for (const name of fs.readdirSync(from).sort()) {
    if (name === ".DS_Store") continue;
    const a = path.join(from, name);
    const b = path.join(to, name);
    const st = fs.statSync(a);
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) { report.skipped.push(path.relative(src, a)); continue; }
      copyTree(a, b, report, dry, src, dest);
      continue;
    }
    if (name === ".env" || name.startsWith(".env.")) { report.skipped.push(path.relative(src, a)); continue; }
    if (st.size > MAX_BYTES) { report.skipped.push(`${path.relative(src, a)} (over 25 MB)`); continue; }
    if (fs.existsSync(b) && fs.statSync(b).size === st.size) continue;
    report.actions.push({ kind: "copy", from: path.relative(src, a), to: path.relative(dest, b) });
    if (!dry) { fs.mkdirSync(to, { recursive: true }); fs.copyFileSync(a, b); }
  }
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function label(s: string | undefined): WorkRightsLabel {
  if (s === "Explicit") return "sponsorship_offered";
  if (s === "No") return "citizen_pr_only";
  return "silent";
}

function importJobFiles(dir: string, jobDir: string, report: LegacyReport, src: string, dest: string, labels: Map<string, string>) {
  const added: { path: string; label: string; at: string }[] = [];
  let hasJd = false, hasScore = false;
  const put = (from: string, rel: string, lbl: string) => {
    const to = path.join(jobDir, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    report.actions.push({ kind: "copy", from: path.relative(src, from), to: path.relative(dest, to) });
    added.push({ path: rel.split(path.sep).join("/"), label: lbl, at: "" });
  };
  for (const name of fs.readdirSync(dir).sort()) {
    if (name === "application.json" || name === ".DS_Store") continue;
    const p = path.join(dir, name);
    const lbl = labels.get(name) ?? name;
    if (fs.statSync(p).isDirectory()) {
      const sub = /email|recruit|recuriter/i.test(name) ? "emails" : name.toLowerCase().replace(/\s+/g, "-");
      for (const f of fs.readdirSync(p).sort()) if (fs.statSync(path.join(p, f)).isFile()) put(path.join(p, f), path.join(sub, f), f);
    } else if (/^JD.*\.md$/i.test(name) && !hasJd) { put(p, "jd.md", "Job description"); hasJd = true; }
    else if (/^score.*\.md$/i.test(name) && !hasScore) { put(p, "score.md", "Career-skill score"); hasScore = true; }
    else if (/^(resume|cover|answers)/i.test(name)) put(p, path.join("application", name), lbl);
    else put(p, name, lbl);
  }
  return added;
}

export function importLegacy(src: string, dest: string, opts: { dryRun?: boolean; now?: Date } = {}): LegacyReport {
  if (!fs.existsSync(src)) throw new Error(`legacy folder not found: ${src}`);
  const dry = opts.dryRun ?? false;
  const report: LegacyReport = { actions: [], unmapped: [], skipped: [], issues: [] };
  if (!dry && !isWorkspace(dest)) initWorkspace(dest, { now: opts.now });
  const L = layout(dest);

  for (const name of fs.readdirSync(src).sort()) {
    if (name === ".DS_Store") continue;
    if (name.startsWith(".")) report.skipped.push(name);
    else if (!HANDLED_TOP.has(name)) report.unmapped.push(name);
  }

  for (const [from, to] of ME_MAP) {
    const s = path.join(src, from);
    if (fs.existsSync(s)) copyTree(s, path.join(dest, to), report, dry, src, dest);
  }

  const sponsorsFile = path.join(src, "Job-Hunt-Sponsorship", "sponsors.json");
  if (fs.existsSync(sponsorsFile)) {
    const raw = readJson(sponsorsFile) as { employers?: unknown[] };
    report.actions.push({ kind: "sponsors", from: path.relative(src, sponsorsFile), to: path.relative(dest, L.sponsors) });
    if (!dry) writeRecord("sponsors", L.sponsors, defaults("sponsors", { employers: raw.employers ?? [] }));
  }

  const logFile = path.join(src, "Job-Hunt-Sponsorship", "SEARCH-LOG.md");
  if (fs.existsSync(logFile)) {
    const have = dry ? new Set<string>() : new Set(readSearches(dest).entries.map((e) => `${e.at}|${e.site}|${e.query}|${e.location}`));
    let n = 0;
    for (const line of fs.readFileSync(logFile, "utf8").split("\n")) {
      if (!line.startsWith("| 20")) continue;
      const [date = "", site = "", query = "", location = "", results = "", kept = "", notes = ""] = line.trim().replace(/^\||\|$/g, "").split("|").map((x) => x.trim());
      const at = date.length === 10 ? `${date}T00:00:00` : `${date.replace(" ", "T")}:00`;
      if (have.has(`${at}|${site}|${query}|${location}`)) continue;
      n++;
      if (!dry) appendSearch(dest, { at, site, query, location, results, kept, notes });
    }
    report.actions.push({ kind: "searches", from: path.relative(src, logFile), to: path.relative(dest, L.searchLog), note: `${n} rows` });
  }

  const companyRoot = path.join(src, "Company");
  if (fs.existsSync(companyRoot)) {
    const done = new Set<string>();
    if (!dry) for (const j of listJobs(dest)) {
      try { const f = readRecord("job", j.file).custom.legacy_folder; if (typeof f === "string") done.add(f); } catch { /* reported by validate */ }
    }
    for (const dirName of fs.readdirSync(companyRoot).sort()) {
      const dir = path.join(companyRoot, dirName);
      if (dirName.startsWith("_") || !fs.statSync(dir).isDirectory()) continue;
      const legacyFolder = `Company/${dirName}`;
      const appFile = path.join(dir, "application.json");
      if (!fs.existsSync(appFile)) { report.unmapped.push(legacyFolder); continue; }
      if (done.has(legacyFolder)) continue;
      const app = readJson(appFile) as Legacy;
      const name = String(app.company || dirName);
      const title = String(app.role || "Unknown role");
      const found = String(app.date_found || app.timeline?.[0]?.date || "").slice(0, 10);
      const when = /^\d{4}-\d{2}-\d{2}$/.test(found) ? new Date(`${found}T00:00:00.000Z`) : (opts.now ?? new Date());
      const company_slug = slugify(splitClient(name).company, "company");
      const plannedId = `${when.toISOString().slice(0, 10)}-${slugify(title, "job")}`;
      if (dry) { report.actions.push({ kind: "job", from: legacyFolder, to: `companies/${company_slug}/jobs/${plannedId}` }); continue; }

      const res = newJob(dest, {
        company: name, title, url: app.source_url || undefined,
        source: /seek|linkedin|indeed/i.test(app.source ?? "") ? "browser" : "pasted", source_site: app.source ?? "",
        apply_via: app.apply_via, posted: app.posted, location: app.location, work_mode: app.work_mode, salary_text: app.salary,
      }, { now: when });
      if (!res.created) { report.actions.push({ kind: "skip", from: legacyFolder, to: `companies/${res.company_slug}/jobs/${res.id}`, note: "same URL already imported" }); continue; }
      report.actions.push({ kind: "job", from: legacyFolder, to: `companies/${res.company_slug}/jobs/${res.id}` });

      const jobFile = L.jobFile(res.company_slug, res.id);
      const labels = new Map((app.files ?? []).filter((f) => f.path).map((f) => [String(f.path), String(f.label ?? f.path)]));
      const files = importJobFiles(dir, path.dirname(jobFile), report, src, dest, labels);
      const scan = app.rights_scan ?? {};
      const status = (JOB_STATUSES as readonly string[]).includes(app.status ?? "") ? (app.status as JobStatus) : (STATUS_MAP[app.status ?? ""] ?? "Found");
      updateRecord("job", jobFile, (j) => {
        j.status = status;
        j.work_rights = { label: label(app.sponsorship), quotes: [...strings(scan.positive), ...strings(scan.weak_positive), ...strings(scan.hard), ...strings(scan.soft)], decided_by: app.rights_scan ? "scan" : "none" };
        j.scores.sponsor = { value: app.sponsor_score ?? null, tier: app.sponsor_tier ?? "", reasons: app.sponsor_reasons ?? [] };
        j.scores.career = { match: app.score?.match ?? null, odds: app.score?.odds ?? null, tier: app.score?.tier ?? "", scored_at: "" };
        j.scores.fit.must_haves = app.must_haves_check ?? app.must_haves ?? [];
        j.scores.fit.nice_to_haves = app.nice_to_haves_check ?? app.nice_to_haves ?? [];
        if (app.timeline?.length) j.timeline = app.timeline.map((e) => ({ at: String(e.date ?? found), event: String(e.event ?? ""), note: String(e.note ?? "") }));
        j.files = files.map((f) => ({ ...f, at: found }));
        j.custom = { ...j.custom, legacy_folder: legacyFolder, legacy_fit: app.fit ?? null, legacy: app };
      });
    }
  }

  if (!dry) report.issues = validateWorkspace(dest);
  return report;
}
```

Add to `src/index.ts`: `export * from "./legacy.js";`

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run packages/core/test/legacy.test.ts && npm run typecheck`
Expected: PASS; typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/core
git commit -m "feat(core): copy-only legacy import with dry run, idempotent re-runs"
```

---

### Task 13: CLI

**Files:**
- Create: `packages/core/src/cli.ts`, `packages/core/test/cli.test.ts`

**Interfaces:**
- Consumes: every public function from Tasks 2-12.
- Produces: `run(argv: string[], env?: NodeJS.ProcessEnv): { code: number; out: string; err: string }`; `careeros` binary. Output is JSON on stdout. Errors go to `err` with exit code 2. `validate` and `search check` exit 1 when they find something.

Commands:

```
careeros init <dir> [--name NAME]
careeros job new --company C --title T [--url U] [--source S] [--site S] [--location L] [--work-mode M] [--job-type J] [--salary S] [--posted P] [--apply-via A] [--jd-file F]
careeros job event <company_slug> <id> <event> [--note N]
careeros job status <company_slug> <id> <status> [--note N]
careeros job attach <company_slug> <id> <file> --label L [--subdir application|emails|interview]
careeros inbox list
careeros inbox file <name> (--me <dir>[/<sub>] | --job <company_slug>/<id> [--subdir S]) [--note N]
careeros search add --site S --query Q --location L [--results N] [--kept N] [--notes N]
careeros search check --site S --query Q --location L
careeros index
careeros validate
careeros migrate
careeros import-legacy <legacy-dir> --to <dir> [--dry-run]
```

Every command except `init` and `import-legacy` takes `--ws <dir>` (default: `$CAREEROS_WORKSPACE`, then the current directory).

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/test/cli.test.ts
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { makeLegacy } from "./fixtures/make-legacy.js";
import { tmpDir } from "./helpers.js";

const json = (r: { out: string }) => JSON.parse(r.out);

describe("cli", () => {
  it("runs the full happy path", () => {
    const ws = path.join(tmpDir(), "ws");
    expect(run(["init", ws, "--name", "Alex Example"]).code).toBe(0);
    const created = json(run(["job", "new", "--ws", ws, "--company", "Acme Corp", "--title", "AI Engineer", "--url", "https://jobs.example.com/9", "--source", "ats"]));
    expect(created.created).toBe(true);
    expect(run(["job", "status", "--ws", ws, created.company_slug, created.id, "Applied"]).code).toBe(0);
    expect(run(["search", "add", "--ws", ws, "--site", "Greenhouse", "--query", "ai engineer", "--location", "Sampletown"]).code).toBe(0);
    expect(run(["search", "check", "--ws", ws, "--site", "Greenhouse", "--query", "ai engineer", "--location", "Sampletown"]).code).toBe(1);
    expect(json(run(["index", "--ws", ws])).jobs).toBe(1);
    expect(run(["validate", "--ws", ws]).code).toBe(0);
  });
  it("uses CAREEROS_WORKSPACE when --ws is absent", () => {
    const ws = path.join(tmpDir(), "ws");
    run(["init", ws]);
    expect(run(["validate"], { CAREEROS_WORKSPACE: ws }).code).toBe(0);
  });
  it("files inbox items into me/ and jobs", () => {
    const ws = path.join(tmpDir(), "ws");
    run(["init", ws]);
    fs.writeFileSync(path.join(ws, "inbox", "grant.pdf"), "x");
    expect(json(run(["inbox", "list", "--ws", ws]))).toEqual(["grant.pdf"]);
    expect(json(run(["inbox", "file", "--ws", ws, "grant.pdf", "--me", "identity/visa", "--note", "visa grant"])).to).toBe(path.join("me", "identity", "visa", "grant.pdf"));
  });
  it("returns exit 1 from validate when files are broken", () => {
    const ws = path.join(tmpDir(), "ws");
    run(["init", ws]);
    fs.writeFileSync(path.join(ws, "settings", "profile.json"), "{");
    const r = run(["validate", "--ws", ws]);
    expect(r.code).toBe(1);
    expect(json(r)[0].file).toBe(path.join("settings", "profile.json"));
  });
  it("prints a helpful error with exit 2 on bad input", () => {
    const r = run(["job", "status", "--ws", tmpDir(), "a", "b", "Ghosted"]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/no job|unknown status/);
    expect(run(["nope"]).code).toBe(2);
  });
  it("runs a legacy dry run", () => {
    const src = tmpDir("legacy-"); makeLegacy(src);
    const r = json(run(["import-legacy", src, "--to", path.join(tmpDir(), "ws"), "--dry-run"]));
    expect(r.actions.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/core/test/cli.test.ts`
Expected: FAIL, cannot resolve `../src/cli.js`.

- [ ] **Step 3: Implement `src/cli.ts`**

```ts
#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { buildIndex } from "./index-db.js";
import { fileInboxItem, type InboxTarget, listInbox } from "./inbox.js";
import { addEvent, attachFile, type JobSubdir, newJob, setStatus } from "./jobs.js";
import { appendSearch, ranRecently } from "./knowledge.js";
import { importLegacy } from "./legacy.js";
import { migrate } from "./migrate.js";
import type { MeDir } from "./paths.js";
import type { JobSource } from "./types.js";
import { validateWorkspace } from "./validate.js";
import { initWorkspace } from "./workspace.js";

const USAGE = `careeros <command>
  init <dir> [--name NAME]
  job new --company C --title T [--url U --source ats|adzuna|browser|pasted --site S --location L --work-mode M --job-type J --salary S --posted P --apply-via A --jd-file F]
  job event <company_slug> <id> <event> [--note N]
  job status <company_slug> <id> <status> [--note N]
  job attach <company_slug> <id> <file> --label L [--subdir application|emails|interview]
  inbox list | inbox file <name> (--me DIR[/SUB] | --job SLUG/ID [--subdir S]) [--note N]
  search add --site S --query Q --location L [--results N --kept N --notes N]
  search check --site S --query Q --location L
  index | validate | migrate
  import-legacy <legacy-dir> --to <dir> [--dry-run]
All workspace commands accept --ws DIR (default: $CAREEROS_WORKSPACE, then the current folder).`;

const OPTIONS = {
  ws: { type: "string" }, name: { type: "string" }, company: { type: "string" }, title: { type: "string" },
  url: { type: "string" }, source: { type: "string" }, site: { type: "string" }, location: { type: "string" },
  "work-mode": { type: "string" }, "job-type": { type: "string" }, salary: { type: "string" }, posted: { type: "string" },
  "apply-via": { type: "string" }, "jd-file": { type: "string" }, note: { type: "string" }, label: { type: "string" },
  subdir: { type: "string" }, me: { type: "string" }, job: { type: "string" }, query: { type: "string" },
  results: { type: "string" }, kept: { type: "string" }, notes: { type: "string" }, to: { type: "string" },
  "dry-run": { type: "boolean" }, help: { type: "boolean" },
} as const;

export function run(argv: string[], env: NodeJS.ProcessEnv = process.env): { code: number; out: string; err: string } {
  const ok = (v: unknown, code = 0) => ({ code, out: JSON.stringify(v, null, 2) + "\n", err: "" });
  try {
    const { values: o, positionals: p } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
    if (o.help || p.length === 0) return { code: 0, out: USAGE + "\n", err: "" };
    const ws = path.resolve(o.ws ?? env.CAREEROS_WORKSPACE ?? process.cwd());
    const need = (v: string | undefined, flag: string) => { if (!v) throw new Error(`missing --${flag}`); return v; };
    const arg = (i: number, what: string) => { const v = p[i]; if (!v) throw new Error(`missing ${what}`); return v; };
    const [cmd, sub] = p;

    if (cmd === "init") { const dir = path.resolve(arg(1, "<dir>")); initWorkspace(dir, { name: o.name }); return ok({ workspace: dir }); }
    if (cmd === "job" && sub === "new") {
      return ok(newJob(ws, {
        company: need(o.company, "company"), title: need(o.title, "title"), url: o.url, source: o.source as JobSource | undefined,
        source_site: o.site, location: o.location, work_mode: o["work-mode"], job_type: o["job-type"], salary_text: o.salary,
        posted: o.posted, apply_via: o["apply-via"], jd_text: o["jd-file"] ? fs.readFileSync(o["jd-file"], "utf8") : undefined,
      }));
    }
    if (cmd === "job" && sub === "event") return ok(addEvent(ws, arg(2, "<company_slug>"), arg(3, "<id>"), arg(4, "<event>"), o.note ?? ""));
    if (cmd === "job" && sub === "status") return ok(setStatus(ws, arg(2, "<company_slug>"), arg(3, "<id>"), arg(4, "<status>"), o.note ?? ""));
    if (cmd === "job" && sub === "attach") {
      return ok({ path: attachFile(ws, arg(2, "<company_slug>"), arg(3, "<id>"), path.resolve(arg(4, "<file>")), { label: need(o.label, "label"), subdir: (o.subdir ?? "") as JobSubdir }) });
    }
    if (cmd === "inbox" && sub === "list") return ok(listInbox(ws));
    if (cmd === "inbox" && sub === "file") {
      let target: InboxTarget;
      if (o.me) { const [dir, ...rest] = o.me.split("/"); target = { kind: "me", dir: dir as MeDir, sub: rest.join("/") || undefined }; }
      else if (o.job) { const [company_slug = "", id = ""] = o.job.split("/"); target = { kind: "job", company_slug, id, subdir: (o.subdir ?? "") as JobSubdir }; }
      else throw new Error("inbox file needs --me or --job");
      return ok(fileInboxItem(ws, arg(2, "<name>"), target, o.note ?? ""));
    }
    if (cmd === "search" && sub === "add") {
      return ok(appendSearch(ws, { site: need(o.site, "site"), query: need(o.query, "query"), location: need(o.location, "location"), results: o.results, kept: o.kept, notes: o.notes }));
    }
    if (cmd === "search" && sub === "check") {
      const hit = ranRecently(ws, need(o.site, "site"), need(o.query, "query"), need(o.location, "location"));
      return hit ? ok({ ran_recently: true, entry: hit }, 1) : ok({ ran_recently: false });
    }
    if (cmd === "index") return ok(buildIndex(ws));
    if (cmd === "validate") { const issues = validateWorkspace(ws); return ok(issues, issues.length ? 1 : 0); }
    if (cmd === "migrate") return ok(migrate(ws));
    if (cmd === "import-legacy") {
      return ok(importLegacy(path.resolve(arg(1, "<legacy-dir>")), path.resolve(need(o.to, "to")), { dryRun: o["dry-run"] ?? false }));
    }
    throw new Error(`unknown command "${p.join(" ")}"\n${USAGE}`);
  } catch (e) {
    return { code: 2, out: "", err: `careeros: ${(e as Error).message}\n` };
  }
}

const invokedDirectly = (() => {
  try { return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1] ?? "")).href; } catch { return false; }
})();
if (invokedDirectly) {
  const r = run(process.argv.slice(2));
  if (r.out) process.stdout.write(r.out);
  if (r.err) process.stderr.write(r.err);
  process.exit(r.code);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run packages/core/test/cli.test.ts && npm run careeros -- --help`
Expected: tests PASS; help text prints.

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): careeros CLI with JSON output for Claude and scripts"
```

---

### Task 14: Fictional sample workspace

**Files:**
- Create: `packages/core/src/sample-pdf.ts`, `packages/core/scripts/make-samples.ts`, `packages/core/test/samples.test.ts`, `samples/alex-example/**` (generated, committed)
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces: `samplePdf(lines: string[]): Uint8Array` (valid one-page PDF headed "SAMPLE"); `npm run samples` rebuilds `samples/alex-example`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/test/samples.test.ts
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { samplePdf } from "../src/sample-pdf.js";
import { validateWorkspace } from "../src/validate.js";
import { buildIndex } from "../src/index-db.js";
import { tmpDir } from "./helpers.js";

const SAMPLE = path.resolve(import.meta.dirname, "../../../samples/alex-example");

describe("samples", () => {
  it("builds a valid PDF that says SAMPLE", () => {
    const text = new TextDecoder().decode(samplePdf(["Alex Example", "Resume"]));
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text).toContain("(SAMPLE) Tj");
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
  });
  it("ships a valid, indexable fictional workspace", () => {
    expect(validateWorkspace(SAMPLE)).toEqual([]);
    const copy = path.join(tmpDir(), "alex");
    fs.cpSync(SAMPLE, copy, { recursive: true });
    expect(buildIndex(copy)).toMatchObject({ jobs: 3, companies: 3, skipped: [] });
  });
  it("uses only reserved fictional contact details", () => {
    const profile = JSON.parse(fs.readFileSync(path.join(SAMPLE, "settings", "profile.json"), "utf8"));
    expect(profile.contact).toMatchObject({ name: "Alex Example", email: "alex" + "@" + "example.com", phone: "0491 570 006" });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/core/test/samples.test.ts`
Expected: FAIL, cannot resolve `../src/sample-pdf.js`.

- [ ] **Step 3: Implement `src/sample-pdf.ts`**

```ts
/** Builds a one-page PDF with "SAMPLE" as the heading. Used only for fictional sample data. */
export function samplePdf(lines: string[]): Uint8Array {
  const esc = (s: string) => s.replace(/[\\()]/g, (m) => `\\${m}`);
  const content = ["BT", "/F1 28 Tf", "72 720 Td", "(SAMPLE) Tj", "/F1 12 Tf", ...lines.flatMap((l) => ["0 -24 Td", `(${esc(l)}) Tj`]), "ET"].join("\n");
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
```

Add to `src/index.ts`: `export * from "./sample-pdf.js";`

- [ ] **Step 4: Write `scripts/make-samples.ts` and generate**

```ts
// packages/core/scripts/make-samples.ts
import fs from "node:fs";
import path from "node:path";
import { appendSearch, fileInboxItem, initWorkspace, layout, newJob, samplePdf, setStatus, updateRecord } from "../src/index.js";

const ROOT = path.resolve(import.meta.dirname, "../../../samples/alex-example");
const at = (d: string) => ({ now: new Date(`${d}T09:00:00.000Z`) });

fs.rmSync(ROOT, { recursive: true, force: true });
initWorkspace(ROOT, { name: "Alex Example", now: new Date("2026-01-10T09:00:00.000Z") });
const L = layout(ROOT);

updateRecord("profile", L.profile, (p) => {
  p.contact = { ...p.contact, email: "alex" + "@" + "example.com", phone: "0491 570 006", city: "Sampletown NSW", links: ["https://example.com/alex"] };
  p.work_rights = { ...p.work_rights, status: "needs_sponsorship", visa_subclass: "485", visa_expiry: "2028-06-30" };
  p.targets = { ...p.targets, roles: ["AI Engineer", "Software Engineer (LLM)"], keywords: ["agents", "RAG", "TypeScript"], seniority: "Senior", job_types: ["full_time", "contract"] };
  p.locations = [{ place: "Sampletown NSW", modes: ["onsite", "hybrid", "remote"], will_relocate: false }, { place: "Remote Australia", modes: ["remote"], will_relocate: false }];
  p.salary = { ...p.salary, min: 100000 };
  p.skip_big_tech = true;
});

const a = newJob(ROOT, { company: "Acme Corp", title: "AI Engineer", url: "https://jobs.example.com/acme/1", source: "ats", source_site: "Greenhouse", location: "Sampletown NSW", work_mode: "Hybrid", salary_text: "$140k-$160k + super", jd_text: "# AI Engineer at Acme Corp\n\nBuild LLM agents. Visa sponsorship available for the right candidate.\n" }, at("2026-01-12"));
updateRecord("job", L.jobFile(a.company_slug, a.id), (j) => {
  j.work_rights = { label: "sponsorship_offered", quotes: ["Visa sponsorship available for the right candidate."], decided_by: "scan" };
  j.scores.sponsor = { value: 95, tier: "Very high", reasons: ["ad says sponsorship is available"] };
});
setStatus(ROOT, a.company_slug, a.id, "Applied", "Applied on the careers page", at("2026-01-13"));

const b = newJob(ROOT, { company: "Example Labs", title: "Backend Engineer (LLM)", url: "https://jobs.example.com/labs/2", source: "adzuna", source_site: "Adzuna", location: "Remote Australia", work_mode: "Remote", jd_text: "# Backend Engineer (LLM)\n\nNode.js and retrieval pipelines.\n" }, at("2026-01-12"));
updateRecord("job", L.jobFile(b.company_slug, b.id), (j) => { j.scores.sponsor = { value: 20, tier: "Low", reasons: ["no sponsorship signal; ad is silent"] }; });

const c = newJob(ROOT, { company: "Acme Recruiting (client Example University)", title: "AI Developer", url: "https://jobs.example.com/rec/3", source: "pasted", source_site: "Pasted link", location: "Sampletown NSW", jd_text: "# AI Developer\n\nMust be an Australian citizen or permanent resident.\n" }, at("2026-01-12"));
updateRecord("job", L.jobFile(c.company_slug, c.id), (j) => {
  j.work_rights = { label: "citizen_pr_only", quotes: ["Must be an Australian citizen or permanent resident."], decided_by: "scan" };
});

fs.writeFileSync(path.join(L.inbox, "alex-example-resume.pdf"), samplePdf(["Alex Example", "AI Engineer", "1 Example Street, Sampletown NSW 2000"]));
fileInboxItem(ROOT, "alex-example-resume.pdf", { kind: "me", dir: "resumes" }, "Sample resume", at("2026-01-11"));
fs.writeFileSync(path.join(L.me("history"), "roles.md"), "# Roles\n\n- AI Engineer, Example Labs, 2024 to now (fictional)\n");
appendSearch(ROOT, { site: "Greenhouse", query: "ai engineer", location: "Sampletown NSW", results: 12, kept: 1, notes: "kept Acme Corp" }, at("2026-01-12"));
console.log(`samples written to ${ROOT}`);
```

Run: `npm run samples`
Expected: prints `samples written to .../samples/alex-example`.

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run packages/core/test/samples.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit (settings/.env and .index are gitignored)**

```bash
git add packages/core samples
git status --short samples | grep -E "\.env|\.index" && echo "STOP: secret or index staged" || true
git commit -m "feat: fictional Alex Example sample workspace and SAMPLE pdf generator"
```

---

### Task 15: Privacy guard (scan rules, hooks)

**Files:**
- Create: `scripts/privacy/rules.mjs`, `scripts/privacy/scan.mjs`, `tests/privacy.test.ts`, `.githooks/pre-commit`, `.githooks/pre-push`

**Interfaces:**
- Produces (from `rules.mjs`):
  - `checkPath(p: string): Finding[]`
  - `checkText(p: string, text: string, denylist?: string[]): Finding[]`
  - `loadDenylist(file: string): string[] | null`
  - `mask(s: string): string`
  - `Finding = { file: string; line: number; rule: "env-file" | "binary-outside-samples" | "email" | "phone" | "id-number" | "denylist"; sample?: string }`
- Scan CLI modes: `--staged`, `--range <rev-range>`, `--all`, `--history`; flag `--require-denylist`. Denylist path: `$CAREEROS_DENYLIST` or `~/.config/careeros/denylist.txt` (never in the repo).

- [ ] **Step 1: Write the failing tests**

```ts
// tests/privacy.test.ts
import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM module without types
import { checkPath, checkText, mask } from "../scripts/privacy/rules.mjs";

const gmail = "someone" + "@" + "gmail.com";
const realPhone = "04" + "12 345 678";

describe("privacy rules", () => {
  it("blocks .env files but allows .env.example", () => {
    expect(checkPath(".env")[0]?.rule).toBe("env-file");
    expect(checkPath("samples/alex-example/settings/.env")[0]?.rule).toBe("env-file");
    expect(checkPath(".env.local")[0]?.rule).toBe("env-file");
    expect(checkPath(".env.example")).toEqual([]);
  });
  it("blocks documents and images outside samples/public", () => {
    expect(checkPath("docs/resume.pdf")[0]?.rule).toBe("binary-outside-samples");
    expect(checkPath("packages/core/x.docx")[0]?.rule).toBe("binary-outside-samples");
    expect(checkPath("samples/alex-example/me/resumes/a.pdf")).toEqual([]);
    expect(checkPath("public/logo.png")).toEqual([]);
  });
  it("flags real-looking emails, allows reserved ones", () => {
    expect(checkText("a.md", `contact ${gmail}`)[0]?.rule).toBe("email");
    expect(checkText("a.md", "alex" + "@" + "example.com and noreply" + "@" + "anthropic.com")).toEqual([]);
    expect(checkText("a.md", "x" + "@" + "users.noreply.github.com")).toEqual([]);
  });
  it("flags real mobile numbers, allows the fictional 0491 57x range", () => {
    expect(checkText("a.md", `call ${realPhone}`)[0]?.rule).toBe("phone");
    expect(checkText("a.md", "call +61 4" + "12 345 678")[0]?.rule).toBe("phone");
    expect(checkText("a.md", "call 0491 570 006")).toEqual([]);
  });
  it("flags ID words followed by long numbers", () => {
    // Digits kept apart from the keyword in source so the scanner never flags this test file.
    const passportDigits = "N" + "1234567";
    const tfnDigits = "1234" + "56789";
    expect(checkText("a.md", `passport no ${passportDigits}`)[0]?.rule).toBe("id-number");
    expect(checkText("a.md", `TFN: ${tfnDigits}`)[0]?.rule).toBe("id-number");
    expect(checkText("a.md", "passport photo required")).toEqual([]);
  });
  it("applies the denylist everywhere, case-insensitively, and masks output", () => {
    const f = checkText("samples/x.md", "Hello Jordan Realname", ["jordan realname"]);
    expect(f[0]).toMatchObject({ rule: "denylist", line: 1 });
    expect(f[0]?.sample).not.toContain("realname");
    expect(mask("abcdefgh")).toBe("ab****gh");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/privacy.test.ts`
Expected: FAIL, cannot resolve `../scripts/privacy/rules.mjs`.

- [ ] **Step 3: Implement `scripts/privacy/rules.mjs`**

```js
import fs from "node:fs";

export const ALLOWED_BINARY_DIRS = ["samples/", "public/", "docs/assets/"];
const BINARY_EXT = /\.(pdf|docx?|png|jpe?g|heic|gif|webp|xlsx?|pptx?|zip)$/i;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const ALLOWED_EMAIL = /@(example\.(com|org|net)|users\.noreply\.github\.com|anthropic\.com)$/i;
const PHONE = /(?<![\d])(?:\+?61\s?|0)4\d{2}[\s-]?\d{3}[\s-]?\d{3}(?![\d])/g;
const FICTIONAL_PHONE = /^(?:\+?61\s?|0)491[\s-]?57\d/;
const ID_NUMBER = /\b(passport|visa grant|tfn|tax file number|medicare)\b[^\n]{0,40}?\d{6,}/i;

export function mask(s) {
  return s.length <= 4 ? "****" : s.slice(0, 2) + "*".repeat(Math.min(s.length - 4, 8)) + s.slice(-2);
}

export function isEnvFile(p) {
  const b = p.split("/").pop() ?? "";
  return b === ".env" || (b.startsWith(".env.") && b !== ".env.example");
}

export function checkPath(p) {
  const out = [];
  if (isEnvFile(p)) out.push({ file: p, line: 0, rule: "env-file" });
  if (BINARY_EXT.test(p) && !ALLOWED_BINARY_DIRS.some((d) => p.startsWith(d))) out.push({ file: p, line: 0, rule: "binary-outside-samples" });
  return out;
}

export function checkText(p, text, denylist = []) {
  const out = [];
  const deny = denylist.map((d) => d.trim().toLowerCase()).filter((d) => d.length >= 3);
  text.split("\n").forEach((line, i) => {
    const n = i + 1;
    const low = line.toLowerCase();
    for (const d of deny) if (low.includes(d)) out.push({ file: p, line: n, rule: "denylist", sample: mask(d) });
    for (const m of line.matchAll(EMAIL)) if (!ALLOWED_EMAIL.test(m[0])) out.push({ file: p, line: n, rule: "email", sample: mask(m[0]) });
    for (const m of line.matchAll(PHONE)) if (!FICTIONAL_PHONE.test(m[0])) out.push({ file: p, line: n, rule: "phone", sample: mask(m[0]) });
    if (ID_NUMBER.test(line)) out.push({ file: p, line: n, rule: "id-number" });
  });
  return out;
}

export function loadDenylist(file) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/privacy.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement `scripts/privacy/scan.mjs`**

```js
#!/usr/bin/env node
// Personal-data scan. Modes: --staged | --range <a..b> | --all | --history. Flag: --require-denylist.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkPath, checkText, loadDenylist } from "./rules.mjs";

const args = process.argv.slice(2);
const mode = args.find((a) => a.startsWith("--") && a !== "--require-denylist") ?? "--all";
const git = (...a) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
const denyFile = process.env.CAREEROS_DENYLIST ?? path.join(os.homedir(), ".config", "careeros", "denylist.txt");
const deny = loadDenylist(denyFile);
if (args.includes("--require-denylist") && !deny) {
  console.error(`privacy-scan: no denylist at ${denyFile}.\nCreate it with your real name variants, emails, phone, street address, employer and ID numbers (one per line) before pushing.`);
  process.exit(1);
}
const BINARY = /\.(pdf|docx?|png|jpe?g|heic|gif|webp|xlsx?|pptx?|zip|sqlite)$/i;
const findings = [];
const scanFile = (label, p, read) => {
  findings.push(...checkPath(p).map((f) => ({ ...f, file: label })));
  if (!BINARY.test(p)) findings.push(...checkText(label, read(), deny ?? []));
};
const scanCommit = (c) => {
  const short = c.slice(0, 8);
  findings.push(...checkText(`commit ${short} message`, git("log", "-1", "--format=%B", c), deny ?? []));
  findings.push(...checkText(`commit ${short} author`, git("log", "-1", "--format=%an <%ae>%n%cn <%ce>", c), deny ?? []));
  for (const p of git("diff-tree", "--no-commit-id", "--name-only", "-r", "--root", "--diff-filter=ACMR", c).split("\n").filter(Boolean)) {
    scanFile(`${short}:${p}`, p, () => git("show", `${c}:${p}`));
  }
};

if (mode === "--staged") {
  for (const p of git("diff", "--cached", "--name-only", "--diff-filter=ACMR").split("\n").filter(Boolean)) scanFile(p, p, () => git("show", `:${p}`));
} else if (mode === "--range") {
  const range = args[args.indexOf("--range") + 1];
  for (const c of git("rev-list", range).split("\n").filter(Boolean)) scanCommit(c);
} else if (mode === "--history") {
  for (const c of git("rev-list", "--all").split("\n").filter(Boolean)) scanCommit(c);
} else {
  for (const p of git("ls-files").split("\n").filter(Boolean)) scanFile(p, p, () => fs.readFileSync(p, "utf8"));
}

if (findings.length) {
  console.error("privacy-scan: personal data found. Fix these before committing or pushing:");
  for (const f of findings) console.error(`  ${f.file}${f.line ? `:${f.line}` : ""}  ${f.rule}${f.sample ? `  (${f.sample})` : ""}`);
  process.exit(1);
}
console.log(`privacy-scan: clean (${mode}${deny ? ", denylist on" : ", no denylist"})`);
```

- [ ] **Step 6: Write the hooks and make them executable**

`.githooks/pre-commit`:

```sh
#!/bin/sh
# Blocks commits that contain personal data.
exec node scripts/privacy/scan.mjs --staged
```

`.githooks/pre-push`:

```sh
#!/bin/sh
# Blocks pushes that contain personal data. Needs ~/.config/careeros/denylist.txt.
zero=0000000000000000000000000000000000000000
while read -r local_ref local_sha remote_ref remote_sha; do
  [ "$local_sha" = "$zero" ] && continue
  if [ "$remote_sha" = "$zero" ]; then range="$local_sha"; else range="$remote_sha..$local_sha"; fi
  node scripts/privacy/scan.mjs --range "$range" --require-denylist || exit 1
done
exit 0
```

Run: `chmod +x .githooks/pre-commit .githooks/pre-push scripts/privacy/scan.mjs && npm run prepare && git config core.hooksPath`
Expected: prints `.githooks`.

- [ ] **Step 7: Prove the hook blocks a bad commit**

Run:

```bash
printf 'contact: %s\n' "someone$(printf '\x40')gmail.com" > leak.md
git add leak.md
git commit -m "test: should be blocked" ; echo "exit=$?"
git reset -q leak.md && rm leak.md
```

Expected: `privacy-scan: personal data found`, `leak.md:1  email`, `exit=1`.

- [ ] **Step 8: Scan the current tree, then commit**

Run: `npm run scan`
Expected: `privacy-scan: clean (--all, ...)`.

```bash
git add scripts/privacy tests/privacy.test.ts .githooks
git commit -m "feat: privacy guard (rules, scan modes, pre-commit and pre-push hooks)"
```

---

### Task 16: CI and first-push readiness

**Files:**
- Create: `.github/workflows/checks.yml`, `docs/first-push.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: `npm run typecheck`, `npm test`, `scripts/privacy/scan.mjs --history`, `npm run careeros -- validate --ws samples/alex-example`.

- [ ] **Step 1: Write `.github/workflows/checks.yml`**

```yaml
name: checks
on:
  push:
    branches: ["**"]
  pull_request:

jobs:
  checks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - name: Personal-data scan (whole history, generic rules)
        run: node scripts/privacy/scan.mjs --history
      - name: Sample workspace is valid
        run: npm run careeros -- validate --ws samples/alex-example
      - name: Secret scan (gitleaks)
        run: docker run --rm -v "$PWD:/repo" zricethezav/gitleaks:v8.24.0 detect --source /repo --redact --no-banner
```

- [ ] **Step 2: Write `docs/first-push.md`**

```markdown
# Before the first push to GitHub

1. Create the private repo on GitHub (do not initialise it with files).
2. Set this repo's commit identity to your GitHub no-reply address:
   `git config user.email "<id>+<username>@users.noreply.github.com"` and `git config user.name "<username>"`.
3. Rewrite the earlier local commits to that identity (local only, nothing pushed yet):
   `git rebase -r --root --exec 'git commit --amend --no-edit --reset-author'`.
4. Create `~/.config/careeros/denylist.txt` (outside the repo) with one entry per line:
   your real name variants, personal emails, phone, street address, employer, ID numbers.
5. Run `node scripts/privacy/scan.mjs --history --require-denylist`. It must print "clean".
6. Run `docker run --rm -v "$PWD:/repo" zricethezav/gitleaks:v8.24.0 detect --source /repo --redact`.
7. Add the remote and push. The pre-push hook re-runs the scan on every push.
8. On GitHub: Settings > Branches > protect `main`, require the `checks` workflow to pass.
```

- [ ] **Step 3: Validate the workflow locally**

Run: `npm run typecheck && npm test && node scripts/privacy/scan.mjs --all && npm run careeros -- validate --ws samples/alex-example`
Expected: all exit 0; validate prints `[]`.

Note: `--history` will fail until step 3 of `docs/first-push.md` rewrites the early commits whose author email is a personal address. That is intended: it is the gate before the first push.

- [ ] **Step 4: Add a "Privacy" section to `README.md`**

```markdown
## Privacy

No real personal data ever goes in this repo. Hooks scan every commit and push; CI scans the
whole history and runs gitleaks. See docs/first-push.md before pushing for the first time.
```

- [ ] **Step 5: Commit**

```bash
git add .github docs/first-push.md README.md
git commit -m "ci: typecheck, tests, privacy history scan, sample validation, gitleaks; first-push checklist"
```

---

### Task 17: One-click setup pattern

**Files:**
- Create: `setup.sh`, `Setup CareerOS.command`, `setup/components/{node,claude-code,chrome,ffmpeg,python,supertonic,hyperframes,agent-browser,workspace}.json`, `scripts/setup/lib.mjs`, `scripts/setup/run.mjs`, `tests/setup.test.ts`
- Modify: `docs/dependencies.md`, `CLAUDE.md`, `README.md`

**Interfaces:**
- Component manifest (`setup/components/<id>.json`):
  `{ "id": string, "name": string, "order": number, "required": boolean, "why": string, "docs": string, "platforms": { "darwin": { "check": string, "install": string[] } } }`
  `check` is a shell command that exits 0 when the component is ready. `install` runs in order, then `check` runs again.
- `lib.mjs` produces:
  - `validateComponent(c: object): string[]` (problems; empty when valid)
  - `loadComponents(dir: string): Component[]` (sorted by `order`, throws on invalid file or duplicate id, naming the file)
  - `runSetup({ components, mode: "install" | "doctor", platform?: string, only?: string, dryRun?: boolean, exec?: (cmd: string) => number }): { results: { id: string; required: boolean; state: "ok" | "installed" | "missing" | "failed" | "unsupported" | "planned" }[]; ok: boolean }`
  - `ok` is false only when a **required** component ends `missing`, `failed` or `unsupported`.
- `run.mjs`: `node scripts/setup/run.mjs install|doctor [--only ID] [--json] [--dry-run]`; exit 0 when `ok`, else 1.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/setup.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM module without types
import { loadComponents, runSetup, validateComponent } from "../scripts/setup/lib.mjs";

const comp = (id: string, over: Record<string, unknown> = {}) => ({
  id, name: id, order: 10, required: true, why: "test", docs: "https://example.com",
  platforms: { darwin: { check: `check-${id}`, install: [`install-${id}`] } }, ...over,
});

function fakeExec(present: Set<string>, installs: string[] = [], failing = new Set<string>()) {
  return (cmd: string) => {
    if (cmd.startsWith("check-")) return present.has(cmd.slice(6)) ? 0 : 1;
    if (cmd.startsWith("install-")) {
      const id = cmd.slice(8); installs.push(id);
      if (failing.has(id)) return 1;
      present.add(id); return 0;
    }
    return 1;
  };
}

describe("setup runner", () => {
  it("installs only what is missing, then re-checks", () => {
    const installs: string[] = [];
    const r = runSetup({ components: [comp("a"), comp("b")], mode: "install", platform: "darwin", exec: fakeExec(new Set(["a"]), installs) });
    expect(installs).toEqual(["b"]);
    expect(r.results.map((x: { state: string }) => x.state)).toEqual(["ok", "installed"]);
    expect(r.ok).toBe(true);
  });
  it("is idempotent: a second run installs nothing", () => {
    const present = new Set<string>(); const installs: string[] = [];
    runSetup({ components: [comp("a")], mode: "install", platform: "darwin", exec: fakeExec(present, installs) });
    runSetup({ components: [comp("a")], mode: "install", platform: "darwin", exec: fakeExec(present, installs) });
    expect(installs).toEqual(["a"]);
  });
  it("doctor never installs", () => {
    const installs: string[] = [];
    const r = runSetup({ components: [comp("a")], mode: "doctor", platform: "darwin", exec: fakeExec(new Set(), installs) });
    expect(installs).toEqual([]);
    expect(r.results[0].state).toBe("missing");
    expect(r.ok).toBe(false);
  });
  it("a failed optional component does not block the rest", () => {
    const r = runSetup({ components: [comp("opt", { required: false }), comp("req", { order: 20 })], mode: "install", platform: "darwin", exec: fakeExec(new Set(), [], new Set(["opt"])) });
    expect(r.results.map((x: { state: string }) => x.state)).toEqual(["failed", "installed"]);
    expect(r.ok).toBe(true);
  });
  it("reports unsupported platforms, honours --only and --dry-run", () => {
    expect(runSetup({ components: [comp("a")], mode: "doctor", platform: "win32", exec: () => 0 }).results[0].state).toBe("unsupported");
    expect(runSetup({ components: [comp("a"), comp("b")], mode: "doctor", platform: "darwin", only: "b", exec: () => 0 }).results.map((x: { id: string }) => x.id)).toEqual(["b"]);
    const installs: string[] = [];
    expect(runSetup({ components: [comp("a")], mode: "install", platform: "darwin", dryRun: true, exec: fakeExec(new Set(), installs) }).results[0].state).toBe("planned");
    expect(installs).toEqual([]);
  });
});

describe("component manifests", () => {
  const dir = path.resolve(import.meta.dirname, "../setup/components");
  it("validate shape", () => {
    expect(validateComponent(comp("a"))).toEqual([]);
    expect(validateComponent({ id: "Bad Id" }).length).toBeGreaterThan(0);
  });
  it("rejects duplicate ids, naming the file", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "comp-"));
    fs.writeFileSync(path.join(d, "one.json"), JSON.stringify(comp("a")));
    fs.writeFileSync(path.join(d, "two.json"), JSON.stringify(comp("a")));
    expect(() => loadComponents(d)).toThrow(/duplicate id "a" in two\.json/);
  });
  it("every shipped component is valid and listed in docs/dependencies.md", () => {
    const deps = fs.readFileSync(path.resolve(import.meta.dirname, "../docs/dependencies.md"), "utf8");
    const comps = loadComponents(dir);
    expect(comps.length).toBeGreaterThanOrEqual(9);
    for (const c of comps) expect(deps, `add "${c.id}" to docs/dependencies.md`).toContain(`\`${c.id}\``);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/setup.test.ts`
Expected: FAIL, cannot resolve `../scripts/setup/lib.mjs`.

- [ ] **Step 3: Implement `scripts/setup/lib.mjs`**

```js
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function validateComponent(c) {
  const p = [];
  if (!c || typeof c !== "object") return ["not an object"];
  if (typeof c.id !== "string" || !ID.test(c.id)) p.push("id must be lowercase-hyphenated");
  for (const k of ["name", "why", "docs"]) if (typeof c[k] !== "string" || !c[k]) p.push(`${k} is required`);
  if (typeof c.order !== "number") p.push("order must be a number");
  if (typeof c.required !== "boolean") p.push("required must be true or false");
  if (!c.platforms || typeof c.platforms !== "object" || !Object.keys(c.platforms).length) p.push("platforms needs at least one OS");
  for (const [os, spec] of Object.entries(c.platforms ?? {})) {
    if (typeof spec?.check !== "string" || !spec.check) p.push(`platforms.${os}.check is required`);
    if (!Array.isArray(spec?.install) || spec.install.some((x) => typeof x !== "string")) p.push(`platforms.${os}.install must be a list of commands`);
  }
  return p;
}

export function loadComponents(dir) {
  const seen = new Map();
  const out = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    let c;
    try { c = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")); }
    catch (e) { throw new Error(`${file}: invalid JSON (${e.message})`); }
    const problems = validateComponent(c);
    if (problems.length) throw new Error(`${file}: ${problems.join("; ")}`);
    if (seen.has(c.id)) throw new Error(`duplicate id "${c.id}" in ${file} (also in ${seen.get(c.id)})`);
    seen.set(c.id, file);
    out.push(c);
  }
  return out.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

export function shellExec(cmd, quiet = true) {
  try { execSync(cmd, { stdio: quiet ? "ignore" : "inherit", shell: "/bin/bash" }); return 0; }
  catch (e) { return typeof e.status === "number" ? e.status : 1; }
}

export function runSetup({ components, mode, platform = process.platform, only, dryRun = false, exec = shellExec }) {
  const results = [];
  for (const c of components) {
    if (only && c.id !== only) continue;
    const spec = c.platforms[platform];
    const r = (state) => results.push({ id: c.id, name: c.name, required: c.required, state, why: c.why, docs: c.docs });
    if (!spec) { r("unsupported"); continue; }
    if (exec(spec.check) === 0) { r("ok"); continue; }
    if (mode === "doctor") { r("missing"); continue; }
    if (dryRun) { r("planned"); continue; }
    let failed = false;
    for (const cmd of spec.install) if (exec(cmd) !== 0) { failed = true; break; }
    r(!failed && exec(spec.check) === 0 ? "installed" : "failed");
  }
  const ok = results.every((x) => !x.required || x.state === "ok" || x.state === "installed" || x.state === "planned");
  return { results, ok };
}
```

- [ ] **Step 4: Implement `scripts/setup/run.mjs`**

```js
#!/usr/bin/env node
// CareerOS setup runner. install: check, install what is missing, re-check. doctor: check only.
import path from "node:path";
import { parseArgs } from "node:util";
import { loadComponents, runSetup, shellExec } from "./lib.mjs";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { only: { type: "string" }, json: { type: "boolean" }, "dry-run": { type: "boolean" } } });
const mode = positionals[0] === "doctor" ? "doctor" : "install";
const dir = path.resolve(import.meta.dirname, "../../setup/components");
const components = loadComponents(dir);
const exec = (cmd) => (mode === "install" && !cmd.includes(" --version") ? shellExec(cmd, false) : shellExec(cmd, true));
const { results, ok } = runSetup({ components, mode, only: values.only, dryRun: values["dry-run"], exec });

if (values.json) {
  console.log(JSON.stringify({ ok, results }, null, 2));
} else {
  const icon = { ok: "✓", installed: "✓", planned: "…", missing: "✗", failed: "✗", unsupported: "–" };
  for (const r of results) {
    console.log(`${icon[r.state]} ${r.name.padEnd(22)} ${r.state}${r.required ? "" : " (optional)"}`);
    if (["missing", "failed"].includes(r.state)) console.log(`    Why it matters: ${r.why}\n    Help: ${r.docs}`);
  }
  console.log(ok ? "\nAll required parts are ready." : "\nSome required parts are not ready. Fix the ✗ items, then run setup again.");
}
process.exit(ok ? 0 : 1);
```

- [ ] **Step 5: Write the component manifests**

`setup/components/node.json`:
```json
{ "id": "node", "name": "Node.js 22+", "order": 10, "required": true, "why": "Runs the CareerOS app and command-line tools.", "docs": "https://nodejs.org",
  "platforms": { "darwin": { "check": "node -e \"process.exit(+process.versions.node.split('.')[0]>=22?0:1)\"", "install": ["brew install node@22", "brew link --overwrite --force node@22"] } } }
```

`setup/components/claude-code.json`:
```json
{ "id": "claude-code", "name": "Claude Code", "order": 20, "required": true, "why": "The AI that does the work, on your own Claude plan.", "docs": "https://docs.claude.com/en/docs/claude-code/setup",
  "platforms": { "darwin": { "check": "command -v claude >/dev/null && claude --version", "install": ["curl -fsSL https://claude.ai/install.sh | bash"] } } }
```

`setup/components/chrome.json`:
```json
{ "id": "chrome", "name": "Google Chrome", "order": 30, "required": true, "why": "Reads job sites in your own Chrome profile and renders videos.", "docs": "https://www.google.com/chrome/",
  "platforms": { "darwin": { "check": "test -d '/Applications/Google Chrome.app'", "install": ["brew install --cask google-chrome"] } } }
```

`setup/components/ffmpeg.json`:
```json
{ "id": "ffmpeg", "name": "ffmpeg", "order": 40, "required": true, "why": "Builds the learning videos and cleans up audio.", "docs": "https://ffmpeg.org",
  "platforms": { "darwin": { "check": "ffmpeg -version && ffprobe -version", "install": ["brew install ffmpeg"] } } }
```

`setup/components/python.json`:
```json
{ "id": "python", "name": "Python 3.11+", "order": 50, "required": true, "why": "Runs the on-device voice and email helpers.", "docs": "https://www.python.org",
  "platforms": { "darwin": { "check": "python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)'", "install": ["brew install python@3.12"] } } }
```

`setup/components/supertonic.json`:
```json
{ "id": "supertonic", "name": "Supertonic 3 voice", "order": 60, "required": true, "why": "Reads videos aloud on your Mac, offline and free.", "docs": "https://huggingface.co/Supertone/supertonic-3",
  "platforms": { "darwin": { "check": "test -x \"$HOME/.careeros/venv/bin/python\" && \"$HOME/.careeros/venv/bin/python\" -c 'import supertonic'", "install": [
    "python3 -m venv \"$HOME/.careeros/venv\"",
    "\"$HOME/.careeros/venv/bin/pip\" install --upgrade pip supertonic",
    "\"$HOME/.careeros/venv/bin/python\" -c 'from supertonic import TTS; TTS(auto_download=True)'"
  ] } } }
```

`setup/components/hyperframes.json`:
```json
{ "id": "hyperframes", "name": "HyperFrames renderer", "order": 70, "required": true, "why": "Turns lesson scripts into videos on your Mac (local render only).", "docs": "https://hyperframes.heygen.com",
  "platforms": { "darwin": { "check": "command -v hyperframes >/dev/null && hyperframes --version", "install": ["npm install -g hyperframes@0.8.140", "hyperframes telemetry disable"] } } }
```

`setup/components/agent-browser.json`:
```json
{ "id": "agent-browser", "name": "agent-browser", "order": 80, "required": true, "why": "Lets Claude read job ads in your own Chrome profile.", "docs": "https://github.com/vercel-labs/agent-browser",
  "platforms": { "darwin": { "check": "command -v agent-browser >/dev/null && agent-browser --version", "install": ["npm install -g agent-browser"] } } }
```

`setup/components/workspace.json`:
```json
{ "id": "workspace", "name": "Your CareerOS folder", "order": 100, "required": true, "why": "Creates ~/CareerOS, where your documents and jobs live (never uploaded).", "docs": "docs/specs/2026-10-08-workspace-design.md",
  "platforms": { "darwin": { "check": "test -f \"$HOME/CareerOS/workspace.json\"", "install": ["npm run --silent careeros -- init \"$HOME/CareerOS\""] } } }
```

- [ ] **Step 6: Write `setup.sh` and `Setup CareerOS.command`, make both executable**

`setup.sh`:
```bash
#!/usr/bin/env bash
# CareerOS one-click setup for macOS. Safe to re-run: it skips anything already installed.
# Usage: ./setup.sh            install everything that is missing
#        ./setup.sh doctor     check only, change nothing
set -euo pipefail
cd "$(dirname "$0")"
say() { printf '\n==> %s\n' "$1"; }

[ "$(uname)" = "Darwin" ] || { echo "CareerOS setup supports macOS for now."; exit 1; }

if ! command -v brew >/dev/null 2>&1; then
  say "Installing Homebrew (your Mac asks for your password once)"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi
eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv)"

if ! node -e "process.exit(+process.versions.node.split('.')[0]>=22?0:1)" >/dev/null 2>&1; then
  say "Installing Node.js 22"
  brew install node@22 && brew link --overwrite --force node@22
fi

if [ "${1:-}" = "doctor" ]; then
  exec node scripts/setup/run.mjs doctor "${@:2}"
fi

say "Installing CareerOS"
npm ci --no-audit --no-fund
say "Installing tools (skips anything already there)"
node scripts/setup/run.mjs install "$@"
say "All set. Run ./setup.sh doctor any time to check."
```

`Setup CareerOS.command`:
```bash
#!/usr/bin/env bash
# Double-click this file in Finder to set up CareerOS.
cd "$(dirname "$0")" && ./setup.sh
echo; read -r -p "Press Return to close this window."
```

Run: `chmod +x setup.sh "Setup CareerOS.command" scripts/setup/run.mjs`

- [ ] **Step 7: Run tests and a real doctor**

Run: `npx vitest run tests/setup.test.ts && node scripts/setup/run.mjs doctor`
Expected: tests PASS. Doctor prints one line per component (states depend on this Mac) and changes nothing.

- [ ] **Step 8: Document the pattern**

Add to the top of the "Rules" list in `docs/dependencies.md`:

```markdown
0. **One-click setup.** Every dependency is one file in `setup/components/<id>.json`
   (id, name, order, required, why, docs, per-OS `check` + `install`) plus a row in this file
   that mentions its id in backticks. `./setup.sh` (or double-click `Setup CareerOS.command`)
   installs what is missing and skips the rest; `./setup.sh doctor` only checks. A test fails if a
   component is missing from this file. Component ids: `node`, `claude-code`, `chrome`, `ffmpeg`,
   `python`, `supertonic`, `hyperframes`, `agent-browser`, `workspace`.
```

Add to `CLAUDE.md`: `- New dependency? Add setup/components/<id>.json and a row in docs/dependencies.md. Never ask users to install things by hand.`

Add to `README.md`: `Setup: double-click "Setup CareerOS.command" (or run ./setup.sh). Check health: ./setup.sh doctor.`

- [ ] **Step 9: Commit**

```bash
git add setup.sh "Setup CareerOS.command" setup scripts/setup tests/setup.test.ts docs/dependencies.md CLAUDE.md README.md
git commit -m "feat: one-click setup pattern (component manifests, idempotent runner, doctor, double-click installer)"
```

---

## Self-review notes

- Spec coverage: layout (§4) Tasks 2, 5; records (§5) Task 3; eligibility and pinning Task 7; extensibility (§6) Tasks 3, 4, 10; library and CLI (§7) Tasks 4-13; index Task 8; migration of the legacy folder (§8) Task 12; privacy (§9) Tasks 14-16; testing (§10) every task plus Task 16 CI. Inbox flow Task 11. Locked folders Task 5. One-click setup pattern (dependencies.md rule) Task 17; the guided UI wizard on top of it is sub-project 4.
- Deferred by design to later sub-projects: sponsor likelihood scoring, work-rights scanning of ad text, sourcing connectors, UI, installer, videos.
