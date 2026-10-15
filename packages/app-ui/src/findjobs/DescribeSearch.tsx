import { useId, useState } from "react";
import { Button, Input, Text } from "@careeros/brand";
import { chipsPatch, FREE_TEXT_MAX, parseSearchText, type SearchTextChip, type SearchTextPatch } from "@careeros/contract";
import "./looking-for.css";

/** What this search changes: the chips the box understood, and the words it didn't (for Claude to apply). */
export interface Described { chips: SearchTextChip[]; free_text: string }
export const NOTHING_DESCRIBED: Described = { chips: [], free_text: "" };

/** "Recent jobs": newest first, posted in the last 3 days. Both show as chips the person can remove or change. */
export const RECENT_CHIPS: SearchTextChip[] = [
  { id: "sort", label: "Newest first", patch: { sort: "recent" } },
  { id: "posted", label: "Posted in the last 3 days", patch: { posted_days: 3 } },
];

/** The run's own search choices for what was described (main checks them again). */
export function describedPatch(d: Described): SearchTextPatch {
  const p = chipsPatch(d.chips);
  return d.free_text ? { ...p, free_text: d.free_text } : p;
}

/** Joins new chips onto the ones there: a chip for the same setting replaces the old one. */
function joinChips(old: readonly SearchTextChip[], add: readonly SearchTextChip[]): SearchTextChip[] {
  const out = old.filter((c) => !add.some((a) => a.id === c.id));
  return [...out, ...add];
}

/**
 * Find jobs › "Describe the jobs you want": one box instead of many buttons. What it understands becomes chips for
 * this search only (remove any that are wrong); the rest is kept as words Claude applies when it reads the ads.
 * The saved filters stay under "All filters".
 */
export function DescribeSearch({ value, onChange, places }: { value: Described; onChange(d: Described): void; places: readonly string[] }) {
  const [text, setText] = useState("");
  const id = useId();
  const read = () => {
    const t = text.trim();
    if (!t) return;
    const r = parseSearchText(t, { places });
    const free = [value.free_text, r.free_text].filter(Boolean).join("; ").slice(0, FREE_TEXT_MAX);
    onChange({ chips: joinChips(value.chips, r.chips), free_text: free });
    setText("");
  };
  const remove = (c: SearchTextChip) => onChange({ ...value, chips: value.chips.filter((x) => x !== c) });
  const any = value.chips.length > 0 || !!value.free_text;
  return (
    <div className="describe" role="group" aria-labelledby={`${id}-label`}>
      <form className="describe__row" onSubmit={(e) => { e.preventDefault(); read(); }}>
        <Input label="Describe the jobs you want" value={text} maxLength={500} onChange={(e) => setText(e.target.value)}
          placeholder="For example: remote or hybrid data roles in Sydney, posted this week, no big tech" />
        <div className="describe__actions">
          <Button size="sm" variant="primary" type="submit" disabled={!text.trim()}>Use this</Button>
          <Button size="sm" variant="ghost" type="button" title="Newest first, posted in the last 3 days. Change either chip after."
            onClick={() => onChange({ ...value, chips: joinChips(value.chips, RECENT_CHIPS) })}>Recent jobs</Button>
        </div>
      </form>
      <span id={`${id}-label`} className="sr-only">This search only</span>
      {any ? (
        <ul className="describe__chips" aria-label="This search only">
          {value.chips.map((c) => (
            <li key={`${c.id}:${c.label}`} className="describe__chip">
              <span>{c.label}</span>
              <button type="button" className="describe__x" aria-label={`Remove ${c.label}`} onClick={() => remove(c)}>×</button>
            </li>
          ))}
          {value.free_text ? (
            <li className="describe__chip describe__chip--text">
              <span>{`Claude will also look for: ${value.free_text}`}</span>
              <button type="button" className="describe__x" aria-label="Remove the words for Claude" onClick={() => onChange({ ...value, free_text: "" })}>×</button>
            </li>
          ) : null}
          <li><Button size="sm" variant="ghost" onClick={() => onChange(NOTHING_DESCRIBED)}>Clear</Button></li>
        </ul>
      ) : (
        <Text role="body-sm" muted as="p" className="describe__hint">For this search only. Your saved filters are under All filters.</Text>
      )}
    </div>
  );
}
