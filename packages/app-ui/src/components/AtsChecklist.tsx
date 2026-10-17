import { Icon, Icons, Text } from "@careeros/brand";
import { useLoad } from "../bridge-context";
import { fmtDateTime } from "../format";

/**
 * The ATS check of the exported resume: what an applicant tracking system reads from the PDF (or Word file) the app
 * made, as a compact pass/warn list. Checked again whenever the resume is exported (spec 2026-10-17-resume-checks).
 */
export function AtsChecklist({ slug, id }: { slug: string; id: string }) {
  const st = useLoad((b) => b.docs.state(slug, id), [slug, id], ["jobs"]);
  // The check reads the file, so it runs again only when the export itself changes, not on every save.
  const made = (st.data?.files ?? []).filter((f) => f.source === "resume" && f.exists).map((f) => `${f.name}@${f.at}`).join(",");
  const chk = useLoad((b) => (st.data ? b.docs.check(slug, id) : Promise.resolve(null)), [slug, id, made, !!st.data], []);
  const head = <Text role="label" as="div">ATS check</Text>;
  if (!st.data || (chk.loading && !chk.data)) return null;
  if (chk.error) return <div className="stack-tight ats-check">{head}<Text role="body-sm" muted>The check didn&apos;t run: {chk.error}</Text></div>;
  const c = chk.data;
  if (!c) return <div className="stack-tight ats-check">{head}<Text role="body-sm" muted>Export your resume to see how an applicant tracking system reads it.</Text></div>;
  const warns = c.items.filter((i) => i.status === "warn").length;
  return (
    <div className="stack-tight ats-check" aria-label="ATS check">
      {head}
      <Text role="body-sm" muted>
        {`What a tracking system reads from ${c.file}${c.at ? `, made ${fmtDateTime(c.at)}` : ""}. `}
        {warns ? `${warns} to look at.` : "All clear."}
      </Text>
      {c.stale ? <Text role="body-sm" className="ats-check__stale">Your resume changed after this export. Export it again to check the latest.</Text> : null}
      <ul className="list-plain ats-check__list">
        {c.items.map((i) => (
          <li key={i.id} className={`ats-check__item is-${i.status}`}>
            <Icon icon={i.status === "pass" ? Icons.check : Icons.watchOut} size="sm" />
            <span>
              <Text role="body-sm" as="span"><strong>{i.label}</strong>{i.status === "pass" ? <span className="sr-only"> (pass)</span> : " (check)"}</Text>
              <Text role="body-sm" muted as="div">{i.detail}</Text>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
