import { useMemo, useState } from "react";
import { Button, Card, Checkbox, Icons, Pill, Text } from "@careeros/brand";
import {
  AD_TERMS, CHIP_PATTERN, chipText, keywordGap, noteProblems, type ActionTarget, type CareerosBridge, type JobFile,
} from "@careeros/contract";
import { useAction, useBridge, useLoad } from "../bridge-context";
import { navigate } from "../router";

export interface ResumeText { text: string; label: string }

/** The resume to compare: this job's tailored resume when there is one, else the newest of the person's own resumes the app can read as text. */
export async function loadResumeText(b: CareerosBridge, files: JobFile[]): Promise<ResumeText | null> {
  const tailored = files.find((f) => f.path === "application/resume.md" && f.exists);
  if (tailored) {
    try { return { text: await b.files.readText(tailored.rel), label: "your tailored resume" }; } catch { /* fall back to your own resume */ }
  }
  const lib = await b.resumes.list();
  for (const r of [...lib.base].sort((x, y) => y.at.localeCompare(x.at))) {
    // A PDF has a plain-text copy beside it ("<name> (text).txt", made by Fill from my resume).
    if (/\.pdf$/i.test(r.rel)) {
      try { return { text: await b.files.readText(r.rel.replace(/\.pdf$/i, " (text).txt")), label: `your resume (${r.name})` }; } catch { continue; }
    }
    try {
      const p = await b.files.preview(r.rel);
      if (p.state === "ready" && p.text) return { text: p.text, label: `your resume (${r.name})` };
    } catch { /* try the next one */ }
  }
  return null;
}

/** A term made safe for a chip (no slashes or quotes), or "" when it can't be one. */
export function termChip(term: string): string {
  const c = chipText(term);
  return c && CHIP_PATTERN.test(c) && !noteProblems(c).length ? c : "";
}

/**
 * Job › Score: the keyword check. A local comparison of the ad with the resume (no Claude): a match share, and the
 * ad's hard skills and terms the resume shows in a strong spot, only in a weak spot, or not at all. The person ticks
 * the missing terms that are really true for them; "Use in tailoring" hands those to the tailor request.
 */
export function KeywordGapCard({ jd, files, target }: { jd: string; files: JobFile[]; target: Extract<ActionTarget, { kind: "job" }> | null }) {
  const bridge = useBridge();
  const { busy, run } = useAction();
  const resume = useLoad((b) => loadResumeText(b, files), [files.map((f) => `${f.rel}@${f.at}`).join("|")], ["jobs", "settings"]);
  const gap = useMemo(() => (resume.data ? keywordGap(jd, resume.data.text) : null), [jd, resume.data]);
  const [picked, setPicked] = useState<string[]>([]);

  if (!jd.trim()) return null;
  const head = <Text role="heading-2" as="h3">Keyword check</Text>;
  if (resume.loading && !resume.data) return <Card className="stack keyword-gap">{head}<Text role="body-sm" muted>Reading your resume…</Text></Card>;
  if (!resume.data || !gap) {
    return (
      <Card className="stack keyword-gap">{head}
        <Text role="body-sm" muted>Add your resume as a Word, text or Markdown file (Settings › Profile, Fill from my resume) to compare it with this ad.</Text>
      </Card>
    );
  }
  if (gap.match === null) {
    return <Card className="stack keyword-gap">{head}<Text role="body-sm" muted>This ad doesn't name hard skills the check knows.</Text></Card>;
  }
  const max = AD_TERMS.max;
  const toggle = (t: string) => setPicked((p) => (p.includes(t) ? p.filter((x) => x !== t) : p.length >= max ? p : [...p, t]));
  const sendToTailoring = () => run("ad-terms", async () => {
    if (!target) return;
    const view = await bridge.claude.compose("tailor_application", target);
    const chips = [...new Set(picked.map(termChip).filter(Boolean))].slice(0, max);
    await bridge.claude.saveOptions("tailor_application", target, { ...view.options, ad_terms: chips });
    navigate({ screen: "apply", slug: target.company_slug, id: target.id, step: "prepare" });
  });

  return (
    <Card className="stack keyword-gap" aria-label="Keyword check">
      <div className="row row--between">
        {head}
        <Pill tone={gap.match >= 70 ? "success" : gap.match >= 40 ? "warning" : "danger"}>{`${gap.match}% match`}</Pill>
      </div>
      <Text role="body-sm" muted>{`The ad's hard skills and terms, compared with ${resume.data.label}. Worked out on this computer; Claude isn't asked.`}</Text>
      <TermRow title="In a strong spot" help="In your headline, summary or a role's first bullets." terms={gap.present} tone="success" />
      <TermRow title="Only in a weak spot" help="Move these up to your summary or a role's first bullets, where a recruiter looks first." terms={gap.weak} tone="warning" />
      {gap.missing.length ? (
        <div className="stack-tight">
          <Text role="label" as="div">{`Missing (${gap.missing.length})`}</Text>
          <Text role="body-sm" as="p"><strong>Only add skills you really have.</strong> Tick the ones that are true for you and Claude works them in where your evidence backs them.</Text>
          <div className="keyword-gap__ticks">
            {gap.missing.map((t) => (
              <Checkbox key={t} label={t} checked={picked.includes(t)} disabled={!picked.includes(t) && picked.length >= max} onChange={() => toggle(t)} />
            ))}
          </div>
          {target ? (
            <div className="row">
              <Button size="sm" variant="primary" icon={Icons.apply} disabled={!picked.length} loading={busy === "ad-terms"} aria-label="Use in tailoring" onClick={() => void sendToTailoring()}>Use these</Button>
              <Text role="body-sm" muted>{picked.length ? `${picked.length} of up to ${max} picked` : "Tick what's true first."}</Text>
            </div>
          ) : null}
        </div>
      ) : <Text role="body-sm" muted>Nothing missing: your resume names every term the check found.</Text>}
    </Card>
  );
}

function TermRow({ title, help, terms, tone }: { title: string; help: string; terms: string[]; tone: "success" | "warning" }) {
  if (!terms.length) return null;
  return (
    <div className="stack-tight">
      <Text role="label" as="div">{`${title} (${terms.length})`}</Text>
      <Text role="body-sm" muted>{help}</Text>
      <div className="row keyword-gap__terms">{terms.map((t) => <Pill key={t} tone={tone}>{t}</Pill>)}</div>
    </div>
  );
}
