// Per-collection hide rules, in the spirit of .gitignore:
//
//   # comment
//   @deprecated                  hide deprecated endpoints
//   @tag:Internal                hide endpoints tagged "Internal"
//   @untagged                    hide endpoints without tags (the "Other" folder)
//   /admin                       hide /admin and everything below it
//   /subscriptions/v2/*/v*       `*` matches within one path segment
//   /legacy/**/export            `**` matches any number of segments
//   get-overview                 no leading "/": matches that segment at any depth
//   DELETE /users/{id}           with method(s) ("GET,POST /path"): exactly that endpoint
//   DELETE /admin/**             ...or everything below a path, for those methods
//   !GET /admin/health           a leading "!" shows matching endpoints again
//
// The last matching rule wins, so negations go after the rules they override.
import type { Endpoint } from "./openapi";

export interface HideRule {
  negate: boolean;
  kind: "deprecated" | "untagged" | "tag" | "path";
  tag?: string;
  methods?: string[]; // upper case; undefined = any
  re?: RegExp;
  line: number;
}

const METHOD_LIST = /^([A-Za-z]+(?:,[A-Za-z]+)*)\s+(\S.*)$/;

export function parseRules(text: string): { rules: HideRule[]; errors: { line: number; message: string }[] } {
  const rules: HideRule[] = [];
  const errors: { line: number; message: string }[] = [];
  (text ?? "").split("\n").forEach((raw, i) => {
    let s = raw.trim();
    if (!s || s.startsWith("#")) return;
    const negate = s.startsWith("!");
    if (negate) s = s.slice(1).trim();
    if (s === "@deprecated") return void rules.push({ negate, kind: "deprecated", line: i + 1 });
    if (s === "@untagged") return void rules.push({ negate, kind: "untagged", line: i + 1 });
    if (s.startsWith("@tag:")) {
      const tag = s.slice(5).trim();
      if (!tag) return void errors.push({ line: i + 1, message: "Missing tag name" });
      return void rules.push({ negate, kind: "tag", tag, line: i + 1 });
    }
    if (s.startsWith("@")) return void errors.push({ line: i + 1, message: `Unknown rule ${s.split(/\s/)[0]}` });
    let methods: string[] | undefined;
    const m = s.match(METHOD_LIST);
    if (m && !m[1].includes("/")) {
      methods = m[1].toUpperCase().split(",");
      s = m[2].trim();
    }
    // A rule naming methods targets endpoints, so it matches the path itself, not what's below it
    // (hiding "GET /list" must not hide "GET /list/v2"); "/**" still reaches below.
    rules.push({ negate, kind: "path", methods, re: globToRegExp(s, !methods), line: i + 1 });
  });
  return { rules, errors };
}

/** Path glob → RegExp. With `subtree` a pattern also matches everything below it (directory semantics). */
export function globToRegExp(pattern: string, subtree = true): RegExp {
  let p = pattern.replace(/\/+$/, "");
  const anchored = p.startsWith("/");
  if (!anchored) p = "/" + p;
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*") {
      if (p[i + 1] === "*") {
        // "/**/" may match a single "/" so "/a/**/b" matches "/a/b".
        if (p[i - 1] === "/" && p[i + 2] === "/") {
          re = re.slice(0, -1) + "(?:/.*)?";
          i++;
        } else {
          re += ".*";
          i++;
        }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${anchored ? "" : "(?:.*)?"}${re}${subtree ? "(?:/.*)?" : ""}$`);
}

export function ruleMatches(r: HideRule, e: Endpoint): boolean {
  switch (r.kind) {
    case "deprecated":
      return e.deprecated;
    case "untagged":
      return e.tags.length === 0;
    case "tag":
      return e.tags.includes(r.tag!);
    case "path":
      return (!r.methods || r.methods.includes(e.method)) && r.re!.test(e.path);
  }
}

export function isHidden(rules: HideRule[], e: Endpoint): boolean {
  let hidden = false;
  for (const r of rules) if (ruleMatches(r, e)) hidden = !r.negate;
  return hidden;
}

export function hiddenSet(rulesText: string | undefined, endpoints: Endpoint[]): Set<string> {
  const out = new Set<string>();
  if (!rulesText?.trim()) return out;
  const { rules } = parseRules(rulesText);
  if (!rules.length) return out;
  for (const e of endpoints) if (isHidden(rules, e)) out.add(e.id);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Editing helpers used by the sidebar's context menu

export function endpointRule(e: Endpoint): string {
  return `${e.method} ${e.path}`;
}

function lines(text: string | undefined): string[] {
  return (text ?? "").split("\n");
}

function normalizeText(ls: string[]): string {
  return ls.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");
}

/** Adds a hide rule (removing an identical "!" rule if present). */
export function addHideRule(text: string | undefined, rule: string): string {
  const ls = lines(text).filter((l) => l.trim() !== `!${rule}` && l.trim() !== rule);
  if (ls.length && ls[ls.length - 1].trim() !== "") ls.push(rule);
  else if (ls.length) ls[ls.length - 1] = rule;
  else ls.push(rule);
  return normalizeText(ls);
}

/**
 * Makes the given endpoints visible again: drops rules that only name them, and adds a
 * "!" rule for whatever is still hidden by broader rules.
 */
export function unhide(text: string | undefined, endpoints: Endpoint[], unhideRule?: string): string {
  const own = new Set(endpoints.map(endpointRule));
  if (unhideRule) own.add(unhideRule);
  let ls = lines(text).filter((l) => !own.has(l.trim()));
  const { rules } = parseRules(ls.join("\n"));
  const still = endpoints.filter((e) => isHidden(rules, e));
  if (still.length) {
    if (unhideRule && still.length > 1) ls = [...ls, `!${unhideRule}`];
    else ls = [...ls, ...still.map((e) => `!${endpointRule(e)}`)];
  }
  return normalizeText(ls);
}

export function hasRule(text: string | undefined, rule: string): boolean {
  return lines(text).some((l) => l.trim() === rule);
}

/** A selected sidebar row: an endpoint, or a folder with the rule that hides it as a whole. */
export interface HideTarget {
  rule: string;
  endpoints: Endpoint[];
}

/** Hides several targets at once; targets that are already fully hidden add no rules. */
export function hideMany(text: string | undefined, targets: HideTarget[]): string {
  let out = text ?? "";
  for (const t of targets) {
    const hidden = hiddenSet(out, t.endpoints);
    if (t.endpoints.every((e) => hidden.has(e.id))) continue;
    out = addHideRule(out, t.rule);
  }
  return out;
}

/** Unhides several targets at once (each folder may collapse into one "!" rule). */
export function unhideMany(text: string | undefined, targets: HideTarget[]): string {
  let out = text ?? "";
  for (const t of targets) {
    const hidden = hiddenSet(out, t.endpoints);
    const inside = t.endpoints.filter((e) => hidden.has(e.id));
    if (inside.length) out = unhide(out, inside, t.endpoints.length > 1 ? t.rule : undefined);
  }
  return out;
}
