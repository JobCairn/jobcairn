import { useEffect, useState } from "react";
import { Button, Dialog, Icons, Input, Tabs, Text, Textarea } from "@careeros/brand";
import { AGENCY_IMPORT_MAX, type AgencyAddResult, type AgencyImportResult } from "@careeros/contract";
import { errorText, useBridge } from "../bridge-context";
import { useClaudeEngine } from "../claude";
import { displayName } from "../components/displayName";
import { plural } from "../format";
import { navigate } from "../router";

const WORKSPACE = { kind: "workspace" } as const;
type Mode = "one" | "list";
type Done = { kind: "one"; r: AgencyAddResult; checking: string } | { kind: "list"; r: AgencyImportResult; checking: string };

/**
 * Add recruiter (spec 2026-10-17-add-recruiter-and-mail): one agency from a pasted website, a job ad link from it, or
 * its name with details and an email; or a list, pasted or from a CSV file, one agency per line. Saving keeps it with
 * where it came from ("Added by you", or the job board's name), then starts Check recruiters so Claude fills in the
 * rest from the agency's own pages. An agency already saved (same site or name) is added to, never repeated.
 */
export function AddRecruiterDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const bridge = useBridge();
  const engine = useClaudeEngine();
  const [mode, setMode] = useState<Mode>("one");
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [list, setList] = useState("");
  const [busy, setBusy] = useState<"save" | "file" | null>(null);
  const [error, setError] = useState("");
  const [done, setDone] = useState<Done | null>(null);
  useEffect(() => { if (open) { setText(""); setName(""); setList(""); setError(""); setBusy(null); setDone(null); setMode("one"); } }, [open]);

  /** Starts Check recruiters, or says why it can't start now (the agencies stay marked and wait for it). */
  const check = async (): Promise<string> => {
    if (!engine.data?.ready) return "Claude isn't set up yet, so it can't check them now. They're saved; use Check on the Recruiters screen once Claude is ready.";
    try {
      await bridge.claude.run("check_recruiters", WORKSPACE, {});
      return "Claude is checking it on the agency's own site and will fill in what it publishes.";
    } catch (e) { return `Saved, but Claude couldn't start the check: ${errorText(e)}`; }
  };

  const saveOne = async () => {
    setError(""); setBusy("save");
    try {
      const r = await bridge.recruiters.add({ text, ...(name.trim() ? { name: name.trim() } : {}) });
      setDone({ kind: "one", r, checking: await check() });
    } catch (e) { setError(errorText(e)); } finally { setBusy(null); }
  };
  const finishList = async (r: AgencyImportResult) => setDone({ kind: "list", r, checking: r.added.length || r.merged.length ? await check() : "" });
  const saveList = async () => {
    setError(""); setBusy("save");
    try { await finishList(await bridge.recruiters.importList(list)); } catch (e) { setError(errorText(e)); } finally { setBusy(null); }
  };
  const fromFile = async () => {
    setError("");
    try {
      const path = await bridge.files.pick();
      if (!path) return;
      setBusy("file");
      await finishList(await bridge.recruiters.importFile(path));
    } catch (e) { setError(errorText(e)); } finally { setBusy(null); }
  };

  if (done) {
    const go = (slug: string) => { onClose(); navigate({ screen: "recruiter", slug }); };
    return (
      <Dialog open={open} onClose={onClose} title={done.kind === "one" ? (done.r.created ? "Recruiter added" : "Already saved") : "Recruiters imported"}
        actions={<>
          <Button onClick={onClose}>Done</Button>
          {done.kind === "one" ? <Button variant="primary" onClick={() => go(done.r.slug)}>Open it</Button> : null}
        </>}>
        <div className="stack" role="status">
          {done.kind === "one" ? (
            <Text role="body">{done.r.created ? `${displayName(done.r.name)} is in your recruiters.` : `${displayName(done.r.name)} was already saved, so what you gave was added to it.`}</Text>
          ) : (
            <>
              <Text role="body">{[`${plural(done.r.added.length, "agency", "agencies")} added`, done.r.merged.length ? `${done.r.merged.length} already saved, added to` : ""].filter(Boolean).join(", ") + "."}</Text>
              {done.r.skipped.length ? (
                <section aria-label="Lines left out" className="stack-tight">
                  <Text role="body-sm" muted>{`${plural(done.r.skipped.length, "line")} left out:`}</Text>
                  <ul className="list-plain stack-tight">
                    {done.r.skipped.slice(0, 20).map((s) => <li key={s.line}><Text role="body-sm" as="span">{`Line ${s.line}: ${s.text} (${s.why})`}</Text></li>)}
                  </ul>
                </section>
              ) : null}
            </>
          )}
          {done.checking ? <Text role="body-sm" muted>{done.checking}</Text> : null}
        </div>
      </Dialog>
    );
  }

  const canSave = mode === "one" ? !!(text.trim() || name.trim()) : !!list.trim();
  return (
    <Dialog open={open} onClose={onClose} title="Add a recruiter"
      actions={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" icon={Icons.add} disabled={!canSave} loading={busy === "save"} title={canSave ? undefined : mode === "one" ? "Paste a website, a job ad link, or a name first" : "Paste your list first"}
          onClick={() => void (mode === "one" ? saveOne() : saveList())}>{mode === "one" ? "Save" : "Import"}</Button>
      </>}>
      <Tabs label="How to add" value={mode} onChange={(m) => { setMode(m as Mode); setError(""); }} tabs={[{ id: "one", label: "One agency" }, { id: "list", label: "A list" }]}>
        {mode === "one" ? (
          <div className="stack">
            <Textarea label="Website, job ad link, or name and email" rows={4} value={text} onChange={(e) => setText(e.target.value)}
              placeholder="https://… or the agency's name, any details and an email"
              help="Their own website, one of their job ads (SEEK, LinkedIn, Indeed…), or a name with whatever you know. Claude checks the rest on their own site." />
            <Input label="Agency name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} placeholder="Optional"
              help="Needed for a job ad link: a job site is never taken as the agency's website." />
          </div>
        ) : (
          <div className="stack">
            <Textarea label="One agency per line" rows={8} value={list} onChange={(e) => setList(e.target.value)}
              placeholder={"name, website, email\nAcme Recruiting, acmerecruiting.example.com"}
              help={`Name, then website and email if you have them, separated by commas. Up to ${AGENCY_IMPORT_MAX} at a time. Ones already saved are added to.`} />
            <div className="row">
              <Text role="body-sm" muted as="span">Have a spreadsheet? Save it as CSV, then</Text>
              <Button size="sm" variant="ghost" icon={Icons.file} loading={busy === "file"} onClick={() => void fromFile()}>Choose file</Button>
            </div>
          </div>
        )}
      </Tabs>
      {error ? <Text role="body-sm" className="field__error" as="p" aria-live="polite">{error}</Text> : null}
    </Dialog>
  );
}
