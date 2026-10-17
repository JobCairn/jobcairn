import fs from "node:fs";
import path from "node:path";
import { iso, type Clock } from "./clock.js";
import { insideRoot, layout } from "./paths.js";
import { writeFileAtomic } from "./store.js";

/**
 * Facts the person confirmed (a stretch bullet they said is true, a fact from their note, a correction in a chat),
 * kept in me/history/confirmed-facts.md so every later claim check finds them as evidence instead of stripping them as
 * made up. Only the person adds facts: the app on a click, or the careeros CLI. Claude never writes to me/.
 * See docs/specs/2026-10-17-resume-checks.md.
 */

export const CONFIRMED_FACTS_NAME = "confirmed-facts.md";
export const MAX_FACT_CHARS = 500;
const MAX_FILE_BYTES = 512 * 1024;
const HEADER = "# Confirmed facts\n\nFacts I confirmed while tailoring or reviewing applications. Each one is true and may be used as evidence.\n\n";

const flat = (s: string) => s.replace(/\s+/g, " ").trim();

/** One line of the file: "- <fact> (confirmed <day>, <where>)". */
export function confirmedFactLine(fact: string, day: string, from: string): string {
  const where = flat(from);
  return `- ${flat(fact)} (confirmed ${day}${where ? `, ${where}` : ""})`;
}

/** me/history/confirmed-facts.md, relative to the workspace. */
export const confirmedFactsRel = () => `me/history/${CONFIRMED_FACTS_NAME}`;

/**
 * Adds one fact. Returns false when the same fact is already there (any date, any source), true when it was added.
 * The history folder must be a plain folder in the workspace and the file a plain, single-named file (or missing).
 */
export function addConfirmedFact(root: string, fact: string, from: string, c?: Clock): boolean {
  const text = flat(fact);
  if (!text) throw new Error("The fact is empty.");
  if (text.length > MAX_FACT_CHARS) throw new Error(`Keep the fact under ${MAX_FACT_CHARS} characters.`);
  const dir = layout(root).me("history");
  const bad = () => new Error("me/history isn't a plain folder in the workspace, so the fact wasn't saved.");
  try {
    const st = fs.lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) throw bad();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!insideRoot(root, dir)) throw bad();
  const file = path.join(dir, CONFIRMED_FACTS_NAME);
  let cur = "";
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.nlink !== 1 || st.size > MAX_FILE_BYTES) throw new Error(`${confirmedFactsRel()} isn't a plain file, so the fact wasn't saved.`);
    cur = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const key = text.toLowerCase();
  if (cur.split("\n").some((l) => l.startsWith("- ") && l.slice(2).toLowerCase().replace(/ \(confirmed \d{4}-\d{2}-\d{2}[^)]*\)$/, "") === key)) return false;
  const day = iso(c).slice(0, 10);
  const base = cur ? (cur.endsWith("\n") ? cur : `${cur}\n`) : HEADER;
  writeFileAtomic(file, `${base}${confirmedFactLine(text, day, from)}\n`);
  return true;
}
