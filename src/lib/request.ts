import type { OperationInfo, Param, SecurityScheme } from "./openapi";
import type { AuthConfig, Collection, RequestState } from "./models";
import type { HttpRequest } from "./platform";
import { interpolate, interpolateJsonText } from "./vars";
import { itemSchema, normalize, variantsOf, Json } from "./schema";

export function paramKey(p: Pick<Param, "in" | "name">): string {
  return `${p.in}:${p.name}`;
}

export function isParamActive(p: Param, state: RequestState): boolean {
  const key = paramKey(p);
  if (p.required) return true;
  if (key in state.paramEnabled) return state.paramEnabled[key];
  return (state.params[key] ?? "") !== "";
}

export function isJsonType(ct: string | undefined): boolean {
  return !!ct && /[/+]json\b|^application\/json/i.test(ct);
}

export function isFormType(ct: string | undefined): boolean {
  return !!ct && /x-www-form-urlencoded|multipart\/form-data/i.test(ct);
}

/** Whether the body editor treats this media type as structured (form + JSON editing). */
export function isStructuredType(ct: string | undefined): boolean {
  return isJsonType(ct) || isFormType(ct);
}

export interface BuiltRequest {
  req: HttpRequest;
  missingVars: string[];
  /** Variables the request refers to anywhere (URL, params, headers, body, auth). */
  usedVars: string[];
  problems: string[];
  /** Headers the app adds by itself, for showing next to the user's own. */
  implicitHeaders: ImplicitHeader[];
  /** Credential values placed in the request, so copies kept elsewhere (history) can mask them. */
  secretValues: string[];
}

export type HeaderSource = "auth" | "body" | "cookie" | "collection" | "client";

/** Headers the client adds on its own; collection settings can change or (mostly) drop them. */
export const CLIENT_HEADERS: { name: string; value: (version: string) => string; nativeOnly?: boolean; required?: string }[] = [
  { name: "User-Agent", value: (v) => `Reqoon/${v}`, nativeOnly: true },
  // reqwest sends "Accept: */*" whenever a request has none, so it can be changed but not removed.
  { name: "Accept", value: () => "*/*", required: "The HTTP client always sends an Accept header; you can change its value." },
  { name: "Accept-Encoding", value: () => "gzip, deflate, br", nativeOnly: true },
];

export interface ImplicitHeader {
  name: string;
  value: string;
  source: HeaderSource;
  /** A header the user set with the same name is sent instead. */
  overridden?: boolean;
  /** Carries credentials: shown masked. */
  secret?: boolean;
  /** Can be left out of this request (collection-wide and most client headers). */
  switchable?: boolean;
  /** Left out of this request. */
  off?: boolean;
}

export function buildRequest(opts: {
  op: OperationInfo;
  state: RequestState;
  collection: Collection;
  vars: Record<string, string>;
  auth: AuthConfig;
  schemes: Record<string, SecurityScheme>;
  doc: Json;
  timeoutSec: number;
  /** Running in the desktop app (the browser fallback can't set User-Agent / Accept-Encoding). */
  client?: { native: boolean; version: string };
}): BuiltRequest {
  const { op, state, collection, vars, doc } = opts;
  const missing = new Set<string>();
  const used = new Set<string>();
  const problems: string[] = [];
  const iv = (s: string) => interpolate(s, vars, missing, used);

  let path = op.endpoint.path;
  const query: [string, string][] = [];
  const headers: [string, string][] = [];
  const cookies: string[] = [];
  const implicit: ImplicitHeader[] = [];
  /** Adds a header unless the user already set one with that name (theirs wins). */
  const auto = (name: string, value: string, source: HeaderSource, secret?: boolean, switchable?: boolean) => {
    const overridden = headers.some(([k]) => k.toLowerCase() === name.toLowerCase());
    const off = !!switchable && !!state.offHeaders?.includes(name.toLowerCase());
    if (!overridden && !off) headers.push([name, value]);
    implicit.push({ name, value, source, overridden, secret, ...(switchable ? { switchable, off } : {}) });
  };

  for (const p of op.params) {
    const key = paramKey(p);
    const raw = state.params[key] ?? "";
    if (!isParamActive(p, state)) continue;
    if (p.required && raw === "") problems.push(`Missing required ${p.in} parameter "${p.name}"`);
    const value = iv(raw);
    switch (p.in) {
      case "path":
        path = path.split(`{${p.name}}`).join(encodeURIComponent(value));
        break;
      case "query":
        query.push(...serializeQueryParam(doc, p, value));
        break;
      case "header":
        headers.push([p.name, value]);
        break;
      case "cookie":
        cookies.push(`${p.name}=${encodeURIComponent(value)}`);
        break;
    }
  }
  for (const kv of state.extraQuery) if (kv.enabled && kv.key) query.push([iv(kv.key), iv(kv.value)]);
  for (const kv of state.extraHeaders) if (kv.enabled && kv.key) headers.push([iv(kv.key), iv(kv.value)]);

  // Collection-wide headers: below the request's own, above everything automatic.
  for (const kv of collection.headers?.extra ?? []) if (kv.enabled && kv.key) auto(iv(kv.key), iv(kv.value), "collection", undefined, true);

  const secretValues: string[] = [];
  applyAuth(opts, iv, auto, query, cookies, secretValues);
  if (cookies.length) auto("Cookie", cookies.join("; "), "cookie");

  let body: string | undefined;
  const ct = state.contentType ?? op.body?.contents[0]?.type;
  if (op.body && ct && (state.bodyText.trim() !== "" || op.body.required)) {
    if (isJsonType(ct)) {
      const schema = op.body.contents.find((c) => c.type === ct)?.schema;
      body = interpolateJsonText(state.bodyText, vars, missing, schema ? (path) => isStringAt(opts.doc, schema, path) : undefined, used);
      auto("Content-Type", ct, "body");
    } else if (/x-www-form-urlencoded/i.test(ct)) {
      body = new URLSearchParams(flattenForm(parseBodyObject(state.bodyText, problems), iv)).toString();
      auto("Content-Type", ct, "body");
    } else if (/multipart\/form-data/i.test(ct)) {
      // A Content-Type the user set (e.g. via override) names the boundary the body must use;
      // otherwise a fixed one, so copying the auto header keeps matching the body.
      const own = state.extraHeaders.find((h) => h.enabled && h.key.trim().toLowerCase() === "content-type");
      const boundary = /boundary="?([^";]+)"?/i.exec(own ? iv(own.value) : "")?.[1] ?? "----ReqoonFormBoundary7MA4YWxkTrZu0gW";
      const parts = flattenForm(parseBodyObject(state.bodyText, problems), iv).map(
        ([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k.replace(/"/g, "%22")}"\r\n\r\n${v}\r\n`,
      );
      body = parts.join("") + `--${boundary}--\r\n`;
      auto("Content-Type", `multipart/form-data; boundary=${boundary}`, "body");
    } else {
      body = iv(state.bodyText);
      auto("Content-Type", ct, "body");
    }
  }

  let noCompression = false;
  for (const h of CLIENT_HEADERS) {
    if (h.nativeOnly && !opts.client?.native) continue;
    const cfg = collection.headers?.client?.[h.name.toLowerCase()];
    if (cfg?.off && !h.required) {
      if (h.name === "Accept-Encoding") noCompression = true;
      continue;
    }
    auto(h.name, cfg?.value ? iv(cfg.value) : h.value(opts.client?.version ?? ""), "client", undefined, !h.required);
    if (h.name === "Accept-Encoding" && state.offHeaders?.includes("accept-encoding")) noCompression = true;
  }

  let base = iv(collection.baseUrl || "").replace(/\/$/, "");
  if (base && !/^[a-z][a-z0-9+.-]*:\/\//i.test(base)) base = `http://${base}`;
  const qs = query.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  const url = `${base}${path}${qs ? `?${qs}` : ""}`;
  if (!base) problems.push("No base URL configured for this collection");

  return {
    req: {
      id: crypto.randomUUID(),
      method: op.endpoint.method,
      url,
      headers,
      body,
      timeoutMs: opts.timeoutSec * 1000,
      ...(noCompression ? { noCompression } : {}),
    },
    missingVars: [...missing],
    usedVars: [...used],
    problems,
    implicitHeaders: implicit,
    secretValues,
  };
}

/** Headers the HTTP client adds on its own (reqwest in the app, fetch in the browser build). */
/** Headers the transport derives from the request itself (not configurable). */
export function transportHeaders(req: HttpRequest): ImplicitHeader[] {
  const has = (name: string) => req.headers.some(([k]) => k.toLowerCase() === name.toLowerCase());
  const out: ImplicitHeader[] = [];
  const add = (name: string, value: string, canOverride = true) =>
    out.push({ name, value, source: "client", overridden: canOverride && has(name) });
  let host = "";
  try {
    host = new URL(req.url).host;
  } catch {
    /* no valid URL yet */
  }
  if (host) add("Host", host, false);
  if (req.body !== undefined) add("Content-Length", String(new TextEncoder().encode(req.body).length), false);
  return out;
}

function serializeQueryParam(doc: Json, p: Param, value: string): [string, string][] {
  const s = normalize(doc, p.schema);
  const type = s._types[0];
  const explode = p.explode ?? (p.style ?? "form") === "form";
  if (type === "array") {
    const items = splitList(value);
    if (explode) return items.map((v) => [p.name, v]);
    const sep = p.style === "spaceDelimited" ? " " : p.style === "pipeDelimited" ? "|" : ",";
    return [[p.name, items.join(sep)]];
  }
  if (type === "object") {
    try {
      const obj = JSON.parse(value);
      if (obj && typeof obj === "object") {
        const entries = Object.entries(obj).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]);
        if (p.style === "deepObject") return entries.map(([k, v]) => [`${p.name}[${k}]`, v]);
        if (explode) return entries as [string, string][];
        return [[p.name, entries.flat().join(",")]];
      }
    } catch {
      /* send as typed */
    }
  }
  return [[p.name, value]];
}

/** Array-typed params are edited as JSON arrays or comma separated text. */
export function splitList(value: string): string[] {
  const t = value.trim();
  if (t.startsWith("[")) {
    try {
      const arr = JSON.parse(t);
      if (Array.isArray(arr)) return arr.map((v) => (typeof v === "string" ? v : JSON.stringify(v)));
    } catch {
      /* fall through */
    }
  }
  return t === "" ? [] : t.split(",").map((s) => s.trim());
}

function parseBodyObject(text: string, problems: string[]): Record<string, Json> {
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text);
    if (v && typeof v === "object" && !Array.isArray(v)) return v;
  } catch {
    /* reported below */
  }
  problems.push("Form body must be a JSON object of fields");
  return {};
}

function flattenForm(obj: Record<string, Json>, iv: (s: string) => string): [string, string][] {
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const item of v) out.push([k, iv(typeof item === "string" ? item : JSON.stringify(item))]);
    else out.push([k, iv(typeof v === "string" ? v : JSON.stringify(v))]);
  }
  return out;
}

function applyAuth(
  opts: { op: OperationInfo; collection: Collection; auth: AuthConfig; schemes: Record<string, SecurityScheme> },
  iv: (s: string) => string,
  auto: (name: string, value: string, source: HeaderSource, secret?: boolean) => void,
  query: [string, string][],
  cookies: string[],
  secrets: string[],
) {
  const cfg = opts.auth[opts.collection.id] ?? {};
  const alternatives = authAlternatives(opts.op.security, opts.collection);
  const schemes = collectionSchemes(opts.collection, opts.schemes);
  if (!alternatives.length) return;
  const configured = (name: string) => {
    const c = cfg[name];
    return !!c && (c.value !== "" || !!c.username || !!c.password);
  };
  const chosen = chooseAuth(alternatives, configured, opts.collection.authChoice);
  if (!chosen) return;
  for (const name of Object.keys(chosen)) {
    const scheme = schemes[name];
    const c = cfg[name];
    if (!scheme || !c) continue;
    if (scheme.type === "apiKey" && scheme.name) {
      const v = iv(c.value);
      secrets.push(v, encodeURIComponent(v));
      if (scheme.in === "query") query.push([scheme.name, v]);
      else if (scheme.in === "cookie") cookies.push(`${scheme.name}=${encodeURIComponent(v)}`);
      else auto(scheme.name, v, "auth", true);
    } else if (scheme.type === "http" && scheme.scheme?.toLowerCase() === "basic") {
      const token = btoa(unescape(encodeURIComponent(`${iv(c.username ?? "")}:${iv(c.password ?? "")}`)));
      secrets.push(token);
      auto("Authorization", `Basic ${token}`, "auth", true);
    } else if (scheme.type === "http" || scheme.type === "oauth2" || scheme.type === "openIdConnect") {
      const prefix = scheme.type === "http" && scheme.scheme ? capitalize(scheme.scheme) : "Bearer";
      secrets.push(iv(c.value));
      auto("Authorization", `${prefix} ${iv(c.value)}`, "auth", true);
    }
  }
}

/** Credentials key of a user-added scheme; can't clash with a spec scheme name used as a key. */
export const customSchemeKey = (id: string) => `custom:${id}`;

/** The spec's security schemes plus the collection's own (user-added) ones. */
export function collectionSchemes(collection: Pick<Collection, "customAuth">, spec: Record<string, SecurityScheme>): Record<string, SecurityScheme> {
  if (!collection.customAuth?.length) return spec;
  const out = { ...spec };
  for (const c of collection.customAuth) {
    out[customSchemeKey(c.id)] =
      c.kind === "apiKey"
        ? { type: "apiKey", in: c.in ?? "header", name: c.param || "X-API-Key", title: c.title }
        : { type: "http", scheme: c.kind, title: c.title };
  }
  return out;
}

/**
 * The ways an endpoint can be authenticated: the spec's alternatives, then each user-added
 * scheme. An endpoint the spec leaves open keeps "no auth" as an option alongside them.
 */
export function authAlternatives(security: Record<string, string[]>[], collection: Pick<Collection, "customAuth">): Record<string, string[]>[] {
  const custom = (collection.customAuth ?? []).map((c) => ({ [customSchemeKey(c.id)]: [] as string[] }));
  if (!custom.length) return security;
  return [...(security.length ? security : [{}]), ...custom];
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

export function toCurl(req: HttpRequest): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const parts = [`curl -X ${req.method} ${q(req.url)}`];
  for (const [k, v] of req.headers) parts.push(`-H ${q(`${k}: ${v}`)}`);
  if (req.body !== undefined) parts.push(`--data-raw ${q(req.body)}`);
  return parts.join(" \\\n  ");
}

/** True when the schema at `path` only admits strings, so "{{var}}" there stays a string. */
export function isStringAt(doc: Json, schema: Json, path: (string | number)[]): boolean {
  let cur: Json = schema;
  for (const seg of path) {
    const n = normalize(doc, cur);
    const step = (s: Json): Json => {
      const m = normalize(doc, s);
      if (typeof seg === "number") return m.items || m.prefixItems ? itemSchema(m, seg) : undefined;
      if (m.properties?.[seg] !== undefined) return m.properties[seg];
      return typeof m.additionalProperties === "object" ? m.additionalProperties : undefined;
    };
    // In a union, any alternative that knows the field decides.
    cur = step(n) ?? variantsOf(doc, n)?.list.map((v) => step(v.schema)).find((x) => x !== undefined);
    if (cur === undefined) return false;
  }
  const n = normalize(doc, cur);
  return n._types.length === 1 && n._types[0] === "string";
}

/** Identifies a security requirement set: its scheme names; "" for the empty set (no auth). */
export function authChoiceKey(alt: Record<string, unknown>): string {
  return Object.keys(alt).sort().join("+");
}

/**
 * The requirement set to send. The user's pick wins when this endpoint offers it; otherwise the
 * first set with all credentials configured, then one with some. The empty set ({}, "auth
 * optional") is trivially satisfied, so it is only used when picked.
 */
export function chooseAuth<T extends Record<string, unknown>>(
  alternatives: T[],
  configured: (scheme: string) => boolean,
  preferred?: string,
): T | undefined {
  const picked = preferred === undefined ? undefined : alternatives.find((alt) => authChoiceKey(alt) === preferred);
  if (picked) return picked;
  const real = alternatives.filter((alt) => Object.keys(alt).length > 0);
  return real.find((alt) => Object.keys(alt).every(configured)) ?? real.find((alt) => Object.keys(alt).some(configured));
}
