import { useEffect, useMemo, useRef } from "react";
import { Decoration, DecorationSet, EditorView, lineNumbers, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { Annotation, EditorState, Extension, RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { codeFolding, foldable, foldedRanges, foldEffect, foldGutter, foldService, unfoldAll, unfoldEffect } from "@codemirror/language";
import { findAll, firstAtOrAfter, Hits, NO_HITS } from "../lib/textSearch";
import {
  columnLayout,
  identityLayout,
  Layout,
  LONG_LINE,
  maxLineLength,
  origLineEnd,
  origLineOfRow,
  rowOfOrigLine,
  toDisplay,
  toOrig,
} from "../lib/wrapLayout";

export type Highlight = "xml" | "json";

/** "Collapse all" / "Expand all" from the response toolbar; `seq` makes each click a new request. */
export interface FoldRequest {
  collapse: boolean;
  seq: number;
}

/** What the editor extensions read; replaced when the layout is rebuilt for a new width. */
interface Ctx {
  text: string;
  layout: Layout;
  cols: number;
  /** After "Collapse all": opening a fold folds the children inside it, as the JSON tree does. */
  collapsed: boolean;
}

/** Read-only view of response text of any size. CodeMirror renders only the visible lines; long
 *  lines are wrapped by column (see wrapLayout.ts) instead of by CodeMirror when wrapping is on.
 *  Highlighting, find marks and folding are computed for the viewport only. */
export default function TextView({
  text,
  wrap,
  folds,
  highlight,
  fold,
  query,
  current,
  onMatches,
}: {
  text: string;
  wrap: boolean;
  /** Fold pairs from formatting: closing line per opening line (see FormattedText). */
  folds?: Int32Array;
  highlight?: Highlight;
  fold?: FoldRequest;
  query: string;
  current: number;
  onMatches: (n: number) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const ctx = useRef<Ctx | null>(null);
  const byColumn = useMemo(() => wrap && maxLineLength(text) > LONG_LINE, [text, wrap]);

  useEffect(() => {
    const c: Ctx = { text, layout: identityLayout(text), cols: 0, collapsed: false };
    if (byColumn) {
      // A first guess from the pane width; corrected once the font is measured below.
      c.cols = Math.max(20, Math.floor((host.current!.clientWidth - 60) / 7.2));
      c.layout = columnLayout(text, c.cols);
    }
    ctx.current = c;
    const exts: Extension[] = [
      EditorState.readOnly.of(true),
      // Only \n breaks lines, so offsets match the body (CodeMirror would also split on \r\n).
      EditorState.lineSeparator.of("\n"),
      lineNumbers({
        formatNumber: (row, state) => {
          const line = origLineOfRow(c.layout, row);
          if (line) return String(line);
          // Continuation rows are blank; the last row still sizes the gutter.
          return row === state.doc.lines ? " ".repeat(String(c.layout.lineStarts?.length ?? row).length) : "";
        },
      }),
      byColumn || !wrap ? [] : EditorView.lineWrapping,
      highlight ? highlighters[highlight] : [],
      findField,
      findMarks(c),
      // Copy the original text, without the row breaks of column wrapping.
      EditorView.clipboardOutputFilter.of((copied, state) => {
        const ranges = state.selection.ranges.filter((r) => !r.empty);
        if (!c.layout.breaks.length || !ranges.length) return copied;
        return ranges.map((r) => c.text.slice(toOrig(c.layout, r.from), toOrig(c.layout, r.to))).join("\n");
      }),
      theme,
      EditorView.contentAttributes.of({ "aria-label": "Response body" }),
    ];
    if (folds) {
      exts.push(
        codeFolding({ placeholderText: "…" }),
        foldGutter(),
        // Folding is lazy: rather than folding every level up front (slow on large bodies),
        // each unfold folds the next level, except the branch leading to a find match.
        EditorState.transactionExtender.of((tr) => {
          if (!c.collapsed) return null;
          const keep = tr.annotation(revealAt);
          const effects = new Map<string, StateEffect<unknown>>();
          for (const e of tr.effects) {
            if (e.is(unfoldEffect)) for (const f of childFolds(tr.startState, e.value, keep)) effects.set(`${f.from}:${f.to}`, foldEffect.of(f));
          }
          return effects.size ? { effects: [...effects.values()] } : null;
        }),
        // Fold to `<a>…</a>` / `{…}`, using the line pairs found while formatting.
        foldService.of((state, from) => {
          const line = origLineOfRow(c.layout, state.doc.lineAt(from).number);
          const end = line && folds[line];
          if (!end) return null;
          const close = state.doc.line(rowOfOrigLine(c.layout, end));
          return { from: origLineEnd(c.layout, line), to: close.from + (/^\s*/.exec(close.text)?.[0].length ?? 0) };
        }),
      );
    }
    const v = new EditorView({ parent: host.current!, state: EditorState.create({ doc: c.layout.doc, extensions: exts }) });
    view.current = v;

    // Column wrapping follows the pane width; rebuilding keeps the same text at the top.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const rebuild = () => {
      const cols = measureCols(v);
      if (cols === c.cols) return;
      const top = toOrig(c.layout, v.lineBlockAtHeight(v.scrollDOM.getBoundingClientRect().top - v.documentTop).from);
      c.cols = cols;
      c.layout = columnLayout(c.text, cols);
      v.dispatch({
        changes: { from: 0, to: v.state.doc.length, insert: c.layout.doc },
        effects: EditorView.scrollIntoView(toDisplay(c.layout, top), { y: "start" }),
      });
    };
    const ro = byColumn ? new ResizeObserver(() => {
      clearTimeout(timer);
      // The first measurement (font now known) applies at once; resizes settle first.
      timer = setTimeout(rebuild, c.cols && v.defaultCharacterWidth ? 200 : 0);
    }) : undefined;
    ro?.observe(v.scrollDOM);
    return () => {
      clearTimeout(timer);
      ro?.disconnect();
      v.destroy();
    };
  }, [text, wrap, byColumn, folds, highlight]);

  useEffect(() => {
    const v = view.current;
    const c = ctx.current;
    if (!v || !c || !fold) return;
    c.collapsed = false;
    unfoldAll(v);
    if (fold.collapse) collapseAll(v, c);
    // Only a new click applies; a rebuilt view starts unfolded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fold]);

  const hits = useMemo(() => findAll(text, query), [text, query]);
  useEffect(() => onMatches(hits.n), [hits, onMatches]);

  useEffect(() => {
    const v = view.current;
    const c = ctx.current;
    if (!v || !c) return;
    const cur = hits.n ? ((current % hits.n) + hits.n) % hits.n : -1;
    const effects: StateEffect<unknown>[] = [setFind.of({ hits, cur })];
    if (cur >= 0) {
      const at = toDisplay(c.layout, hits.pos[cur]);
      foldedRanges(v.state).between(at, at + 1, (from, to) => void effects.push(unfoldEffect.of({ from, to })));
      effects.push(EditorView.scrollIntoView(at, { y: "center" }));
    }
    v.dispatch({ effects, annotations: cur >= 0 ? revealAt.of(toDisplay(c.layout, hits.pos[cur])) : [] });
  }, [hits, current, text, wrap, byColumn, folds, highlight]);

  return <div className="resp-view" ref={host} />;
}

/** A find match being scrolled to: lazy folding leaves the branch that leads to it open. */
const revealAt = Annotation.define<number>();

/** Folds for the elements directly inside `range` (an open fold range). The child containing
 *  `keep` isn't folded; its own children are, recursively, so `keep` stays visible. */
function childFolds(state: EditorState, range: { from: number; to: number }, keep?: number): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  for (let pos = state.doc.lineAt(range.from).to + 1; pos < range.to; ) {
    const line = state.doc.lineAt(pos);
    const child = foldable(state, line.from, line.to);
    if (child) {
      if (keep !== undefined && keep >= line.from && keep <= child.to) out.push(...childFolds(state, child, keep));
      else out.push(child);
    }
    pos = (child ? state.doc.lineAt(child.to) : line).to + 1;
  }
  return out;
}

/** Leaves the outermost element or container open with its children folded. Deeper levels are
 *  folded as they are opened (see the transaction extender). */
function collapseAll(v: EditorView, c: Ctx) {
  const { state } = v;
  for (let pos = 0; pos < state.doc.length; ) {
    const line = state.doc.lineAt(pos);
    const root = foldable(state, line.from, line.to);
    if (root) {
      c.collapsed = true;
      v.dispatch({ effects: unfoldEffect.of(root) });
      return;
    }
    pos = line.to + 1;
  }
}

/** Characters that fit in a row next to the gutter. */
function measureCols(v: EditorView): number {
  const gutter = v.dom.querySelector<HTMLElement>(".cm-gutters")?.offsetWidth ?? 0;
  // .cm-line padding (6px + 2px) and a little slack for the scrollbar.
  const width = v.scrollDOM.clientWidth - gutter - 12;
  return Math.max(20, Math.floor(width / (v.defaultCharacterWidth || 7.2)));
}

// ---------------------------------------------------------------------------------------------
// Find marks

interface FindState {
  hits: Hits;
  cur: number;
}

const setFind = StateEffect.define<FindState>();

const findField = StateField.define<FindState>({
  create: () => ({ hits: NO_HITS, cur: -1 }),
  update: (value, tr) => tr.effects.find((e) => e.is(setFind))?.value ?? value,
});

const hitMark = Decoration.mark({ tagName: "mark", class: "jt-hit" });
const curMark = Decoration.mark({ tagName: "mark", class: "jt-hit cur" });

function findMarks(c: Ctx) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }
      update(u: ViewUpdate) {
        if (u.viewportChanged || u.docChanged || u.startState.field(findField) !== u.state.field(findField)) this.decorations = this.build(u.view);
      }
      build(view: EditorView): DecorationSet {
        const { hits, cur } = view.state.field(findField);
        const b = new RangeSetBuilder<Decoration>();
        const { pos, n, len } = hits;
        if (!n) return b.finish();
        // Hits are original offsets; a hit spanning two visible ranges is added once.
        let i = 0;
        for (const { from, to } of view.visibleRanges) {
          const end = toOrig(c.layout, to);
          for (i = Math.max(i, firstAtOrAfter(pos, n, toOrig(c.layout, from) - len + 1)); i < n && pos[i] < end; i++) {
            const a = toDisplay(c.layout, pos[i], 1);
            const z = toDisplay(c.layout, pos[i] + len, -1);
            if (z > a) b.add(a, z, i === cur ? curMark : hitMark);
          }
        }
        return b.finish();
      }
    },
    { decorations: (p) => p.decorations },
  );
}

// ---------------------------------------------------------------------------------------------
// Syntax highlighting, per visible line. Formatted text puts every tag or member on its own line,
// so a line-local scan is enough; a token cut by column wrapping just loses its colors.

const marks = {
  tag: Decoration.mark({ class: "cm-x-tag" }),
  attr: Decoration.mark({ class: "cm-x-attr" }),
  key: Decoration.mark({ class: "cm-x-key" }),
  string: Decoration.mark({ class: "cm-x-string" }),
  number: Decoration.mark({ class: "cm-x-number" }),
  literal: Decoration.mark({ class: "cm-x-literal" }),
  punct: Decoration.mark({ class: "cm-x-punct" }),
  comment: Decoration.mark({ class: "cm-x-comment" }),
};
type Kind = keyof typeof marks;
type Add = (from: number, to: number, kind: Kind) => void;

function highlightXmlLine(text: string, base: number, add: Add) {
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt < 0) return;
    const special = /^<(!--[\s\S]*?(?:-->|$)|!\[CDATA\[[\s\S]*?(?:\]\]>|$)|[?!][^>]*>?)/.exec(text.slice(lt));
    if (special) {
      add(base + lt, base + lt + special[0].length, special[0].startsWith("<![CDATA[") ? "string" : "comment");
      i = lt + special[0].length;
      continue;
    }
    const name = /^<\/?([\w:.-]+)/.exec(text.slice(lt));
    if (!name) {
      i = lt + 1;
      continue;
    }
    const nameAt = lt + name[0].length - name[1].length;
    add(base + lt, base + nameAt, "punct");
    add(base + nameAt, base + lt + name[0].length, "tag");
    i = lt + name[0].length;
    // Attributes up to the end of the tag.
    const attr = /\s*([\w:.-]+)(\s*=\s*)("[^"]*"|'[^']*')?|\s*(\/?>)|\s*\S/y;
    for (;;) {
      attr.lastIndex = i;
      const m = attr.exec(text);
      if (!m) return;
      const start = i + m[0].length - m[0].trimStart().length;
      if (m[4]) {
        add(base + start, base + i + m[0].length, "punct");
        i += m[0].length;
        break;
      }
      if (m[1]) {
        add(base + start, base + start + m[1].length, "attr");
        if (m[3]) add(base + i + m[0].length - m[3].length, base + i + m[0].length, "string");
      }
      i += m[0].length;
    }
  }
}

function highlightJsonLine(text: string, base: number, add: Add) {
  const token = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d[\d.eE+-]*)|(true|false|null)\b|([{}[\],:])/g;
  for (let m = token.exec(text); m; m = token.exec(text)) {
    const at = base + m.index;
    if (m[1]) add(at, at + m[1].length, m[2] ? "key" : "string");
    else add(at, at + m[0].length, m[3] ? "number" : m[4] ? "literal" : "punct");
  }
}

function lineHighlighter(highlightLine: (text: string, base: number, add: Add) => void) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }
      update(u: ViewUpdate) {
        if (u.viewportChanged || u.docChanged) this.decorations = this.build(u.view);
      }
      build(view: EditorView): DecorationSet {
        const b = new RangeSetBuilder<Decoration>();
        for (const { from, to } of view.visibleRanges) {
          for (let pos = from; pos <= to; ) {
            const line = view.state.doc.lineAt(pos);
            highlightLine(line.text, line.from, (f, t, kind) => t > f && b.add(f, t, marks[kind]));
            pos = line.to + 1;
          }
        }
        return b.finish();
      }
    },
    { decorations: (p) => p.decorations },
  );
}

const highlighters: Record<Highlight, ReturnType<typeof lineHighlighter>> = {
  xml: lineHighlighter(highlightXmlLine),
  json: lineHighlighter(highlightJsonLine),
};

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "12px" },
  ".cm-content": { padding: "8px 0" },
  ".cm-foldPlaceholder": { background: "var(--bg-active)", border: "none", color: "var(--text-2)", padding: "0 4px" },
  ".cm-x-tag, .cm-x-key": { color: "var(--j-key)" },
  ".cm-x-attr, .cm-x-number": { color: "var(--j-number)" },
  ".cm-x-string": { color: "var(--j-string)" },
  ".cm-x-literal": { color: "var(--j-bool)" },
  ".cm-x-punct": { color: "var(--j-punct)" },
  ".cm-x-comment": { color: "var(--text-3)", fontStyle: "italic" },
});
