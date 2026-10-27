import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/request-schemas.json";
import { applyHidden, autoOpenChildren, buildTree, folderPathTo, GroupMode, subtreeKeys, TreeNode } from "./tree";
import type { Endpoint, ParsedSpec } from "./openapi";

function ep(id: string, tags: string[] = []): Endpoint {
  const [method, path] = id.split(" ");
  return { id, method, path, tags, deprecated: false };
}

function spec(endpoints: Endpoint[]): ParsedSpec {
  const tags = [...new Set(endpoints.flatMap((e) => e.tags))].map((name) => ({ name }));
  return { doc: {}, openapi: "3.0.3", title: "t", version: "1", endpoints, tags, servers: [], securitySchemes: {} };
}

/** Compact outline: folders as "label/", items as "METHOD label". */
function outline(n: TreeNode, indent = ""): string[] {
  const out: string[] = [];
  for (const f of n.folders) {
    out.push(`${indent}${f.label}${f.prefix ? ` (${f.prefix})` : ""}/ [${f.count}]`);
    out.push(...outline(f, indent + "  "));
  }
  for (const i of n.items) out.push(`${indent}${i.endpoint.method} ${i.label}`);
  return out;
}

const sample = [
  "GET /energy/get-usage",
  "GET /energy/load-tariff-info",
  "POST /energy/save-tariff-plan",
  "POST /energy/v2/meters/create-recurring-reading",
  "POST /energy/v2/meters/delete-recurring-reading",
  "GET /energy/v2/meters/preview",
  "GET /energy/v3/meters/preview",
  "GET /health",
  "GET /sensors/v2/get-overview",
  "GET /sensors/v2/get-overview/v10",
  "GET /sensors/v2/get-overview/v2",
  "GET /sensors/{id}",
  "DELETE /sensors/{id}",
].map((id) => ep(id, [id.includes("/sensors") ? "Sensors" : "Energy"]));

describe("path grouping", () => {
  it("groups by first segment, compresses chains, keeps singletons flat", () => {
    expect(outline(buildTree(spec(sample), "path"))).toEqual([
      "/energy/ [7]",
      "  /v2/meters/ [3]",
      "    POST /create-recurring-reading",
      "    POST /delete-recurring-reading",
      "    GET /preview",
      "  GET /get-usage",
      "  GET /load-tariff-info",
      "  POST /save-tariff-plan",
      "  GET /v3/meters/preview",
      "/sensors/ [5]",
      "  GET /v2/get-overview",
      "  GET /v2/get-overview/v2",
      "  GET /v2/get-overview/v10",
      "  GET /{id}",
      "  DELETE /{id}",
      "GET /health",
    ]);
  });

  it("combined mode groups by path inside tags, relative to their shared prefix", () => {
    expect(outline(buildTree(spec(sample), "combined"))).toEqual([
      "Energy/ [8]",
      "  /energy/ [7]",
      "    /v2/meters/ [3]",
      "      POST /create-recurring-reading",
      "      POST /delete-recurring-reading",
      "      GET /preview",
      "    GET /get-usage",
      "    GET /load-tariff-info",
      "    POST /save-tariff-plan",
      "    GET /v3/meters/preview",
      "  GET /health",
      "Sensors (/sensors)/ [5]",
      "  GET /v2/get-overview",
      "  GET /v2/get-overview/v2",
      "  GET /v2/get-overview/v10",
      "  GET /{id}",
      "  DELETE /{id}",
    ]);
  });

  it("stays flat for small specs", () => {
    expect(outline(buildTree(spec(sample.slice(0, 3)), "path"))).toEqual([
      "GET /energy/get-usage",
      "GET /energy/load-tariff-info",
      "POST /energy/save-tariff-plan",
    ]);
  });
});

describe("tree invariants on a larger spec", () => {
  const endpoints = Object.keys((fixture as Record<string, unknown>)["x-request-bodies"] as object).map((id) => ep(id, ["All"]));
  const modes: GroupMode[] = ["path", "combined", "tag", "none"];

  for (const mode of modes) {
    it(`${mode}: lists every endpoint once with a label that rebuilds its path`, () => {
      const seen: string[] = [];
      const problems: string[] = [];
      const walk = (n: TreeNode, base: string) => {
        const here = n.kind === "path" ? base + n.label : n.prefix ?? base;
        if (n.kind === "path" && n.count < 2) problems.push(`tiny folder ${here}`);
        if (n.kind === "path" && n.items.length === 0 && n.folders.length === 1) problems.push(`chain ${here}`);
        for (const i of n.items) {
          seen.push(i.endpoint.id);
          const full = mode === "tag" || mode === "none" ? i.label : i.label === "/" ? here : here + i.label;
          if (full !== i.endpoint.path) problems.push(`${i.endpoint.id} shown as ${full}`);
        }
        for (const f of n.folders) walk(f, n.kind === "path" ? here : n.prefix ?? "");
      };
      walk(buildTree(spec(endpoints), mode), "");
      expect(problems).toEqual([]);
      expect(seen.sort()).toEqual(endpoints.map((e) => e.id).sort());
    });
  }
});

describe("auto-expansion", () => {
  const folder = (key: string, rows: number, sub: TreeNode[] = []): TreeNode => ({
    key,
    label: key,
    kind: "path",
    folders: sub,
    items: Array.from({ length: rows }, (_, i) => ({ endpoint: ep(`GET /${key}/${i}`), label: `/${i}` })),
    count: rows + sub.reduce((n, f) => n + f.count, 0),
  });

  it("counts the folder's own rows in the budget and opens smallest-first", () => {
    // 3 own rows + a(3) + b(4) = 10 ≤ 12; c(6) no longer fits.
    const parent = folder("p", 0, [folder("a", 3), folder("big", 20), folder("b", 4)]);
    expect([...autoOpenChildren(parent, { explicit: true, big: false })].sort()).toEqual(["a", "b"]);
    // 2 own items + 4 folders = 6 rows; a(3) fits, b(4) doesn't.
    const crowded = folder("p", 2, [folder("a", 3), folder("big", 20), folder("b", 4), folder("c", 6)]);
    expect([...autoOpenChildren(crowded, { explicit: true, big: false })]).toEqual(["a"]);
  });
  it("opens same-size folders together or not at all", () => {
    // A wide folder: 11 own rows, six 2-row folders → none fit together.
    const kids = ["alarms", "activate", "change", "members", "limits", "v2"].map((k) => folder(k, 2));
    const bt = folder("bt", 4, [...kids, folder("onboarding", 7)]);
    expect(autoOpenChildren(bt, { explicit: true, big: false }).size).toBe(0);
    // Room for exactly two of three equal folders: open none of them.
    // 4 items + 3 folders = 7 own rows; 5 left, the three 2-row folders need 6.
    const tie = folder("t", 4, [folder("x", 2), folder("y", 2), folder("z", 2)]);
    expect(autoOpenChildren(tie, { explicit: true, big: false }).size).toBe(0);
    // Room for all three.
    const roomy = folder("r", 0, [folder("x", 2), folder("y", 2), folder("z", 2)]);
    expect(autoOpenChildren(roomy, { explicit: true, big: false }).size).toBe(3);
  });
  it("opens nothing extra when the parent opened by itself", () => {
    const parent = folder("p", 2, [folder("a", 3), folder("b", 4)]);
    expect(autoOpenChildren(parent, { explicit: false, big: false }).size).toBe(0);
  });
  it("always opens a lone subfolder", () => {
    const parent = folder("p", 0, [folder("only", 40)]);
    expect([...autoOpenChildren(parent, { explicit: false, big: true })]).toEqual(["only"]);
  });
  it("opens top-level folders only in small collections", () => {
    const root: TreeNode = { key: "", label: "", kind: "root", folders: [folder("a", 3), folder("b", 3)], items: [], count: 6 };
    expect(autoOpenChildren(root, { explicit: false, big: false }).size).toBe(2);
    expect(autoOpenChildren(root, { explicit: false, big: true }).size).toBe(0);
  });
  it("finds the folders leading to an endpoint and a subtree's keys", () => {
    const tree = buildTree(spec(sample), "path");
    expect(folderPathTo(tree, "POST /energy/v2/meters/create-recurring-reading")).toEqual(["/energy", "/energy/v2/meters"]);
    expect(folderPathTo(tree, "GET /health")).toEqual([]);
    expect(subtreeKeys(tree.folders[0])).toEqual(["/energy", "/energy/v2/meters"]);
  });
});

describe("hidden endpoints in the tree", () => {
  const tree = buildTree(spec(sample), "path");
  const hide = new Set(["POST /energy/v2/meters/create-recurring-reading", "POST /energy/v2/meters/delete-recurring-reading", "GET /energy/v2/meters/preview", "GET /energy/get-usage", "GET /health"]);

  it("removes hidden endpoints and counts them where they were", () => {
    const t = applyHidden(tree, hide, false);
    expect(outline(t)).toEqual([
      "/energy/ [3]",
      "  GET /load-tariff-info",
      "  POST /save-tariff-plan",
      "  GET /v3/meters/preview",
      "/sensors/ [5]",
      "  GET /v2/get-overview",
      "  GET /v2/get-overview/v2",
      "  GET /v2/get-overview/v10",
      "  GET /{id}",
      "  DELETE /{id}",
    ]);
    expect(t.folders[0].hiddenHere).toBe(4); // get-usage + the whole /v2/meters folder
    expect(t.hiddenHere).toBe(1); // /health
  });
  it("keeps the shape and flags hidden rows when shown", () => {
    const t = applyHidden(tree, hide, true);
    expect(outline(t)).toEqual(outline(tree));
    expect(t.folders[0].folders[0].allHidden).toBe(true);
    expect(t.folders[0].hiddenHere).toBe(4); // the toggle row stays where it was
    expect(t.folders[0].folders[0].hiddenHere).toBe(0); // counted by its parent only
    expect(t.items.find((i) => i.endpoint.path === "/health")?.hidden).toBe(true);
    expect(t.folders[0].folders[0].path).toBe("/energy/v2/meters");
  });
});
