import { DOC_ONLY_KEYS, Endpoint, getOperation, operationFingerprint, OperationInfo, ParsedSpec, structureKey } from "./openapi";
import { deref, describeType, itemSchema, Json, normalize, singleValue, validate, variantsOf } from "./schema";
import type { RequestState } from "./models";
import { isJsonType, isStructuredType, paramKey } from "./request";
import { parseJson } from "./json";

export type Severity = "breaking" | "warning" | "info";

export interface Change {
  severity: Severity;
  message: string;
}

export interface EndpointDiff {
  id: string;
  kind: "added" | "removed" | "modified";
  endpoint: Endpoint;
  changes: Change[];
}

export interface Conflict {
  endpointId: string;
  severity: Severity;
  message: string;
}

export interface SpecDiff {
  added: EndpointDiff[];
  removed: EndpointDiff[];
  modified: EndpointDiff[];
  meta: Change[];
  conflicts: Conflict[];
  breaking: number;
}

export function diffSpecs(
  oldSpec: ParsedSpec,
  newSpec: ParsedSpec,
  savedRequests: Record<string, RequestState>, // keyed by endpoint id
): SpecDiff {
  const oldById = new Map(oldSpec.endpoints.map((e) => [e.id, e]));
  const newById = new Map(newSpec.endpoints.map((e) => [e.id, e]));
  const added: EndpointDiff[] = [];
  const removed: EndpointDiff[] = [];
  const modified: EndpointDiff[] = [];
  const conflicts: Conflict[] = [];

  for (const e of newSpec.endpoints) {
    if (!oldById.has(e.id)) added.push({ id: e.id, kind: "added", endpoint: e, changes: [] });
  }
  for (const e of oldSpec.endpoints) {
    const saved = savedRequests[e.id];
    if (!newById.has(e.id)) {
      removed.push({ id: e.id, kind: "removed", endpoint: e, changes: [] });
      if (saved && hasUserData(saved))
        conflicts.push({
          endpointId: e.id,
          severity: "warning",
          message: "Endpoint was removed. Its saved request values will be kept under “Removed endpoints”.",
        });
      continue;
    }
    const ne = newById.get(e.id)!;
    const oldOp = getOperation(oldSpec, e.id)!;
    const newOp = getOperation(newSpec, e.id)!;
    const metaChanged = e.summary !== ne.summary || e.deprecated !== ne.deprecated || e.tags.join() !== ne.tags.join();
    const structural = operationFingerprint(oldSpec, e) !== operationFingerprint(newSpec, ne);
    if (structural || metaChanged) {
      const changes = structural ? diffOperation(oldSpec.doc, newSpec.doc, oldOp, newOp) : [];
      if (!e.deprecated && ne.deprecated) changes.push({ severity: "warning", message: "Endpoint is now deprecated" });
      if (e.summary !== ne.summary) changes.push({ severity: "info", message: "Summary changed" });
      if (e.tags.join() !== ne.tags.join())
        changes.push({ severity: "info", message: `Tags changed: ${e.tags.join(", ") || "—"} → ${ne.tags.join(", ") || "—"}` });
      if (structural && changes.length === 0) changes.push(...rawChanges(oldSpec, e, newSpec, ne));
      modified.push({ id: e.id, kind: "modified", endpoint: ne, changes });
    }
    if (saved) conflicts.push(...savedValueConflicts(oldSpec.doc, newSpec.doc, oldOp, newOp, saved));
  }

  const meta: Change[] = [];
  if (oldSpec.version !== newSpec.version)
    meta.push({ severity: "info", message: `Version ${oldSpec.version || "?"} → ${newSpec.version || "?"}` });
  if (oldSpec.title !== newSpec.title) meta.push({ severity: "info", message: `Title changed to “${newSpec.title}”` });
  const oldServers = oldSpec.servers.map((s) => s.url).join();
  if (oldServers !== newSpec.servers.map((s) => s.url).join())
    meta.push({ severity: "warning", message: "Server URLs changed" });

  const breaking =
    removed.length + modified.reduce((n, m) => n + m.changes.filter((c) => c.severity === "breaking").length, 0);
  return { added, removed, modified, meta, conflicts, breaking };
}

export function hasUserData(s: RequestState): boolean {
  return (
    Object.values(s.params).some((v) => v !== "") ||
    s.bodyText.trim() !== "" ||
    s.extraHeaders.some((h) => h.key) ||
    s.extraQuery.some((q) => q.key)
  );
}

function diffOperation(oldDoc: Json, newDoc: Json, a: OperationInfo, b: OperationInfo): Change[] {
  const out: Change[] = [];
  const bParams = new Map(b.params.map((p) => [paramKey(p), p]));
  const aParams = new Map(a.params.map((p) => [paramKey(p), p]));
  for (const [k, p] of aParams) {
    const np = bParams.get(k);
    if (!np) {
      out.push({ severity: "breaking", message: `Removed ${p.in} parameter “${p.name}”` });
      continue;
    }
    if (!p.required && np.required)
      out.push({ severity: "breaking", message: `${cap(p.in)} parameter “${p.name}” is now required` });
    diffSchema(oldDoc, newDoc, p.schema, np.schema, `${p.in} parameter “${p.name}”`, "request", out, 0, new Map());
  }
  for (const [k, p] of bParams) {
    if (aParams.has(k)) continue;
    out.push({
      severity: p.required ? "breaking" : "info",
      message: `Added ${p.required ? "required" : "optional"} ${p.in} parameter “${p.name}”`,
    });
  }

  if (a.body && !b.body) out.push({ severity: "breaking", message: "Request body removed" });
  else if (!a.body && b.body)
    out.push({ severity: b.body.required ? "breaking" : "info", message: `Request body added${b.body.required ? " (required)" : ""}` });
  else if (a.body && b.body) {
    if (!a.body.required && b.body.required) out.push({ severity: "breaking", message: "Request body is now required" });
    const bTypes = new Map(b.body.contents.map((c) => [c.type, c]));
    for (const c of a.body.contents) {
      const nc = bTypes.get(c.type);
      if (!nc) out.push({ severity: "breaking", message: `Request content type ${c.type} removed` });
      else diffSchema(oldDoc, newDoc, c.schema, nc.schema, "body", "request", out, 0, new Map());
    }
    for (const c of b.body.contents)
      if (!a.body.contents.some((x) => x.type === c.type))
        out.push({ severity: "info", message: `Request content type ${c.type} added` });
  }

  const bResp = new Map(b.responses.map((r) => [r.status, r]));
  for (const r of a.responses) {
    const nr = bResp.get(r.status);
    if (!nr) out.push({ severity: "warning", message: `Response ${r.status} removed` });
    else {
      const oc = r.contents.find((c) => isJsonType(c.type)) ?? r.contents[0];
      const ncc = nr.contents.find((c) => c.type === oc?.type);
      if (oc && ncc) diffSchema(oldDoc, newDoc, oc.schema, ncc.schema, `response ${r.status}`, "response", out, 0, new Map());
    }
  }
  for (const r of b.responses)
    if (!a.responses.some((x) => x.status === r.status)) out.push({ severity: "info", message: `Response ${r.status} added` });

  if (JSON.stringify(a.security) !== JSON.stringify(b.security))
    out.push({ severity: "warning", message: "Authentication requirements changed" });
  return dedupe(out);
}

function diffSchema(
  oldDoc: Json,
  newDoc: Json,
  a: Json,
  b: Json,
  where: string,
  mode: "request" | "response",
  out: Change[],
  depth: number,
  seen: Map<string, number>,
) {
  if (depth > 6 || a === undefined || b === undefined || structureKey(oldDoc, a) === structureKey(newDoc, b)) return;
  const sa = normalize(oldDoc, a);
  const sb = normalize(newDoc, b);
  // A pair of named schemas is compared once, at the shallowest place it shows up: big specs
  // reuse schemas everywhere, and comparing them at every path grows exponentially.
  if (sa._refName) {
    const pairKey = `${sa._refName}|${sb._refName ?? ""}`;
    if ((seen.get(pairKey) ?? Infinity) <= depth) return;
    seen.set(pairKey, depth);
    // Every operation that uses the pair would compare it again; do it once per diff, with a
    // placeholder for the path that's filled in for each place it shows up.
    let memo = pairMemo.get(oldDoc)?.get(newDoc);
    if (!memo) {
      const byNew = pairMemo.get(oldDoc) ?? new WeakMap();
      pairMemo.set(oldDoc, byNew);
      byNew.set(newDoc, (memo = new Map()));
    }
    const memoKey = `${pairKey}|${mode}|${depth}`;
    let changes = memo.get(memoKey);
    if (!changes) {
      changes = [];
      compareSchemas(oldDoc, newDoc, a, b, sa, sb, WHERE, mode, changes, depth, new Map([[pairKey, depth]]));
      for (const c of changes) c.owner ??= [pairKey, depth];
      memo.set(memoKey, changes);
    }
    // Pairs nested inside were already compared here if this call met them first, at no greater depth.
    const shown = new Map<string, boolean>([[pairKey, true]]);
    for (const c of changes) {
      const [owner, ownerDepth] = c.owner!;
      if (!shown.has(owner)) {
        const show = (seen.get(owner) ?? Infinity) > ownerDepth;
        shown.set(owner, show);
        if (show) seen.set(owner, ownerDepth);
      }
      if (shown.get(owner)) out.push({ ...c, message: cap(where) + c.message.slice(WHERE.length) });
    }
    return;
  }
  compareSchemas(oldDoc, newDoc, a, b, sa, sb, where, mode, out, depth, seen);
}

/** Stands in for the path in changes cached by `diffSchema`; every message starts with it. */
const WHERE = "\u0001";
/** A cached change, with the named schema pair (and its depth) whose comparison produced it. */
type OwnedChange = Change & { owner?: [string, number] };
const pairMemo = new WeakMap<object, WeakMap<object, Map<string, OwnedChange[]>>>();

function compareSchemas(
  oldDoc: Json,
  newDoc: Json,
  a: Json,
  b: Json,
  sa: Json,
  sb: Json,
  where: string,
  mode: "request" | "response",
  out: Change[],
  depth: number,
  seen: Map<string, number>,
) {
  const req = mode === "request";

  const ta = describeType(oldDoc, a);
  const tb = describeType(newDoc, b);
  if (sa._types.join() !== sb._types.join() || (sa.format ?? "") !== (sb.format ?? "")) {
    out.push({ severity: req ? "breaking" : "warning", message: `${cap(where)}: type changed ${ta} → ${tb}` });
    return;
  }
  if (sa._nullable && !sb._nullable && req) out.push({ severity: "breaking", message: `${cap(where)}: no longer nullable` });
  if (Array.isArray(sa.enum) && Array.isArray(sb.enum)) {
    const removed = sa.enum.filter((v: Json) => !sb.enum.some((w: Json) => JSON.stringify(w) === JSON.stringify(v)));
    const addedV = sb.enum.filter((v: Json) => !sa.enum.some((w: Json) => JSON.stringify(w) === JSON.stringify(v)));
    if (removed.length)
      out.push({ severity: req ? "breaking" : "warning", message: `${cap(where)}: enum values removed: ${removed.map(String).join(", ")}` });
    if (addedV.length)
      out.push({ severity: req ? "info" : "warning", message: `${cap(where)}: enum values added: ${addedV.map(String).join(", ")}` });
  }
  if (!sa._nullable && sb._nullable)
    out.push({ severity: req ? "info" : "warning", message: `${cap(where)}: now nullable` });
  for (const k of CONSTRAINTS) {
    const va = JSON.stringify(sa[k]);
    const vb = JSON.stringify(sb[k]);
    if (va === vb) continue;
    const message =
      va === undefined ? `${cap(where)}: ${k} ${vb} added` : vb === undefined ? `${cap(where)}: ${k} ${va} removed` : `${cap(where)}: ${k} ${va} → ${vb}`;
    out.push({ severity: req && k !== "default" ? "warning" : "info", message });
  }
  diffUnions(oldDoc, newDoc, sa, sb, where, mode, out, depth, seen);
  if (sa._types.includes("object") || sa.properties || sb.properties) {
    const pa = sa.properties ?? {};
    const pb = sb.properties ?? {};
    const ra = new Set<string>(sa.required ?? []);
    const rb = new Set<string>(sb.required ?? []);
    for (const k of Object.keys(pa)) {
      const w = `${where}.${k}`;
      if (!(k in pb)) {
        out.push({ severity: req ? "warning" : "breaking", message: `${cap(w)} removed` });
        continue;
      }
      if (!ra.has(k) && rb.has(k))
        out.push({ severity: req ? "breaking" : "info", message: `${cap(w)} is now required` });
      if (ra.has(k) && !rb.has(k))
        out.push({ severity: req ? "info" : "warning", message: `${cap(w)} is now optional` });
      diffSchema(oldDoc, newDoc, pa[k], pb[k], w, mode, out, depth + 1, seen);
    }
    for (const k of Object.keys(pb)) {
      if (k in pa) continue;
      const required = rb.has(k);
      out.push({
        severity: req && required ? "breaking" : "info",
        message: `${cap(`${where}.${k}`)} added${required ? " (required)" : ""}`,
      });
    }
  }
  if ((sa.items || sa.prefixItems) && (sb.items || sb.prefixItems))
    diffSchema(oldDoc, newDoc, itemSchema(sa, 0), itemSchema(sb, 0), `${where}[]`, mode, out, depth + 1, seen);
}

const CONSTRAINTS = [
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "default",
  "const",
];

/**
 * oneOf/anyOf alternatives are matched across versions by the fixed values they carry
 * (e.g. `success: false, error.code: "NotFound"`), so a new error variant reads as such
 * instead of shifting every alternative after it.
 */
function diffUnions(
  oldDoc: Json,
  newDoc: Json,
  sa: Json,
  sb: Json,
  where: string,
  mode: "request" | "response",
  out: Change[],
  depth: number,
  seen: Map<string, number>,
) {
  const ua = variantsOf(oldDoc, sa);
  const ub = variantsOf(newDoc, sb);
  if (!ua && !ub) return;
  const req = mode === "request";
  if (!ua || !ub) {
    out.push({ severity: req ? "breaking" : "warning", message: `${cap(where)}: now ${ub ? `one of ${ub.list.length} variants` : "a single shape"}` });
    return;
  }
  const keyed = (doc: Json, list: { schema: Json; label: string }[]) =>
    list.map((v, i) => ({ ...v, i, fixed: variantValues(doc, v.schema) }));
  const va = keyed(oldDoc, ua.list);
  const vb = keyed(newDoc, ub.list);
  // Values every variant shares (like `success: false` on all errors) don't tell them apart.
  const all = [...va, ...vb];
  const common = new Set(Object.keys(all[0]?.fixed ?? {}).filter((k) => all.every((v) => JSON.stringify(v.fixed[k]) === JSON.stringify(all[0].fixed[k]))));
  const parts = (v: (typeof va)[number]) => Object.entries(v.fixed).filter(([k]) => !common.has(k));
  const show = ([k, x]: [string, Json]) => `${k}: ${typeof x === "string" ? x : JSON.stringify(x)}`;
  // Matched on all distinguishing values, so the identity doesn't depend on the other variants.
  const ident = (v: (typeof va)[number]) => JSON.stringify(parts(v)) + (parts(v).length ? "" : v.label);
  // Shown by a single value that tells it apart from its siblings, when there is one: preferably
  // the most specific (error.code over a success flag every variant has), then the shortest.
  const label = (v: (typeof va)[number], list: typeof va) => {
    const spread = (k: string) => list.filter((o) => k in o.fixed).length;
    const solo = parts(v)
      .filter(([k, x]) => list.every((o) => o === v || JSON.stringify(o.fixed[k]) !== JSON.stringify(x)))
      .sort((p, q) => spread(p[0]) - spread(q[0]) || show(p).length - show(q).length)[0];
    return solo ? show(solo) : parts(v).map(show).join(", ") || v.label;
  };
  const count = (list: typeof va) => list.reduce((m, v) => m.set(ident(v), (m.get(ident(v)) ?? 0) + 1), new Map<string, number>());
  const ca = count(va);
  const cb = count(vb);
  // Ambiguous identities: fall back to pairing by position.
  const unique = [...ca.values(), ...cb.values()].every((n) => n === 1);
  const id = (v: (typeof va)[number]) => (unique ? ident(v) : `#${v.i + 1}`);
  const name = (v: (typeof va)[number], list: typeof va) => (unique ? label(v, list) : `variant ${v.i + 1} (${label(v, list)})`);
  const byB = new Map(vb.map((v) => [id(v), v]));
  const byA = new Map(va.map((v) => [id(v), v]));
  for (const v of va) {
    const nv = byB.get(id(v));
    if (!nv) out.push({ severity: req ? "breaking" : "info", message: `${cap(where)}: variant removed — ${name(v, va)}` });
    else diffSchema(oldDoc, newDoc, v.schema, nv.schema, `${where} [${name(v, va)}]`, mode, out, depth + 1, seen);
  }
  for (const v of vb)
    if (!byA.has(id(v))) out.push({ severity: req ? "info" : "warning", message: `${cap(where)}: variant added — ${name(v, vb)}` });
}

const variantCache = new WeakMap<object, WeakMap<object, Record<string, Json>>>();

/** `fixedValues` of a union variant, cached: big specs repeat the same unions in every operation. */
function variantValues(doc: Json, schema: Json): Record<string, Json> {
  if (!schema || typeof schema !== "object") return fixedValues(doc, schema, "", 0);
  let cache = variantCache.get(doc);
  if (!cache) variantCache.set(doc, (cache = new WeakMap()));
  let values = cache.get(schema);
  if (!values) cache.set(schema, (values = fixedValues(doc, schema, "", 0)));
  return values;
}

/** Properties (up to two levels deep) that allow exactly one value, by dotted path. */
function fixedValues(doc: Json, schema: Json, prefix: string, depth: number): Record<string, Json> {
  const out: Record<string, Json> = {};
  const n = normalize(doc, schema);
  for (const [k, ps] of Object.entries<Json>(n.properties ?? {})) {
    const one = singleValue(doc, ps);
    if (one) out[prefix + k] = one.value;
    else if (depth < 1) Object.assign(out, fixedValues(doc, ps, `${prefix}${k}.`, depth + 1));
  }
  return out;
}

/** Last resort when no known kind of change explains the difference: name the exact spots. */
function rawChanges(oldSpec: ParsedSpec, a: Endpoint, newSpec: ParsedSpec, b: Endpoint): Change[] {
  const operation = (spec: ParsedSpec, e: Endpoint) => {
    const item = spec.doc.paths[e.path] ?? {};
    return { parameters: item.parameters, ...item[e.method.toLowerCase()] };
  };
  const oldDoc = oldSpec.doc;
  const newDoc = newSpec.doc;
  const out: Change[] = [];
  // $refs are followed as the walk descends; `refs` holds the pairs on the current path, so a
  // recursive schema is walked once.
  const walk = (x: Json, y: Json, path: string[], refs: Set<string>) => {
    if (out.length >= 10 || structureKey(oldDoc, x) === structureKey(newDoc, y)) return;
    const pair = `${x?.$ref ?? ""}|${y?.$ref ?? ""}`;
    if (pair !== "|") {
      if (refs.has(pair)) return;
      refs = new Set(refs).add(pair);
      x = deref(oldDoc, x);
      y = deref(newDoc, y);
    }
    if (x && y && typeof x === "object" && typeof y === "object" && Array.isArray(x) === Array.isArray(y)) {
      for (const k of new Set([...Object.keys(x), ...Object.keys(y)]))
        if (Array.isArray(x) || !DOC_ONLY_KEYS.has(k)) walk(x[k], y[k], [...path, k], refs);
      return;
    }
    const where = path.filter((p) => p !== "content" && p !== "schema" && p !== "properties").join(" › ");
    const show = (v: Json) => (v === undefined ? "—" : trim(JSON.stringify(v)));
    out.push({ severity: "info", message: `${where}: ${show(x)} → ${show(y)}` });
  };
  walk(operation(oldSpec, a), operation(newSpec, b), [], new Set());
  return out.length ? out : [{ severity: "info", message: "Schema details changed" }];
}

function savedValueConflicts(
  oldDoc: Json,
  newDoc: Json,
  oldOp: OperationInfo,
  newOp: OperationInfo,
  saved: RequestState,
): Conflict[] {
  const out: Conflict[] = [];
  const id = newOp.endpoint.id;
  const newParams = new Map(newOp.params.map((p) => [paramKey(p), p]));
  const oldParams = new Map(oldOp.params.map((p) => [paramKey(p), p]));
  for (const [key, value] of Object.entries(saved.params)) {
    if (value === "") continue;
    const np = newParams.get(key);
    const label = key.replace(":", " parameter “") + "”";
    if (!np) {
      out.push({ endpointId: id, severity: "warning", message: `Saved value for removed ${label} (“${trim(value)}”) is kept but no longer sent` });
      continue;
    }
    const op = oldParams.get(key);
    const before = op ? validate(oldDoc, op.schema, coerceParamValue(oldDoc, op.schema, value)).length : 0;
    const after = validate(newDoc, np.schema, coerceParamValue(newDoc, np.schema, value));
    if (after.length && !before)
      out.push({ endpointId: id, severity: "breaking", message: `Saved ${label} value “${trim(value)}” is invalid: ${after[0].message}` });
  }

  const ct = saved.contentType ?? oldOp.body?.contents[0]?.type;
  if (saved.bodyText.trim() && ct) {
    const newContent = newOp.body?.contents.find((c) => c.type === ct);
    if (!newOp.body) {
      out.push({ endpointId: id, severity: "warning", message: "Saved request body is kept, but the endpoint no longer accepts a body" });
    } else if (!newContent) {
      out.push({ endpointId: id, severity: "warning", message: `Saved body uses ${ct}, which is no longer supported` });
    } else if (isStructuredType(ct)) {
      let value: Json;
      try {
        value = parseJson(saved.bodyText);
      } catch {
        return out;
      }
      const oldContent = oldOp.body?.contents.find((c) => c.type === ct);
      const before = new Set(
        oldContent ? validate(oldDoc, oldContent.schema, value).map((e) => `${e.path}|${e.message}`) : [],
      );
      for (const e of validate(newDoc, newContent.schema, value)) {
        if (before.has(`${e.path}|${e.message}`)) continue;
        out.push({
          endpointId: id,
          severity: e.message === "Required" ? "warning" : "breaking",
          message: `Saved body ${e.path || "/"}: ${e.message}`,
        });
      }
    }
  }
  return out;
}

export function coerceParamValue(doc: Json, schema: Json, value: string): Json {
  const s = normalize(doc, schema);
  const t = s._types[0];
  if ((t === "integer" || t === "number") && value.trim() !== "" && !isNaN(Number(value))) return Number(value);
  if (t === "boolean" && (value === "true" || value === "false")) return value === "true";
  if (t === "array" || t === "object") {
    try {
      return JSON.parse(value);
    } catch {
      return t === "array" ? value.split(",").map((v) => v.trim()) : value;
    }
  }
  return value;
}

function trim(s: string): string {
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function dedupe(list: Change[]): Change[] {
  const seen = new Set<string>();
  return list
    .filter((c) => (seen.has(c.message) ? false : (seen.add(c.message), true)))
    .map(({ severity, message }) => ({ severity, message }));
}
