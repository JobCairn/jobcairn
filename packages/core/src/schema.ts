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
