// Inlines $refs to other files, so a spec split across files becomes one document.
//
// Every referenced file is loaded relative to the file that references it. Referenced objects are
// moved under `x-bundled` and the $ref is rewritten to point there: the last part of the ref stays
// the name the UI shows for a schema, shared objects are stored once, and recursive schemas keep
// working. A $ref that stands for a whole map (`securitySchemes: {$ref: ...}`) is replaced by the
// map itself, because maps are read directly rather than through deref.
import { parseSpecText } from "./openapi";
import { resolvePointer, type Json } from "./schema";

export const BUNDLE_KEY = "x-bundled";

/** Keys whose value is a map or list in OpenAPI; a $ref there is inlined instead of moved. */
const MAP_KEYS = new Set([
  "paths", "webhooks", "components", "schemas", "parameters", "responses", "requestBodies", "headers",
  "securitySchemes", "examples", "links", "callbacks", "pathItems", "properties", "content", "servers", "tags",
]);

const isExternal = (ref: unknown): ref is string => typeof ref === "string" && !ref.startsWith("#");

export function hasExternalRefs(node: Json): boolean {
  if (!node || typeof node !== "object") return false;
  if (isExternal(node.$ref)) return true;
  for (const v of Array.isArray(node) ? node : Object.values(node)) if (hasExternalRefs(v)) return true;
  return false;
}

/** Absolute location of `ref`'s file relative to `base` (a URL, or a file path). */
export function resolveLocation(base: string, ref: string): string {
  const file = ref.split("#")[0];
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(base)) return new URL(file, base).href;
  const unix = base.replace(/\\/g, "/");
  const url = new URL(encodeURI(file.replace(/\\/g, "/")), "file://" + encodeURI(unix.startsWith("/") ? unix : "/" + unix));
  const path = decodeURIComponent(url.pathname);
  // Windows drive paths come back as "/C:/..."; the original separator style is kept.
  const out = /^\/[a-z]:\//i.test(path) && !unix.startsWith("/") ? path.slice(1) : path;
  return base.includes("\\") ? out.replace(/\//g, "\\") : out;
}

/** Bundles `doc`, read from `location`, loading referenced files with `load`. Returns `doc` itself
 *  when it references no other files. */
export async function bundleRefs(doc: Json, location: string, load: (location: string) => Promise<string>): Promise<Json> {
  if (!hasExternalRefs(doc)) return doc;

  // Load every file first, a level of references at a time, so remote files download in parallel.
  const files = new Map<string, Json>([[location, doc]]);
  let level: [string, Json][] = [[location, doc]];
  while (level.length) {
    const wanted = new Set<string>();
    for (const [loc, d] of level) collectFiles(d, loc, files, wanted);
    level = await Promise.all(
      [...wanted].map(async (loc): Promise<[string, Json]> => {
        let text: string;
        try {
          text = await load(loc);
        } catch (e) {
          throw new Error(`Could not load ${loc}, referenced by the spec: ${e}`);
        }
        try {
          return [loc, parseSpecText(text)];
        } catch (e) {
          throw new Error(`Could not parse ${loc}, referenced by the spec: ${e}`);
        }
      }),
    );
    for (const [loc, d] of level) files.set(loc, d);
  }

  // Entries the document already has under the same key keep their names.
  const bundled: Record<string, Json> = { ...(doc[BUNDLE_KEY] ?? {}) };
  const names = new Map<string, string>();
  const inlined = new Map<string, Json>();
  const inProgress = new Set<string>();

  const target = (loc: string, fragment: string): Json => {
    const t = resolvePointer(files.get(loc), "#" + fragment);
    if (t === undefined) throw new Error(`The spec references ${fragment ? `#${fragment} in ` : ""}${loc}, which does not exist.`);
    return t;
  };

  const move = (loc: string, fragment: string, key: string): string => {
    let name = names.get(key);
    if (!name) {
      const base = (fragment.split("/").filter(Boolean).pop() ?? loc.split(/[\\/]/).pop()!.replace(/\.(ya?ml|json)$/i, "")) || "ref";
      name = base;
      for (let i = 2; name in bundled; i++) name = `${base}${i}`;
      names.set(key, name);
      bundled[name] = null;
      bundled[name] = walk(target(loc, fragment), loc, undefined);
    }
    return `#/${BUNDLE_KEY}/${name.replace(/~/g, "~0").replace(/\//g, "~1")}`;
  };

  const walk = (node: Json, loc: string, parentKey: string | undefined): Json => {
    if (!node || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map((v) => walk(v, loc, undefined));
    const ref = node.$ref;
    // A local ref in the main file already points into the result.
    if (typeof ref === "string" && (isExternal(ref) || loc !== location)) {
      const fileLoc = isExternal(ref) ? resolveLocation(loc, ref) : loc;
      const fragment = ref.includes("#") ? ref.slice(ref.indexOf("#") + 1) : "";
      const key = `${fileLoc}#${fragment}`;
      const { $ref: _, ...siblings } = node;
      const rest = walk(siblings, loc, undefined);
      if (parentKey && MAP_KEYS.has(parentKey) && !inProgress.has(key)) {
        let value = inlined.get(key);
        if (value === undefined) {
          inProgress.add(key);
          value = walk(target(fileLoc, fragment), fileLoc, parentKey);
          inProgress.delete(key);
          inlined.set(key, value);
        }
        return Object.keys(rest).length && value && typeof value === "object" && !Array.isArray(value) ? { ...value, ...rest } : value;
      }
      return { $ref: move(fileLoc, fragment, key), ...rest };
    }
    // Inside a named map (`properties`, `schemas`, ...) the keys are names, not OpenAPI keywords.
    const named = parentKey !== undefined && parentKey !== "components" && MAP_KEYS.has(parentKey);
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(node)) out[k] = walk(v, loc, named ? undefined : k);
    return out;
  };

  const result = walk(doc, location, undefined);
  result[BUNDLE_KEY] = { ...bundled, ...(result[BUNDLE_KEY] ?? {}) };
  return result;
}

function collectFiles(node: Json, loc: string, files: Map<string, Json>, wanted: Set<string>) {
  if (!node || typeof node !== "object") return;
  if (isExternal(node.$ref)) {
    const target = resolveLocation(loc, node.$ref);
    if (!files.has(target)) wanted.add(target);
  }
  for (const v of Array.isArray(node) ? node : Object.values(node)) collectFiles(v, loc, files, wanted);
}
