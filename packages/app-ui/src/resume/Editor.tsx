import { useEffect, useRef, useState, type DragEvent, type FocusEvent, type KeyboardEvent } from "react";
import { Button, Icon, Icons, Input, Pill, Text, Textarea } from "@careeros/brand";
import {
  addBullet, addRole, addRoleBullet, addSectionEntry, addTypedSection, bulletLines, headerFieldId, headerView, isHidden, itemView, linkLabel, listsAreItems,
  moveBullet, moveEntry, moveSection, pageBox, removeBlock, removeBullet, removeEntry, removeRole, removeSection, removeSkillGroup, resumeTheme, rewriteOptionsFor,
  SECTION_INFO, sectionView, setBulletText, setEntryFields, setHeader, setItem, setRole, setSectionHeading, setSkillGroup, setText, stripInline,
  type EntryView, type ResumeBullet, type ResumeModel, type ResumeStyle, type ResumeText, type RewriteOptions, type SectionType, type SectionView,
} from "@careeros/contract";
import { MoreMenu } from "../mail/MoreMenu";
import { ChipInput, DateRangeField, IconButton } from "./controls";

export interface EditorProps {
  model: ResumeModel;
  style: ResumeStyle;
  /** `key` groups typing in one field into one undo step. */
  onChange(next: ResumeModel, key?: string): void;
  onToggleHidden(heading: string): void;
  /** Absent while Claude can't rewrite this resume: the AI buttons are hidden. */
  onRewrite?(options: RewriteOptions): void;
  busy?: boolean;
  /** Focus moved to a field: its id, then the ids around it (entry, section), most specific first. */
  onSelect?(path: string[]): void;
  /** Focus this field (a click on the preview). */
  focus?: { id: string; tick: number } | null;
  /** Says a change out loud for screen readers ("Moved to 2 of 4"). */
  announce?(text: string): void;
}

/** A preview of text for labels, without Markdown marks, cut at a word. */
export const short = (s: string, n = 48) => { const t = stripInline(s); return t.length <= n ? t : `${t.slice(0, n).replace(/\s+\S*$/, "")}…`; };

type Drag = { kind: "section" | "bullet"; id: string; list?: string } | null;
type Ctx = EditorProps & { drag: Drag; setDrag(d: Drag): void; over: string | null; setOver(o: string | null): void; focusSoon(id: string): void; perLine(text: string): number };

/** Focus the first control in a field's container and bring it into view. */
function focusField(root: HTMLElement | null, id: string): boolean {
  const el = root?.querySelector<HTMLElement>(`[data-field="${CSS.escape(id)}"]`);
  if (!el) return false;
  const target = el.matches("input, textarea, select") ? el : el.querySelector<HTMLElement>("input, textarea, select") ?? el.querySelector<HTMLElement>("button");
  el.scrollIntoView?.({ block: "center", behavior: "smooth" });
  target?.focus({ preventScroll: true });
  return true;
}

const SECTION_ORDER: SectionType[] = ["projects", "certifications", "publications", "awards", "volunteering", "languages", "interests", "custom", "summary", "experience", "education", "skills"];

/** The structured editor: typed header fields, then each section as entries, items, chip groups or paragraphs. */
export function Editor(props: EditorProps) {
  const { model, style, onChange, focus } = props;
  const root = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag>(null);
  const [over, setOver] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [tick, setTick] = useState(0);
  const pending = useRef<string | null>(null);
  const t = resumeTheme(style);
  const box = pageBox(style);
  const perLine = (text: string) => bulletLines(text, box.contentWidth, t.basePt);

  // Focus requests: from the preview, or a field just added. A folded section opens first.
  const focusSoon = (id: string) => { pending.current = id; setTick((n) => n + 1); };
  useEffect(() => { if (focus) focusSoon(focus.id); }, [focus?.tick]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const id = pending.current;
    if (!id) return;
    const el = root.current?.querySelector<HTMLElement>(`[data-field="${CSS.escape(id)}"]`);
    const sec = el?.closest<HTMLElement>("[data-section]")?.dataset.section;
    if (sec && collapsed.has(sec)) { setCollapsed((c) => { const n = new Set(c); n.delete(sec); return n; }); return; }
    pending.current = null;
    focusField(root.current, id);
  }, [tick, collapsed]);

  const onFocus = (e: FocusEvent) => {
    const path: string[] = [];
    for (let el = e.target as HTMLElement | null; el && el !== root.current; el = el.parentElement) {
      const f = el.dataset?.field ?? el.dataset?.section;
      if (f && !path.includes(f)) path.push(f);
    }
    if (path.length) props.onSelect?.(path);
  };

  const ctx: Ctx = { ...props, drag, setDrag, over, setOver, focusSoon, perLine };
  const toggle = (id: string) => setCollapsed((c) => { const n = new Set(c); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <div ref={root} className="rs-editor" aria-label="Resume editor" onFocus={onFocus}>
      <HeaderCard ctx={ctx} />
      {model.sections.map((s, i) => (
        <SectionCard key={s.id} ctx={ctx} view={sectionView(s)} index={i} count={model.sections.length} hidden={isHidden(s, style.hidden)} collapsed={collapsed.has(s.id)} onCollapse={() => toggle(s.id)} />
      ))}
      {!model.sections.length ? <Text role="body-sm" muted>No sections yet. Add one below, like Experience or Skills.</Text> : null}
      <AddSection present={model.sections.map((s) => sectionView(s).type)}
        onAdd={(type) => { const r = addTypedSection(model, type); onChange(r.model); focusSoon(r.focusId); props.announce?.(`${SECTION_INFO[type].label} added`); }} />
    </div>
  );
}

// ---- header ------------------------------------------------------------------------------

function HeaderCard({ ctx }: { ctx: Ctx }) {
  const { model, onChange } = ctx;
  const h = headerView(model);
  const set = (patch: Parameters<typeof setHeader>[1], key: string) => onChange(setHeader(model, patch), key);
  const restBlocks = model.header.blocks.filter((b) => h.rest.includes(b.id));
  return (
    <section className="rs-card rs-card--header" aria-label="Header" data-section="header">
      <div className="rs-card__bar"><Text role="label" className="rs-kind">Header</Text></div>
      <div className="rs-grid">
        <div className="rs-span2" data-field={headerFieldId("name")}><Input label="Name" value={h.name} placeholder="Your name" onChange={(e) => set({ name: e.target.value }, "h:name")} /></div>
        <div className="rs-span2" data-field={headerFieldId("headline")}><Input label="Headline" value={h.headline} placeholder="AI Engineer | Retrieval and agents" onChange={(e) => set({ headline: e.target.value }, "h:headline")} /></div>
        <div data-field={headerFieldId("location")}><Input label="Location" value={h.location} placeholder="Sampletown NSW" onChange={(e) => set({ location: e.target.value }, "h:location")} /></div>
        <div data-field={headerFieldId("email")}><Input label="Email" type="email" value={h.email} onChange={(e) => set({ email: e.target.value }, "h:email")} /></div>
        <div data-field={headerFieldId("phone")}><Input label="Phone" type="tel" value={h.phone} onChange={(e) => set({ phone: e.target.value }, "h:phone")} /></div>
        <div className="rs-span2">
          <ChipInput field={headerFieldId("links")} label="Links" chips={h.links} placeholder="linkedin.com/in/you, github.com/you or a portfolio"
            render={(l) => { const x = linkLabel(l); return x.href ? `${x.label}: ${x.href.replace(/^https:\/\/(www\.)?/, "").replace(/\/$/, "")}` : stripInline(l); }}
            onChange={(links) => set({ links }, "h:links")} />
        </div>
        {h.extras.length ? <div className="rs-span2"><ChipInput label="Other details" chips={h.extras} onChange={(extras) => set({ extras }, "h:extras")} /></div> : null}
      </div>
      {restBlocks.map((b) => (b.kind === "text" ? <Paragraph key={b.id} ctx={ctx} block={b} /> : null))}
    </section>
  );
}

// ---- sections ------------------------------------------------------------------------------

function SectionCard({ ctx, view: v, index: i, count, hidden, collapsed, onCollapse }: {
  ctx: Ctx; view: SectionView; index: number; count: number; hidden: boolean; collapsed: boolean; onCollapse(): void;
}) {
  const { model, onChange, drag, over, setOver, setDrag, onRewrite, busy, announce } = ctx;
  const info = SECTION_INFO[v.type];
  const name = v.heading || "this section";
  const move = (to: number) => { onChange(moveSection(model, v.id, to)); announce?.(`${name} moved to ${to + 1} of ${count}`); };
  const add = () => { const r = addSectionEntry(model, v.id); onChange(r.model); ctx.focusSoon(r.focusId); };
  const empty = !v.items.length && !v.groups.length;
  return (
    <section aria-label={`Section ${v.heading || "without a heading"}`} data-section={v.id}
      className={`rs-card${hidden ? " is-hidden" : ""}${over === v.id ? " is-over" : ""}${drag?.id === v.id ? " is-dragging" : ""}`}
      onDragOver={(e) => { if (drag?.kind === "section") { e.preventDefault(); setOver(v.id); } }}
      onDragLeave={() => { if (over === v.id) setOver(null); }}
      onDrop={(e) => { e.preventDefault(); setOver(null); if (drag?.kind === "section" && drag.id !== v.id) { onChange(moveSection(model, drag.id, i)); announce?.(`Section moved to ${i + 1} of ${count}`); } setDrag(null); }}>
      <div className="rs-card__bar">
        <span className="rs-grip" draggable aria-hidden="true" data-tip="Drag to move"
          onDragStart={(e: DragEvent) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", v.id); setDrag({ kind: "section", id: v.id }); }}
          onDragEnd={() => { setDrag(null); setOver(null); }}><Icon icon={Icons.dragHandle} size="sm" /></span>
        <IconButton icon={collapsed ? Icons.folded : Icons.expand} label={collapsed ? `Open ${name}` : `Fold ${name}`} tip={collapsed ? "Open" : "Fold"} aria-expanded={!collapsed} onClick={onCollapse} />
        <div className="rs-heading" data-field={v.id}>
          <Input label="Section heading" hideLabel value={v.heading} placeholder={info.heading} className="rs-heading__input" onChange={(e) => onChange(setSectionHeading(model, v.id, e.target.value), `h:${v.id}`)} />
        </div>
        {hidden ? <Pill tone="neutral">Hidden</Pill> : null}
        <div className="rs-tools" role="toolbar" aria-label={`${name} tools`}>
          <IconButton icon={Icons.moveUp} label={`Move ${name} up`} tip={i === 0 ? "Already the first section" : "Move up"} disabled={i === 0} onClick={() => move(i - 1)} />
          <IconButton icon={Icons.moveDown} label={`Move ${name} down`} tip={i === count - 1 ? "Already the last section" : "Move down"} disabled={i === count - 1} onClick={() => move(i + 1)} />
          <IconButton icon={hidden ? Icons.hide : Icons.show} label={hidden ? `Show ${name} in the resume` : `Hide ${name} from the resume`} tip={hidden ? "Hidden. Show it again" : "Hide from the resume"}
            aria-pressed={hidden} onClick={() => ctx.onToggleHidden(v.heading)} />
          {onRewrite ? <IconButton icon={Icons.ai} label={`Rewrite ${name} with AI`} tip={busy ? "Claude is busy. Wait for it to finish." : empty ? "Add something first" : "Rewrite with AI"} disabled={busy || empty}
            onClick={() => { const o = rewriteOptionsFor(model, v.id); if (o) onRewrite(o); }} /> : null}
          <MoreMenu label={`More for ${name}`} items={[{ id: "delete", label: "Delete section", onSelect: () => { onChange(removeSection(model, v.id)); announce?.(`${name} deleted. Undo with Cmd or Ctrl + Z.`); } }]} />
        </div>
      </div>
      <div className="rs-card__body" hidden={collapsed}>
        {v.shape === "chips" ? <Groups ctx={ctx} view={v} /> : null}
        {v.items.map((it) => {
          if (it.kind === "entry") return <EntryCard key={it.id} ctx={ctx} section={v} entry={it.entry} />;
          if (it.kind === "text") return v.shape === "chips" && !it.block.fixed ? null : <Paragraph key={it.id} ctx={ctx} block={it.block} />;
          if (v.shape === "chips") return null;
          if (listsAreItems(v.type)) return <Items key={it.id} ctx={ctx} type={v.type} bullets={it.block.bullets} />;
          return <BulletList key={it.id} ctx={ctx} listId={it.id} bullets={it.block.bullets} section={v.heading} />;
        })}
        {empty ? <Text role="body-sm" muted as="p" className="rs-empty">Nothing here yet. {info.help}</Text> : null}
        <div><Button size="sm" icon={Icons.add} onClick={add}>{info.addLabel}</Button></div>
      </div>
    </section>
  );
}

// ---- entries -------------------------------------------------------------------------------

function EntryCard({ ctx, section, entry: e }: { ctx: Ctx; section: SectionView; entry: EntryView }) {
  const { model, onChange } = ctx;
  const info = SECTION_INFO[section.type];
  const L = info.entry;
  const set = (k: Parameters<typeof setEntryFields>[3], key: string) => onChange(setEntryFields(model, e.id, section.type, k), `e:${key}:${e.id}`);
  const multi = e.roles.length > 1;
  const entries = section.items.filter((x) => x.kind === "entry");
  const at = entries.findIndex((x) => x.id === e.id);
  const label = short([e.role, e.org].filter(Boolean).join(", ") || `New ${info.addLabel.replace(/^Add /, "")}`, 40);
  const move = (dir: -1 | 1) => { onChange(moveEntry(model, section.id, e.id, dir)); ctx.announce?.(`${label} moved to ${at + dir + 1} of ${entries.length}`); };
  return (
    <div className="rs-entry" data-field={e.id}>
      <div className="rs-entry__bar">
        <Text role="body" as="div" className="rs-entry__title">{label}</Text>
        <div className="rs-tools" role="toolbar" aria-label={`${label} tools`}>
          <IconButton icon={Icons.moveUp} label={`Move ${label} up`} tip={at === 0 ? "Already first" : "Move up"} disabled={at === 0} onClick={() => move(-1)} />
          <IconButton icon={Icons.moveDown} label={`Move ${label} down`} tip={at === entries.length - 1 ? "Already last" : "Move down"} disabled={at === entries.length - 1} onClick={() => move(1)} />
          <MoreMenu label={`More for ${label}`} items={[{ id: "delete", label: "Delete entry", onSelect: () => { onChange(removeEntry(model, section.id, e.id)); ctx.announce?.(`${label} deleted. Undo with Cmd or Ctrl + Z.`); } }]} />
        </div>
      </div>
      <div className="rs-grid">
        <Input label={L.org} value={e.org} onChange={(x) => set({ org: x.target.value }, "org")} />
        {!multi ? <Input label={L.role} value={e.role} onChange={(x) => set({ role: x.target.value }, "role")} /> : null}
        {section.type !== "projects" ? <Input label={L.location} value={e.location} placeholder="Optional" onChange={(x) => set({ location: x.target.value }, "loc")} /> : null}
        {section.type === "projects" || e.link ? <Input label={L.link} value={e.link} placeholder="github.com/you/project" onChange={(x) => set({ link: x.target.value }, "link")} /> : null}
        <div className="rs-span2"><DateRangeField key={`d:${e.id}`} label={multi ? "Dates at this organisation" : L.dates} value={e.dates} onChange={(d) => set({ dates: d }, "dates")} /></div>
      </div>
      {e.notes.map((n) => <Paragraph key={n.id} ctx={ctx} block={n} label="Note under this entry" />)}
      {e.extra.length ? <Text role="body-sm" muted as="div" className="rs-extra">Also under the title, kept as written: {short(e.extra.join(" · "), 90)}</Text> : null}
      {multi ? e.roles.map((r, k) => (
        <div key={r.id} className="rs-role" data-field={k ? r.id : `${e.id}:role`}>
          <div className="rs-role__head">
            <Input label={`Role ${k + 1}`} value={r.title} onChange={(x) => onChange(k ? setRole(model, r.id, { title: x.target.value }) : setEntryFields(model, e.id, section.type, { role: x.target.value }), `r:${r.id}`)} />
            {k ? <IconButton icon={Icons.remove} label={`Remove the role ${r.title || k + 1}`} tip="Remove role" tone="danger" onClick={() => onChange(removeRole(model, r.id))} /> : null}
          </div>
          <DateRangeField key={`rd:${r.id}`} label="Dates in this role" value={r.dates} onChange={(d) => onChange(k ? setRole(model, r.id, { dates: d }) : setEntryFields(model, e.id, section.type, { roleDates: d }), `rd:${r.id}`)} />
          <BulletList ctx={ctx} listId={r.listId} role={r} bullets={r.bullets} section={section.heading} />
        </div>
      )) : <BulletList ctx={ctx} listId={e.id} role={e.roles[0]} bullets={e.bullets} section={section.heading} />}
      {info.roles ? (
        <div><Button size="sm" variant="ghost" icon={Icons.add} onClick={() => { const r = addRole(model, section.id, e.id); onChange(r.model); ctx.focusSoon(r.focusId); }}>Add role</Button></div>
      ) : null}
    </div>
  );
}

// ---- bullets ----------------------------------------------------------------------------------

function BulletList({ ctx, listId, bullets, section, role }: { ctx: Ctx; listId: string | null; bullets: ResumeBullet[]; section: string; role?: { id: string; listId: string | null } }) {
  const { model, onChange, drag, setDrag, setOver, over, onRewrite, busy, announce } = ctx;
  const list = listId ?? role?.id ?? "";
  const addAfter = (after?: string) => {
    if (listId) {
      const next = addBullet(model, listId, "", after);
      const blk = [...next.header.blocks, ...next.sections.flatMap((s) => s.blocks)].find((b) => b.id === listId);
      const bs = blk && blk.kind !== "text" ? blk.bullets : [];
      const i = after ? bs.findIndex((b) => b.id === after) + 1 : bs.length - 1;
      onChange(next);
      if (bs[i]) ctx.focusSoon(bs[i]!.id);
    } else if (role) { const r = addRoleBullet(model, role); onChange(r.model); ctx.focusSoon(r.focusId); }
  };
  const move = (b: ResumeBullet, to: number) => {
    if (to < 0 || to >= bullets.length) return;
    onChange(moveBullet(model, b.id, to));
    announce?.(`Bullet moved to ${to + 1} of ${bullets.length}`);
    ctx.focusSoon(b.id);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>, b: ResumeBullet, i: number) => {
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) { e.preventDefault(); move(b, i + (e.key === "ArrowUp" ? -1 : 1)); return; }
    // One bullet is one line: Enter starts the next bullet; Backspace in an empty one removes it.
    if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.nativeEvent.isComposing) { e.preventDefault(); addAfter(b.id); return; }
    if (e.key === "Backspace" && !b.text) { e.preventDefault(); onChange(removeBullet(model, b.id)); const near = bullets[i - 1] ?? bullets[i + 1]; if (near) ctx.focusSoon(near.id); }
  };
  return (
    <div className="rs-bullets-wrap">
      {bullets.length ? (
        <ol className="rs-bullets" aria-label={`Bullets in ${section || "this section"}`}>
          {bullets.map((b, i) => {
            const lines = ctx.perLine(b.text);
            const n = stripInline(b.text).length;
            return (
              <li key={b.id} data-field={b.id} className={`rs-bullet${over === b.id ? " is-over" : ""}${drag?.id === b.id ? " is-dragging" : ""}`}
                onDragOver={(e) => { if (drag?.kind === "bullet" && drag.list === list) { e.preventDefault(); e.stopPropagation(); setOver(b.id); } }}
                onDrop={(e) => {
                  e.preventDefault(); e.stopPropagation(); setOver(null);
                  if (drag?.kind === "bullet" && drag.list === list && drag.id !== b.id) { const from = bullets.find((x) => x.id === drag.id); if (from) move(from, i); }
                  setDrag(null);
                }}>
                <button type="button" className="rs-grip" draggable aria-label={`Move bullet ${i + 1} of ${bullets.length}. Use the up and down arrow keys.`} data-tip="Drag, or use the arrow keys"
                  onKeyDown={(e) => { if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); move(b, i + (e.key === "ArrowUp" ? -1 : 1)); } }}
                  onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", b.id); setDrag({ kind: "bullet", id: b.id, list }); }}
                  onDragEnd={() => { setDrag(null); setOver(null); }}><Icon icon={Icons.dragHandle} size="sm" /></button>
                <div className="rs-bullet__main">
                  <Textarea label={`Bullet ${i + 1}`} hideLabel rows={1} value={b.text} placeholder="What you did and what changed because of it"
                    onChange={(e) => onChange(setBulletText(model, b.id, e.target.value), `b:${b.id}`)} onKeyDown={(e) => onKey(e, b, i)} />
                  <div className="rs-bullet__meta" aria-live="off">
                    {lines > 2 ? <span className="rs-hint rs-warn">About {lines} lines on the page. One or two read best.</span> : <span className="rs-hint">{lines === 2 ? "2 lines on the page" : ""}</span>}
                    <span className="rs-count" title={`${n} characters`}>{n}</span>
                  </div>
                </div>
                <div className="rs-bullet__tools">
                  {onRewrite ? <IconButton icon={Icons.ai} label={`Rewrite bullet ${i + 1} with AI`} tip={!b.text.trim() ? "Write something first" : busy ? "Claude is busy. Wait for it to finish." : "Rewrite with AI"}
                    disabled={busy || !b.text.trim()} onClick={() => { const o = rewriteOptionsFor(model, b.id); if (o) onRewrite(o); }} /> : null}
                  <IconButton icon={Icons.remove} label={`Delete bullet ${i + 1}`} tip="Delete bullet" tone="danger" onClick={() => { onChange(removeBullet(model, b.id)); announce?.("Bullet deleted. Undo with Cmd or Ctrl + Z."); }} />
                </div>
                {b.children.length ? <Text role="body-sm" muted as="div" className="rs-children">Nested lines kept as written: {short(b.children.join(" "), 80)}</Text> : null}
              </li>
            );
          })}
        </ol>
      ) : null}
      <div><Button size="sm" variant="ghost" icon={Icons.add} onClick={() => addAfter()}>Add bullet</Button></div>
    </div>
  );
}

// ---- items, chip groups, paragraphs -----------------------------------------------------------

function Items({ ctx, type, bullets }: { ctx: Ctx; type: SectionType; bullets: ResumeBullet[] }) {
  const { model, onChange } = ctx;
  const info = SECTION_INFO[type];
  return (
    <ul className="list-plain rs-items">
      {bullets.map((b, i) => {
        const v = itemView(b, type);
        const name = short(stripInline(v.fields[0] ?? "") || `item ${i + 1}`, 30);
        return (
          <li key={b.id} className="rs-item" data-field={b.id}>
            <div className="rs-item__fields">
              {info.itemFields.map((f, k) => (
                <Input key={f} label={f} value={v.fields[k] ?? ""} onChange={(e) => { const fields = [...v.fields]; fields[k] = e.target.value; onChange(setItem(model, b.id, type, { fields }), `i:${b.id}:${k}`); }} />
              ))}
              {type !== "languages" ? <Input label={type === "education" ? "Dates" : "Date"} value={v.dates} placeholder="2024" onChange={(e) => onChange(setItem(model, b.id, type, { dates: e.target.value }), `i:${b.id}:d`)} /> : null}
              {type === "certifications" || type === "publications" || v.link ? <Input label="Link" value={v.link} placeholder="Optional" onChange={(e) => onChange(setItem(model, b.id, type, { link: e.target.value }), `i:${b.id}:l`)} /> : null}
            </div>
            <IconButton icon={Icons.remove} label={`Delete ${name}`} tip="Delete" tone="danger" onClick={() => onChange(removeBullet(model, b.id))} />
          </li>
        );
      })}
    </ul>
  );
}

function Groups({ ctx, view }: { ctx: Ctx; view: SectionView }) {
  const { model, onChange } = ctx;
  return (
    <ul className="list-plain rs-groups">
      {view.groups.map((g, i) => (
        <li key={g.id} className="rs-group" data-field={g.id}>
          <Input label="Group" value={g.label} placeholder={view.type === "skills" ? "Languages" : "Optional"} onChange={(e) => onChange(setSkillGroup(model, g.id, { label: e.target.value }), `g:${g.id}`)} />
          <ChipInput label={view.type === "skills" ? "Skills" : "Items"} chips={g.chips} placeholder="Type, then press Enter" onChange={(chips) => onChange(setSkillGroup(model, g.id, { chips }), `gc:${g.id}`)} />
          <IconButton icon={Icons.remove} label={`Delete group ${g.label || i + 1}`} tip="Delete group" tone="danger" onClick={() => onChange(removeSkillGroup(model, g.id))} />
        </li>
      ))}
    </ul>
  );
}

function Paragraph({ ctx, block: b, label = "Paragraph" }: { ctx: Ctx; block: ResumeText; label?: string }) {
  const { model, onChange } = ctx;
  if (b.fixed) return <div className="rs-fixed" data-field={b.id}><Text role="body-sm" muted>A code block, kept as written. Edit it in the file.</Text><pre>{b.text}</pre></div>;
  return (
    <div className="rs-para" data-field={b.id}>
      <Textarea label={label} hideLabel={label === "Paragraph"} rows={2} value={b.text} placeholder="A short paragraph" onChange={(e) => onChange(setText(model, b.id, e.target.value), `t:${b.id}`)} />
      <IconButton icon={Icons.remove} label={`Delete this ${label === "Paragraph" ? "paragraph" : "note"}`} tip={label === "Paragraph" ? "Delete paragraph" : "Delete note"} tone="danger" onClick={() => onChange(removeBlock(model, b.id))} />
    </div>
  );
}

// ---- add section --------------------------------------------------------------------------

function AddSection({ onAdd, present }: { onAdd(t: SectionType): void; present: SectionType[] }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    wrap.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const away = (e: PointerEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  const onKey = (e: KeyboardEvent) => {
    const all = [...(wrap.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = all.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") { e.preventDefault(); setOpen(false); wrap.current?.querySelector<HTMLElement>("button")?.focus(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); all[(at + 1) % all.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); all[(at - 1 + all.length) % all.length]?.focus(); }
    else if (e.key === "Tab") setOpen(false);
  };
  return (
    <div className="rs-add" ref={wrap} onKeyDown={open ? onKey : undefined} data-tour="resume-add-section">
      <Button icon={Icons.add} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>Add section</Button>
      {open ? (
        <div role="menu" aria-label="Add a section" className="rs-add__menu">
          {SECTION_ORDER.map((t) => (
            <button key={t} type="button" role="menuitem" tabIndex={-1} className="rs-add__item" onClick={() => { setOpen(false); onAdd(t); }}>
              <span className="rs-add__label">{SECTION_INFO[t].label}{present.includes(t) && t !== "custom" ? <span className="rs-add__have"> · you have one</span> : null}</span>
              <span className="rs-add__help">{SECTION_INFO[t].help}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
