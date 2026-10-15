/** Line and word diffs for versions and AI suggestions. Pure; output is text only. */

export interface DiffPart { op: "same" | "add" | "del"; text: string }

/** Above this many cells the LCS table is skipped and the diff is "all removed, all added". */
const MAX_CELLS = 4_000_000;

function lcs(a: string[], b: string[]): DiffPart[] {
  // Trim the common head and tail first: most edits touch a few lines.
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let e = 0;
  while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  const A = a.slice(s, a.length - e);
  const B = b.slice(s, b.length - e);
  const head = a.slice(0, s).map((text) => ({ op: "same" as const, text }));
  const tail = a.slice(a.length - e).map((text) => ({ op: "same" as const, text }));
  let mid: DiffPart[];
  if (A.length * B.length > MAX_CELLS) {
    mid = [...A.map((text) => ({ op: "del" as const, text })), ...B.map((text) => ({ op: "add" as const, text }))];
  } else {
    const n = A.length, m = B.length;
    const t = new Uint32Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
      t[i * (m + 1) + j] = A[i] === B[j] ? t[(i + 1) * (m + 1) + j + 1]! + 1 : Math.max(t[(i + 1) * (m + 1) + j]!, t[i * (m + 1) + j + 1]!);
    }
    mid = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) { mid.push({ op: "same", text: A[i]! }); i++; j++; }
      else if (t[(i + 1) * (m + 1) + j]! >= t[i * (m + 1) + j + 1]!) mid.push({ op: "del", text: A[i++]! });
      else mid.push({ op: "add", text: B[j++]! });
    }
    while (i < n) mid.push({ op: "del", text: A[i++]! });
    while (j < m) mid.push({ op: "add", text: B[j++]! });
  }
  return [...head, ...mid, ...tail];
}

export function diffLines(a: string, b: string): DiffPart[] {
  return lcs(a.split(/\r?\n/), b.split(/\r?\n/));
}

/** Word diff with adjacent parts of the same kind merged, for showing a suggestion inline. */
export function diffWords(a: string, b: string): DiffPart[] {
  const tok = (s: string) => s.split(/(\s+)/).filter((x) => x !== "");
  const out: DiffPart[] = [];
  for (const p of lcs(tok(a), tok(b))) {
    const last = out.at(-1);
    if (last && last.op === p.op) last.text += p.text; else out.push({ ...p });
  }
  return out;
}

export function diffStats(parts: DiffPart[]): { added: number; removed: number } {
  return { added: parts.filter((p) => p.op === "add").length, removed: parts.filter((p) => p.op === "del").length };
}
