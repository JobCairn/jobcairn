import { Icon, Icons, Pill, Text } from "@careeros/brand";
import { RESEARCH_DISCLAIMER, type ResearchChart, type ResearchReport, type ResearchSource } from "@careeros/contract";
import { ExternalLink, hostLabel } from "../components/ExternalLink";
import { fmtDayOf } from "../reading/dates";

/**
 * A research report drawn from report.json (spec 2026-10-17-research-any-topic). Every value is React text: nothing
 * Claude wrote is ever read as HTML. Footnotes link to the numbered sources at the end, which open in the browser.
 */

/** Footnote marks for a list of source ids, each a link to its source. Ids the report doesn't list are left out. */
function Cites({ ids, known }: { ids: readonly number[] | undefined; known: ReadonlySet<number> }) {
  const shown = (ids ?? []).filter((n) => known.has(n));
  if (!shown.length) return null;
  return (
    <sup className="rr-cite">
      {shown.map((n) => <a key={n} href={`#rr-source-${n}`} aria-label={`Source ${n}`} onClick={(e) => { e.preventDefault(); jump(n); }}>[{n}]</a>)}
    </sup>
  );
}

function jump(n: number) {
  const el = document.getElementById(`rr-source-${n}`);
  el?.scrollIntoView?.({ behavior: "smooth", block: "center" });
  el?.classList.add("rr-source--flash");
  setTimeout(() => el?.classList.remove("rr-source--flash"), 1200);
}

const fmtNumber = (n: number) => n.toLocaleString("en-AU", { maximumFractionDigits: 2 });

/** Horizontal bars scaled to the largest value: label, bar, value and unit. */
export function BarChart({ chart, known }: { chart: ResearchChart; known: ReadonlySet<number> }) {
  const max = Math.max(0, ...chart.bars.map((b) => b.value));
  return (
    <figure className="rr-chart">
      <figcaption className="rr-chart__title">
        <Text role="label" as="span">{chart.title}</Text><Cites ids={chart.sources} known={known} />
      </figcaption>
      <ul className="rr-bars">
        {chart.bars.map((b, i) => {
          const pct = max > 0 ? Math.max(1, Math.round((b.value / max) * 1000) / 10) : 0;
          return (
            <li key={`${b.label}-${i}`} className="rr-bar">
              <span className="rr-bar__label">{b.label}</span>
              <span className="rr-bar__track" aria-hidden="true"><span className="rr-bar__fill" style={{ width: `${pct}%` }} /></span>
              <span className="rr-bar__value t-numeric">{fmtNumber(b.value)}{chart.unit ? ` ${chart.unit}` : ""}</span>
            </li>
          );
        })}
      </ul>
      {chart.note ? <Text role="body-sm" muted as="p" className="rr-note">{chart.note}</Text> : null}
    </figure>
  );
}

function Source({ s }: { s: ResearchSource }) {
  return (
    <li id={`rr-source-${s.id}`} className="rr-source">
      <span className="rr-source__n t-numeric">{s.id}</span>
      <div className="rr-source__body">
        <ExternalLink href={s.url} className="rr-source__link">{s.title}</ExternalLink>
        <span className="rr-source__meta t-body-sm t-muted">
          {[s.publisher, hostLabel(s.url), s.accessed ? `read ${fmtDayOf(s.accessed) || s.accessed}` : ""].filter(Boolean).join(" · ")}
        </span>
      </div>
      {s.official ? <Pill tone="success">Official</Pill> : null}
    </li>
  );
}

const CONFIDENCE = { high: "High confidence", medium: "Medium confidence", low: "Low confidence" } as const;

export function ReportView({ report: r, stale }: { report: ResearchReport; stale?: boolean }) {
  const known = new Set(r.sources.map((s) => s.id));
  const official = r.sources.filter((s) => s.official).length;
  return (
    <article className="rr" aria-label={r.title}>
      <header className="rr-head">
        <p className="t-label rr-kicker"><Icon icon={Icons.research} size="sm" />Research report</p>
        <Text role="heading-1" className="rr-title">{r.title}</Text>
        <div className="rr-meta">
          <Pill tone={stale ? "warning" : "neutral"}>{`As of ${fmtDayOf(r.as_of) || r.as_of}`}</Pill>
          {stale ? <Pill tone="warning">Needs refresh</Pill> : null}
          {r.confidence ? <Pill tone={r.confidence === "low" ? "warning" : "neutral"}>{CONFIDENCE[r.confidence]}</Pill> : null}
          <span className="t-body-sm t-muted">{`${r.sources.length} ${r.sources.length === 1 ? "source" : "sources"}${official ? `, ${official} official` : ""}`}</span>
        </div>
      </header>

      <section className="rr-summary" aria-label="Summary">
        <Text role="body" as="p" className="rr-summary__text">{r.summary}</Text>
        {r.changes_often ? (
          <p className="rr-callout rr-callout--warn"><Icon icon={Icons.watchOut} size="sm" /><span>{r.changes_often}</span></p>
        ) : null}
      </section>

      {r.key_facts?.length ? (
        <section className="rr-section" aria-labelledby="rr-facts">
          <Text role="heading-2" id="rr-facts" className="rr-h2">Key figures</Text>
          <div className="rr-tiles">
            {r.key_facts.map((f, i) => (
              <div key={`${f.label}-${i}`} className="rr-tile">
                <span className="rr-tile__label">{f.label}</span>
                <span className="rr-tile__value">{f.value}<Cites ids={f.sources} known={known} /></span>
                {f.detail ? <span className="rr-tile__detail">{f.detail}</span> : null}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {r.sections?.map((s, i) => (
        <section key={`${s.heading}-${i}`} className="rr-section" aria-labelledby={`rr-s-${i}`}>
          <Text role="heading-2" id={`rr-s-${i}`} className="rr-h2">{s.heading}<Cites ids={s.sources} known={known} /></Text>
          {s.paragraphs?.map((p, j) => <Text key={j} role="body" as="p" className="rr-p">{p}</Text>)}
          {s.bullets?.length ? <ul className="rr-list">{s.bullets.map((b, j) => <li key={j}>{b}</li>)}</ul> : null}
        </section>
      ))}

      {r.steps?.length ? (
        <section className="rr-section" aria-labelledby="rr-steps">
          <Text role="heading-2" id="rr-steps" className="rr-h2">Steps</Text>
          <ol className="rr-steps">
            {r.steps.map((s, i) => (
              <li key={`${s.title}-${i}`} className="rr-step">
                <span className="rr-step__n t-numeric" aria-hidden="true">{i + 1}</span>
                <div className="rr-step__body">
                  <div className="rr-step__head">
                    <span className="rr-step__title">{s.title}<Cites ids={s.sources} known={known} /></span>
                    {s.duration ? <span className="rr-step__time t-body-sm">{s.duration}</span> : null}
                  </div>
                  {s.detail ? <Text role="body-sm" muted as="p" className="rr-p">{s.detail}</Text> : null}
                </div>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {r.tables?.map((t, i) => (
        <section key={`${t.title}-${i}`} className="rr-section" aria-labelledby={`rr-t-${i}`}>
          <Text role="heading-2" id={`rr-t-${i}`} className="rr-h2">{t.title}<Cites ids={t.sources} known={known} /></Text>
          <div className="rr-table-wrap">
            <table className="rr-table">
              <thead><tr>{t.columns.map((c, j) => <th key={j} scope="col">{c}</th>)}</tr></thead>
              <tbody>
                {t.rows.map((row, j) => (
                  <tr key={j}>{row.map((c, k) => (k === 0 ? <th key={k} scope="row">{c}</th> : <td key={k}>{c}</td>))}</tr>
                ))}
              </tbody>
            </table>
          </div>
          {t.note ? <Text role="body-sm" muted as="p" className="rr-note">{t.note}</Text> : null}
        </section>
      ))}

      {r.charts?.length ? (
        <section className="rr-section" aria-label="Charts">
          <div className="rr-charts">{r.charts.map((c, i) => <BarChart key={`${c.title}-${i}`} chart={c} known={known} />)}</div>
        </section>
      ) : null}

      {r.uncertain?.length ? (
        <section className="rr-section" aria-labelledby="rr-unsure">
          <div className="rr-callout rr-callout--block">
            <Text role="heading-2" id="rr-unsure" className="rr-h3"><Icon icon={Icons.help} size="sm" />What we couldn't confirm</Text>
            <ul className="rr-list">{r.uncertain.map((u, i) => <li key={i}>{u}</li>)}</ul>
          </div>
        </section>
      ) : null}

      <section className="rr-section" aria-labelledby="rr-sources">
        <Text role="heading-2" id="rr-sources" className="rr-h2">Sources</Text>
        <ol className="rr-sources">{r.sources.map((s) => <Source key={s.id} s={s} />)}</ol>
      </section>

      <footer className="rr-foot t-body-sm t-muted">{RESEARCH_DISCLAIMER}</footer>
    </article>
  );
}
