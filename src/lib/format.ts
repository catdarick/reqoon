// Response formatting for the Pretty view: XML and large JSON bodies re-indented as text.

/** Whether a response should be shown as XML: an XML content type, or an XML declaration when the
 *  type says nothing more specific. HTML is left alone: void tags like <br> have no end tag. */
export function isXmlResponse(contentType: string, body: string): boolean {
  const ct = contentType.toLowerCase();
  if (/[/+]xml\b/.test(ct)) return true;
  if (ct && !/^(text\/plain|application\/octet-stream)\b/.test(ct)) return false;
  return body.trimStart().startsWith("<?xml");
}

export interface FormattedText {
  text: string;
  /** Indexed by 1-based line: for a line that opens an element or container spanning several
   *  lines, the line that closes it; 0 otherwise. A typed array, so a worker can hand it over. */
  folds: Int32Array;
}

const INDENT = "  ";

/** Output text written into a UTF-16 buffer and decoded once: about twice as fast as joining
 *  millions of small strings, which matters for bodies of tens of megabytes. */
class Out {
  buf: Uint16Array;
  o = 0;
  /** 1-based number of the line being written. */
  line = 1;
  private folds = new Int32Array(1024);
  constructor(size: number) {
    this.buf = new Uint16Array(Math.max(1024, size));
  }
  fold(from: number, to: number) {
    if (from >= this.folds.length) {
      const grown = new Int32Array(Math.max(from + 1, this.folds.length * 2));
      grown.set(this.folds);
      this.folds = grown;
    }
    this.folds[from] = to;
  }
  ensure(k: number) {
    if (this.o + k <= this.buf.length) return;
    const grown = new Uint16Array((this.o + k) * 2);
    grown.set(this.buf.subarray(0, this.o));
    this.buf = grown;
  }
  copy(src: string, from: number, to: number) {
    this.ensure(to - from);
    const buf = this.buf;
    let o = this.o;
    for (let k = from; k < to; k++) buf[o++] = src.charCodeAt(k);
    this.o = o;
  }
  char(c: number) {
    this.ensure(1);
    this.buf[this.o++] = c;
  }
  newline(depth: number) {
    const n = depth * INDENT.length;
    this.ensure(1 + n);
    this.buf[this.o++] = 10;
    for (let k = 0; k < n; k++) this.buf[this.o++] = 32;
    this.line++;
  }
  result(): FormattedText {
    return { text: new TextDecoder("utf-16le").decode(this.buf.subarray(0, this.o)), folds: this.folds };
  }
}

const isSpace = (c: number) => c === 32 || c === 10 || c === 13 || c === 9;

const OPEN = 1;
const CLOSE = 2;
const TEXT = 3;
const OTHER = 4;

/** Re-indents XML: one element per line, elements holding only text stay on one line, whitespace-only
 *  text is dropped and other text is trimmed. Markup is copied as is. Returns null when the text
 *  isn't tag-shaped (an unterminated tag, comment or CDATA section). */
export function formatXml(src: string): FormattedText | null {
  const t = tokenize(src);
  if (!t) return null;
  const { kind, s, e, n } = t;
  const out = new Out(src.length * 2);
  const openLines: number[] = [];
  let first = true;
  const startLine = () => {
    if (first) first = false;
    else out.newline(openLines.length);
  };
  for (let i = 0; i < n; i++) {
    switch (kind[i]) {
      case OPEN: {
        startLine();
        out.copy(src, s[i], e[i]);
        // <a>text</a> and <a></a> stay on one line.
        if (kind[i + 1] === CLOSE) {
          out.copy(src, s[i + 1], e[i + 1]);
          i++;
        } else if (kind[i + 1] === TEXT && kind[i + 2] === CLOSE) {
          out.copy(src, s[i + 1], e[i + 1]);
          out.copy(src, s[i + 2], e[i + 2]);
          i += 2;
        } else {
          openLines.push(out.line);
        }
        break;
      }
      case CLOSE: {
        const from = openLines.pop();
        startLine();
        out.copy(src, s[i], e[i]);
        if (from !== undefined) out.fold(from, out.line);
        break;
      }
      default:
        startLine();
        out.copy(src, s[i], e[i]);
    }
  }
  return out.result();
}

/** Tokens as parallel arrays (millions of token objects would cost more in allocation than the
 *  formatting itself). Text tokens are already trimmed; whitespace-only text is skipped. */
function tokenize(src: string): { kind: Uint8Array; s: Int32Array; e: Int32Array; n: number } | null {
  let cap = 1024;
  let kind = new Uint8Array(cap);
  let s = new Int32Array(cap);
  let e = new Int32Array(cap);
  let n = 0;
  const push = (k: number, from: number, to: number) => {
    if (n === cap) {
      cap *= 2;
      const k2 = new Uint8Array(cap);
      k2.set(kind);
      kind = k2;
      const s2 = new Int32Array(cap);
      s2.set(s);
      s = s2;
      const e2 = new Int32Array(cap);
      e2.set(e);
      e = e2;
    }
    kind[n] = k;
    s[n] = from;
    e[n] = to;
    n++;
  };
  const len = src.length;
  let i = 0;
  while (i < len) {
    let lt = src.indexOf("<", i);
    if (lt < 0) lt = len;
    // Text before the tag, trimmed.
    let a = i;
    let z = lt;
    while (a < z && isSpace(src.charCodeAt(a))) a++;
    while (z > a && isSpace(src.charCodeAt(z - 1))) z--;
    if (z > a) push(TEXT, a, z);
    if (lt === len) break;
    let end: number;
    let k = OTHER;
    if (src.startsWith("<!--", lt)) end = after(src, "-->", lt + 4);
    else if (src.startsWith("<![CDATA[", lt)) {
      end = after(src, "]]>", lt + 9);
      k = TEXT;
    } else if (src.startsWith("<?", lt)) end = after(src, "?>", lt + 2);
    else if (src.startsWith("<!", lt)) end = declarationEnd(src, lt);
    else {
      end = tagEnd(src, lt);
      if (end > 0) k = src.charCodeAt(lt + 1) === 47 ? CLOSE : src.charCodeAt(end - 2) === 47 ? OTHER : OPEN;
    }
    if (end < 0) return null;
    push(k, lt, end);
    i = end;
  }
  return { kind, s, e, n };
}

function after(src: string, marker: string, from: number): number {
  const at = src.indexOf(marker, from);
  return at < 0 ? -1 : at + marker.length;
}

/** End of a start or end tag, skipping quoted attribute values (which may contain ">"). */
function tagEnd(src: string, from: number): number {
  let quote = 0;
  for (let i = from + 1; i < src.length; i++) {
    const c = src.charCodeAt(i);
    if (quote) {
      if (c === quote) quote = 0;
    } else if (c === 34 || c === 39) quote = c;
    else if (c === 62) return i + 1;
    else if (c === 60) return -1;
  }
  return -1;
}

/** End of <!DOCTYPE …>, including an internal subset in [ ]. */
function declarationEnd(src: string, from: number): number {
  let bracket = 0;
  for (let i = from + 2; i < src.length; i++) {
    const c = src[i];
    if (c === "[") bracket++;
    else if (c === "]") bracket--;
    else if (c === ">" && bracket <= 0) return i + 1;
  }
  return -1;
}

/** Re-indents JSON text the way JSON.stringify(v, null, 2) would, without building objects:
 *  values (numbers included) are copied as written, and memory stays proportional to the text.
 *  Returns null when brackets don't balance, a comma is misplaced or a string is unterminated. */
export function formatJson(src: string): FormattedText | null {
  const n = src.length;
  const out = new Out(n * 2);
  const openLines: number[] = [];
  const closers: number[] = [];
  let empty = true; // nothing written on the current line yet
  let i = 0;
  while (i < n) {
    const c = src.charCodeAt(i);
    if (isSpace(c)) {
      i++;
    } else if (c === 123 || c === 91) {
      // { or [; an empty one stays on its line.
      const close = c + 2;
      i++;
      while (isSpace(src.charCodeAt(i))) i++;
      out.char(c);
      if (src.charCodeAt(i) === close) {
        out.char(close);
        empty = false;
        i++;
        continue;
      }
      openLines.push(out.line);
      closers.push(close);
      out.newline(openLines.length);
      empty = true;
    } else if (c === 125 || c === 93) {
      // } or ]
      const from = openLines.pop();
      if (from === undefined || closers.pop() !== c || empty) return null;
      out.newline(openLines.length);
      out.char(c);
      out.fold(from, out.line);
      empty = false;
      i++;
    } else if (c === 44) {
      // ,
      if (empty) return null;
      out.char(c);
      out.newline(openLines.length);
      empty = true;
      i++;
    } else if (c === 58) {
      // :
      out.char(c);
      out.char(32);
      i++;
    } else if (c === 34) {
      // A string: find the closing quote that isn't escaped.
      let j = i + 1;
      for (;;) {
        j = src.indexOf('"', j);
        if (j < 0) return null;
        let k = j - 1;
        while (src.charCodeAt(k) === 92) k--;
        if ((j - k) % 2 === 1) break;
        j++;
      }
      out.copy(src, i, j + 1);
      empty = false;
      i = j + 1;
    } else {
      // A number or literal: up to whitespace or the next delimiter.
      const start = i;
      for (let d = c; i < n && d > 32 && d !== 44 && d !== 58 && d !== 93 && d !== 125; d = src.charCodeAt(++i));
      if (i === start) return null;
      out.copy(src, start, i);
      empty = false;
    }
  }
  if (openLines.length) return null;
  return out.result();
}

export type FormatKind = "xml" | "json";

export function formatText(kind: FormatKind, src: string): FormattedText | null {
  return kind === "xml" ? formatXml(src) : formatJson(src);
}
