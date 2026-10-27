// Regression suite over every union reachable from the request bodies in __fixtures__/request-schemas.json,
// a synthetic spec with the union shapes real ones produce (aeson tag/contents, single-value enum tags,
// boolean switches, variants told apart by required keys): each variant must be selectable,
// stay selected, and survive the user clearing a field.
import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/request-schemas.json";
import { defaultValue, itemSchema, matchVariant, normalize, NSchema, switchVariant, validate, variantsOf } from "./schema";
import { isPlainObject } from "./json";

const doc = fixture as unknown as Record<string, unknown>;
const bodies = Object.entries((fixture as Record<string, unknown>)["x-request-bodies"] as Record<string, unknown>);

function collectUnions(): NSchema[] {
  const seen = new Set<object>();
  const unions: NSchema[] = [];
  const visit = (schema: unknown, depth: number) => {
    if (!schema || typeof schema !== "object" || depth > 30) return;
    const s = normalize(doc, schema);
    if (seen.has(s)) return;
    seen.add(s);
    const u = variantsOf(doc, s);
    if (u) {
      unions.push(s);
      for (const v of u.list) visit(v.schema, depth + 1);
    }
    for (const p of Object.values<unknown>(s.properties ?? {})) visit(p, depth + 1);
    if (s.items || s.prefixItems) for (let i = 0; i < 3; i++) visit(itemSchema(s, i), depth + 1);
    if (typeof s.additionalProperties === "object") visit(s.additionalProperties, depth + 1);
  };
  for (const [, schema] of bodies) visit(schema, 0);
  return unions;
}

const unions = collectUnions();
const name = (s: NSchema) => s._refName ?? variantsOf(doc, s)!.list.map((v) => v.label).join("|");

describe("unions in the wild", () => {
  it("finds the unions in the fixture", () => {
    expect(unions.length).toBeGreaterThan(20);
  });

  it("gives every variant a distinct label", () => {
    const bad = unions.filter((s) => {
      const labels = variantsOf(doc, s)!.list.map((v) => v.label);
      return new Set(labels).size !== labels.length || labels.some((l) => /^object( #\d+)?$/.test(l));
    });
    expect(bad.map(name)).toEqual([]);
  });

  it("selects each variant and keeps it selected", () => {
    const failures: string[] = [];
    for (const s of unions) {
      const { list } = variantsOf(doc, s)!;
      const start = defaultValue(doc, s);
      list.forEach((v, i) => {
        const value = switchVariant(doc, s, list, start, i);
        // With the user's choice remembered, the picker must never jump.
        if (matchVariant(doc, s, list, value, i) !== i) failures.push(`${name(s)} → ${v.label} (with choice)`);
        // Variants identified by tags must also be recognised from the value alone (Raw edits, reloads).
        if (Object.keys(v.tags).length && matchVariant(doc, s, list, value) !== i) failures.push(`${name(s)} → ${v.label}`);
      });
    }
    expect(failures).toEqual([]);
  });

  it("keeps the variant when a required field is cleared", () => {
    const failures: string[] = [];
    for (const s of unions) {
      const { list } = variantsOf(doc, s)!;
      list.forEach((v, i) => {
        if (!Object.keys(v.tags).length) return;
        const value = switchVariant(doc, s, list, undefined, i);
        if (!isPlainObject(value)) return;
        for (const k of Object.keys(value)) {
          if (k in v.tags) continue;
          const cleared = { ...value };
          delete cleared[k];
          if (matchVariant(doc, s, list, cleared) !== i) failures.push(`${name(s)} → ${v.label} without ${k}`);
        }
      });
    }
    expect(failures).toEqual([]);
  });

  it("generates default bodies with the right shape", () => {
    const failures: string[] = [];
    for (const [id, schema] of bodies) {
      const errs = validate(doc, schema, defaultValue(doc, schema)).filter(
        (e) => e.message === "Required" || e.message.startsWith("Expected") || e.message.startsWith("Must be one of"),
      );
      if (errs.length) failures.push(`${id}: ${errs.map((e) => `${e.path} ${e.message}`).join("; ")}`);
    }
    expect(failures).toEqual([]);
  });
});
