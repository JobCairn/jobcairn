import { useId, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import { Button, Checkbox, Icon, Icons, Input, Select, Text } from "@careeros/brand";
import type { FieldDef } from "@careeros/contract";
import "./list-field.css";
import { PlaceInput } from "../filters/PlaceInput";
import "../filters/filters.css";

export type ListRow = Record<string, unknown>;

/** How a list change should save: straight away (add-free changes such as remove, move, ticks), or after typing pauses. */
export type ListChange = "now" | "typing";

const optionWords = (f: FieldDef, o: string) => f.optionLabels[o] ?? (o.charAt(0).toUpperCase() + o.slice(1)).replace(/_/g, " ");

/** The sub-field that names a row (the first text field: "Place"), or undefined. */
export const nameField = (f: FieldDef): FieldDef | undefined => f.fields.find((x) => x.type === "string");

/** A fresh row: text empty, ticks off, multi-choice with every option (the schemas' "any" default). */
export function blankRow(f: FieldDef): ListRow {
  const row: ListRow = {};
  for (const x of f.fields) {
    if (x.type === "string") row[x.path] = "";
    else if (x.type === "boolean") row[x.path] = false;
    else if (x.type === "enum[]") row[x.path] = [...x.options];
    else if (x.type === "enum") row[x.path] = x.options[0] ?? "";
  }
  return row;
}

/** Moves one row from `from` to `to` (both clamped). Returns a new list. */
export function moveRow<T>(rows: readonly T[], from: number, to: number): T[] {
  const out = [...rows];
  const t = Math.max(0, Math.min(out.length - 1, to));
  if (from < 0 || from >= out.length || t === from) return out;
  const [x] = out.splice(from, 1);
  out.splice(t, 0, x!);
  return out;
}

/**
 * Checks a list before it's saved: every row needs its name (e.g. a place), text is trimmed, and two rows can't have
 * the same name. Returns the cleaned list, or what to fix.
 */
export function checkRows(f: FieldDef, rows: unknown): { value?: ListRow[]; error?: string } {
  if (!Array.isArray(rows)) return { value: [] };
  const name = nameField(f);
  const seen = new Set<string>();
  const out: ListRow[] = [];
  for (const r of rows) {
    const row: ListRow = { ...(r && typeof r === "object" ? (r as ListRow) : {}) };
    for (const x of f.fields) if (x.type === "string" && typeof row[x.path] === "string") row[x.path] = (row[x.path] as string).trim();
    if (name) {
      const n = String(row[name.path] ?? "");
      const what = name.label.toLowerCase();
      if (!n) return { error: `Each row needs a ${what}. Type one, or remove the empty row.` };
      if (seen.has(n.toLowerCase())) return { error: `${n} is in the list twice. Remove one.` };
      seen.add(n.toLowerCase());
    }
    out.push(row);
  }
  return { value: out };
}

export interface ListFieldProps {
  field: FieldDef;
  rows: ListRow[];
  error?: string;
  /** Suggestions for the name field (a place picker's places). */
  suggestions?: readonly string[];
  /** The list's own help line under the title. */
  help?: string;
  onChange(rows: ListRow[], how: ListChange): void;
  /** Focus left the whole list (save what was typed). */
  onLeave(): void;
  onEnter(): void;
  note?: ReactNode;
}

/**
 * A list of records the person edits in place: add, edit, remove and reorder rows (drag the handle, or use the
 * arrow buttons; the handle also moves with the Up and Down keys). The first row is the most preferred. Sub-fields
 * are drawn from the schema, so any list of records works; the name field can offer suggestions.
 */
export function ListField({ field, rows, error, suggestions, help, onChange, onLeave, onEnter, note }: ListFieldProps) {
  const id = useId();
  const name = nameField(field);
  const what = (name?.label ?? "row").toLowerCase();
  const [said, setSaid] = useState("");
  const [drag, setDrag] = useState<{ from: number; over: number } | null>(null);
  const root = useRef<HTMLFieldSetElement>(null);
  const label = (r: ListRow, i: number) => (name && String(r[name.path] ?? "").trim()) || `${name?.label ?? "Row"} ${i + 1}`;

  const focusRow = (i: number, sel = "[data-row-handle]") => requestAnimationFrame(() => {
    root.current?.querySelectorAll<HTMLElement>(`[data-row="${i}"] ${sel}`)[0]?.focus();
  });
  const move = (from: number, to: number, keepFocus = "[data-row-handle]") => {
    if (to < 0 || to >= rows.length || to === from) return;
    onChange(moveRow(rows, from, to), "now");
    setSaid(`${label(rows[from]!, from)} moved to position ${to + 1} of ${rows.length}.`);
    focusRow(to, keepFocus);
  };
  const remove = (i: number) => {
    const gone = label(rows[i]!, i);
    onChange(rows.filter((_, j) => j !== i), "now");
    setSaid(`${gone} removed.`);
    requestAnimationFrame(() => {
      const next = root.current?.querySelector<HTMLElement>(`[data-row="${Math.min(i, rows.length - 2)}"] input`) ?? root.current?.querySelector<HTMLElement>("[data-list-add]");
      next?.focus();
    });
  };
  const add = () => {
    onChange([...rows, blankRow(field)], "typing");
    focusRow(rows.length, "input");
  };
  const set = (i: number, key: string, v: unknown, how: ListChange) => onChange(rows.map((r, j) => (j === i ? { ...r, [key]: v } : r)), how);
  const onHandleKey = (e: KeyboardEvent, i: number) => {
    if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); move(i, i + (e.key === "ArrowUp" ? -1 : 1)); }
    else if (e.key === "Home") { e.preventDefault(); move(i, 0); }
    else if (e.key === "End") { e.preventDefault(); move(i, rows.length - 1); }
  };
  const onDragOver = (e: DragEvent, i: number) => {
    if (!drag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (drag.over !== i) setDrag({ ...drag, over: i });
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    if (drag) move(drag.from, drag.over);
    setDrag(null);
  };

  return (
    <fieldset className="list-field" ref={root} aria-describedby={help ? `${id}-help` : undefined}
      onFocus={onEnter} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onLeave(); }}>
      <legend className="list-field__legend">{field.label}</legend>
      {help ? <Text role="body-sm" muted id={`${id}-help`} className="list-field__help">{help}</Text> : null}
      {rows.length ? (
        <ol className="list-field__rows">
          {rows.map((r, i) => {
            const rowName = label(r, i);
            return (
              <li key={i} className="list-field__row" data-row={i} data-dragging={drag?.from === i || undefined}
                data-drop={drag && drag.over === i && drag.from !== i ? (drag.from < i ? "after" : "before") : undefined}
                onDragOver={(e) => onDragOver(e, i)} onDrop={onDrop}>
                <button type="button" className="list-field__handle" data-row-handle draggable
                  aria-label={`Reorder ${rowName}, position ${i + 1} of ${rows.length}. Use the Up and Down keys.`}
                  title="Drag to reorder, or focus and press Up or Down"
                  onKeyDown={(e) => onHandleKey(e, i)}
                  onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", rowName); setDrag({ from: i, over: i }); }}
                  onDragEnd={() => setDrag(null)}>
                  <Icon icon={Icons.dragHandle} size="sm" />
                  <span className="list-field__rank" aria-hidden="true">{i + 1}</span>
                </button>
                <div className="list-field__body">
                  {field.fields.map((x) => {
                    const v = r[x.path];
                    if (x.type === "string") {
                      // The name field with suggestions is a place box: free text, the app's own suggestion list.
                      if (x === name && suggestions?.length) {
                        return (
                          <PlaceInput key={x.path} label={`${x.label} ${i + 1}`} className="list-field__name" value={String(v ?? "")}
                            placeholder={`For example: ${suggestions[0]}`} onChange={(t) => set(i, x.path, t, "typing")}
                            onAccept={(t) => set(i, x.path, t, "now")} />
                        );
                      }
                      return (
                        <Input key={x.path} label={`${x.label} ${i + 1}`} hideLabel className="list-field__name" value={String(v ?? "")} autoComplete="off"
                          onChange={(e) => set(i, x.path, e.target.value, "typing")} />
                      );
                    }
                    if (x.type === "enum[]") {
                      const list = Array.isArray(v) ? (v as string[]) : [];
                      return (
                        <fieldset key={x.path} className="list-field__choices">
                          <legend className="sr-only">{`${x.label} for ${rowName}`}</legend>
                          {x.options.map((o) => (
                            <Checkbox key={o} label={optionWords(x, o)} checked={list.includes(o)}
                              onChange={(e) => set(i, x.path, e.target.checked ? x.options.filter((y) => y === o || list.includes(y)) : list.filter((y) => y !== o), "now")} />
                          ))}
                        </fieldset>
                      );
                    }
                    if (x.type === "boolean") {
                      return <Checkbox key={x.path} className="list-field__flag" label={x.label} checked={v === true} onChange={(e) => set(i, x.path, e.target.checked, "now")} />;
                    }
                    if (x.type === "enum") {
                      return (
                        <Select key={x.path} label={`${x.label} for ${rowName}`} hideLabel value={String(v ?? "")} onChange={(e) => set(i, x.path, e.target.value, "now")}
                          options={x.options.map((o) => ({ value: o, label: optionWords(x, o) }))} />
                      );
                    }
                    return null;
                  })}
                </div>
                <div className="list-field__tools">
                  <button type="button" className="list-field__tool" data-move="up" aria-label={`Move ${rowName} up`} title="Move up" disabled={i === 0} onClick={() => move(i, i - 1, i - 1 === 0 ? "[data-move=down]" : "[data-move=up]")}>
                    <Icon icon={Icons.moveUp} size="sm" />
                  </button>
                  <button type="button" className="list-field__tool" data-move="down" aria-label={`Move ${rowName} down`} title="Move down" disabled={i === rows.length - 1} onClick={() => move(i, i + 1, i + 1 === rows.length - 1 ? "[data-move=up]" : "[data-move=down]")}>
                    <Icon icon={Icons.moveDown} size="sm" />
                  </button>
                  <button type="button" className="list-field__tool list-field__tool--danger" aria-label={`Remove ${rowName}`} title="Remove" onClick={() => remove(i)}>
                    <Icon icon={Icons.close} size="sm" />
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <Text role="body-sm" muted className="list-field__empty">{`No ${what}s yet. Add one below.`}</Text>
      )}
      <div className="list-field__foot">
        <Button size="sm" icon={Icons.add} data-list-add onClick={add}>{`Add ${what}`}</Button>
        {note}
      </div>
      {error ? <Text role="body-sm" className="list-field__error" aria-live="polite">{error}</Text> : null}
      <span className="sr-only" aria-live="polite">{said}</span>
    </fieldset>
  );
}
