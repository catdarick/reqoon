import type { Environment } from "./models";

export const VAR_PATTERN = /\{\{\s*([^{}\s]+)\s*\}\}/g;

const dynamic: Record<string, () => string> = {
  $uuid: () => crypto.randomUUID(),
  $timestamp: () => String(Math.floor(Date.now() / 1000)),
  $isoTimestamp: () => new Date().toISOString(),
  $randomInt: () => String(Math.floor(Math.random() * 1000)),
};

export const DYNAMIC_VARS = Object.keys(dynamic);

export function envVarMap(env: Environment | undefined, secrets: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  if (!env) return out;
  for (const v of env.vars) {
    if (!v.enabled || !v.key) continue;
    out[v.key] = v.secret ? secrets[secretKey(env.id, v.id)] ?? "" : v.value;
  }
  return out;
}

export function secretKey(envId: string, varId: string): string {
  return `env:${envId}:${varId}`;
}

/** Longest value a variable may expand to; guards against chains that double at every level. */
const MAX_EXPANSION = 1_000_000;

interface Ctx {
  vars: Record<string, string>;
  missing?: Set<string>;
  /** Names referenced, resolved or not (dynamic ones like {{$uuid}} aside). */
  used?: Set<string>;
  /** Resolved values, so a variable used many times is expanded once. */
  memo: Map<string, string | undefined>;
  /** Cycles hit so far; a value computed while hitting one depends on the path and isn't reused. */
  cycles: number;
}

export function interpolate(text: string, vars: Record<string, string>, missing?: Set<string>, used?: Set<string>): string {
  return expand(text, { vars, missing, used, memo: new Map(), cycles: 0 }, []);
}

function expand(text: string, ctx: Ctx, stack: string[]): string {
  if (!text || !text.includes("{{")) return text;
  return text.replace(VAR_PATTERN, (m, name: string) => lookup(name, ctx, stack) ?? m);
}

/** Value of a variable with the variables inside it resolved too (base_url = ".../{{user_id}}").
 *  A variable that refers back to itself is left unresolved and reported as missing. */
function lookup(name: string, ctx: Ctx, stack: string[]): string | undefined {
  if (name in ctx.vars || !(name in dynamic)) ctx.used?.add(name);
  if (ctx.memo.has(name)) {
    const v = ctx.memo.get(name);
    if (v === undefined) ctx.missing?.add(name);
    return v;
  }
  let value: string | undefined;
  const cyclesBefore = ctx.cycles;
  if (stack.includes(name)) ctx.cycles++;
  else if (name in ctx.vars) {
    value = expand(ctx.vars[name], ctx, [...stack, name]);
    if (value.length > MAX_EXPANSION) value = undefined;
  } else if (!(name in ctx.vars) && name in dynamic) {
    return dynamic[name](); // fresh on every use
  }
  if (value === undefined) ctx.missing?.add(name);
  if (ctx.cycles === cyclesBefore) ctx.memo.set(name, value);
  return value;
}

const JSON_LITERAL = /^(-?\d+(\.\d+)?([eE][+-]?\d+)?|true|false|null|\{[\s\S]*\}|\[[\s\S]*\])$/;

/**
 * Interpolates a JSON body. A value that is exactly "{{var}}" becomes the raw value when that
 * is itself valid JSON (number, boolean, object), keeping types intact, unless `isStringAt`
 * says the field at that path is a string. Keys and other strings get the value escaped.
 */
export function interpolateJsonText(
  text: string,
  vars: Record<string, string>,
  missing?: Set<string>,
  isStringAt?: (path: (string | number)[]) => boolean,
  used?: Set<string>,
): string {
  if (!text.includes("{{")) return text;
  const ctx: Ctx = { vars, missing, used, memo: new Map(), cycles: 0 };
  const escape = (raw: string) =>
    raw.replace(VAR_PATTERN, (m, name: string) => {
      const v = lookup(name, ctx, []);
      return v === undefined ? m : JSON.stringify(v).slice(1, -1);
    });
  type Frame = { obj: true; key: string | null; expectKey: boolean } | { obj: false; index: number };
  const stack: Frame[] = [];
  const path = () => stack.map((f) => (f.obj ? f.key ?? "" : f.index));
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      const raw = text.slice(i + 1, j);
      i = j + 1;
      const top = stack[stack.length - 1];
      if (top?.obj && top.expectKey) {
        try {
          top.key = JSON.parse(`"${raw}"`);
        } catch {
          top.key = raw;
        }
        top.expectKey = false;
        out += `"${escape(raw)}"`;
        continue;
      }
      const whole = /^\{\{\s*([^{}\s]+)\s*\}\}$/.exec(raw);
      const value = whole ? lookup(whole[1], ctx, []) : undefined;
      if (whole && value !== undefined) {
        const t = value.trim();
        let literal = false;
        if (t && JSON_LITERAL.test(t) && !isStringAt?.(path())) {
          try {
            JSON.parse(t);
            literal = true;
          } catch {
            /* not JSON: keep it a string */
          }
        }
        out += literal ? t : JSON.stringify(value);
      } else {
        out += `"${escape(raw)}"`;
      }
      continue;
    }
    if (ch === "{" && text[i + 1] === "{") {
      // A bare {{var}} outside quotes: insert the raw value.
      const m = new RegExp(VAR_PATTERN.source, "y");
      m.lastIndex = i;
      const hit = m.exec(text);
      if (hit) {
        const v = lookup(hit[1], ctx, []);
        out += v ?? hit[0];
        i += hit[0].length;
        continue;
      }
    }
    const top = stack[stack.length - 1];
    if (ch === "{") stack.push({ obj: true, key: null, expectKey: true });
    else if (ch === "[") stack.push({ obj: false, index: 0 });
    else if (ch === "}" || ch === "]") stack.pop();
    else if (ch === "," && top) {
      if (top.obj) top.expectKey = true;
      else top.index++;
    }
    out += ch;
    i++;
  }
  return out;
}

export function findVars(text: string): string[] {
  return [...text.matchAll(VAR_PATTERN)].map((m) => m[1]);
}
