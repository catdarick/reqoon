import { describe, expect, it } from "vitest";
import { BUNDLE_KEY, bundleRefs, hasExternalRefs, resolveLocation } from "./bundle";
import { buildSpec, getOperation, parseSpecText } from "./openapi";
import { deref, normalize } from "./schema";

const files: Record<string, string> = {
  "https://x.test/api/openapi.yaml": `
openapi: 3.1.0
info: { title: Split, version: "1" }
paths:
  /pets:
    $ref: paths/pets.yaml#/collection
  /ping:
    $ref: paths/ping.yaml
components:
  securitySchemes:
    $ref: components/security.yaml
`,
  "https://x.test/api/paths/pets.yaml": `
collection:
  get:
    parameters:
      - $ref: '../components/params.yaml#/Limit'
    responses:
      '200':
        description: ok
        content:
          application/json:
            schema:
              $ref: '../schemas/pet.yaml'
`,
  "https://x.test/api/paths/ping.yaml": `
get:
  responses:
    '200': { description: pong }
`,
  "https://x.test/api/components/params.yaml": `
Limit: { name: limit, in: query, schema: { type: integer } }
`,
  "https://x.test/api/components/security.yaml": `
Bearer: { type: http, scheme: bearer }
`,
  "https://x.test/api/schemas/pet.yaml": `
type: object
properties:
  name: { type: string }
  parent: { $ref: '#' }
  owner: { $ref: './owner.yaml#/Owner' }
`,
  "https://x.test/api/schemas/owner.yaml": `
Owner:
  type: object
  properties:
    pets: { type: array, items: { $ref: '../schemas/pet.yaml' } }
    content: { $ref: '#/Owner' }
`,
};

const load = async (loc: string) => {
  if (!(loc in files)) throw new Error("404");
  return files[loc];
};

describe("bundleRefs", () => {
  it("turns a spec split across files into one document", async () => {
    const main = "https://x.test/api/openapi.yaml";
    const doc = await bundleRefs(parseSpecText(files[main]), main, load);
    expect(hasExternalRefs(doc)).toBe(false);
    // The result is stored as JSON, so it must survive a round trip.
    const spec = buildSpec(JSON.parse(JSON.stringify(doc)));
    expect(spec.endpoints.map((e) => e.id)).toEqual(["GET /pets", "GET /ping"]);
    expect(spec.securitySchemes.Bearer).toEqual({ type: "http", scheme: "bearer" });

    const op = getOperation(spec, "GET /pets")!;
    expect(op.params.map((p) => p.name)).toEqual(["limit"]);
    const schema = op.responses[0].contents[0].schema;
    expect(normalize(spec.doc, schema)._refName).toBe("pet");
    // Recursive schemas point into the bundle instead of repeating forever.
    const pet = deref(spec.doc, schema);
    expect(pet.properties.parent.$ref).toBe(`#/${BUNDLE_KEY}/pet`);
    const owner = deref(spec.doc, pet.properties.owner);
    expect(owner.properties.pets.items.$ref).toBe(`#/${BUNDLE_KEY}/pet`);
    expect(owner.properties.content.$ref).toBe(`#/${BUNDLE_KEY}/Owner`);
  });

  it("leaves specs without references to other files alone", async () => {
    const doc = { openapi: "3.1.0", paths: { "/a": { $ref: "#/x" } } };
    expect(await bundleRefs(doc, "https://x.test/a.yaml", load)).toBe(doc);
  });

  it("keeps entries the document already has under the bundle key", async () => {
    const own = { type: "string" };
    const doc = { openapi: "3.1.0", paths: { "/a": { $ref: "paths/ping.yaml" } }, [BUNDLE_KEY]: { ping: own } };
    const out = await bundleRefs(doc, "https://x.test/api/openapi.yaml", load);
    expect(out[BUNDLE_KEY].ping).toEqual(own);
    expect(out.paths["/a"].$ref).toBe(`#/${BUNDLE_KEY}/ping2`);
    expect(out[BUNDLE_KEY].ping2.get).toBeDefined();
  });

  it("names the file that could not be loaded", async () => {
    const doc = { openapi: "3.1.0", paths: { "/a": { $ref: "missing.yaml" } } };
    await expect(bundleRefs(doc, "https://x.test/api/openapi.yaml", load)).rejects.toThrow("https://x.test/api/missing.yaml");
  });
});

describe("resolveLocation", () => {
  it("resolves URLs and file paths", () => {
    expect(resolveLocation("https://x.test/a/b.yaml", "../c.yaml#/X")).toBe("https://x.test/c.yaml");
    expect(resolveLocation("/specs/api/openapi.yaml", "paths/my pets.yaml")).toBe("/specs/api/paths/my pets.yaml");
    expect(resolveLocation("C:\\specs\\openapi.yaml", "../shared/x.yaml")).toBe("C:\\shared\\x.yaml");
  });
});
