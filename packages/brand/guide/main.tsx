import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import "../src/styles/index.css";
import { identity } from "../identity";
import { core, themes, type ThemeName } from "../dist/tokens.ts";
import {
  AI_CANDIDATES, AI_GLYPH, Badge, Button, Card, Checkbox, Glyphs, Icon, Icons, Mark, Input, Kbd, KpiCard, NavRail, Pill, Select, Table, Tabs, Text,
} from "../src";

const SWATCHES = ["color-bg", "color-bg-raised", "color-surface", "color-border-strong", "color-text", "color-text-muted", "color-accent", "color-success", "color-warning", "color-danger", "color-info", "color-focus"] as const;

function Panel({ theme }: { theme: ThemeName }) {
  const [tab, setTab] = useState("one");
  const t = themes[theme];
  return (
    <section data-theme={theme} className="guide-panel" aria-label={`${theme} theme`}>
      <div className="guide-row guide-between">
        <Text role="heading-1" as="h2">{identity.name}</Text>
        <Text role="label">{theme === "graphite" ? "Graphite · dark" : "Paper · light"}</Text>
      </div>
      <Text role="label" as="h3" className="guide-section">Colour · semantic tokens</Text>
      <div className="guide-swatches">
        {SWATCHES.map((name) => (
          <div key={name} className="guide-swatch">
            <span className="guide-chip" style={{ background: `var(--${name})` }} />
            <Text role="body-sm">{name.replace("color-", "")}</Text>
            <Text role="label">{t[name]}</Text>
          </div>
        ))}
      </div>
      <Text role="label" as="h3" className="guide-section">Type roles</Text>
      <Text role="display">Good morning, <i className="guide-accent">Alex.</i></Text>
      <div className="guide-row"><Text role="hero" className="guide-accent">158</Text><Text role="heading-1" as="span">Heading one</Text><Text role="heading-2" as="span">Heading two</Text></div>
      <Text role="body">Body · Geist 14/1.5. Two applications are ready for your review.</Text>
      <div className="guide-row"><Text role="label">Label · Geist, sentence case</Text><Text role="numeric">0123456789 · $150–170k</Text></div>
      <Text role="label" as="h3" className="guide-section">Buttons</Text>
      <div className="guide-row">
        <Button variant="primary">Prepare</Button><Button variant="primary" icon={Icons.send}>Review &amp; approve</Button>
        <Button>Practise</Button><Button variant="ghost">Later</Button><Button variant="danger">Decline</Button>
        <Button size="sm">Small</Button><Button variant="primary" loading>Saving</Button><Button variant="primary" disabled>Disabled</Button>
      </div>
      <Text role="label" as="h3" className="guide-section">Mark and icons</Text>
      <div className="guide-row">
        <Mark size={48} label={`${identity.name} mark`} />
        {(["apply", "dropBox", "learn", "sponsor"] as const).map((g) => (
          <span key={g} className="guide-glyph"><Icon icon={Glyphs[g]} /><Text role="body-sm">{g}</Text></span>
        ))}
      </div>
      <Text role="body-sm" muted>AI action glyph candidates (in use: {AI_GLYPH})</Text>
      <div className="guide-row">
        {AI_CANDIDATES.map((g) => <Button key={g} variant={g === AI_GLYPH ? "primary" : "secondary"} icon={Glyphs[g]}>Research company</Button>)}
        <Button icon={Icons.ai} disabled>Disabled stays legible</Button>
      </div>
      <Text role="label" as="h3" className="guide-section">Pills, badges, keys</Text>
      <div className="guide-row">
        <Pill tone="success">Sponsorship offered</Pill><Pill tone="accent">Interview Thu</Pill><Pill>Ad silent</Pill>
        <Pill tone="warning">Visa ends soon</Pill><Pill tone="danger">Citizens/PR only</Pill><Badge>51</Badge><Kbd>Ctrl K</Kbd>
      </div>
      <Text role="label" as="h3" className="guide-section">Navigation and inputs</Text>
      <div className="guide-row guide-top">
        <NavRail current="home" onNavigate={() => undefined} onOpenCommand={() => undefined} items={[
          { id: "home", label: "Home", icon: Icons.home }, { id: "jobs", label: "Jobs", icon: Icons.jobs, count: 51 },
          { id: "inbox", label: "Drop box", icon: Icons.dropBox, count: 3 }, { id: "privacy", label: "Privacy", icon: Icons.privacy, section: "secondary", trailing: "Locked" },
        ]} footer={<><span className="status-dot" />Claude · desktop app</>} />
        <div className="guide-col">
          <Input label="Search" placeholder="Search role, company…" />
          <Input label="Visa expiry" defaultValue="soon" error="Use YYYY-MM-DD" />
          <Select label="Work rights" options={[{ value: "needs_sponsorship", label: "Need visa sponsorship" }]} defaultValue="needs_sponsorship" />
          <Checkbox label="Willing to relocate" defaultChecked />
        </div>
      </div>
      <Text role="label" as="h3" className="guide-section">Cards</Text>
      <div className="guide-grid">
        <KpiCard label="Applied" value={4} delta="+2 this week" trend={[0, 0, 1, 2, 4]} tone="accent" />
        <Card highlight><Text role="label">Waiting for you</Text><Text role="heading-2">Application ready</Text><Button variant="primary" size="sm">Review</Button></Card>
      </div>
      <Tabs label="Example" value={tab} onChange={setTab} tabs={[{ id: "one", label: "Description" }, { id: "two", label: "Score", count: 2 }]}>
        <Table caption="Example jobs" rowKey={(r) => r.id} rows={[{ id: "a", role: "Backend Engineer (LLM) at Example Labs, a very long company name that truncates", fit: 64 }]}
          columns={[{ key: "role", header: "Role", render: (r) => <Text truncate as="span">{r.role}</Text> }, { key: "fit", header: "Fit", align: "end", render: (r) => <Text role="numeric">{r.fit}</Text> }]} />
      </Tabs>
      <Text role="label">{Object.keys(core).length} core tokens · {Object.keys(t).length} theme tokens</Text>
    </section>
  );
}

function Guide() {
  return (
    <main className="guide">
      <h1 className="sr-only">{identity.name} brand</h1>
      <Panel theme="graphite" />
      <Panel theme="paper" />
    </main>
  );
}

const style = document.createElement("style");
style.textContent = `
.guide { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
.guide-panel { background: var(--color-bg); color: var(--color-text); padding: var(--space-8); display: flex; flex-direction: column; gap: var(--space-3); }
.guide-row { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
.guide-between { justify-content: space-between; }
.guide-top { align-items: flex-start; }
.guide-col { display: flex; flex-direction: column; gap: var(--space-3); flex: 1; }
.guide-section { margin-top: var(--space-6); padding-top: var(--space-3); border-top: var(--size-border) solid var(--color-border); }
.guide-swatches { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--space-3); }
.guide-swatch { display: flex; flex-direction: column; gap: var(--space-1); }
.guide-chip { display: block; height: var(--space-10); border-radius: var(--radius-md); border: var(--size-border) solid var(--color-border-strong); }
.guide-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: var(--space-3); }
.guide-accent { color: var(--color-accent); }
.guide-glyph { display: inline-flex; flex-direction: column; align-items: center; gap: var(--space-1); }
`;
document.head.append(style);
createRoot(document.getElementById("root")!).render(<StrictMode><Guide /></StrictMode>);
