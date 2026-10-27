// JSON Schema helpers tuned for OpenAPI 3.0 / 3.1: $ref resolution, allOf merging,
// default value generation, validation and oneOf/anyOf variant matching.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { isBig, isPlainObject, numericValue, parseJson, stringifyJson } from "./json";

export type Json = any;
export type Schema = Record<string, any>;

export interface NSchema extends Schema {
  _types: string[]; // json types allowed (without "null")
  _nullable: boolean;
  _refName?: string;
}

export function resolvePointer(doc: Json, ref: string): Json {
  if (!ref.startsWith("#")) return undefined;
  const parts = ref
    .slice(1)
    .split("/")
    .filter(Boolean)
    .map((p) => decodeURIComponent(p).replace(/~1/g, "/").replace(/~0/g, "~"));
  let cur = doc;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[p];
  }
  return cur;
}

/** Follows a chain of $refs (with 3.1 sibling keywords merged on top). */
export function deref(doc: Json, node: Json): Json {
  let cur = node;
  let siblings: Record<string, unknown> | null = null;
  for (let i = 0; i < 32 && cur && typeof cur === "object" && typeof cur.$ref === "string"; i++) {
    const { $ref, ...rest } = cur;
    if (Object.keys(rest).length) siblings = { ...rest, ...(siblings ?? {}) };
    const next = resolvePointer(doc, $ref);
    if (next === undefined) return { ...(siblings ?? {}), "x-unresolved-ref": $ref };
    cur = next;
  }
  return siblings ? { ...cur, ...siblings } : cur;
}

export function refName(node: Json): string | undefined {
  if (node && typeof node.$ref === "string") {
    const seg = node.$ref.split("/");
    return seg[seg.length - 1];
  }
  return undefined;
}

const normCache = new WeakMap<object, WeakMap<object, NSchema>>();

export function normalize(doc: Json, schema: Json): NSchema {
  if (!schema || typeof schema !== "object") {
    return { _types: [], _nullable: schema === false ? false : true } as NSchema;
  }
  let perDoc = normCache.get(doc);
  if (!perDoc) normCache.set(doc, (perDoc = new WeakMap()));
  const hit = perDoc.get(schema);
  if (hit) return hit;

  const name = refName(schema);
  let s: Schema = deref(doc, schema) ?? {};
  if (Array.isArray(s.allOf) && s.allOf.length) s = mergeAllOf(doc, s, 0);

  let types: string[] = [];
  let nullable = s.nullable === true;
  if (Array.isArray(s.type)) types = s.type.slice();
  else if (typeof s.type === "string") types = [s.type];
  if (types.includes("null")) {
    nullable = true;
    types = types.filter((t) => t !== "null");
  }
  if (s.const === null || (Array.isArray(s.enum) && s.enum.includes(null))) nullable = true;
  if (!types.length) {
    if (s.properties || s.additionalProperties || s.required) types = ["object"];
    else if (s.items || s.prefixItems) types = ["array"];
    else if (Array.isArray(s.enum) && s.enum.length) {
      types = [...new Set(s.enum.filter((v: unknown) => v !== null).map(jsonType))] as string[];
    }
  }
  const out = { ...s, _types: types, _nullable: nullable, _refName: name ?? s.title } as NSchema;
  perDoc.set(schema, out);
  return out;
}

function mergeAllOf(doc: Json, s: Schema, depth: number): Schema {
  const { allOf, ...base } = s;
  let out: Schema = { ...base };
  for (const part of allOf as Json[]) {
    let p = deref(doc, part) ?? {};
    if (Array.isArray(p.allOf) && depth < 16) p = mergeAllOf(doc, p, depth + 1);
    out = mergeSchemas(out, p);
  }
  return out;
}

function mergeSchemas(a: Schema, b: Schema): Schema {
  const out: Schema = { ...b, ...a };
  if (a.properties || b.properties) {
    const props: Record<string, Json> = { ...(a.properties ?? {}) };
    // A property declared by both parts must satisfy both, so merge rather than overwrite.
    for (const [k, v] of Object.entries<Json>(b.properties ?? {})) props[k] = k in props ? { allOf: [props[k], v] } : v;
    out.properties = props;
  }
  if (a.required || b.required) out.required = [...new Set([...(a.required ?? []), ...(b.required ?? [])])];
  if (!a.type && b.type) out.type = b.type;
  if (a.description || b.description) out.description = a.description ?? b.description;
  return out;
}

/** Positional item schemas: 3.1 `prefixItems` or the older tuple form `items: [...]`. */
export function tupleItems(s: Schema): Json[] | null {
  if (Array.isArray(s.prefixItems)) return s.prefixItems;
  if (Array.isArray(s.items)) return s.items;
  return null;
}

/** Schema of the i-th array item, handling tuple forms. */
export function itemSchema(s: Schema, i: number): Json {
  const tuple = tupleItems(s);
  if (!tuple) return s.items ?? {};
  if (i < tuple.length) return tuple[i];
  const rest = Array.isArray(s.prefixItems) ? s.items : s.additionalItems;
  return rest && typeof rest === "object" ? rest : {};
}

export function jsonType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (isBig(v)) return "integer";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

export function typeMatches(t: string, v: unknown): boolean {
  const vt = jsonType(v);
  if (t === vt) return true;
  if (t === "number" && vt === "integer") return true;
  return false;
}

// ---------------------------------------------------------------------------------------------
// Unions (oneOf / anyOf)

export interface Variant {
  label: string;
  /** The alternative with the parent's own properties/required merged in. */
  schema: Json;
  /** Properties whose schema allows exactly one value (e.g. tag: {enum: ["Rent"]}); these
   *  identify the variant the way a discriminator would. */
  tags: Record<string, Json>;
}

export interface Union {
  kind: "oneOf" | "anyOf";
  list: Variant[];
  /** A null alternative was present (and is not listed as a variant). */
  nullable: boolean;
}

/** A schema that only admits null: {type: "null"}, {type: ["null"]}, {enum: [null]}, {nullable: true}. */
export function isNullSchema(n: NSchema): boolean {
  return (
    n._types.length === 0 &&
    n._nullable &&
    !n.properties &&
    !n.items &&
    !n.prefixItems &&
    !Array.isArray(n.oneOf) &&
    !Array.isArray(n.anyOf)
  );
}

/** The single value a schema allows, if any (const, or a one-element non-null enum). */
export function singleValue(doc: Json, schema: Json): { value: Json } | null {
  const s = normalize(doc, schema);
  if (s.const !== undefined && s.const !== null) return { value: s.const };
  if (Array.isArray(s.enum) && s.enum.length === 1 && s.enum[0] !== null) return { value: s.enum[0] };
  return null;
}

const PARENT_KEYS = ["properties", "required", "additionalProperties", "minProperties", "maxProperties"];
const unionCache = new WeakMap<object, Union | null>();

export function variantsOf(doc: Json, s: NSchema): Union | null {
  const cached = unionCache.get(s);
  if (cached !== undefined) return cached;
  const kind = Array.isArray(s.oneOf) ? "oneOf" : Array.isArray(s.anyOf) ? "anyOf" : null;
  if (!kind) {
    unionCache.set(s, null);
    return null;
  }
  // Keywords next to oneOf/anyOf apply to every alternative; fold them into each variant.
  let parent: Schema | null = null;
  if (s.properties || s.required) {
    parent = { type: "object" };
    for (const k of PARENT_KEYS) if (s[k] !== undefined) parent[k] = s[k];
  }
  const disc: string | undefined = s.discriminator?.propertyName;
  const mapping: Record<string, string> = s.discriminator?.mapping ?? {};
  let nullable = s._nullable;
  const list: Variant[] = [];
  (s[kind] as Json[]).forEach((alt, i) => {
    const n = normalize(doc, alt);
    if (isNullSchema(n)) {
      nullable = true;
      return;
    }
    const schema = parent ? { allOf: [parent, alt] } : alt;
    const merged = normalize(doc, schema);
    const tags: Record<string, Json> = {};
    for (const [k, ps] of Object.entries<Json>(merged.properties ?? {})) {
      const one = singleValue(doc, ps);
      if (one) tags[k] = one.value;
    }
    // Mapping values are refs or bare schema names ("Cat" means #/components/schemas/Cat).
    const mapped = Object.entries(mapping).find(([, ref]) => ref === alt?.$ref || (!ref.includes("/") && ref === refName(alt)))?.[0];
    if (disc && !(disc in tags)) {
      const implicit = mapped ?? refName(alt);
      if (implicit !== undefined) tags[disc] = implicit;
    }
    list.push({ label: variantLabel(n, alt, tags, mapped, i), schema, tags });
  });
  // Untitled, untagged object variants: name them by the fields only they require/declare.
  list.forEach((v) => {
    const n = normalize(doc, v.schema);
    if (v.label !== "object" || !n.properties) return;
    const others = list.filter((o) => o !== v).map((o) => normalize(doc, o.schema));
    const req: string[] = n.required ?? [];
    let keys = req.filter((k) => others.every((o) => !(o.required ?? []).includes(k)));
    if (!keys.length) keys = Object.keys(n.properties).filter((k) => others.every((o) => !(k in (o.properties ?? {}))));
    if (keys.length) v.label = `{ ${keys.slice(0, 3).join(", ")}${keys.length > 3 ? ", …" : ""} }`;
  });
  // Make labels unique so the picker never shows indistinguishable entries.
  const seen = new Map<string, number>();
  for (const v of list) seen.set(v.label, (seen.get(v.label) ?? 0) + 1);
  const counter = new Map<string, number>();
  for (const v of list) {
    if ((seen.get(v.label) ?? 0) < 2) continue;
    const c = (counter.get(v.label) ?? 0) + 1;
    counter.set(v.label, c);
    v.label = `${v.label} #${c}`;
  }
  const out: Union = { kind, list, nullable };
  unionCache.set(s, out);
  return out;
}

function variantLabel(n: NSchema, alt: Json, tags: Record<string, Json>, mapped: string | undefined, i: number): string {
  if (mapped) return mapped;
  if (typeof n.title === "string" && n.title) return n.title;
  const entries = Object.entries(tags);
  if (entries.length === 1) return String(entries[0][1]);
  if (entries.length > 1) return entries.map(([k, v]) => `${k}: ${String(v)}`).join(", ");
  const ref = refName(alt);
  if (ref) return ref;
  if (Array.isArray(n.enum) && n.enum.length) return `${n.enum.length > 3 ? "enum" : n.enum.map(String).join(" | ")}`;
  if (n._types.length) return n._types.join(" | ") + (n.format ? ` <${n.format}>` : "");
  return `Option ${i + 1}`;
}

export function hasNullAlternative(doc: Json, s: NSchema): boolean {
  return !!variantsOf(doc, s)?.nullable;
}

/**
 * Picks the variant a value belongs to.
 * 1. Tag properties (discriminator or single-value enum/const) rule variants in or out.
 * 2. `preferred` (the variant the user picked) wins while the value still fits it, so values
 *    that fit several variants (an enum and a free string, say) don't flip the picker.
 * 3. Otherwise the variant with the fewest validation errors and undeclared keys wins.
 */
export function matchVariant(doc: Json, _s: NSchema, list: Variant[], value: unknown, preferred?: number): number {
  if (!list.length) return 0;
  const pref = preferred !== undefined && preferred >= 0 && preferred < list.length ? preferred : undefined;
  if (value === undefined) return pref ?? 0;
  const obj = isPlainObject(value) ? value : null;
  const tagKeys = (v: Variant) => Object.keys(v.tags);
  const contradicts = (v: Variant) => !!obj && tagKeys(v).some((k) => k in obj && !deepEqual(obj[k], v.tags[k]));
  const confirms = (v: Variant) => !!obj && tagKeys(v).length > 0 && tagKeys(v).every((k) => k in obj && deepEqual(obj[k], v.tags[k]));

  let cands = list.map((_, i) => i).filter((i) => !contradicts(list[i]));
  if (!cands.length) cands = list.map((_, i) => i);
  const confirmed = cands.filter((i) => confirms(list[i]));
  if (confirmed.length) cands = confirmed;
  if (cands.length === 1) return cands[0];

  if (pref !== undefined && cands.includes(pref) && (confirmed.length || validate(doc, list[pref].schema, value).length === 0))
    return pref;

  let best = cands[0];
  let bestScore = Infinity;
  for (const i of cands) {
    let score = validate(doc, list[i].schema, value).length;
    const n = normalize(doc, list[i].schema);
    if (obj && n.properties) for (const k of Object.keys(obj)) if (!(k in n.properties)) score += 1;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

/** Builds a value for variant `i`, carrying over fields of the current value that the new
 *  variant accepts. Fields it rejects (e.g. a `tag` enum naming the old variant) are reset. */
export function switchVariant(doc: Json, _s: NSchema, list: Variant[], value: Json, i: number): Json {
  const v = list[i];
  const next = defaultValue(doc, v.schema, 1);
  if (isPlainObject(next)) {
    if (isPlainObject(value)) {
      const props = normalize(doc, v.schema).properties ?? {};
      for (const [k, cur] of Object.entries(value))
        if (k in props && !(k in v.tags) && validate(doc, props[k], cur).length === 0) next[k] = pruneToSchema(doc, props[k], cur);
    }
    Object.assign(next, v.tags);
  }
  return next;
}

/** Drops object keys the schema doesn't declare (when it declares properties and has no
 *  additionalProperties schema), so values carried between variants don't drag along stale fields. */
export function pruneToSchema(doc: Json, schema: Json, value: Json, depth = 0): Json {
  if (depth > 20 || value === null || typeof value !== "object" || isBig(value)) return value;
  const s = normalize(doc, schema);
  if (Array.isArray(value)) return value.map((v, i) => pruneToSchema(doc, itemSchema(s, i), v, depth + 1));
  if (!s.properties || variantsOf(doc, s) || typeof s.additionalProperties === "object" || s.additionalProperties === true)
    return value;
  const out: Record<string, Json> = {};
  for (const [k, v] of Object.entries(value)) if (k in s.properties) out[k] = pruneToSchema(doc, s.properties[k], v, depth + 1);
  return out;
}

export interface DefaultOpts {
  /** Produce a non-null value even if the schema's default/enum/const is null. */
  nonNull?: boolean;
}

export function defaultValue(doc: Json, schema: Json, depth = 0, opts: DefaultOpts = {}): Json {
  const s = normalize(doc, schema);
  const ok = (v: Json) => v !== undefined && !(opts.nonNull && v === null);
  if (ok(s.default)) return clone(s.default);
  if (ok(s.const)) return clone(s.const);
  if (s.example !== undefined && s.example !== null && depth > 0 && !s._types.includes("object")) return clone(s.example);
  if (Array.isArray(s.examples) && s.examples.length && s.examples[0] !== null && depth > 0 && !s._types.includes("object"))
    return clone(s.examples[0]);
  if (Array.isArray(s.enum) && s.enum.length) {
    const first = s.enum.find((v: Json) => v !== null);
    if (first !== undefined) return clone(first);
    if (!opts.nonNull) return null;
  }
  const vs = variantsOf(doc, s);
  if (vs && vs.list.length && depth < 12) {
    const v = defaultValue(doc, vs.list[0].schema, depth + 1, { nonNull: true });
    if (isPlainObject(v)) Object.assign(v, vs.list[0].tags);
    return v;
  }
  const t = s._types[0];
  switch (t) {
    case "object": {
      const out: Record<string, Json> = {};
      if (depth < 12) {
        const required = new Set<string>(s.required ?? []);
        for (const [key, ps] of Object.entries<Json>(s.properties ?? {})) {
          if (normalize(doc, ps).readOnly) continue;
          // Required fields, plus single-value fields that identify a variant (tag, kind, …).
          if (required.has(key) || singleValue(doc, ps)) out[key] = defaultValue(doc, ps, depth + 1, { nonNull: true });
        }
        for (const key of required) if (!(key in out) && !s.properties?.[key]) out[key] = "";
      }
      return out;
    }
    case "array": {
      const n = typeof s.minItems === "number" && depth < 12 ? Math.min(s.minItems, 10) : 0;
      return Array.from({ length: n }, (_, i) => defaultValue(doc, itemSchema(s, i), depth + 1, { nonNull: true }));
    }
    case "string":
      return stringDefault(s);
    case "integer":
    case "number": {
      // Prefer 0; int64 schemas often declare huge min/max bounds that make poor defaults.
      const step = t === "integer" ? 1 : 0.5;
      let lo = -Infinity;
      let hi = Infinity;
      if (typeof s.minimum === "number") lo = s.exclusiveMinimum === true ? s.minimum + step : s.minimum;
      if (typeof s.exclusiveMinimum === "number") lo = Math.max(lo, s.exclusiveMinimum + step);
      if (typeof s.maximum === "number") hi = s.exclusiveMaximum === true ? s.maximum - step : s.maximum;
      if (typeof s.exclusiveMaximum === "number") hi = Math.min(hi, s.exclusiveMaximum - step);
      return 0 >= lo && 0 <= hi ? 0 : lo > 0 ? lo : hi;
    }
    case "boolean":
      return false;
    default:
      return s._nullable && !opts.nonNull ? null : "";
  }
}

function stringDefault(s: NSchema): string {
  switch (s.format) {
    case "date-time":
      return new Date().toISOString();
    case "date":
      return new Date().toISOString().slice(0, 10);
    case "uuid":
      return crypto.randomUUID();
    default:
      return "";
  }
}

export function clone<T>(v: T): T {
  return v === undefined ? v : (parseJson(stringifyJson(v)) as T);
}

export interface ValidationError {
  path: string; // JSON pointer, "" for root
  message: string;
}

const FORMAT_RE: Record<string, RegExp> = {
  "date-time": /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:?\d{2})?$/,
  date: /^\d{4}-\d{2}-\d{2}$/,
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  uri: /^[a-z][a-z0-9+.-]*:/i,
  ipv4: /^(\d{1,3}\.){3}\d{1,3}$/,
};

const VAR_RE = /\{\{\s*[^}]+\s*\}\}/;

export function validate(doc: Json, schema: Json, value: Json, path = "", depth = 0): ValidationError[] {
  const errors: ValidationError[] = [];
  validateInto(doc, schema, value, path, errors, depth);
  // Parent-level keywords of a union are checked both on the parent and inside the variant.
  const seen = new Set<string>();
  return errors.filter((e) => {
    const k = `${e.path}\u0000${e.message}`;
    return seen.has(k) ? false : (seen.add(k), true);
  });
}

function validateInto(doc: Json, schema: Json, value: Json, path: string, errors: ValidationError[], depth: number) {
  if (depth > 40 || schema === undefined || schema === true) return;
  const s = normalize(doc, schema);
  const push = (message: string) => errors.push({ path, message });

  if (value === null) {
    if (!s._nullable && s._types.length) push("Must not be null");
    return;
  }
  // Values that reference environment variables are resolved at send time; skip strict checks.
  if (typeof value === "string" && VAR_RE.test(value)) return;

  if (s._types.length && !s._types.some((t) => typeMatches(t, value))) {
    push(`Expected ${s._types.join(" or ")}, got ${jsonType(value)}`);
    return;
  }
  if (Array.isArray(s.enum) && s.enum.length && !s.enum.some((e: Json) => deepEqual(e, value))) {
    push(`Must be one of: ${s.enum.map((e: Json) => stringifyJson(e)).join(", ")}`);
  }
  if (s.const !== undefined && !deepEqual(s.const, value)) push(`Must equal ${stringifyJson(s.const)}`);

  if (typeof value === "string") {
    if (typeof s.minLength === "number" && value.length < s.minLength) push(`Minimum length is ${s.minLength}`);
    if (typeof s.maxLength === "number" && value.length > s.maxLength) push(`Maximum length is ${s.maxLength}`);
    if (typeof s.pattern === "string") {
      try {
        if (!new RegExp(s.pattern, "u").test(value)) push(`Must match pattern ${s.pattern}`);
      } catch {
        /* unsupported pattern syntax */
      }
    }
    const re = s.format && FORMAT_RE[s.format];
    if (re && value !== "" && !re.test(value)) push(`Invalid ${s.format}`);
  } else if (typeof value === "number" || isBig(value)) {
    const num = numericValue(value)!;
    validateNumber(s, num, push);
  } else if (Array.isArray(value)) {
    if (typeof s.minItems === "number" && value.length < s.minItems) push(`At least ${s.minItems} item(s) required`);
    if (typeof s.maxItems === "number" && value.length > s.maxItems) push(`At most ${s.maxItems} item(s) allowed`);
    if (s.uniqueItems) {
      const seen = new Set(value.map((v) => JSON.stringify(v)));
      if (seen.size !== value.length) push("Items must be unique");
    }
    if (s.items || s.prefixItems)
      value.forEach((v, i) => validateInto(doc, itemSchema(s, i), v, `${path}/${i}`, errors, depth + 1));
  } else if (isPlainObject(value)) {
    for (const key of (s.required as string[]) ?? []) {
      if (!(key in value)) {
        const ps = s.properties?.[key];
        if (ps && normalize(doc, ps).readOnly) continue;
        errors.push({ path: `${path}/${escapeKey(key)}`, message: "Required" });
      }
    }
    const props = s.properties ?? {};
    for (const [k, v] of Object.entries(value)) {
      const childPath = `${path}/${escapeKey(k)}`;
      if (k in props) validateInto(doc, props[k], v, childPath, errors, depth + 1);
      else if (s.additionalProperties === false) errors.push({ path: childPath, message: "Unknown property" });
      else if (s.additionalProperties && typeof s.additionalProperties === "object")
        validateInto(doc, s.additionalProperties, v, childPath, errors, depth + 1);
    }
    if (typeof s.minProperties === "number" && Object.keys(value).length < s.minProperties)
      push(`At least ${s.minProperties} propert${s.minProperties === 1 ? "y" : "ies"} required`);
  }

  const vs = variantsOf(doc, s);
  if (vs && vs.list.length) {
    const results = vs.list.map((v) => validate(doc, v.schema, value, path, depth + 1));
    const ok = results.filter((r) => r.length === 0).length;
    if (ok === 0) {
      const idx = matchVariant(doc, s, vs.list, value);
      errors.push(...results[idx]);
    }
  }
}

function validateNumber(s: NSchema, value: number, push: (m: string) => void) {
  if (typeof s.minimum === "number" && (s.exclusiveMinimum === true ? value <= s.minimum : value < s.minimum))
    push(`Must be ${s.exclusiveMinimum === true ? ">" : "≥"} ${s.minimum}`);
  if (typeof s.maximum === "number" && (s.exclusiveMaximum === true ? value >= s.maximum : value > s.maximum))
    push(`Must be ${s.exclusiveMaximum === true ? "<" : "≤"} ${s.maximum}`);
  if (typeof s.exclusiveMinimum === "number" && value <= s.exclusiveMinimum) push(`Must be > ${s.exclusiveMinimum}`);
  if (typeof s.exclusiveMaximum === "number" && value >= s.exclusiveMaximum) push(`Must be < ${s.exclusiveMaximum}`);
  if (typeof s.multipleOf === "number" && Math.abs(value / s.multipleOf - Math.round(value / s.multipleOf)) > 1e-9)
    push(`Must be a multiple of ${s.multipleOf}`);
}

export function escapeKey(k: string): string {
  return k.replace(/~/g, "~0").replace(/\//g, "~1");
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (isBig(a) || isBig(b)) return isBig(a) && isBig(b) ? a.raw === b.raw : false;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

export function describeType(doc: Json, schema: Json, depth = 0): string {
  const s = normalize(doc, schema);
  const vs = variantsOf(doc, s);
  if (vs) return vs.list.map((v) => v.label).join(" | ");
  let t = s._types.join(" | ") || "any";
  const tuple = tupleItems(s);
  if (t === "array" && tuple) t = depth < 4 ? `[${tuple.map((x) => describeType(doc, x, depth + 1)).join(", ")}]` : "array";
  else if (t === "array" && s.items) t = depth < 4 ? `${describeType(doc, s.items, depth + 1)}[]` : "array";
  if (s.format) t += ` <${s.format}>`;
  if (s._nullable) t += "?";
  return t;
}
