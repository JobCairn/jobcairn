import { useState } from "react";
import { Button, Checkbox, Dialog, Input, Select, Text, useToast } from "@careeros/brand";
import { agencyFacets, filterAgencies, localDate, type AgencyPatch, type AgencyRow } from "@careeros/contract";
import { errorText, useAction, useBridge, useLoad } from "../bridge-context";
import { ActionButton } from "../components/ActionButton";
import { displayName } from "../components/displayName";
import { errorSentence } from "../components/ErrorBanner";
import { EmptyState, ErrorState, Loading, ScreenHead } from "../components/States";
import { plural } from "../format";
import { AgencyCard, RECRUITER_NOTE } from "../recruiters/AgencyCard";
import { BulkEmail } from "../recruiters/BulkEmail";
import { RecruiterEmail } from "../recruiters/RecruiterEmail";
import { useSponsorshipFocus } from "../useSponsorshipFocus";
import "../recruiters/recruiters.css";

const WORKSPACE = { kind: "workspace" } as const;

/**
 * Recruiters: recruitment agencies as cards, to find who places people in your roles and email them. Search, tag,
 * city and (for people who need sponsorship) a sponsorship-signal filter; select cards to email them or mark them
 * contacted in one go. "Email" writes to one like an application (RecruiterEmail); nothing is sent without
 * approval. Agencies come from Find recruiters (Claude, published pages only) and from recruiter job ads you save.
 */
export function RecruitersScreen() {
  const bridge = useBridge();
  const toast = useToast();
  const { run, busy } = useAction();
  const { showSponsorship } = useSponsorshipFocus();
  const { data, error } = useLoad((b) => b.recruiters.list(), [], ["recruiters", "jobs", "claude", "mail"]);
  const [q, setQ] = useState("");
  const [tag, setTag] = useState("");
  const [city, setCity] = useState("");
  const [sponsor, setSponsor] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [emailing, setEmailing] = useState<AgencyRow | null>(null);
  const [bulk, setBulk] = useState(false);

  const head = <ScreenHead title="Recruiters" sub="Recruitment agencies that place people in your roles, what they're hiring for, and how to reach them."
    right={<span data-tour="recruiters-find"><ActionButton action="find_recruiters" target={WORKSPACE} variant="primary" size="md" /></span>} />;
  if (error && !data) return <>{head}<ErrorState title="Recruiters can't be shown" text={errorSentence(error)} /></>;
  if (!data) return <>{head}<Loading /></>;
  if (!data.length) {
    return <>{head}<EmptyState boxed text="No recruiters yet. Find recruiters asks Claude to look up agencies for your roles and cities. Agencies also appear here when you save a job a recruiter advertised." /></>;
  }

  const facets = agencyFacets(data);
  const rows = filterAgencies(data, { q, tag, city, sponsor: showSponsorship && sponsor });
  const chosen = data.filter((r) => picked.has(r.slug));
  const select = (slug: string, on: boolean) => setPicked((s) => { const n = new Set(s); if (on) n.add(slug); else n.delete(slug); return n; });
  const change = (slug: string, patch: AgencyPatch) => void bridge.recruiters.update(slug, patch).catch((e: unknown) => toast({ tone: "danger", text: `Couldn't save: ${errorText(e)}` }));
  const markContacted = () => run("contacted", async () => {
    const today = localDate(new Date());
    for (const a of chosen) await bridge.recruiters.update(a.slug, { contacted_on: today });
    setPicked(new Set());
  }, `Marked ${plural(chosen.length, "agency", "agencies")} contacted`);

  return (
    <>
      {head}
      <p role="note" className="agency-note"><Text role="body-sm" muted as="span">{RECRUITER_NOTE}</Text></p>
      <div className="filters filters--wrap" role="search" aria-label="Filter recruiters">
        <Input label="Search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, specialty or role" />
        <Select label="Tag" value={tag} onChange={(e) => setTag(e.target.value)} options={[{ value: "", label: "All tags" }, ...facets.tags.map((t) => ({ value: t, label: t }))]} />
        <Select label="City" value={city} onChange={(e) => setCity(e.target.value)} options={[{ value: "", label: "All cities" }, ...facets.cities.map((c) => ({ value: c, label: c }))]} />
        {showSponsorship ? <Checkbox label="Ads open to visa holders" checked={sponsor} onChange={(e) => setSponsor(e.target.checked)} /> : null}
      </div>
      {chosen.length ? (
        <div className="row agency-bulk" role="toolbar" aria-label="Selected recruiters">
          <Text role="body-sm" as="span">{`${chosen.length} selected`}</Text>
          <Button size="sm" onClick={() => setBulk(true)}>Email selected</Button>
          <Button size="sm" loading={busy === "contacted"} onClick={() => void markContacted()}>Mark contacted</Button>
          <Button size="sm" variant="ghost" onClick={() => setPicked(new Set())}>Clear</Button>
        </div>
      ) : null}
      {rows.length ? (
        <div className="agency-grid" data-tour="recruiters-grid">
          {rows.map((a) => (
            <AgencyCard key={a.slug} a={a} selected={picked.has(a.slug)} onSelect={(on) => select(a.slug, on)} onChange={(p) => change(a.slug, p)}
              onEmail={() => setEmailing(a)} showSponsorship={showSponsorship} />
          ))}
        </div>
      ) : <EmptyState boxed text="No recruiters match these filters." action={<Button onClick={() => { setQ(""); setTag(""); setCity(""); setSponsor(false); }}>Clear filters</Button>} />}
      <Dialog open={!!emailing} onClose={() => setEmailing(null)} title={emailing ? `Email ${displayName(emailing.name)}` : "Email"}>
        {emailing ? <RecruiterEmail a={emailing} onClose={() => setEmailing(null)} /> : null}
      </Dialog>
      <Dialog open={bulk} onClose={() => setBulk(false)} title={`Email ${plural(chosen.length, "recruiter")}`}>
        {bulk ? <BulkEmail agencies={chosen} onDone={() => { setBulk(false); setPicked(new Set()); }} /> : null}
      </Dialog>
    </>
  );
}
