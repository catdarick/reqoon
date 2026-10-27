import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Json } from "../lib/schema";
import { isBig, stringifyJson } from "../lib/json";
import { Check, Copy } from "./Icons";
import type { FoldRequest } from "./TextView";

const PAGE = 200;
/** Containers start expanded until the tree has this many rows; later ones start collapsed,
 *  so a large response doesn't render tens of thousands of rows at once. "Collapse all" instead
 *  keeps only the root open. */
const AUTO_OPEN_ROWS = 5000;

// The tree is rendered as a flat list of rows so that copying a selection and searching can
// work on the whole document, including collapsed nodes and unrendered pages.

type Seg = (string | number)[];

interface Row {
  kind: "prim" | "open" | "close" | "empty" | "collapsed" | "more";
  path: Seg;
  depth: number;
  name?: string | number; // object key (string) or array index (number, not shown)
  value?: Json; // the node itself (for "more": the parent container)
  last: boolean; // no trailing comma
  arr?: boolean;
  from?: number; // "more": first entry not rendered yet
}

/** A search hit: a line of the fully expanded pretty JSON and where the hit starts in it. */
export interface JsonMatch {
  path: Seg;
  line: "node" | "close"; // the node's own line (opening line for containers) or its closing bracket
  at: number;
}

const pathId = (p: Seg) => p.map((s) => String(s).replace(/~/g, "~0").replace(/\//g, "~1")).join("/");

function isContainer(v: Json): v is Json[] | { [k: string]: Json } {
  return v !== null && typeof v === "object" && !isBig(v);
}

function entriesOf(v: Json[] | { [k: string]: Json }): [string | number, Json][] {
  return Array.isArray(v) ? v.map((x, i) => [i, x]) : Object.entries(v);
}

function keyPart(name: string | number | undefined): string {
  return typeof name === "string" ? `${JSON.stringify(name)}: ` : "";
}

/** Pretty JSON of a value whose first line starts at `depth` (later lines get the indentation). */
function pretty(v: Json, depth: number): string {
  const text = stringifyJson(v, 2) ?? "null";
  const pad = "  ".repeat(depth);
  return text.replace(/\n/g, `\n${pad}`);
}

/** Text of a row as it would appear in fully expanded pretty JSON (without leading indentation). */
function fullText(r: Row): string {
  const comma = r.last ? "" : ",";
  switch (r.kind) {
    case "prim":
    case "empty":
    case "collapsed":
      return `${keyPart(r.name)}${pretty(r.value!, r.depth)}${comma}`;
    case "open":
      return `${keyPart(r.name)}${r.arr ? "[" : "{"}`;
    case "close":
      return `${r.arr ? "]" : "}"}${comma}`;
    case "more": {
      const pad = "  ".repeat(r.depth);
      return entriesOf(r.value as Json[])
        .slice(r.from)
        .map(([k, v]) => `${keyPart(k)}${pretty(v, r.depth)}`)
        .join(`,\n${pad}`);
    }
  }
}

/** Text shown in the row's content span; equal to fullText except for collapsed and "more" rows. */
function shownText(r: Row): string {
  if (r.kind === "collapsed") return `${keyPart(r.name)}${r.arr ? "[" : "{"}`;
  if (r.kind === "more") return "";
  return fullText(r);
}

/** Plain substring search over each line of the fully expanded pretty JSON, so queries like
 *  `name": "foo` work across keys, punctuation and values. */
function findMatches(root: Json, q: string): JsonMatch[] {
  const out: JsonMatch[] = [];
  const needle = q.toLowerCase();
  const scan = (text: string, path: Seg, line: JsonMatch["line"]) => {
    const lower = text.toLowerCase();
    for (let i = lower.indexOf(needle); i >= 0; i = lower.indexOf(needle, i + needle.length)) out.push({ path, line, at: i });
  };
  const walk = (v: Json, path: Seg, name: string | number | undefined, last: boolean) => {
    const comma = last ? "" : ",";
    if (!isContainer(v)) return scan(`${keyPart(name)}${primText(v)}${comma}`, path, "node");
    const arr = Array.isArray(v);
    const entries = entriesOf(v);
    if (!entries.length) return scan(`${keyPart(name)}${arr ? "[]" : "{}"}${comma}`, path, "node");
    scan(`${keyPart(name)}${arr ? "[" : "{"}`, path, "node");
    entries.forEach(([k, x], i) => walk(x, [...path, k], k, i === entries.length - 1));
    scan(`${arr ? "]" : "}"}${comma}`, path, "close");
  };
  walk(root, [], undefined, true);
  return out;
}

function primText(v: Json): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (isBig(v)) return v.raw;
  return String(v);
}

export default function JsonTree({
  value,
  query = "",
  current = 0,
  onMatches,
  fold,
}: {
  value: Json;
  query?: string;
  current?: number;
  onMatches?: (n: number) => void;
  fold?: FoldRequest;
}) {
  // User choices override the default open state; keyed by path id.
  const [openState, setOpenState] = useState<Map<string, boolean>>(() => new Map());
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    if (!fold) return;
    setOpenState(new Map());
    setCollapsed(fold.collapse);
  }, [fold]);
  const [limits, setLimits] = useState<Map<string, number>>(() => new Map());
  const box = useRef<HTMLDivElement>(null);

  const matches = useMemo(() => (query ? findMatches(value, query) : []), [value, query]);
  useEffect(() => onMatches?.(matches.length), [matches, onMatches]);
  const cur = matches.length ? matches[((current % matches.length) + matches.length) % matches.length] : undefined;

  // Reveal the current match: open its ancestors and page far enough to render it.
  useEffect(() => {
    if (!cur) return;
    // A closing bracket is only shown while its own node is open.
    const upto = cur.line === "close" ? cur.path.length + 1 : cur.path.length;
    const ids = Array.from({ length: upto }, (_, i) => pathId(cur.path.slice(0, i)));
    setOpenState((m) => (ids.every((id) => m.get(id)) ? m : new Map([...m, ...ids.map((id) => [id, true] as [string, boolean])])));
    setLimits((m) => {
      const next = new Map(m);
      let changed = false;
      cur.path.forEach((seg, i) => {
        const parent = pathId(cur.path.slice(0, i));
        const pos = typeof seg === "number" ? seg : 0;
        if (typeof seg === "number" && pos >= (next.get(parent) ?? PAGE)) {
          next.set(parent, Math.ceil((pos + 1) / PAGE) * PAGE);
          changed = true;
        }
      });
      return changed ? next : m;
    });
  }, [cur]);

  const rows = useMemo(() => {
    const out: Row[] = [];
    const walk = (v: Json, path: Seg, depth: number, name: string | number | undefined, last: boolean) => {
      if (!isContainer(v)) return void out.push({ kind: "prim", path, depth, name, value: v, last });
      const arr = Array.isArray(v);
      const entries = entriesOf(v);
      if (!entries.length) return void out.push({ kind: "empty", path, depth, name, value: v, last, arr });
      const id = pathId(path);
      const open = openState.get(id) ?? (collapsed ? depth === 0 : out.length < AUTO_OPEN_ROWS);
      if (!open) return void out.push({ kind: "collapsed", path, depth, name, value: v, last, arr });
      out.push({ kind: "open", path, depth, name, value: v, last, arr });
      const limit = limits.get(id) ?? PAGE;
      entries.slice(0, limit).forEach(([k, x], i) => walk(x, [...path, k], depth + 1, k, i === entries.length - 1));
      if (entries.length > limit) out.push({ kind: "more", path, depth: depth + 1, value: v, last: true, from: limit });
      out.push({ kind: "close", path, depth, last, arr });
    };
    walk(value, [], 0, undefined, true);
    return out;
  }, [value, openState, limits, collapsed]);

  const toggle = useCallback((r: Row) => {
    const id = pathId(r.path);
    setOpenState((m) => new Map(m).set(id, r.kind === "collapsed"));
  }, []);

  // Scroll the current match into view once it's rendered.
  useEffect(() => {
    box.current?.querySelector(".jt-hit.cur")?.scrollIntoView({ block: "nearest" });
  }, [cur, rows]);

  const onCopy = (e: React.ClipboardEvent) => {
    const text = selectionText(rows, box.current);
    if (text === null) return;
    e.preventDefault();
    e.clipboardData.setData("text/plain", text);
  };

  const curId = cur ? pathId(cur.path) : null;
  return (
    <div className="jt" ref={box} onCopy={onCopy}>
      {rows.map((r, i) => (
        <RowView
          key={`${r.kind}:${pathId(r.path)}`}
          row={r}
          idx={i}
          query={query}
          curAt={curId !== null && pathId(r.path) === curId && (r.kind === "close") === (cur!.line === "close") ? cur!.at : null}
          onToggle={toggle}
          onMore={() => setLimits((m) => new Map(m).set(pathId(r.path), (r.from ?? PAGE) + PAGE * 5))}
        />
      ))}
    </div>
  );
}

function RowView({
  row: r,
  idx,
  query,
  curAt,
  onToggle,
  onMore,
}: {
  row: Row;
  idx: number;
  query: string;
  curAt: number | null;
  onToggle: (r: Row) => void;
  onMore: () => void;
}) {
  const indent = { paddingLeft: r.depth * 16 };
  const comma = r.last ? "" : ",";
  if (r.kind === "more") {
    const total = Array.isArray(r.value) ? r.value.length : Object.keys(r.value as object).length;
    return (
      <div className="jt-row" style={indent} data-idx={idx}>
        <span className="jt-toggle" />
        <span className="jt-text" />
        <span className="jt-more" onClick={onMore}>
          … show more ({total - r.from!} remaining)
        </span>
      </div>
    );
  }
  const togglable = r.kind === "open" || r.kind === "collapsed";
  // The row's text as styled pieces; together they spell shownText(r).
  const segs: [string, string][] = [];
  if (typeof r.name === "string" && r.kind !== "close") segs.push([JSON.stringify(r.name), "jt-key"], [": ", "jt-p"]);
  if (r.kind === "prim") segs.push([primText(r.value!), primClass(r.value!)], [comma, "jt-p"]);
  else if (r.kind === "close") segs.push([(r.arr ? "]" : "}") + comma, "jt-p"]);
  else if (r.kind === "empty") segs.push([(r.arr ? "[]" : "{}") + comma, "jt-p"]);
  else segs.push([r.arr ? "[" : "{", "jt-p"]);
  const size = r.kind === "collapsed" ? (Array.isArray(r.value) ? r.value.length : Object.keys(r.value as object).length) : 0;
  return (
    <div className={`jt-row ${togglable ? "togglable" : ""}`} style={indent} data-idx={idx}>
      <span className={`jt-toggle ${r.kind}`} onClick={togglable ? () => onToggle(r) : undefined} />
      <span className="jt-text">
        <Segments segs={segs} q={query} curAt={curAt} />
      </span>
      {r.kind === "collapsed" && (
        <>
          <span className="jt-summary" onClick={() => onToggle(r)}>
            {" "}
            {r.arr ? `${size} item${size === 1 ? "" : "s"}` : `${size} key${size === 1 ? "" : "s"}`}{" "}
          </span>
          <span className="jt-p">{(r.arr ? "]" : "}") + comma}</span>
        </>
      )}
      {r.kind !== "close" && <CopyValue value={r.value!} />}
    </div>
  );
}

/** Styled pieces of a row with search hits highlighted, even when a hit spans several pieces. */
function Segments({ segs, q, curAt }: { segs: [string, string][]; q: string; curAt: number | null }) {
  const full = segs.map(([t]) => t).join("");
  const hits: number[] = [];
  if (q) {
    const lower = full.toLowerCase();
    const needle = q.toLowerCase();
    for (let i = lower.indexOf(needle); i >= 0; i = lower.indexOf(needle, i + needle.length)) hits.push(i);
  }
  let pos = 0;
  return (
    <>
      {segs.map(([text, cls], si) => {
        const from = pos;
        pos += text.length;
        if (!text) return null;
        const parts: React.ReactNode[] = [];
        let at = from;
        for (const h of hits) {
          const s = Math.max(h, from);
          const e = Math.min(h + q.length, pos);
          if (s >= e) continue;
          if (s > at) parts.push(full.slice(at, s));
          parts.push(
            <mark key={s} className={`jt-hit ${h === curAt ? "cur" : ""}`}>
              {full.slice(s, e)}
            </mark>,
          );
          at = e;
        }
        if (at < pos) parts.push(full.slice(at, pos));
        return (
          <span key={si} className={cls}>
            {parts}
          </span>
        );
      })}
    </>
  );
}

function primClass(v: Json): string {
  if (typeof v === "string") return "jt-str";
  if (typeof v === "number" || isBig(v)) return "jt-num";
  if (typeof v === "boolean") return "jt-bool";
  return "jt-null";
}

function CopyValue({ value }: { value: Json }) {
  const [done, setDone] = useState(false);
  const text = typeof value === "string" ? value : stringifyJson(value, 2) ?? "null";
  return (
    <button
      className="jt-copy"
      title={typeof value === "string" ? "Copy value" : isContainer(value) ? "Copy as JSON" : "Copy value"}
      onMouseDown={(e) => e.preventDefault()} // keep the current text selection
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1000);
      }}
    >
      {done ? <Check size={11} /> : <Copy size={11} />}
    </button>
  );
}

/**
 * The selected part of the tree as JSON text, with collapsed nodes and unrendered pages
 * written out in full. Returns null when the selection isn't inside the tree.
 */
function selectionText(rows: Row[], box: HTMLElement | null): string | null {
  const sel = window.getSelection();
  if (!box || !sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!box.contains(range.commonAncestorContainer)) return null;
  const locate = (node: Node, offset: number, atEnd: boolean) => {
    const el = (node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement)?.closest<HTMLElement>(".jt-row");
    if (!el) {
      // Selection boundary on the container itself: before the first / after the last row.
      return { idx: atEnd ? rows.length - 1 : 0, offset: atEnd ? Infinity : 0 };
    }
    const idx = Number(el.dataset.idx);
    const text = el.querySelector(".jt-text");
    let off: number;
    if (text?.contains(node)) {
      const r = document.createRange();
      r.selectNodeContents(text);
      r.setEnd(node, offset);
      off = r.toString().length;
    } else {
      // In the toggle (before the text) or the summary / copy button (after it).
      off = text && text.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_PRECEDING ? 0 : Infinity;
    }
    return { idx, offset: off };
  };
  const a = locate(range.startContainer, range.startOffset, false);
  const b = locate(range.endContainer, range.endOffset, true);
  const lines: string[] = [];
  for (let i = a.idx; i <= b.idx; i++) {
    const r = rows[i];
    if (!r) continue;
    const full = fullText(r);
    const shown = shownText(r);
    // Rows that stand for hidden content are always copied whole.
    const partial = r.kind !== "collapsed" && r.kind !== "more";
    let t = full;
    let indent = "  ".repeat(r.depth);
    if (partial) {
      const start = i === a.idx ? Math.min(a.offset, shown.length) : 0;
      const end = i === b.idx ? Math.min(b.offset, shown.length) : shown.length;
      t = shown.slice(start, end);
      if (start > 0) indent = "";
    }
    if (!t && (r.kind === "more" || i === a.idx || i === b.idx)) continue;
    lines.push(indent + t);
  }
  return lines.join("\n");
}
