import { friendlyFile } from "./files";
import { useFileViewer } from "../viewer";
import { useState } from "react";
import { Button, Card, Dialog, Pill, Text, useToast, Icons, SectionTitle } from "@careeros/brand";
import { EXPORT_FORMATS } from "@careeros/contract";
import { errorText, useAction, useBridge, useLoad } from "../bridge-context";
import { bytes, fmtDateTime } from "../format";

/** ATS-safe PDF and Word files for the resume and cover letter, made on this computer. */

/** "resume.pdf" -> "Resume (PDF)". */
const exportTitle = (name: string) => { const f = friendlyFile(name); return `${f.title} (${f.type})`; };

export function ExportPanel({ slug, id, variant = "primary" }: { slug: string; id: string; variant?: "primary" | "secondary" }) {
  const bridge = useBridge();
  const toast = useToast();
  const { busy, run } = useAction();
  const [confirm, setConfirm] = useState(false);
  const st = useLoad((b) => b.docs.state(slug, id), [slug, id], ["jobs"]);
  const s = st.data;
  const viewer = useFileViewer((s?.files ?? []).filter((f) => f.exists).map((f) => ({ rel: f.path, title: exportTitle(f.name), at: f.at })));
  if (!s) {
    if (!st.error) return null; // still loading
    return (
      <Card className="stack" aria-label="Export">
        <SectionTitle icon={Icons.exportFile} title="Export" />
        <Text role="body" muted>Export isn't available: {st.error}</Text>
      </Card>
    );
  }
  const sources = s.sources.filter((x) => x.exists).map((x) => x.source);
  const made = s.files.filter((f) => f.exists);
  const problems = s.files.filter((f) => f.problem && sources.includes(f.source));
  const clash = made.filter((f) => sources.includes(f.source));
  const go = (overwrite: boolean) => run("export", async () => {
    await bridge.docs.export(slug, id, sources, [...EXPORT_FORMATS], overwrite);
    setConfirm(false);
    st.reload();
  }, "Saved in application/export");
  const reveal = (rel: string) => void bridge.files.reveal(rel).catch((e: unknown) => toast({ tone: "danger", text: errorText(e) }));

  return (
    <Card className="stack" aria-label="Export">
      <SectionTitle icon={Icons.exportFile} title="Export" />
      <Text role="body-sm" muted>PDF and Word files an applicant tracking system can read: one column, real text, standard headings, no images or tables. Made on this computer.</Text>
      {sources.length ? (
        <div><Button variant={variant} icon={Icons.exportFile} loading={busy === "export"} title="Export PDF and Word files" onClick={() => (clash.length ? setConfirm(true) : void go(false))}>Export</Button></div>
      ) : (
        <Text role="body" muted>Nothing to export yet. Claude writes application/resume.md and application/cover-letter.md first.</Text>
      )}
      {problems.length ? (
        <ul className="list-plain" aria-label="Export problems" role="alert">
          {problems.map((f) => <li key={f.path}><Pill tone="warning">Blocked</Pill> <Text role="body" as="span">{f.problem}</Text></li>)}
        </ul>
      ) : null}
      {made.length ? (
        <ul className="list-plain" aria-label="Exported files">
          {made.map((f) => (
            <li key={f.path} className="row">
              <span className="grow">
                <Text role="body" as="div">{f.name}</Text>
                <Text role="body-sm" muted as="div">{f.size !== null ? bytes(f.size) : ""}{f.at ? ` · ${fmtDateTime(f.at)}` : ""}</Text>
              </span>
              <Button size="sm" variant="ghost" icon={Icons.show} aria-label={`View ${exportTitle(f.name)}`} onClick={() => viewer.open(f.path)}>View</Button>
              <Button size="sm" variant="ghost" icon={Icons.showInFolder} aria-label={`Show file: ${f.name}`} title="Show in folder" onClick={() => reveal(f.path)}>Show file</Button>
            </li>
          ))}
        </ul>
      ) : null}
      {viewer.element}
      <Dialog open={confirm} onClose={() => setConfirm(false)} title="Replace the exported files?"
        actions={<><Button variant="ghost" onClick={() => setConfirm(false)}>Cancel</Button><Button variant="primary" loading={busy === "export"} onClick={() => void go(true)}>Replace</Button></>}>
        <Text role="body">These files exist and will be written again: {clash.map((f) => f.name).join(", ")}.</Text>
      </Dialog>
    </Card>
  );
}
