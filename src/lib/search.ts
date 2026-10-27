import type { Endpoint } from "./openapi";
import { METHODS } from "./openapi";

export interface Match {
  score: number;
  pathHits: number[]; // indices in endpoint.path to highlight
}

/** Matches queries like "post pets", "/users/{id}", "getUser" or "del ord".
 *  A leading method token filters by HTTP method; remaining tokens fuzzy-match path/summary/operationId. */
export function matchEndpoint(e: Endpoint, query: string): Match | null {
  const q = query.trim().toLowerCase();
  if (!q) return { score: 0, pathHits: [] };
  let tokens = q.split(/\s+/);
  let score = 0;
  const m = tokens[0];
  const methods = METHODS as readonly string[];
  const isMethodToken = methods.includes(m) || (tokens.length > 1 && m.length >= 2 && methods.some((x) => x.startsWith(m)));
  if (isMethodToken) {
    if (!e.method.toLowerCase().startsWith(m)) return null;
    tokens = tokens.slice(1);
    score += 5;
  }
  const path = e.path.toLowerCase();
  const hay = [path, (e.summary ?? "").toLowerCase(), (e.operationId ?? "").toLowerCase(), e.tags.join(" ").toLowerCase()];
  const pathHits: number[] = [];
  for (const t of tokens) {
    const idx = path.indexOf(t);
    if (idx >= 0) {
      score += 20 + (idx === 0 || path[idx - 1] === "/" ? 10 : 0) - Math.min(idx, 10) * 0.2;
      for (let i = 0; i < t.length; i++) pathHits.push(idx + i);
      continue;
    }
    if (hay.slice(1).some((h) => h.includes(t))) {
      score += 12;
      continue;
    }
    const fz = fuzzy(path, t);
    if (fz) {
      score += fz.score;
      pathHits.push(...fz.hits);
      continue;
    }
    const fzOp = fuzzy(hay[2], t);
    if (fzOp) {
      score += fzOp.score * 0.6;
      continue;
    }
    return null;
  }
  score -= path.length * 0.02;
  if (e.deprecated) score -= 3;
  return { score, pathHits };
}

function fuzzy(text: string, pat: string): { score: number; hits: number[] } | null {
  const hits: number[] = [];
  let ti = 0;
  let score = 0;
  let prev = -2;
  for (const ch of pat) {
    const i = text.indexOf(ch, ti);
    if (i < 0) return null;
    hits.push(i);
    score += i === prev + 1 ? 3 : 1;
    if (i === 0 || "/-_{.".includes(text[i - 1])) score += 2;
    prev = i;
    ti = i + 1;
  }
  return { score, hits };
}
