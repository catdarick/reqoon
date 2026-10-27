// Text-level JSON helpers for the raw editor: cursor context (for schema-aware completion) on
// possibly incomplete input, and pointer → source range mapping (for inline validation errors).

import { escapeKey } from "./schema";

export type Seg = string | number;

export interface CursorContext {
  kind: "key" | "value" | "none";
  path: Seg[]; // for "key": the object's path; for "value": the value's path
  from: number; // start of the token being completed (or pos)
  to: number; // end of the token being completed (or pos)
  inString: boolean;
  existingKeys: string[];
  typed: string; // text typed so far inside the token (without quotes)
}

interface Frame {
  type: "obj" | "arr";
  key: string | null;
  index: number;
  expect: "key" | "colon" | "value" | "comma";
  keys: string[];
}

export function cursorContext(text: string, pos: number): CursorContext {
  const stack: Frame[] = [];
  let rootDone = false;
  let i = 0;
  const top = () => stack[stack.length - 1];
  const afterValue = () => {
    const f = top();
    if (f) f.expect = "comma";
    else rootDone = true;
  };
  const build = (kind: CursorContext["kind"], from: number, to: number, inString: boolean, typed: string): CursorContext => {
    const path: Seg[] = [];
    stack.forEach((f, idx) => {
      const last = idx === stack.length - 1;
      if (last && kind === "key") return;
      path.push(f.type === "obj" ? f.key ?? "" : f.index);
    });
    return { kind, path, from, to, inString, existingKeys: top()?.keys ?? [], typed };
  };

  while (i < pos) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const f = top();
    if (ch === '"') {
      // Read string token
      let j = i + 1;
      let s = "";
      while (j < text.length && text[j] !== '"' && text[j] !== "\n") {
        if (text[j] === "\\") {
          s += text[j + 1] ?? "";
          j += 2;
        } else s += text[j++];
      }
      const closed = text[j] === '"';
      const end = closed ? j + 1 : j;
      if (pos <= j || (!closed && pos <= end)) {
        // Cursor inside this string.
        const typed = text.slice(i + 1, pos);
        const isKey = !!f && f.type === "obj" && f.expect === "key";
        if (isKey) return build("key", i, end, true, typed);
        if (!f || f.expect === "value") return build("value", i, end, true, typed);
        return build("none", pos, pos, true, typed);
      }
      if (f && f.type === "obj" && f.expect === "key") {
        f.key = s;
        f.keys.push(s);
        f.expect = "colon";
      } else afterValue();
      i = end;
      continue;
    }
    if (ch === "{" || ch === "[") {
      stack.push({ type: ch === "{" ? "obj" : "arr", key: null, index: 0, expect: ch === "{" ? "key" : "value", keys: [] });
      i++;
      continue;
    }
    if (ch === "}" || ch === "]") {
      stack.pop();
      afterValue();
      i++;
      continue;
    }
    if (ch === ":") {
      if (f) f.expect = "value";
      i++;
      continue;
    }
    if (ch === ",") {
      if (f) {
        if (f.type === "obj") {
          f.expect = "key";
          f.key = null;
        } else {
          f.index++;
          f.expect = "value";
        }
      }
      i++;
      continue;
    }
    // literal (number, true, false, null) or garbage
    let j = i;
    while (j < text.length && !/[\s,:\]}[{"]/.test(text[j])) j++;
    if (pos <= j) {
      const typed = text.slice(i, pos);
      if (f?.type === "obj" && f.expect === "key") return build("key", i, j, false, typed);
      return build("value", i, j, false, typed);
    }
    afterValue();
    i = j;
  }

  const f = top();
  if (!f) return rootDone ? build("none", pos, pos, false, "") : build("value", pos, pos, false, "");
  if (f.type === "obj" && f.expect === "key") return build("key", pos, pos, false, "");
  if (f.expect === "value") return build("value", pos, pos, false, "");
  return build("none", pos, pos, false, "");
}

export interface Located {
  keyFrom?: number;
  keyTo?: number;
  from: number;
  to: number;
}

/** Parses valid JSON text and records where each value (by JSON pointer) lives. */
export function locatePointers(text: string): Map<string, Located> | null {
  const out = new Map<string, Located>();
  let i = 0;
  const ws = () => {
    while (i < text.length && /\s/.test(text[i])) i++;
  };
  const str = (): string => {
    const start = i;
    i++;
    while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    i++;
    return JSON.parse(text.slice(start, i));
  };
  const value = (ptr: string, keyFrom?: number, keyTo?: number) => {
    ws();
    const from = i;
    const ch = text[i];
    if (ch === "{") {
      i++;
      ws();
      if (text[i] === "}") i++;
      else
        for (;;) {
          ws();
          const kf = i;
          const k = str();
          const kt = i;
          ws();
          if (text[i++] !== ":") throw new Error("expected :");
          value(`${ptr}/${escapeKey(k)}`, kf, kt);
          ws();
          if (text[i] === ",") i++;
          else if (text[i] === "}") {
            i++;
            break;
          } else throw new Error("expected , or }");
        }
    } else if (ch === "[") {
      i++;
      ws();
      let idx = 0;
      if (text[i] === "]") i++;
      else
        for (;;) {
          value(`${ptr}/${idx++}`);
          ws();
          if (text[i] === ",") i++;
          else if (text[i] === "]") {
            i++;
            break;
          } else throw new Error("expected , or ]");
        }
    } else if (ch === '"') str();
    else {
      while (i < text.length && !/[\s,\]}]/.test(text[i])) i++;
      if (i === from) throw new Error("unexpected token");
    }
    out.set(ptr, { from, to: i, keyFrom, keyTo });
  };
  try {
    value("");
    return out;
  } catch {
    return null;
  }
}
