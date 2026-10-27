import YAML from "yaml";
import { deref, Json } from "./schema";

export const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

export interface Endpoint {
  id: string; // "GET /pets/{id}"
  method: string; // upper case
  path: string;
  summary?: string;
  description?: string;
  operationId?: string;
  tags: string[];
  deprecated: boolean;
}

export interface Param {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required: boolean;
  schema: Json;
  description?: string;
  deprecated?: boolean;
  example?: Json;
  explode?: boolean;
  style?: string;
}

export interface MediaContent {
  type: string;
  schema: Json;
  example?: Json;
}

export interface OperationInfo {
  endpoint: Endpoint;
  params: Param[];
  body?: { required: boolean; description?: string; contents: MediaContent[] };
  responses: { status: string; description?: string; contents: MediaContent[] }[];
  security: Record<string, string[]>[]; // alternatives; [] = no auth
}

export interface SecurityScheme {
  type: "apiKey" | "http" | "oauth2" | "openIdConnect" | "mutualTLS";
  name?: string;
  in?: "query" | "header" | "cookie";
  scheme?: string;
  bearerFormat?: string;
  description?: string;
  /** Display name of a scheme the user added to the collection (not in the spec). */
  title?: string;
}

export interface ParsedSpec {
  doc: Json;
  openapi: string;
  title: string;
  version: string;
  description?: string;
  endpoints: Endpoint[];
  tags: { name: string; description?: string }[];
  servers: { url: string; description?: string }[];
  securitySchemes: Record<string, SecurityScheme>;
}

export function parseSpecText(text: string): Json {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(text);
    } catch {
      /* fall back to YAML, which is a JSON superset */
    }
  }
  return YAML.parse(text, { maxAliasCount: 10000, merge: true });
}

export function buildSpec(doc: Json, sourceUrl?: string): ParsedSpec {
  if (!doc || typeof doc !== "object") throw new Error("The document is not a valid OpenAPI object.");
  if (doc.swagger) throw new Error("Swagger 2.0 is not supported. Please convert the spec to OpenAPI 3.x.");
  if (typeof doc.openapi !== "string" || !/^3\.[01]/.test(doc.openapi))
    throw new Error(`Unsupported OpenAPI version "${doc.openapi ?? "unknown"}". Expected 3.0 or 3.1.`);

  const endpoints: Endpoint[] = [];
  const paths = doc.paths ?? {};
  for (const [path, rawItem] of Object.entries<Json>(paths)) {
    const item = deref(doc, rawItem) ?? {};
    for (const m of METHODS) {
      const op = item[m];
      if (!op || typeof op !== "object") continue;
      endpoints.push({
        id: `${m.toUpperCase()} ${path}`,
        method: m.toUpperCase(),
        path,
        summary: op.summary,
        description: op.description,
        operationId: op.operationId,
        tags: Array.isArray(op.tags) && op.tags.length ? op.tags : [],
        deprecated: op.deprecated === true,
      });
    }
  }

  const declaredTags: { name: string; description?: string }[] = Array.isArray(doc.tags)
    ? doc.tags.filter((t: Json) => t?.name).map((t: Json) => ({ name: t.name, description: t.description }))
    : [];
  const known = new Set(declaredTags.map((t) => t.name));
  for (const e of endpoints) for (const t of e.tags) if (!known.has(t)) (known.add(t), declaredTags.push({ name: t }));

  const servers = (Array.isArray(doc.servers) && doc.servers.length ? doc.servers : [{ url: "/" }]).map((s: Json) => ({
    url: resolveServerUrl(s, sourceUrl),
    description: s.description,
  }));

  const schemes: Record<string, SecurityScheme> = {};
  for (const [name, s] of Object.entries<Json>(doc.components?.securitySchemes ?? {})) schemes[name] = deref(doc, s);

  return {
    doc,
    openapi: doc.openapi,
    title: doc.info?.title ?? "Untitled API",
    version: doc.info?.version ?? "",
    description: doc.info?.description,
    endpoints,
    tags: declaredTags,
    servers,
    securitySchemes: schemes,
  };
}

function resolveServerUrl(server: Json, sourceUrl?: string): string {
  let url: string = server.url ?? "/";
  for (const [k, v] of Object.entries<Json>(server.variables ?? {})) {
    url = url.split(`{${k}}`).join(String(v?.default ?? ""));
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && sourceUrl && /^https?:/i.test(sourceUrl)) {
    try {
      url = new URL(url, sourceUrl).toString();
    } catch {
      /* keep as is */
    }
  }
  return url.replace(/\/$/, "");
}

export function getOperation(spec: ParsedSpec, endpointId: string): OperationInfo | null {
  const endpoint = spec.endpoints.find((e) => e.id === endpointId);
  if (!endpoint) return null;
  const doc = spec.doc;
  const item = deref(doc, doc.paths[endpoint.path]) ?? {};
  const op = item[endpoint.method.toLowerCase()];

  const params = new Map<string, Param>();
  for (const raw of [...(item.parameters ?? []), ...(op.parameters ?? [])]) {
    const p = deref(doc, raw);
    if (!p?.name || !p.in) continue;
    let schema = p.schema;
    if (!schema && p.content) schema = (Object.values<Json>(p.content)[0] as Json)?.schema;
    params.set(`${p.in}:${p.name}`, {
      name: p.name,
      in: p.in,
      required: p.in === "path" ? true : p.required === true,
      schema: schema ?? { type: "string" },
      description: p.description,
      deprecated: p.deprecated,
      example: p.example ?? (p.examples ? (deref(doc, Object.values<Json>(p.examples)[0]) as Json)?.value : undefined),
      explode: p.explode,
      style: p.style,
    });
  }

  let body: OperationInfo["body"];
  if (op.requestBody) {
    const rb = deref(doc, op.requestBody) ?? {};
    body = {
      required: rb.required === true,
      description: rb.description,
      contents: contentList(doc, rb.content),
    };
  }

  const responses = Object.entries<Json>(op.responses ?? {}).map(([status, raw]) => {
    const r = deref(doc, raw) ?? {};
    return { status, description: r.description, contents: contentList(doc, r.content) };
  });

  const security: Record<string, string[]>[] = op.security ?? doc.security ?? [];
  return { endpoint, params: [...params.values()], body, responses, security };
}

function contentList(doc: Json, content: Json): MediaContent[] {
  return Object.entries<Json>(content ?? {}).map(([type, raw]) => {
    const m = deref(doc, raw) ?? {};
    const ex = m.example ?? (m.examples ? (deref(doc, Object.values<Json>(m.examples)[0]) as Json)?.value : undefined);
    return { type, schema: m.schema, example: ex };
  });
}

/** Inlines $refs up to a depth so two versions of an operation can be compared structurally. */
export function expandRefs(doc: Json, node: Json, depth = 0, stack: string[] = []): Json {
  if (node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map((n) => expandRefs(doc, n, depth, stack));
  if (typeof node.$ref === "string") {
    if (stack.includes(node.$ref) || depth > 8) return { $recursive: node.$ref.split("/").pop() };
    return expandRefs(doc, deref(doc, node), depth + 1, [...stack, node.$ref]);
  }
  const out: Record<string, Json> = {};
  for (const k of Object.keys(node).sort()) {
    if (k === "description" || k === "summary" || k === "example" || k === "examples" || k === "externalDocs")
      continue;
    out[k] = expandRefs(doc, node[k], depth, stack);
  }
  return out;
}

export function operationFingerprint(spec: ParsedSpec, endpoint: Endpoint): string {
  const doc = spec.doc;
  const item = deref(doc, doc.paths[endpoint.path]) ?? {};
  const op = item[endpoint.method.toLowerCase()];
  return JSON.stringify(
    expandRefs(doc, {
      params: [...(item.parameters ?? []), ...(op.parameters ?? [])],
      body: op.requestBody,
      responses: op.responses,
      security: op.security ?? doc.security,
      deprecated: op.deprecated,
    }),
  );
}

export function hashText(text: string): string {
  // FNV-1a 64-bit split in two 32-bit halves; good enough for change detection.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995);
  }
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0") + text.length.toString(16);
}
