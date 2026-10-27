// Column wrapping for response text with very long lines.
//
// CodeMirror's own wrapping lays a long line out as one block: a multi-megabyte line is rendered
// in full and can exceed the browser's maximum element height. Instead the text is cut into rows
// of `cols` characters, so every row has the same height and CodeMirror virtualizes them like any
// other lines. Find, folding, copy and line numbers work on original offsets through the mapping.
import { Text } from "@codemirror/state";
import { firstAtOrAfter } from "./textSearch";

/** Lines longer than this are wrapped by column instead of by CodeMirror (twice CodeMirror's
 *  margin for drawing part of a wrapped line, so its partial drawing never comes into play). */
export const LONG_LINE = 20_000;

export function maxLineLength(text: string): number {
  let max = 0;
  for (let at = 0; at <= text.length; ) {
    let nl = text.indexOf("\n", at);
    if (nl < 0) nl = text.length;
    if (nl - at > max) max = nl - at;
    at = nl + 1;
  }
  return max;
}

export interface Layout {
  doc: Text;
  /** Original offsets before which a row break was inserted, ascending. Empty for the identity layout. */
  breaks: Int32Array;
  /** For each displayed row (0-based), the original 1-based line it shows, or 0 for a continuation row. */
  rowLine: Int32Array | null;
  /** Start offset of each original line (0-based), for column layouts. */
  lineStarts: Int32Array | null;
}

export function identityLayout(text: string): Layout {
  return { doc: Text.of(text.split("\n")), breaks: new Int32Array(0), rowLine: null, lineStarts: null };
}

/** Cuts every line longer than `cols` into `cols`-character rows. */
export function columnLayout(text: string, cols: number): Layout {
  cols = Math.max(1, Math.floor(cols));
  const rows: string[] = [];
  const breaks: number[] = [];
  const rowLine: number[] = [];
  const lineStarts: number[] = [];
  let lineNo = 0;
  for (let at = 0; at <= text.length; ) {
    let nl = text.indexOf("\n", at);
    if (nl < 0) nl = text.length;
    lineNo++;
    lineStarts.push(at);
    rows.push(text.slice(at, Math.min(nl, at + cols)));
    rowLine.push(lineNo);
    for (let s = at + cols; s < nl; s += cols) {
      breaks.push(s);
      rows.push(text.slice(s, Math.min(nl, s + cols)));
      rowLine.push(0);
    }
    at = nl + 1;
  }
  return { doc: Text.of(rows), breaks: Int32Array.from(breaks), rowLine: Int32Array.from(rowLine), lineStarts: Int32Array.from(lineStarts) };
}

/** Display offset of an original offset. At a row break, `assoc` 1 puts it at the start of the
 *  next row (for range starts) and -1 at the end of the previous row (for range ends). */
export function toDisplay(l: Layout, pos: number, assoc: 1 | -1 = 1): number {
  const b = l.breaks;
  if (!b.length) return pos;
  // Breaks at or before pos (assoc 1), or strictly before it (assoc -1).
  const k = firstAtOrAfter(b, b.length, assoc === 1 ? pos + 1 : pos);
  return pos + k;
}

/** Original offset of a display offset. */
export function toOrig(l: Layout, pos: number): number {
  const b = l.breaks;
  if (!b.length) return pos;
  // The inserted newline for break i sits at display offset b[i] + i.
  let lo = 0;
  let hi = b.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (b[mid] + mid < pos) lo = mid + 1;
    else hi = mid;
  }
  return pos - lo;
}

/** Original line number shown on a displayed row (1-based), or 0 for a continuation row. */
export function origLineOfRow(l: Layout, row: number): number {
  return l.rowLine ? l.rowLine[row - 1] : row;
}

/** Displayed row (1-based) where an original line starts. */
export function rowOfOrigLine(l: Layout, line: number): number {
  if (!l.lineStarts) return line;
  return l.doc.lineAt(toDisplay(l, l.lineStarts[line - 1])).number;
}

/** Display offset of the end of an original line. */
export function origLineEnd(l: Layout, line: number): number {
  if (!l.lineStarts) return l.doc.line(line).to;
  const next = line < l.lineStarts.length ? l.lineStarts[line] - 1 : toOrig(l, l.doc.length);
  return toDisplay(l, next, -1);
}
