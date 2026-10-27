// Builds the sidebar's endpoint tree for the different grouping modes.
import type { Endpoint, ParsedSpec } from "./openapi";

export type GroupMode = "tag" | "path" | "combined" | "none";

export interface TreeItem {
  endpoint: Endpoint;
  /** Path shown in the row, relative to the enclosing path folder ("/" for the folder's own path). */
  label: string;
  /** Hidden by the collection's hide rules (only present while hidden endpoints are shown). */
  hidden?: boolean;
}

export interface TreeNode {
  key: string; // stable within a collection + mode, used for collapse state
  label: string;
  kind: "tag" | "path" | "root";
  /** Path prefix shared by everything inside (shown muted on tag folders in combined mode). */
  prefix?: string;
  /** Full path of a path folder, e.g. "/energy/v2/meters". */
  path?: string;
  folders: TreeNode[];
  items: TreeItem[];
  count: number;
  /** Hidden endpoints directly here or in subfolders that are hidden entirely ("N hidden" row,
   *  kept in the same place while they're shown so it can hide them again). */
  hiddenHere?: number;
  /** Every endpoint inside is hidden (only present while hidden endpoints are shown). */
  allHidden?: boolean;
}

/** Folders only form inside a group with more endpoints than this. */
export const GROUP_THRESHOLD = 5;

const METHOD_ORDER = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE"];
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Segment-wise path order: shorter prefix first, literal segments before {params}, natural numbers (v2 < v10). */
function comparePaths(a: string, b: string): number {
  const as = a.split("/").filter(Boolean);
  const bs = b.split("/").filter(Boolean);
  for (let i = 0; i < Math.min(as.length, bs.length); i++) {
    const pa = as[i].startsWith("{");
    const pb = bs[i].startsWith("{");
    if (pa !== pb) return pa ? 1 : -1;
    const c = collator.compare(as[i], bs[i]);
    if (c) return c;
  }
  return as.length - bs.length;
}

function compareEndpoints(a: Endpoint, b: Endpoint): number {
  return comparePaths(a.path, b.path) || METHOD_ORDER.indexOf(a.method) - METHOD_ORDER.indexOf(b.method);
}

interface Entry {
  e: Endpoint;
  segs: string[];
}

function relLabel(entry: Entry, depth: number): string {
  return depth >= entry.segs.length ? "/" : "/" + entry.segs.slice(depth).join("/");
}

function count(n: TreeNode): number {
  return n.items.length + n.folders.reduce((s, f) => s + f.count, 0);
}

/**
 * Groups entries (which all share their first `depth` segments) by the next segment.
 * - Groups of up to GROUP_THRESHOLD endpoints stay flat.
 * - A segment with a single endpoint stays a plain row; two or more become a folder.
 * - Folder names absorb single-child chains ("/v2/meters" rather than "/v2" › "/meters").
 */
function groupByPath(entries: Entry[], depth: number, keyPrefix: string, force: boolean): Pick<TreeNode, "folders" | "items"> {
  const sorted = entries.slice().sort((a, b) => compareEndpoints(a.e, b.e));
  if (!force && sorted.length <= GROUP_THRESHOLD) return { folders: [], items: sorted.map((x) => ({ endpoint: x.e, label: relLabel(x, depth) })) };

  const here: Entry[] = [];
  const buckets = new Map<string, Entry[]>();
  for (const x of sorted) {
    if (x.segs.length <= depth) here.push(x);
    else {
      const seg = x.segs[depth];
      const list = buckets.get(seg);
      if (list) list.push(x);
      else buckets.set(seg, [x]);
    }
  }
  // Nothing would be shared: keep the list flat rather than making one-item folders.
  if (!force && [...buckets.values()].every((b) => b.length === 1)) {
    return { folders: [], items: sorted.map((x) => ({ endpoint: x.e, label: relLabel(x, depth) })) };
  }

  const items: TreeItem[] = here.map((x) => ({ endpoint: x.e, label: "/" }));
  const folders: TreeNode[] = [];
  for (const [, list] of buckets) {
    if (list.length === 1) {
      items.push({ endpoint: list[0].e, label: relLabel(list[0], depth) });
      continue;
    }
    // Extend the folder over segments every member shares (and none ends at).
    let end = depth + 1;
    while (list.every((x) => x.segs.length > end && x.segs[end] === list[0].segs[end])) end++;
    const name = "/" + list[0].segs.slice(depth, end).join("/");
    const key = `${keyPrefix}${name}`;
    const inner = groupByPath(list, end, key, false);
    const node: TreeNode = { key, label: name, kind: "path", path: "/" + list[0].segs.slice(0, end).join("/"), ...inner, count: 0 };
    node.count = count(node);
    folders.push(node);
  }
  folders.sort((a, b) => comparePaths(a.label, b.label));
  items.sort((a, b) => compareEndpoints(a.endpoint, b.endpoint));
  return { folders, items };
}

function entriesOf(endpoints: Endpoint[]): Entry[] {
  return endpoints.map((e) => ({ e, segs: e.path.split("/").filter(Boolean) }));
}

/** Longest whole-segment path prefix shared by all entries (never the full path of any entry). */
function commonDepth(entries: Entry[]): number {
  if (entries.length < 2) return 0;
  let d = 0;
  while (entries.every((x) => x.segs.length > d + 1 && x.segs[d] === entries[0].segs[d])) d++;
  return d;
}

/** Builds the tree from all endpoints (so hiding never reshapes it); see applyHidden. */
/** Key of the "Other" folder of untagged endpoints; can't collide with a tag folder ("#name"). */
export const UNTAGGED_FOLDER = "~untagged";

export function buildTree(spec: ParsedSpec, mode: GroupMode): TreeNode {
  const endpoints = spec.endpoints;
  const root: TreeNode = { key: "", label: "", kind: "root", folders: [], items: [], count: 0 };

  if (mode === "none") {
    root.items = endpoints.map((e) => ({ endpoint: e, label: e.path }));
  } else if (mode === "path") {
    Object.assign(root, groupByPath(entriesOf(endpoints), 0, "", endpoints.length > GROUP_THRESHOLD));
  } else {
    // Tag folders, in spec order; untagged endpoints go to "Other".
    const byTag = new Map<string, Endpoint[]>(spec.tags.map((t) => [t.name, []]));
    const untagged: Endpoint[] = [];
    for (const e of endpoints) {
      if (!e.tags.length) untagged.push(e);
      for (const t of e.tags) byTag.get(t)?.push(e);
    }
    const groups = [...byTag.entries()].filter(([, v]) => v.length);
    if (untagged.length) groups.push(["Other", untagged]);
    if (groups.length === 1 && groups[0][1] === untagged) {
      // No tags at all: fall back to the plain list (or path grouping in combined mode).
      if (mode === "combined") Object.assign(root, groupByPath(entriesOf(untagged), 0, "", untagged.length > GROUP_THRESHOLD));
      else root.items = untagged.map((e) => ({ endpoint: e, label: e.path }));
    } else {
      root.folders = groups.map(([name, list]) => {
        const key = list === untagged ? UNTAGGED_FOLDER : `#${name}`;
        if (mode === "tag") {
          return { key, label: name, kind: "tag", folders: [], items: list.map((e) => ({ endpoint: e, label: e.path })), count: list.length };
        }
        // Combined: path grouping inside the tag, relative to the prefix the tag's paths share.
        const entries = entriesOf(list);
        const depth = commonDepth(entries);
        const prefix = depth ? "/" + entries[0].segs.slice(0, depth).join("/") : undefined;
        const inner = groupByPath(entries, depth, key, false);
        return { key, label: name, kind: "tag", prefix, ...inner, count: list.length } as TreeNode;
      });
    }
  }
  root.count = count(root);
  return root;
}

// ---------------------------------------------------------------------------------------------
// Auto-expansion

/** Visible rows a folder the user opens may show in total, its own rows included. */
export const AUTO_EXPAND_ROWS = 12;

/** Rows a folder shows when opened (its direct children). */
export function directRows(n: TreeNode): number {
  return n.folders.length + n.items.length;
}

/**
 * Which child folders of `node` open by themselves (without a remembered user choice).
 * - Root: everything in small collections, nothing in big ones.
 * - A lone subfolder with no endpoints beside it always opens (there's nothing else to show).
 * - When the user explicitly opened `node`, children open smallest-first while the total of
 *   `node`'s own rows plus the opened children's rows stays within AUTO_EXPAND_ROWS. Children
 *   of the same size open together or not at all, so the choice never looks arbitrary.
 */
export function autoOpenChildren(node: TreeNode, opts: { explicit: boolean; big: boolean }): Set<string> {
  const out = new Set<string>();
  if (node.kind === "root") {
    if (!opts.big) for (const f of node.folders) out.add(f.key);
    return out;
  }
  if (node.folders.length === 1 && node.items.length === 0) {
    out.add(node.folders[0].key);
    return out;
  }
  if (!opts.explicit) return out;
  let budget = AUTO_EXPAND_ROWS - directRows(node);
  const bySize = new Map<number, TreeNode[]>();
  for (const f of node.folders) bySize.set(directRows(f), [...(bySize.get(directRows(f)) ?? []), f]);
  for (const size of [...bySize.keys()].sort((a, b) => a - b)) {
    const group = bySize.get(size)!;
    if (size * group.length > budget) break;
    budget -= size * group.length;
    for (const f of group) out.add(f.key);
  }
  return out;
}

/** Keys of the folders leading to an endpoint, outermost first; null if it isn't in the tree. */
export function folderPathTo(root: TreeNode, endpointId: string): string[] | null {
  const walk = (n: TreeNode, trail: string[]): string[] | null => {
    if (n.items.some((i) => i.endpoint.id === endpointId)) return trail;
    for (const f of n.folders) {
      const r = walk(f, [...trail, f.key]);
      if (r) return r;
    }
    return null;
  };
  return walk(root, []);
}

/** Keys of a folder and every folder below it. */
export function subtreeKeys(n: TreeNode): string[] {
  return [n.key, ...n.folders.flatMap(subtreeKeys)];
}

// ---------------------------------------------------------------------------------------------
// Hidden endpoints

/**
 * Applies hide rules to a built tree.
 * - show = false: hidden endpoints and fully hidden folders are removed; each folder records
 *   how many were removed directly under it (`hiddenHere`) and `count` becomes the visible count.
 * - show = true: everything stays, hidden items are flagged and fully hidden folders marked.
 */
export function applyHidden(node: TreeNode, hidden: Set<string>, show: boolean): TreeNode {
  if (!hidden.size) return node;
  return walkHidden(node, hidden, show).node;
}

function walkHidden(n: TreeNode, hidden: Set<string>, show: boolean): { node: TreeNode; visible: number; hiddenTotal: number } {
  let visible = 0;
  let hiddenTotal = 0;
  let hiddenHere = 0;
  const items: TreeItem[] = [];
  for (const it of n.items) {
    if (hidden.has(it.endpoint.id)) {
      hiddenTotal++;
      hiddenHere++;
      if (show) items.push({ ...it, hidden: true });
    } else {
      visible++;
      items.push(it);
    }
  }
  const folders: TreeNode[] = [];
  for (const f of n.folders) {
    const r = walkHidden(f, hidden, show);
    visible += r.visible;
    hiddenTotal += r.hiddenTotal;
    if (r.visible === 0) {
      hiddenHere += r.hiddenTotal;
      // The parent's row already counts this folder, so no rows of its own inside it.
      if (show) folders.push({ ...withoutHiddenRows(r.node), allHidden: true });
    } else folders.push(r.node);
  }
  const node: TreeNode = { ...n, items, folders, count: show ? visible + hiddenTotal : visible, hiddenHere };
  return { node, visible, hiddenTotal };
}

function withoutHiddenRows(n: TreeNode): TreeNode {
  return { ...n, hiddenHere: 0, folders: n.folders.map(withoutHiddenRows) };
}
