import { describe, expect, it } from "vitest";
import { addHideRule, hiddenSet, hideMany, parseRules, unhide, unhideMany } from "./hide";
import type { Endpoint } from "./openapi";

const ep = (id: string, extra: Partial<Endpoint> = {}): Endpoint => {
  const [method, path] = id.split(" ");
  return { id, method, path, tags: [], deprecated: false, ...extra };
};
const all = [
  ep("GET /admin"),
  ep("GET /admin/health"),
  ep("DELETE /admin/users/{id}"),
  ep("GET /administrators"),
  ep("GET /subscriptions/v2/get-overview"),
  ep("GET /subscriptions/v2/get-overview/v3"),
  ep("GET /subscriptions/v2/list/v3"),
  ep("GET /legacy/export"),
  ep("GET /legacy/a/b/export"),
  ep("POST /old", { deprecated: true }),
  ep("GET /internal-thing", { tags: ["Internal"] }),
];
const hidden = (rules: string) => [...hiddenSet(rules, all)].sort();

describe("hide rules", () => {
  it("treats a path as a folder and matches nothing outside it", () => {
    expect(hidden("/admin")).toEqual(["DELETE /admin/users/{id}", "GET /admin", "GET /admin/health"]);
  });
  it("supports *, ** and unanchored segment patterns", () => {
    expect(hidden("/subscriptions/v2/*/v3")).toEqual(["GET /subscriptions/v2/get-overview/v3", "GET /subscriptions/v2/list/v3"]);
    expect(hidden("/legacy/**/export")).toEqual(["GET /legacy/a/b/export", "GET /legacy/export"]);
    expect(hidden("get-overview")).toEqual(["GET /subscriptions/v2/get-overview", "GET /subscriptions/v2/get-overview/v3"]);
  });
  it("filters by method, deprecated flag and tag", () => {
    expect(hidden("DELETE /admin/**")).toEqual(["DELETE /admin/users/{id}"]);
    // A rule with a method is one endpoint: hiding GET /admin leaves GET /admin/health alone.
    expect(hidden("GET /admin")).toEqual(["GET /admin"]);
    expect(hidden("GET /subscriptions/v2/get-overview")).toEqual(["GET /subscriptions/v2/get-overview"]);
    expect(hidden("get,post /old\n@tag:Internal")).toEqual(["GET /internal-thing", "POST /old"]);
    expect(hidden("@deprecated")).toEqual(["POST /old"]);
  });
  it("lets the last matching rule win, so ! re-includes", () => {
    expect(hidden("/admin\n!GET /admin/health")).toEqual(["DELETE /admin/users/{id}", "GET /admin"]);
    expect(hidden("!GET /admin/health\n/admin")).toEqual(["DELETE /admin/users/{id}", "GET /admin", "GET /admin/health"]);
  });
  it("ignores comments and reports unknown directives", () => {
    expect(hidden("# /admin\n")).toEqual([]);
    expect(parseRules("@nope").errors[0].message).toMatch(/Unknown rule/);
  });
  it("adds and removes rules from the text", () => {
    let t = addHideRule("# mine\n/admin", "GET /old");
    expect(t).toBe("# mine\n/admin\nGET /old");
    // Unhiding an endpoint named by its own rule just drops that rule…
    t = unhide(t, [ep("GET /old")]);
    expect(t).toBe("# mine\n/admin");
    // …while one hidden by a broader rule gets an exception.
    t = unhide(t, [ep("GET /admin/health")]);
    expect(t).toBe("# mine\n/admin\n!GET /admin/health");
    expect(hidden(t)).toEqual(["DELETE /admin/users/{id}", "GET /admin"]);
    // Hiding it again removes the exception.
    expect(addHideRule(t, "GET /admin/health")).toBe("# mine\n/admin\nGET /admin/health");
  });
});

describe("bulk hide/unhide", () => {
  const e = (id: string, extra: Partial<Endpoint> = {}): Endpoint => {
    const [method, path] = id.split(" ");
    return { id, method, path, tags: [], deprecated: false, ...extra };
  };
  const admin = [e("GET /admin/users"), e("DELETE /admin/users/{id}")];
  const health = e("GET /health");
  const pets = e("GET /pets");

  it("hides folders and endpoints with one rule each, skipping what's already hidden", () => {
    const text = hideMany("GET /health", [
      { rule: "/admin", endpoints: admin },
      { rule: "GET /health", endpoints: [health] },
      { rule: "GET /pets", endpoints: [pets] },
    ]);
    expect(text).toBe("GET /health\n/admin\nGET /pets");
  });
  it("unhides back to an empty rule set and negates what broader rules still hide", () => {
    expect(unhideMany("/admin\nGET /pets", [{ rule: "/admin", endpoints: admin }, { rule: "GET /pets", endpoints: [pets] }])).toBe("");
    const t = unhideMany("@deprecated\n/admin", [{ rule: "/admin", endpoints: admin }, { rule: "GET /x", endpoints: [e("GET /x", { deprecated: true })] }]);
    expect(hiddenSet(t, [...admin, e("GET /x", { deprecated: true }), e("GET /y", { deprecated: true })])).toEqual(new Set(["GET /y"]));
  });
});

describe("untagged rule", () => {
  it("hides endpoints without tags only", () => {
    const h = [...hiddenSet("@untagged", all)];
    expect(h).not.toContain("GET /internal-thing");
    expect(h).toContain("GET /admin");
    expect(parseRules("@untagged").errors).toEqual([]);
  });
});
