// Plain-SVG charts for Home. Each chart also renders its data as a visually hidden table, and
// sponsorship classes use a marker shape as well as a colour.
import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Button, Card, Text, SectionTitle, Icons } from "@careeros/brand";
import { WR_LABEL_TEXT, type HomeAnalytics, type JobRef, type MapPoint, type WeekBar, type WorkRightsLabel } from "@careeros/contract";
import { fmtDate, plural } from "../format";
import { navigate } from "../router";
import { ScoreMany } from "./runs";

const openJob = (j: JobRef) => navigate({ screen: "job", slug: j.company_slug, id: j.id });

/**
 * The drawn width of a chart's box, so the SVG's viewBox can match it 1:1. Axis text then renders at its CSS size
 * at any card width, instead of growing with the card. Falls back to `fallback` until measured (and in tests).
 */
function useBoxWidth(ref: RefObject<HTMLElement | null>, fallback: number): number {
  const [w, setW] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return undefined;
    const read = () => { const next = Math.round(el.getBoundingClientRect().width); if (next > 0) setW(next); };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

/** A marker per sponsorship class: circle, diamond, square, cross. */
export function Marker({ label, x, y, r, hollow }: { label: WorkRightsLabel; x: number; y: number; r: number; hollow?: boolean }) {
  const cls = `mark wr--${label}${hollow ? " mark--hollow" : ""}`;
  switch (label) {
    case "sponsorship_offered": return <circle className={cls} cx={x} cy={y} r={r} />;
    case "visa_ok": return <rect className={cls} x={x - r} y={y - r} width={r * 2} height={r * 2} transform={`rotate(45 ${x} ${y})`} />;
    case "silent": return <rect className={cls} x={x - r * 0.85} y={y - r * 0.85} width={r * 1.7} height={r * 1.7} />;
    default: return <path className={cls} d={`M${x - r} ${y - r}L${x + r} ${y + r}M${x + r} ${y - r}L${x - r} ${y + r}`} />;
  }
}

function LegendSwatch({ label }: { label: WorkRightsLabel }) {
  return <svg className="swatch" viewBox="0 0 12 12" aria-hidden="true"><Marker label={label} x={6} y={6} r={4} /></svg>;
}

// ---- Opportunity map ----------------------------------------------------------------------

const MAP_MAX = 480, PAD = { l: 40, r: 10, t: 12, b: 34 };

export function OpportunityMap({ map, sponsorship = true }: { map: HomeAnalytics["map"]; sponsorship?: boolean }) {
  const [active, setActive] = useState<MapPoint | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const W = Math.min(MAP_MAX, useBoxWidth(box, 320));
  const H = Math.round(W * 0.62);
  const sx = (v: number) => PAD.l + (v / 100) * (W - PAD.l - PAD.r);
  const sy = (v: number) => H - PAD.b - (v / 100) * (H - PAD.t - PAD.b);
  const labels = [...new Set(map.points.map((p) => p.wr_label))];
  const firstUnscored = map.unscored.slice(0, 5);
  // The map plots sponsor score, so without sponsorship only the scoring strip is left (or nothing).
  if (!sponsorship) {
    if (!map.unscored.length) return null;
    return (
      <Card aria-label="Not scored yet" className="home-card">
        <div className="home-card__head">
          <SectionTitle icon={Icons.jobs} title="Not scored yet" />
          <Text role="body-sm" muted>Next up ranks roles by fit, so score these first.</Text>
        </div>
        <UnscoredStrip unscored={map.unscored} first={firstUnscored} />
      </Card>
    );
  }
  return (
    <Card aria-label="Opportunity map" className="home-card">
      <div className="home-card__head">
        <SectionTitle icon={Icons.company} title="Opportunity map" />
        <Text role="body-sm" muted>Sponsor score across, fit down the side.</Text>
      </div>
      {map.points.length === 0 ? (
        <Text role="body-sm" muted>Roles appear here once they have a fit score and a sponsor score.</Text>
      ) : (
        <div className="chart-box" ref={box}>
          <svg className="chart map" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${plural(map.points.length, "scored role")} by sponsor score and fit`}>
            <rect className="map__quadrant" x={sx(50)} y={sy(100)} width={sx(100) - sx(50)} height={sy(50) - sy(100)} />
            <text className="map__quadrant-label" x={sx(100) - 4} y={sy(100) + 12} textAnchor="end">Apply first</text>
            {[0, 50, 100].map((v) => (
              <g key={v}>
                <line className="axis-line" x1={sx(v)} x2={sx(v)} y1={sy(0)} y2={sy(100)} />
                <line className="axis-line" x1={sx(0)} x2={sx(100)} y1={sy(v)} y2={sy(v)} />
                <text className="axis-text" x={sx(v)} y={H - PAD.b + 14} textAnchor="middle">{v}</text>
                <text className="axis-text" x={PAD.l - 6} y={sy(v) + 4} textAnchor="end">{v}</text>
              </g>
            ))}
            <text className="axis-title" x={(sx(0) + sx(100)) / 2} y={H - 3} textAnchor="middle">Sponsor score</text>
            <text className="axis-title" x={8} y={(sy(0) + sy(100)) / 2} textAnchor="middle" transform={`rotate(-90 8 ${(sy(0) + sy(100)) / 2})`}>Fit</text>
            {map.points.map((p) => (
              <g key={`${p.company_slug}/${p.id}`} className={`map__dot${active === p ? " is-active" : ""}`} role="link" tabIndex={0}
                aria-label={`${p.title} at ${p.company_name}: fit ${p.fit}, sponsor ${p.sponsor}, ${WR_LABEL_TEXT[p.wr_label]}${p.applied ? ", applied" : ""}`}
                onMouseEnter={() => setActive(p)} onMouseLeave={() => setActive(null)} onFocus={() => setActive(p)} onBlur={() => setActive(null)}
                onClick={() => openJob(p)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openJob(p); } }}>
                <title>{`${p.title} · ${p.company_name}`}</title>
                <circle className="map__hit" cx={sx(p.sponsor)} cy={sy(p.fit)} r={9} />
                <Marker label={p.wr_label} x={sx(p.sponsor)} y={sy(p.fit)} r={4.5} hollow={p.applied} />
              </g>
            ))}
          </svg>
          <p className="map__caption t-body-sm" aria-live="polite">
            {active ? <><strong>{active.title}</strong> at {active.company_name} · fit {active.fit} · sponsor {active.sponsor}</> : <span className="t-muted">Point at a role to see it. Click to open it. Hollow marks are applied.</span>}
          </p>
          <ul className="legend" aria-label="Map legend">
            {labels.map((l) => <li key={l}><LegendSwatch label={l} />{WR_LABEL_TEXT[l]}</li>)}
          </ul>
          <div className="sr-only">
            <table>
              <caption>Scored roles</caption>
              <thead><tr><th>Role</th><th>Company</th><th>Fit</th><th>Sponsor score</th><th>Work rights</th></tr></thead>
              <tbody>{map.points.map((p) => <tr key={`${p.company_slug}/${p.id}`}><td>{p.title}</td><td>{p.company_name}</td><td>{p.fit}</td><td>{p.sponsor}</td><td>{WR_LABEL_TEXT[p.wr_label]}</td></tr>)}</tbody>
            </table>
          </div>
        </div>
      )}
      {map.unscored.length ? <UnscoredStrip unscored={map.unscored} first={firstUnscored} /> : null}
    </Card>
  );
}

/** "N roles not scored yet" with one button that asks Claude to score the first few. */
function UnscoredStrip({ unscored, first }: { unscored: JobRef[]; first: JobRef[] }) {
  return (
    <div className="unscored" aria-label="Not scored yet">
      <div className="unscored__text">
        <Text role="body-sm"><strong>{plural(unscored.length, "role")}</strong> not scored yet</Text>
        <Text role="body-sm" muted>{first.map((j) => j.title).join(", ")}{unscored.length > first.length ? ", and more" : ""}</Text>
      </div>
      <ScoreMany jobs={first} ariaLabel={`Score ${first.length === unscored.length ? "these roles" : `the first ${first.length} roles`}`} />
    </div>
  );
}

// ---- Weekly activity ----------------------------------------------------------------------

const AH = 160, AP = { l: 26, r: 4, t: 10, b: 24 };

/** A bar with rounded data end (top) and a square end on the baseline; nothing for a zero value. */
function barPath(x: number, w: number, top: number, base: number): string {
  const h = base - top;
  if (h <= 0) return "";
  const r = Math.min(2, w / 2, h);
  return `M${x} ${base}V${top + r}Q${x} ${top} ${x + r} ${top}H${x + w - r}Q${x + w} ${top} ${x + w} ${top + r}V${base}Z`;
}

export function WeeklyActivity({ weeks, goal }: { weeks: WeekBar[]; goal: number | null }) {
  const box = useRef<HTMLDivElement>(null);
  const AW = useBoxWidth(box, 360);
  const max = Math.max(1, goal ?? 0, ...weeks.flatMap((w) => [w.found, w.applied]));
  const top = Math.ceil(max / 5) * 5;
  const band = (AW - AP.l - AP.r) / weeks.length;
  // Bars stay slim on a wide card: at most 14px each, centred in their week.
  const bw = Math.min(14, Math.max(3, (band - 6) / 2));
  const inset = (band - bw * 2 - 2) / 2;
  const y = (v: number) => AH - AP.b - (v / top) * (AH - AP.t - AP.b);
  const total = weeks.reduce((s, w) => ({ found: s.found + w.found, applied: s.applied + w.applied }), { found: 0, applied: 0 });
  const label = (iso: string) => fmtDate(`${iso}T12:00:00.000Z`).replace(/ \d{4}$/, "");
  return (
    <Card aria-label="Weekly activity" className="home-card">
      <div className="home-card__head">
        <SectionTitle icon={Icons.activity} title="Weekly activity" />
        <Text role="body-sm" muted>Last {weeks.length} weeks: {plural(total.found, "role")} found, {plural(total.applied, "application")} sent.</Text>
      </div>
      {total.found + total.applied === 0 ? <Text role="body-sm" muted>No activity in the last {weeks.length} weeks.</Text> : (
        <div className="chart-box" ref={box}>
          <svg className="chart activity" viewBox={`0 0 ${AW} ${AH}`} role="img" aria-label="Roles found and applications sent each week">
            {[0, top / 2, top].map((v) => (
              <g key={v}><line className="axis-line" x1={AP.l} x2={AW - AP.r} y1={y(v)} y2={y(v)} /><text className="axis-text" x={AP.l - 5} y={y(v) + 4} textAnchor="end">{v}</text></g>
            ))}
            {weeks.map((w, i) => {
              const x0 = AP.l + i * band + inset;
              return (
                <g key={w.week}>
                  <title>{`Week of ${label(w.week)}: ${w.found} found, ${w.applied} applied`}</title>
                  <path className="bar bar--found" d={barPath(x0, bw - 1, y(w.found), y(0))} />
                  <path className="bar bar--applied" d={barPath(x0 + bw + 1, bw - 1, y(w.applied), y(0))} />
                  {i % 3 === 0 || i === weeks.length - 1 ? <text className="axis-text" x={x0 + bw} y={AH - 6} textAnchor="middle">{label(w.week)}</text> : null}
                </g>
              );
            })}
            {goal ? <line className="goal-line" x1={AP.l} x2={AW - AP.r} y1={y(goal)} y2={y(goal)} /> : null}
          </svg>
          <ul className="legend" aria-label="Activity legend">
            <li><span className="key key--found" aria-hidden="true" />Found</li>
            <li><span className="key key--applied" aria-hidden="true" />Applied</li>
            {goal ? <li><span className="key key--goal" aria-hidden="true" />Goal {goal} a week</li> : null}
          </ul>
          <div className="sr-only">
            <table>
              <caption>Weekly activity</caption>
              <thead><tr><th>Week of</th><th>Found</th><th>Applied</th></tr></thead>
              <tbody>{weeks.map((w) => <tr key={w.week}><td>{label(w.week)}</td><td>{w.found}</td><td>{w.applied}</td></tr>)}</tbody>
            </table>
          </div>
        </div>
      )}
    </Card>
  );
}

// ---- Sponsorship mix ----------------------------------------------------------------------

/**
 * What the ads say about work rights. For people who need sponsorship it is the headline card; with a temporary
 * visa (`plain`) it is background info.
 */
export function SponsorshipMix({ mix, plain = false }: { mix: HomeAnalytics["mix"]; plain?: boolean }) {
  const total = mix.reduce((s, m) => s + m.count, 0);
  const go = (label: WorkRightsLabel) => navigate({ screen: "jobs", label });
  return (
    <Card aria-label="Sponsorship mix" className="home-card" data-tour="home-mix">
      <div className="home-card__head">
        <SectionTitle icon={Icons.sponsors} title="Sponsorship mix" />
        <Text role="body-sm" muted>{plain ? `For your information: what ${plural(total, "ad")} say about work rights and sponsorship. Click to see them.` : `What ${plural(total, "ad")} say about visas. Click to see them.`}</Text>
      </div>
      {total === 0 ? <Text role="body-sm" muted>No roles yet.</Text> : (
        <>
          <div className="mix-bar">
            {mix.map((m) => (
              <button key={m.label} type="button" className={`mix-bar__seg wr--${m.label}`} style={{ flexGrow: m.count }}
                aria-label={`${WR_LABEL_TEXT[m.label]}: ${plural(m.count, "role")}. Show them`} onClick={() => go(m.label)} title={`${WR_LABEL_TEXT[m.label]}: ${m.count}`} />
            ))}
          </div>
          <ul className="mix-legend">
            {mix.map((m) => (
              <li key={m.label}>
                <button type="button" className="mix-legend__item" onClick={() => go(m.label)}>
                  <LegendSwatch label={m.label} /><span className="grow">{WR_LABEL_TEXT[m.label]}</span><span className="num">{m.count}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}
