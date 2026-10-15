/**
 * A small, deterministic diagram layout (no dependency): layered left-to-right for architecture, pipeline and user
 * flow diagrams, a ring for a mesh. Diagrams have at most 8 nodes, so simple passes are enough and every result is
 * the same for the same input (the renderer seeks frame by frame; nothing here may vary between runs).
 */
export interface LNode { id: string; w: number; h: number; group?: string }
/** `lead`: a straight run (px) out of the source before the curve, for a label to sit on (forward edges). */
export interface LEdge { from: string; to: string; lead?: number }
export interface Placed { id: string; x: number; y: number; w: number; h: number; rank: number }
export interface Box { x: number; y: number; w: number; h: number }
export interface Route { from: string; to: string; d: string; end: { x: number; y: number; angle: number }; mid: { x: number; y: number };
  /** Where an edge label goes, clear of the line: on the far side of a forward edge's straight lead-out from where its curve turns, beside a straight edge. */
  label: { x: number; y: number; align: "start" | "middle" } }
export interface Layout { nodes: Placed[]; edges: Route[]; groups: { id: string; box: Box }[] }

const r1 = (x: number) => Math.round(x * 10) / 10;

/** Longest-path ranks from the sources, ignoring edges that would close a cycle (kept in input order). */
export function ranks(nodes: LNode[], edges: LEdge[]): Map<string, number> {
  const ids = nodes.map((n) => n.id);
  const out = new Map<string, string[]>(ids.map((id) => [id, []]));
  const indeg = new Map<string, number>(ids.map((id) => [id, 0]));
  // Drop back edges: an edge whose target can already reach its source.
  const reach = (a: string, b: string, seen = new Set<string>()): boolean => {
    if (a === b) return true;
    if (seen.has(a)) return false;
    seen.add(a);
    return (out.get(a) ?? []).some((n) => reach(n, b, seen));
  };
  for (const e of edges) {
    if (!out.has(e.from) || !out.has(e.to) || e.from === e.to || reach(e.to, e.from)) continue;
    out.get(e.from)!.push(e.to);
    indeg.set(e.to, indeg.get(e.to)! + 1);
  }
  const rank = new Map<string, number>(ids.map((id) => [id, 0]));
  const queue = ids.filter((id) => indeg.get(id) === 0);
  const left = new Map(indeg);
  while (queue.length) {
    const id = queue.shift()!;
    for (const n of out.get(id)!) {
      rank.set(n, Math.max(rank.get(n)!, rank.get(id)! + 1));
      left.set(n, left.get(n)! - 1);
      if (left.get(n) === 0) queue.push(n);
    }
  }
  return rank;
}

/** Layered layout inside `area`. Columns are ranks; inside a column nodes sit in input order, nudged towards the
 * average row of their parents (one barycentre pass), centred vertically. */
export function layered(nodes: LNode[], edges: LEdge[], area: Box): Layout {
  const rank = ranks(nodes, edges);
  const cols = Math.max(...nodes.map((n) => rank.get(n.id)!)) + 1;
  const byCol: LNode[][] = Array.from({ length: cols }, () => []);
  for (const n of nodes) byCol[rank.get(n.id)!]!.push(n);
  const colW = area.w / cols;
  const pos = new Map<string, number>(); // row index per node, for the barycentre pass
  byCol.forEach((col, c) => {
    if (c > 0) {
      const bary = (n: LNode) => {
        const ps = edges.filter((e) => e.to === n.id && pos.has(e.from)).map((e) => pos.get(e.from)!);
        return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : Number.POSITIVE_INFINITY;
      };
      col.sort((a, b) => { const d = bary(a) - bary(b); return Number.isFinite(d) && d !== 0 ? d : nodes.indexOf(a) - nodes.indexOf(b); });
    }
    col.forEach((n, k) => pos.set(n.id, k - (col.length - 1) / 2));
  });
  const placed: Placed[] = [];
  byCol.forEach((col, c) => {
    const gap = 56;
    const total = col.reduce((a, n) => a + n.h, 0) + gap * (col.length - 1);
    let y = area.y + (area.h - total) / 2;
    for (const n of col) {
      const w = Math.min(n.w, colW - 64);
      placed.push({ id: n.id, x: r1(area.x + colW * c + (colW - w) / 2), y: r1(y), w: r1(w), h: n.h, rank: c });
      y += n.h + gap;
    }
  });
  placed.sort((a, b) => nodes.findIndex((n) => n.id === a.id) - nodes.findIndex((n) => n.id === b.id));
  return { nodes: placed, edges: routes(placed, edges, "layered"), groups: groupBoxes(nodes, placed) };
}

/** A ring: node 1 at the top, the rest clockwise. */
export function ring(nodes: LNode[], edges: LEdge[], area: Box): Layout {
  const cx = area.x + area.w / 2, cy = area.y + area.h / 2;
  const rad = Math.min(area.w, area.h) / 2 - Math.max(...nodes.map((n) => Math.max(n.w, n.h))) / 2;
  const placed = nodes.map((n, k) => {
    const a = -Math.PI / 2 + (2 * Math.PI * k) / nodes.length;
    return { id: n.id, x: r1(cx + rad * Math.cos(a) - n.w / 2), y: r1(cy + rad * Math.sin(a) - n.h / 2), w: n.w, h: n.h, rank: 0 };
  });
  const all = edges.length ? edges : nodes.flatMap((a, i) => nodes.slice(i + 1).map((b) => ({ from: a.id, to: b.id })));
  return { nodes: placed, edges: routes(placed, all, "straight"), groups: groupBoxes(nodes, placed) };
}

function center(p: Placed) { return { x: p.x + p.w / 2, y: p.y + p.h / 2 }; }

/** Where the line from a box's centre towards `to` leaves the box. */
function exitPoint(p: Placed, to: { x: number; y: number }): { x: number; y: number } {
  const c = center(p), dx = to.x - c.x, dy = to.y - c.y;
  if (!dx && !dy) return c;
  const sx = dx ? (p.w / 2) / Math.abs(dx) : Number.POSITIVE_INFINITY, sy = dy ? (p.h / 2) / Math.abs(dy) : Number.POSITIVE_INFINITY;
  const s = Math.min(sx, sy);
  return { x: c.x + dx * s, y: c.y + dy * s };
}

function routes(placed: Placed[], edges: LEdge[], style: "layered" | "straight"): Route[] {
  const at = new Map(placed.map((p) => [p.id, p]));
  return edges.flatMap((e): Route[] => {
    const a = at.get(e.from), b = at.get(e.to);
    if (!a || !b) return [];
    const forward = style === "layered" && b.rank > a.rank;
    if (forward) {
      const s = { x: a.x + a.w, y: a.y + a.h / 2 }, t = { x: b.x - 14, y: b.y + b.h / 2 };
      const lead = Math.max(0, Math.min(e.lead ?? 0, (t.x - s.x) * 0.7));
      const c0 = { x: s.x + lead, y: s.y };
      const k = (t.x - c0.x) / 2;
      const head = lead ? `M ${r1(s.x)} ${r1(s.y)} L ${r1(c0.x)} ${r1(c0.y)} C` : `M ${r1(s.x)} ${r1(s.y)} C`;
      return [{ from: e.from, to: e.to, d: `${head} ${r1(c0.x + k)} ${r1(c0.y)} ${r1(t.x - k)} ${r1(t.y)} ${r1(t.x)} ${r1(t.y)}`, end: { x: r1(t.x), y: r1(t.y), angle: 0 },
        mid: { x: r1((c0.x + t.x) / 2), y: r1((c0.y + t.y) / 2) }, label: { x: r1(s.x + 12), y: r1(t.y < s.y - 1 ? s.y + 26 : s.y - 26), align: "start" as const } }];
    }
    const s = exitPoint(a, center(b)), t0 = exitPoint(b, center(a));
    const len = Math.hypot(t0.x - s.x, t0.y - s.y) || 1;
    const t = { x: t0.x - ((t0.x - s.x) / len) * 14, y: t0.y - ((t0.y - s.y) / len) * 14 };
    const angle = Math.round((Math.atan2(t.y - s.y, t.x - s.x) * 180) / Math.PI);
    const mid = { x: (s.x + t.x) / 2, y: (s.y + t.y) / 2 };
    // Beside the line: 30px along its normal, on the upper side.
    let nx = -(t.y - s.y) / len, ny = (t.x - s.x) / len;
    if (ny > 0) { nx = -nx; ny = -ny; }
    return [{ from: e.from, to: e.to, d: `M ${r1(s.x)} ${r1(s.y)} L ${r1(t.x)} ${r1(t.y)}`, end: { x: r1(t.x), y: r1(t.y), angle }, mid: { x: r1(mid.x), y: r1(mid.y) },
      label: { x: r1(mid.x + nx * 30), y: r1(mid.y + ny * 30), align: "middle" as const } }];
  });
}

function groupBoxes(nodes: LNode[], placed: Placed[]): { id: string; box: Box }[] {
  const ids = [...new Set(nodes.map((n) => n.group).filter((g): g is string => !!g))];
  return ids.map((g) => {
    const ps = placed.filter((p) => nodes.find((n) => n.id === p.id)?.group === g);
    const pad = 28, top = 44;
    const x = Math.min(...ps.map((p) => p.x)) - pad, y = Math.min(...ps.map((p) => p.y)) - top;
    const x2 = Math.max(...ps.map((p) => p.x + p.w)) + pad, y2 = Math.max(...ps.map((p) => p.y + p.h)) + pad;
    return { id: g, box: { x: r1(x), y: r1(y), w: r1(x2 - x), h: r1(y2 - y) } };
  });
}
