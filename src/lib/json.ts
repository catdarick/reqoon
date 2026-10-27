// Lossless JSON for request bodies: integers outside Number's safe range (int64 IDs) are kept
// as BigInt wrappers holding their exact source text instead of being rounded by JSON.parse.

/** An integer literal that doesn't fit in a JS number without losing precision. */
export class BigInt64Value {
  constructor(readonly raw: string) {}
  toNumber(): number {
    return Number(this.raw);
  }
  toJSON(): string {
    return MARK + this.raw;
  }
}

// Private-use character: JSON.stringify leaves it unescaped, and it never appears in real input.
const MARK = "big:";

export function isBig(v: unknown): v is BigInt64Value {
  return v instanceof BigInt64Value;
}

/** A plain JSON object (not an array, null or a BigInt64Value). */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof BigInt64Value);
}

/** Numeric value of a number or BigInt64Value; undefined otherwise. */
export function numericValue(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (v instanceof BigInt64Value) return v.toNumber();
  return undefined;
}

/** Wraps an integer literal as a number when exact, otherwise as a BigInt64Value. */
export function integerFromText(text: string): number | BigInt64Value {
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : new BigInt64Value(normalizeInt(text));
}

function normalizeInt(text: string): string {
  const neg = text.startsWith("-");
  const digits = text.replace(/^[-+]/, "").replace(/^0+(?=\d)/, "");
  return (neg && digits !== "0" ? "-" : "") + digits;
}

/** JSON.parse that preserves unsafe integers. Throws like JSON.parse on invalid input. */
export function parseJson(text: string): unknown {
  let marked: string | null = null;
  let last = 0;
  let parts: string[] | null = null;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "-" || (c >= "0" && c <= "9")) {
      let j = i + 1;
      while (j < text.length && /[0-9.eE+-]/.test(text[j])) j++;
      const tok = text.slice(i, j);
      if (/^-?\d{16,}$/.test(tok) && !Number.isSafeInteger(Number(tok))) {
        parts ??= [];
        parts.push(text.slice(last, i), JSON.stringify(MARK + normalizeInt(tok)));
        last = j;
      }
      i = j - 1;
    }
  }
  if (parts) {
    parts.push(text.slice(last));
    marked = parts.join("");
  }
  if (marked === null) return JSON.parse(text);
  return JSON.parse(marked, (_k, v) => (typeof v === "string" && v.startsWith(MARK) ? new BigInt64Value(v.slice(MARK.length)) : v));
}

/** JSON.stringify that writes BigInt64Values back as exact integer literals. */
export function stringifyJson(value: unknown, indent?: number): string {
  const out = JSON.stringify(value, null, indent);
  if (out === undefined || !out.includes(MARK)) return out;
  return out.replace(/"big:(-?\d+)"/g, "$1");
}
