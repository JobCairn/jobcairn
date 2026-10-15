import { Button, Text, useToast } from "@careeros/brand";
import { adTerms, linkArtefact, proofHint, resumeProjects, type Artefact, type CareerosBridge } from "@careeros/contract";
import { useLoad } from "../bridge-context";
import { loadResumeText } from "../score/KeywordGap";
import { copyText } from "./copy";
import "./outreach.css";

async function loadHint(b: CareerosBridge, slug: string, id: string) {
  const d = await b.jobs.get(slug, id);
  const must = d.score?.must_haves[0]?.text || adTerms(d.description)[0] || "";
  if (!must) return null;
  const [resume, profile] = await Promise.all([loadResumeText(b, d.files).catch(() => null), b.settings.get("profile").catch(() => null)]);
  const links = (profile?.values.contact as { links?: unknown } | undefined)?.links;
  const artefacts: Artefact[] = [
    ...(resume ? resumeProjects(resume.text) : []),
    ...(Array.isArray(links) ? links.filter((l): l is string => typeof l === "string").map(linkArtefact).filter((a): a is Artefact => !!a) : []),
  ];
  const hint = proofHint(must, artefacts);
  return hint ? { must, hint } : null;
}

/**
 * Apply › Prepare: which of your own projects or profile links best proves the job's top must-have, with a one-line
 * mention to add to the cover letter. Worked out on this computer from words only; shows nothing when no artefact fits.
 */
export function ProofHintCard({ slug, id }: { slug: string; id: string }) {
  const toast = useToast();
  const h = useLoad((b) => loadHint(b, slug, id), [slug, id], ["jobs", "settings"]);
  if (!h.data) return null;
  const { must, hint } = h.data;
  const copy = async () => toast(await copyText(hint.line) ? { tone: "success", text: "Line copied" } : { tone: "danger", text: "Couldn't copy the line." });
  return (
    <div className="stack-tight proof-hint" role="note" aria-label="Proof of work">
      <Text role="label" as="div">Proof of work</Text>
      <Text role="body-sm" as="p">{`Your best proof for “${must}” is ${hint.artefact.label}. A line for your cover letter:`}</Text>
      <div className="outreach__text">{hint.line}</div>
      <div className="row"><Button size="sm" variant="ghost" onClick={() => void copy()}>Copy line</Button></div>
    </div>
  );
}
