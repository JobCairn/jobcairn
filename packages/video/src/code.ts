import { esc } from "./html.js";

export type TokenClass = "" | "k" | "s" | "n" | "f" | "c";

const words = (s: string) => new Set(s.split(" "));
const KEYWORDS: Record<string, Set<string>> = {
  ts: words("const let var function return if else for while do switch case break continue async await import from export default class new type interface extends implements of in try catch finally throw true false null undefined this typeof as"),
  py: words("def return if elif else for while import from as class with try except finally raise True False None lambda yield async await pass in not and or is global"),
  go: words("func return if else for range package import type struct interface go defer chan map var const nil true false switch case break continue"),
  sql: words("select from where join left right inner outer on group by order insert into values update set delete create table and or not null as limit having distinct count"),
  sh: words("if then else elif fi for in do done case esac function echo export local return while"),
  yaml: words("true false null yes no"),
};
const ALIASES: Record<string, string> = { typescript: "ts", tsx: "ts", javascript: "ts", js: "ts", jsx: "ts", python: "py", golang: "go", shell: "sh", bash: "sh", zsh: "sh", yml: "yaml" };
const HASH_COMMENT = new Set(["py", "sh", "yaml"]);

// Sticky ("y") regexes match only at `lastIndex`, in place, so a line is scanned left to right
// without ever slicing a fresh substring per character or per token - the only substrings created
// are the matched tokens themselves, so the total work is O(line length) even on a 100k-character
// hostile line (an unterminated string or comment is consumed in a single match/break, not
// character by character).
const STR_RE = /("([^"\\]|\\.)*"?|'([^'\\]|\\.)*'?|`([^`\\]|\\.)*`?)/y;
const NUM_RE = /\d+(\.\d+)?/y;
const ID_RE = /[A-Za-z_$][\w$]*/y;
const WS = /\s/;
const ALNUM_ = /[A-Za-z_]/;
const UPPER_FIRST = /^[A-Z]/;

export function tokenize(line: string, lang: string): { cls: TokenClass; text: string }[] {
  const l = ALIASES[lang.toLowerCase()] ?? lang.toLowerCase();
  const kw = KEYWORDS[l] ?? KEYWORDS.ts!;
  const out: { cls: TokenClass; text: string }[] = [];
  const push = (cls: TokenClass, text: string) => {
    const last = out.at(-1);
    if (last && last.cls === cls && cls === "") last.text += text; else out.push({ cls, text });
  };
  let i = 0;
  const n = line.length;
  while (i < n) {
    const c0 = line[i]!;
    const isLineComment =
      (c0 === "/" && line[i + 1] === "/" && !HASH_COMMENT.has(l)) ||
      (c0 === "#" && HASH_COMMENT.has(l)) ||
      (c0 === "-" && line[i + 1] === "-" && l === "sql");
    if (isLineComment) { push("c", line.slice(i)); break; }

    if (c0 === '"' || c0 === "'" || c0 === "`") {
      STR_RE.lastIndex = i;
      const str = STR_RE.exec(line);
      if (str && str.index === i) { push("s", str[0]); i += str[0].length; continue; }
    }

    if (c0 >= "0" && c0 <= "9") {
      const prev = i > 0 ? line[i - 1]! : "";
      if (!ALNUM_.test(prev)) {
        NUM_RE.lastIndex = i;
        const num = NUM_RE.exec(line);
        if (num && num.index === i) { push("n", num[0]); i += num[0].length; continue; }
      }
    }

    ID_RE.lastIndex = i;
    const id = ID_RE.exec(line);
    if (id && id.index === i) {
      const w = id[0];
      const isKw = l === "sql" ? kw.has(w.toLowerCase()) : kw.has(w);
      let j = i + w.length;
      while (j < n && WS.test(line[j]!)) j++;
      const isFn = line[j] === "(" || (UPPER_FIRST.test(w) && l !== "sql");
      push(isKw ? "k" : isFn ? "f" : "", w);
      i += w.length;
      continue;
    }

    push("", c0);
    i++;
  }
  return out;
}

export function highlightLine(line: string, lang: string): string {
  return tokenize(line, lang).map((t) => (t.cls ? `<span class="${t.cls}">${esc(t.text)}</span>` : esc(t.text))).join("");
}

/** One span per character, carrying its token colour, for the typing scene. */
export function typeLine(line: string, lang: string): string {
  return tokenize(line, lang).map((t) => [...t.text].map((ch) => `<span class="ch${t.cls ? ` ${t.cls}` : ""}">${esc(ch)}</span>`).join("")).join("");
}

// Above this many lines per side, the O(a x b) alignment table would be too large (and too slow)
// to be worth it for a diff nobody can read anyway; fall back to a simple all-delete/all-add split
// so a hostile or oversized before/after pair can never blow up memory or time.
const DIFF_CAP = 2000;

export function diffLines(a: string[], b: string[]): { op: "same" | "add" | "del"; text: string }[] {
  if (a.length > DIFF_CAP || b.length > DIFF_CAP) {
    return [...a.map((text) => ({ op: "del" as const, text })), ...b.map((text) => ({ op: "add" as const, text }))];
  }
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  }
  const out: { op: "same" | "add" | "del"; text: string }[] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push({ op: "same", text: a[i]! }); i++; j++; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) out.push({ op: "del", text: a[i++]! });
    else out.push({ op: "add", text: b[j++]! });
  }
  while (i < a.length) out.push({ op: "del", text: a[i++]! });
  while (j < b.length) out.push({ op: "add", text: b[j++]! });
  return out;
}
