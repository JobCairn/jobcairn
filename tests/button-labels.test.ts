// Button-label lint: every visible action label in the renderer is two words or fewer
// ("Add job", "Stop & switch", "Open…"). Longer wording goes in a tooltip (title) or the
// accessible name. Counts and dynamic values don't count as words ("File 3 files", "All 12 jobs").
//
// It reads the JSX with the TypeScript parser and checks: the text of <button>, <a>, <summary>,
// any *Button / *Chip component and any role="menuitem|tab|option|button" element; their
// `label` prop; and `{ label, onSelect | onClick | to }` objects (menus and settings links).
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
const SRC = path.join(ROOT, "packages/app-ui/src");
const MAX_WORDS = 2;

/** Rich rows and cards: a title plus help text in one big target, not an action label. */
const ROW_CLASSES = ["mail-row", "stepper__button", "folder-tile", "rs-add__item", "onboard__other", "vscene__read"];
/** The command palette lists searchable commands, not buttons. */
const SKIP_OBJECTS = new Set(["Shell.tsx"]);

const words = (s: string): number => s.replace(/&amp;/g, "&").replace(/[….]+$/, "").trim().split(/\s+/)
  .filter((w) => w && !/^[&+·/:%()X0-9-]+$/.test(w)).length;
const cross = (a: string[], b: string[]): string[] => a.flatMap((x) => b.map((y) => `${x} ${y}`.trim())).slice(0, 32);

/** The texts a node can render (a conditional gives both branches). Other expressions render as "X". */
function alts(node: ts.Node | undefined, sf: ts.SourceFile): string[] {
  if (!node) return [""];
  if (ts.isJsxText(node)) return [node.text.replace(/\s+/g, " ").trim()];
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isTemplateExpression(node)) {
    let out = [node.head.text];
    for (const sp of node.templateSpans) out = cross(out, alts(sp.expression, sf)).map((x) => x + sp.literal.text);
    return out;
  }
  if (ts.isJsxExpression(node)) return node.expression ? alts(node.expression, sf) : [""];
  if (ts.isConditionalExpression(node)) return [...alts(node.whenTrue, sf), ...alts(node.whenFalse, sf)];
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) return cross(alts(node.left, sf), alts(node.right, sf));
  if (ts.isBinaryExpression(node)) return [...alts(node.left, sf), ...alts(node.right, sf)];
  if (ts.isParenthesizedExpression(node)) return alts(node.expression, sf);
  if (ts.isJsxElement(node)) {
    const tag = node.openingElement.tagName.getText(sf);
    const cls = node.openingElement.attributes.properties.find((a) => ts.isJsxAttribute(a) && a.name.getText(sf) === "className");
    if (cls && /sr-only/.test(cls.getText(sf))) return [""];
    return /^(span|strong|b|em|Text)$/.test(tag) ? seq(node.children, sf) : [""];
  }
  if (ts.isJsxSelfClosingElement(node) || node.kind === ts.SyntaxKind.NullKeyword) return [""];
  return ["X"];
}
const seq = (kids: readonly ts.Node[], sf: ts.SourceFile): string[] => kids.reduce<string[]>((acc, k) => cross(acc, alts(k, sf)), [""]);

function attr(open: ts.JsxOpeningLikeElement, name: string, sf: ts.SourceFile): ts.JsxAttribute | undefined {
  return open.attributes.properties.find((a): a is ts.JsxAttribute => ts.isJsxAttribute(a) && a.name.getText(sf) === name);
}

export function longLabels(file: string, text: string): string[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  const report = (n: ts.Node, labels: string[]) => {
    const bad = [...new Set(labels.map((x) => x.replace(/\s+/g, " ").trim()))].filter((x) => x && x !== "X" && words(x) > MAX_WORDS);
    if (bad.length) out.push(`${path.relative(ROOT, file)}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}: ${bad.join(" | ")}`);
  };
  const visit = (n: ts.Node): void => {
    if (ts.isObjectLiteralExpression(n) && !SKIP_OBJECTS.has(path.basename(file))) {
      const props = n.properties.filter(ts.isPropertyAssignment);
      const has = (k: string) => props.find((p) => p.name.getText(sf) === k);
      const label = has("label");
      if (label && (has("onSelect") || has("onClick") || has("to"))) report(n, alts(label.initializer, sf));
    }
    const open = ts.isJsxElement(n) ? n.openingElement : ts.isJsxSelfClosingElement(n) ? n : null;
    if (open) {
      const tag = open.tagName.getText(sf);
      const role = attr(open, "role", sf)?.initializer?.getText(sf) ?? "";
      const cls = attr(open, "className", sf)?.initializer?.getText(sf) ?? "";
      // IconButton's label is its accessible name only; the visible label is the icon.
      const action = tag !== "IconButton" && (/Button$|Chip$|^(button|a|summary)$/.test(tag) || /menuitem|"tab"|option|"button"/.test(role));
      if (action && !ROW_CLASSES.some((c) => cls.includes(c))) {
        const labels = ts.isJsxElement(n) ? seq(n.children, sf) : [];
        const prop = attr(open, "label", sf);
        if (prop?.initializer) labels.push(...alts(prop.initializer, sf));
        report(open, labels);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? files(p) : p.endsWith(".tsx") ? [p] : [];
  });
}

describe("button labels", () => {
  it("flags long labels and lets short ones, counts and tooltips through", () => {
    const src = `export const A = () => <>
      <Button>Add a job</Button><Button title="Add a job you found">Add job</Button>
      <Button>{n ? \`File \${n} files\` : "Move to Trash"}</Button>
      <IconButton label="Move this section up" /><button className="mail-row">From Sam about the interview</button>
    </>;
    const menu = [{ id: "a", label: "Duplicate as general version", onSelect: () => {} }];`;
    expect(longLabels(path.join(SRC, "x.tsx"), src).map((l) => l.replace(/^.*?: /, ""))).toEqual([
      "Add a job", "Move to Trash", "Duplicate as general version",
    ]);
  });

  it(`keeps every visible action label in app-ui at ${MAX_WORDS} words or fewer`, () => {
    const all = files(SRC);
    expect(all.length).toBeGreaterThan(50);
    expect(all.flatMap((f) => longLabels(f, fs.readFileSync(f, "utf8")))).toEqual([]);
  });
});
