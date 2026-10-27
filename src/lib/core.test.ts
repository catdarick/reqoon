import { describe, expect, it } from "vitest";
import { buildSpec, getOperation, parseSpecText } from "./openapi";
import { defaultValue, describeType, hasNullAlternative, matchVariant, normalize, switchVariant, validate, variantsOf } from "./schema";
import { isBig, parseJson, stringifyJson } from "./json";
import { cursorContext, locatePointers } from "./jsontext";
import { diffSpecs } from "./diff";
import { buildRequest } from "./request";
import { interpolate, interpolateJsonText } from "./vars";
import { matchEndpoint } from "./search";
import { SAMPLE_SPEC } from "../sample";
import type { Collection, RequestState } from "./models";

const spec = buildSpec(parseSpecText(SAMPLE_SPEC));
const doc = spec.doc;

function state(p: Partial<RequestState> = {}): RequestState {
  return { params: {}, paramEnabled: {}, extraQuery: [], extraHeaders: [], bodyText: "", bodyMode: "form", updatedAt: 0, ...p };
}

describe("openapi", () => {
  it("parses endpoints, tags and servers", () => {
    expect(spec.endpoints.length).toBe(12);
    expect(spec.tags.map((t) => t.name)).toEqual(["pet", "store", "user"]);
    expect(spec.servers[0].url).toBe("https://petstore3.swagger.io/api/v3");
  });
  it("rejects swagger 2", () => {
    expect(() => buildSpec({ swagger: "2.0" })).toThrow(/Swagger 2.0/);
  });
  it("merges path params and resolves bodies", () => {
    const op = getOperation(spec, "POST /pet/{petId}/adoption")!;
    expect(op.params.map((p) => p.name)).toEqual(["petId"]);
    expect(op.body?.required).toBe(true);
  });
});

describe("schema", () => {
  const pet = { $ref: "#/components/schemas/Pet" };
  it("generates defaults with required fields only and skips readOnly", () => {
    expect(defaultValue(doc, pet)).toEqual({ name: "doggie", photoUrls: [""] });
  });
  it("validates nested values with paths", () => {
    const errs = validate(doc, pet, { name: 5, photoUrls: [], status: "lost", tags: [{ id: "x" }] });
    expect(errs.map((e) => e.path).sort()).toEqual(["/name", "/photoUrls", "/status", "/tags/0/id"].sort());
    expect(validate(doc, pet, { name: "a" }).some((e) => e.path === "/photoUrls" && e.message === "Required")).toBe(true);
  });
  it("skips checks for {{variables}}", () => {
    expect(validate(doc, { type: "integer" }, "{{id}}")).toEqual([]);
  });
  it("merges allOf and handles oneOf with discriminator", () => {
    const adoption = normalize(doc, { $ref: "#/components/schemas/AdoptionRequest" });
    const adopter = normalize(doc, adoption.properties!.adopter);
    const vs = variantsOf(doc, adopter)!;
    expect(vs.list.map((v) => v.label)).toEqual(["person", "organization"]);
    expect(matchVariant(doc, adopter, vs.list, { kind: "organization" })).toBe(1);
    const org = normalize(doc, { $ref: "#/components/schemas/Organization" });
    const contact = normalize(doc, org.properties!.contacts.items);
    expect(Object.keys(contact.properties!)).toEqual(expect.arrayContaining(["fullName", "role"]));
    expect(validate(doc, adoption, { adopter: { kind: "person" }, startDate: "2024-01-01" })[0]).toMatchObject({
      path: "/adopter/fullName",
    });
  });
  it("supports 3.1 type arrays", () => {
    const s = normalize({}, { type: ["string", "null"] });
    expect(s._types).toEqual(["string"]);
    expect(s._nullable).toBe(true);
    expect(validate({}, { type: ["string", "null"] }, null)).toEqual([]);
  });
});

describe("tagged unions (tag/contents oneOf)", () => {
  const int64 = { type: "integer", minimum: -9223372036854776000, maximum: 9223372036854776000 };
  const body = { type: "object", required: ["level"], properties: { level: int64 } };
  const variant = (tag: string) => ({
    title: tag,
    type: "object",
    required: ["tag", "contents"],
    properties: { tag: { type: "string", enum: [tag] }, contents: body },
  });
  const d = { components: { schemas: {} } };
  const union = normalize(d, { oneOf: ["Light", "Heater", "Fan"].map(variant) });
  const list = variantsOf(d, union)!.list;

  it("switches between structurally identical variants", () => {
    const light = defaultValue(d, union);
    expect(light).toEqual({ tag: "Light", contents: { level: 0 } });
    light.contents.level = 125;
    const heater = switchVariant(d, union, list, light, 1);
    expect(heater).toEqual({ tag: "Heater", contents: { level: 125 } });
    expect(matchVariant(d, union, list, heater)).toBe(1);
  });
  it("drops fields the new variant doesn't declare", () => {
    const withRoom = { ...body, properties: { ...body.properties, roomId: int64 } };
    const scene = { ...variant("Scene"), properties: { tag: { type: "string", enum: ["Scene"] }, contents: withRoom } };
    const u2 = normalize(d, { oneOf: [scene, variant("Fan")] });
    const l2 = variantsOf(d, u2)!.list;
    const v = { tag: "Scene", contents: { level: 9, roomId: 3 } };
    expect(switchVariant(d, u2, l2, v, 1)).toEqual({ tag: "Fan", contents: { level: 9 } });
  });
  it("defaults int64 fields to 0 rather than the minimum", () => {
    expect(defaultValue(d, int64)).toBe(0);
    expect(defaultValue(d, { type: "integer", minimum: 5 })).toBe(5);
  });
  it("handles tuple-style items", () => {
    const pair = { type: "array", minItems: 2, maxItems: 2, items: [int64, { type: "string" }] };
    expect(defaultValue(d, pair)).toEqual([0, ""]);
    expect(validate(d, pair, [1, 2])[0]).toMatchObject({ path: "/1" });
    expect(describeType(d, pair)).toBe("[integer, string]");
  });
});

describe("form review fixes", () => {
  const d = {};
  it("folds parent properties into variants so every option is selectable", () => {
    // `method` is required by the parent only.
    const acct = { type: "integer" };
    const s = normalize(d, {
      required: ["method"],
      oneOf: [
        { properties: { method: { enum: ["Manual"] } } },
        { properties: { method: { enum: ["QrCode"] }, accountId: acct }, required: ["accountId"] },
        { properties: { method: { enum: ["Bluetooth"] }, accountId: acct }, required: ["accountId"] },
      ],
    });
    const { list } = variantsOf(d, s)!;
    expect(list.map((v) => v.label)).toEqual(["Manual", "QrCode", "Bluetooth"]);
    expect(defaultValue(d, s)).toEqual({ method: "Manual" });
    const bt = switchVariant(d, s, list, { method: "QrCode", accountId: 5 }, 2);
    expect(bt).toEqual({ method: "Bluetooth", accountId: 5 });
    expect(matchVariant(d, s, list, bt)).toBe(2);
    expect(validate(d, s, {}).some((e) => e.path === "/method")).toBe(true);
  });
  it("keeps the user's choice for overlapping variants (enum vs free string)", () => {
    const s = normalize(d, { anyOf: [{ type: "string", enum: ["bulb", "plug"] }, { type: "string" }] });
    const { list } = variantsOf(d, s)!;
    expect(matchVariant(d, s, list, "bulb", 1)).toBe(1);
    expect(matchVariant(d, s, list, "")).toBe(1);
    expect(matchVariant(d, s, list, "bulb")).toBe(0);
  });
  it("treats every null-only alternative as nullable", () => {
    for (const alt of [{ type: "null" }, { type: ["null"] }, { enum: [null] }, { nullable: true }]) {
      const s = normalize(d, { oneOf: [{ type: "string" }, alt] });
      expect(variantsOf(d, s)!.list.length).toBe(1);
      expect(hasNullAlternative(d, s)).toBe(true);
    }
  });
  it("builds a non-null value when the default is null", () => {
    expect(defaultValue(d, { type: "string", nullable: true, default: null }, 0, { nonNull: true })).toBe("");
    expect(defaultValue(d, { enum: [null, "a"] }, 0, { nonNull: true })).toBe("a");
  });
  it("respects boolean exclusive bounds", () => {
    expect(defaultValue(d, { type: "integer", minimum: 0, exclusiveMinimum: true })).toBe(1);
  });
  it("merges a property declared by several allOf parts", () => {
    const s = normalize(d, {
      allOf: [
        { properties: { a: { type: "object", properties: { x: { type: "string" } } } } },
        { properties: { a: { required: ["x"] } } },
      ],
    });
    expect(validate(d, s, { a: {} })).toEqual([{ path: "/a/x", message: "Required" }]);
  });
  it("round-trips int64 values exactly", () => {
    const text = '{"id": 9007199254740993, "neg": -9223372036854775807, "small": 42, "s": "9007199254740993", "f": 1.5e300}';
    const v = parseJson(text) as Record<string, unknown>;
    expect(isBig(v.id)).toBe(true);
    expect(v.small).toBe(42);
    expect(v.s).toBe("9007199254740993");
    expect(stringifyJson(v)).toBe('{"id":9007199254740993,"neg":-9223372036854775807,"small":42,"s":"9007199254740993","f":1.5e+300}');
    expect(validate(d, { type: "integer", maximum: 9223372036854776000 }, v.neg)).toEqual([]);
    expect(validate(d, { type: "string" }, v.id)[0].message).toMatch(/Expected string, got integer/);
  });
});

describe("jsontext", () => {
  it("finds key context inside nested objects", () => {
    const t = '{"category": {"';
    expect(cursorContext(t, t.length)).toMatchObject({ kind: "key", path: ["category"], inString: true });
  });
  it("finds value context in arrays", () => {
    const t = '{"tags": [{"id": 1}, {"name": ';
    expect(cursorContext(t, t.length)).toMatchObject({ kind: "value", path: ["tags", 1, "name"] });
  });
  it("lists existing keys", () => {
    const t = '{"name": "x", ';
    expect(cursorContext(t, t.length)).toMatchObject({ kind: "key", path: [], existingKeys: ["name"] });
  });
  it("locates pointers", () => {
    const t = '{\n  "a": [1, {"b": true}]\n}';
    const loc = locatePointers(t)!;
    expect(t.slice(loc.get("/a/1/b")!.from, loc.get("/a/1/b")!.to)).toBe("true");
    expect(t.slice(loc.get("/a")!.keyFrom!, loc.get("/a")!.keyTo!)).toBe('"a"');
  });
});

describe("request building", () => {
  const collection: Collection = {
    id: "c", name: "x", version: "", source: { kind: "paste" }, hash: "", importedAt: 0, syncedAt: 0, baseUrl: "{{base}}", monitor: false,
  };
  it("substitutes vars, params, auth and keeps JSON types", () => {
    const op = getOperation(spec, "GET /pet/{petId}")!;
    const built = buildRequest({
      op, collection, doc, timeoutSec: 5, schemes: spec.securitySchemes,
      state: state({ params: { "path:petId": "{{id}}" } }),
      vars: { base: "https://x.test/v3", id: "42", key: "k1" },
      auth: { c: { api_key: { value: "{{key}}" } } },
    });
    expect(built.req.url).toBe("https://x.test/v3/pet/42");
    expect(built.req.headers).toContainEqual(["api_key", "k1"]);
    expect(built.missingVars).toEqual([]);
    expect(built.usedVars.sort()).toEqual(["base", "id", "key"]);
  });
  it("knows when a request uses no environment variables", () => {
    const op = getOperation(spec, "GET /pet/findByTags")!;
    const opts = { op, collection: { ...collection, baseUrl: "http://h" }, doc, timeoutSec: 5, schemes: {}, vars: {}, auth: {} };
    expect(buildRequest({ ...opts, state: state({ params: { "query:tags": "{{$uuid}}" } }) }).usedVars).toEqual([]);
    expect(buildRequest({ ...opts, state: state({ params: { "query:tags": "{{nope}}" } }) }).usedVars).toEqual(["nope"]);
  });
  it("reports auto-generated headers and lets custom headers override them", () => {
    const op = getOperation(spec, "GET /pet/{petId}")!;
    const opts = {
      op, collection, doc, timeoutSec: 5, schemes: spec.securitySchemes,
      vars: { base: "https://x.test/v3" }, auth: { c: { api_key: { value: "k1" } } },
    };
    const plain = buildRequest({ ...opts, state: state({ params: { "path:petId": "1" } }) });
    expect(plain.implicitHeaders).toEqual([
      { name: "api_key", value: "k1", source: "auth", overridden: false, secret: true },
      { name: "Accept", value: "*/*", source: "client", overridden: false, secret: undefined },
    ]);
    const custom = buildRequest({
      ...opts,
      state: state({ params: { "path:petId": "1" }, extraHeaders: [{ id: "h", key: "API_KEY", value: "mine", enabled: true }] }),
    });
    expect(custom.implicitHeaders[0].overridden).toBe(true);
    expect(custom.req.headers.filter(([k]) => k.toLowerCase() === "api_key")).toEqual([["API_KEY", "mine"]]);
  });
  it("explodes array query params", () => {
    const op = getOperation(spec, "GET /pet/findByTags")!;
    const built = buildRequest({ op, collection: { ...collection, baseUrl: "http://h" }, doc, timeoutSec: 5, schemes: {}, vars: {}, auth: {}, state: state({ params: { "query:tags": "a, b" } }) });
    expect(built.req.url).toBe("http://h/pet/findByTags?tags=a&tags=b");
  });
  it("interpolates numbers into JSON bodies", () => {
    expect(interpolateJsonText('{"id": "{{n}}", "s": "a {{n}}"}', { n: "7" })).toBe('{"id": 7, "s": "a 7"}');
    expect(interpolateJsonText('{"s": "{{q}}"}', { q: 'he said "hi"' })).toBe('{"s": "he said \\"hi\\""}');
  });
});

describe("diff", () => {
  it("detects added/removed/modified endpoints and conflicts with saved data", () => {
    const changed = SAMPLE_SPEC.replace("  /user/{username}:", "  /users/{username}:")
      .replace("username: { type: string, example: theUser, minLength: 3 }", "username: { type: integer }")
      .replace("        - name: status\n          in: query\n          required: false", "        - name: status\n          in: query\n          required: true");
    const next = buildSpec(parseSpecText(changed));
    const saved = {
      "GET /user/{username}": state({ params: { "path:username": "bob" } }),
      "POST /user": state({ bodyText: '{"username": "bob", "email": "a@b.co"}' }),
    };
    const d = diffSpecs(spec, next, saved);
    expect(d.added.map((x) => x.id)).toEqual(["GET /users/{username}"]);
    expect(d.removed.map((x) => x.id)).toEqual(["GET /user/{username}"]);
    const mod = Object.fromEntries(d.modified.map((m) => [m.id, m.changes.map((c) => c.message)]));
    expect(mod["GET /pet/findByStatus"]).toContain("Query parameter “status” is now required");
    expect(mod["POST /user"].some((m) => m.includes("type changed"))).toBe(true);
    expect(d.conflicts.some((c) => c.endpointId === "POST /user" && c.severity === "breaking")).toBe(true);
    expect(d.conflicts.some((c) => c.endpointId === "GET /user/{username}")).toBe(true);
    expect(d.breaking).toBeGreaterThan(0);
  });
  describe("schema details", () => {
    // One endpoint whose 200 response is a success/error union, like many RPC-style APIs.
    const api = (variants: string, extra = "") => `
openapi: 3.0.0
info: { title: t, version: "1" }
paths:
  /pay:
    post:
      requestBody:
        content:
          application/json:
            schema:
              type: object
              required: [amount, note]
              properties:
                amount: { type: integer, maximum: 100 }
                note: { type: string }${extra}
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                oneOf:${variants}
`;
    const ok = `
                  - type: object
                    properties: { success: { enum: [true] }, id: { type: integer } }`;
    const err = (code: string) => `
                  - type: object
                    properties:
                      success: { enum: [false] }
                      error: { type: object, properties: { code: { enum: [${code}] }, message: { type: string } } }`;
    const changes = (a: string, b: string) =>
      diffSpecs(buildSpec(parseSpecText(a)), buildSpec(parseSpecText(b)), {}).modified[0]?.changes.map((c) => c.message) ?? [];

    it("names union variants by their distinguishing value", () => {
      const before = api(ok + err("NotFound"));
      expect(changes(before, api(ok + err("NotFound") + err("Expired")))).toEqual([
        "Response 200: variant added — error.code: Expired",
      ]);
      expect(changes(before, api(ok))).toEqual(["Response 200: variant removed — error.code: NotFound"]);
    });
    it("diffs inside a matched variant regardless of order", () => {
      const moved = err("NotFound").replace("message: { type: string }", "message: { type: string }, retry: { type: boolean }");
      expect(changes(api(ok + err("NotFound")), api(moved + ok))).toEqual([
        "Response 200 [error.code: NotFound].error.retry added",
      ]);
    });
    it("reports constraints and optional fields", () => {
      const before = api(ok);
      const after = before.replace("maximum: 100", "maximum: 500").replace("required: [amount, note]", "required: [amount]");
      expect(changes(before, after)).toEqual(["Body.amount: maximum 100 → 500", "Body.note is now optional"]);
    });
    it("falls back to naming the exact spot", () => {
      const before = api(ok);
      expect(changes(before, before.replace("type: integer, maximum: 100", "type: integer, maximum: 100, readOnly: true"))).toEqual([
        "requestBody › application/json › amount › readOnly: — → true",
      ]);
    });
  });
  it("reports nothing for identical specs", () => {
    const d = diffSpecs(spec, buildSpec(parseSpecText(SAMPLE_SPEC)), {});
    expect(d.added.length + d.removed.length + d.modified.length).toBe(0);
  });
});

describe("search", () => {
  const find = (q: string) =>
    spec.endpoints
      .map((e) => ({ e, m: matchEndpoint(e, q) }))
      .filter((x) => x.m)
      .sort((a, b) => b.m!.score - a.m!.score)
      .map((x) => x.e.id);
  it("filters by method prefix", () => {
    expect(find("del pet")).toEqual(["DELETE /pet/{petId}"]);
  });
  it("ranks path matches", () => {
    expect(find("inventory")[0]).toBe("GET /store/inventory");
    expect(find("getUserByName")[0]).toBe("GET /user/{username}");
  });
});

describe("nested variables", () => {
  const vars = { base_url: "https://api.dev/as-user/{{user_id}}", user_id: "42", n: "{{user_id}}", a: "{{b}}", b: "x{{a}}" };
  it("resolves variables inside variable values", () => {
    expect(interpolate("{{base_url}}/orders", vars)).toBe("https://api.dev/as-user/42/orders");
    expect(interpolateJsonText('{"id": "{{n}}", "u": "{{base_url}}"}', vars)).toBe('{"id": 42, "u": "https://api.dev/as-user/42"}');
  });
  it("reports missing and circular references instead of looping", () => {
    const missing = new Set<string>();
    expect(interpolate("{{base_url}}", { base_url: "/u/{{nope}}" }, missing)).toBe("/u/{{nope}}");
    expect([...missing]).toEqual(["nope"]);
    const cyc = new Set<string>();
    expect(interpolate("{{a}}", vars, cyc)).toBe("x{{a}}");
    expect([...cyc]).toEqual(["a"]);
  });
});

describe("tab copy keys", () => {
  it("map copies back to their endpoint", async () => {
    const { baseRequestKey, isCopyKey, newCopyKey, requestKey, splitRequestKey } = await import("./models");
    const main = requestKey("c1", "GET /users/{id}");
    const copy = newCopyKey(main);
    expect(isCopyKey(main)).toBe(false);
    expect(isCopyKey(copy)).toBe(true);
    expect(baseRequestKey(copy)).toBe(main);
    expect(newCopyKey(copy)).not.toBe(copy);
    expect(baseRequestKey(newCopyKey(copy))).toBe(main);
    expect(splitRequestKey(copy)).toEqual(["c1", "GET /users/{id}"]);
  });
});

describe("JSON body variables", () => {
  const vars = { field: "123", zip: "02139", n: "7", flag: "true" };
  it("never unquotes keys and handles escaped quotes", () => {
    expect(interpolateJsonText('{"{{field}}": "{{n}}"}', vars)).toBe('{"123": 7}');
    expect(interpolateJsonText('{"s": "x \\"{{n}}\\""}', vars)).toBe('{"s": "x \\"7\\""}');
    expect(interpolateJsonText('{"a": [1, {{n}}]}', vars)).toBe('{"a": [1, 7]}');
  });
  it("keeps values a string where the schema says string", () => {
    const isString = (p: (string | number)[]) => p.join(".") === "zip" || p.join(".") === "list.1";
    expect(interpolateJsonText('{"zip": "{{n}}", "n": "{{n}}", "list": ["{{flag}}", "{{flag}}"]}', vars, undefined, isString)).toBe(
      '{"zip": "7", "n": 7, "list": [true, "true"]}',
    );
  });
  it("finds string fields through the schema", async () => {
    const { isStringAt } = await import("./request");
    const schema = {
      type: "object",
      properties: { zip: { type: "string" }, n: { type: "integer" }, tags: { type: "array", items: { type: "string" } } },
    };
    expect(isStringAt({}, schema, ["zip"])).toBe(true);
    expect(isStringAt({}, schema, ["n"])).toBe(false);
    expect(isStringAt({}, schema, ["tags", 3])).toBe(true);
    expect(isStringAt({}, schema, ["unknown"])).toBe(false);
  });
  it("stops chains that double at every level", () => {
    const chain: Record<string, string> = { v30: "x" };
    for (let i = 29; i >= 0; i--) chain[`v${i}`] = `{{v${i + 1}}}{{v${i + 1}}}`;
    const missing = new Set<string>();
    const t = Date.now();
    expect(interpolate("{{v0}}", chain, missing).length).toBeLessThan(2_000_000);
    expect(Date.now() - t).toBeLessThan(1000);
    expect(missing.size).toBeGreaterThan(0);
    expect(interpolate("{{v20}}", chain)).toHaveLength(1024);
  });
});

describe("auth and discriminators", () => {
  const api = parseSpecText(`
openapi: 3.0.0
info: { title: t, version: "1" }
components:
  securitySchemes:
    bearer: { type: http, scheme: bearer }
  schemas:
    Cat: { type: object, properties: { petType: { type: string }, meow: { type: boolean } } }
    Dog: { type: object, properties: { petType: { type: string }, bark: { type: boolean } } }
    Pet:
      oneOf: [{ $ref: "#/components/schemas/Cat" }, { $ref: "#/components/schemas/Dog" }]
      discriminator: { propertyName: petType, mapping: { cat: Cat, dog: "#/components/schemas/Dog" } }
paths:
  /x:
    get:
      security: [{}, { bearer: [] }]
      responses: { "200": { description: ok } }
`);
  const s = buildSpec(api);
  const collection = { id: "c", name: "x", version: "", source: { kind: "paste" as const }, hash: "", importedAt: 0, syncedAt: 0, baseUrl: "http://h", monitor: false };
  it("sends configured credentials even when auth is optional", () => {
    const op = getOperation(s, "GET /x")!;
    const built = buildRequest({ op, collection, doc: api, timeoutSec: 5, schemes: s.securitySchemes, vars: {}, state: state(), auth: { c: { bearer: { value: "T" } } } });
    expect(built.req.headers).toContainEqual(["Authorization", "Bearer T"]);
    const none = buildRequest({ op, collection, doc: api, timeoutSec: 5, schemes: s.securitySchemes, vars: {}, state: state(), auth: {} });
    expect(none.req.headers.some(([k]) => k === "Authorization")).toBe(false);
  });
  it("reads discriminator mappings given as schema names", () => {
    const u = variantsOf(api, normalize(api, api.components.schemas.Pet))!;
    expect(u.list.map((v) => v.tags.petType)).toEqual(["cat", "dog"]);
  });
});

describe("example bodies", () => {
  it("keep int64 values as numbers", async () => {
    const { exampleBodyText } = await import("../store/app");
    const schema = { type: "object", required: ["id"], properties: { id: { type: "integer", format: "int64", example: 1234567890123456789 } } };
    const text = exampleBodyText({}, { type: "application/json", schema });
    expect(text).not.toContain("big:");
    expect(text).toMatch(/"id": \d+/);
    expect(exampleBodyText({}, { type: "application/xml", schema })).toBe("");
    expect(exampleBodyText({}, { type: "text/plain", example: { a: 1 } })).toBe('{\n  "a": 1\n}');
  });
});

describe("multipart", () => {
  it("uses the boundary of a user Content-Type header", () => {
    const api = parseSpecText(`
openapi: 3.0.0
info: { title: t, version: "1" }
paths:
  /up:
    post:
      requestBody: { content: { multipart/form-data: { schema: { type: object, properties: { a: { type: string } } } } } }
      responses: { "200": { description: ok } }
`);
    const s = buildSpec(api);
    const op = getOperation(s, "POST /up")!;
    const collection = { id: "c", name: "x", version: "", source: { kind: "paste" as const }, hash: "", importedAt: 0, syncedAt: 0, baseUrl: "http://h", monitor: false };
    const st = state({ bodyText: '{"a": "1"}', extraHeaders: [{ id: "h", key: "Content-Type", value: "multipart/form-data; boundary=XYZ", enabled: true }] });
    const built = buildRequest({ op, collection, doc: api, timeoutSec: 5, schemes: {}, vars: {}, auth: {}, state: st });
    expect(built.req.body?.startsWith("--XYZ\r\n")).toBe(true);
    const auto = buildRequest({ op, collection, doc: api, timeoutSec: 5, schemes: {}, vars: {}, auth: {}, state: state({ bodyText: '{"a": "1"}' }) });
    const again = buildRequest({ op, collection, doc: api, timeoutSec: 5, schemes: {}, vars: {}, auth: {}, state: state({ bodyText: '{"a": "1"}' }) });
    expect(auto.req.body).toBe(again.req.body);
  });
});

describe("shortcut validation", () => {
  it("rejects combos that are plain typing", async () => {
    const { needsModifier } = await import("./shortcuts");
    expect(needsModifier("F")).toBe(true);
    expect(needsModifier("Shift+F")).toBe(true);
    expect(needsModifier("Mod+Shift+F")).toBe(false);
    expect(needsModifier("Alt+F")).toBe(false);
    expect(needsModifier("Shift+F5")).toBe(false);
  });
});

describe("reordering", () => {
  it("moves tabs and collections before a target or to the end", async () => {
    const app = await import("../store/app");
    app.useApp.setState({ tabs: ["a", "b", "c", "d"] });
    app.moveTab("d", "b");
    expect(app.useApp.getState().tabs).toEqual(["a", "d", "b", "c"]);
    app.moveTab("a", null);
    expect(app.useApp.getState().tabs).toEqual(["d", "b", "c", "a"]);
    app.moveTab("b", "b");
    expect(app.useApp.getState().tabs).toEqual(["d", "b", "c", "a"]);
    const col = (id: string) => ({ id }) as Collection;
    app.useApp.setState({ collections: [col("x"), col("y"), col("z")] });
    app.moveCollection("z", "x");
    expect(app.useApp.getState().collections.map((c) => c.id)).toEqual(["z", "x", "y"]);
  });
});

describe("choosing between auth alternatives", () => {
  it("sends the picked option, else the first configured one", async () => {
    const { chooseAuth } = await import("./request");
    const alts = [{ basic: [] }, { bearer: [] }, {}];
    const both = () => true;
    expect(chooseAuth(alts, both)).toBe(alts[0]);
    expect(chooseAuth(alts, both, "bearer")).toBe(alts[1]);
    expect(chooseAuth(alts, both, "")).toBe(alts[2]); // explicitly "No auth"
    expect(chooseAuth(alts, (n) => n === "bearer", "gone")).toBe(alts[1]); // pick not offered here
    expect(chooseAuth(alts, () => false)).toBeUndefined();
  });
});

describe("environments limited to collections", () => {
  it("fit only their collections; no list means all", async () => {
    const { envSupports } = await import("./models");
    const { envMismatch } = await import("../store/app");
    const env = (collections?: string[]) => ({ id: "e", name: "Prod", color: "", vars: [], collections });
    expect(envSupports(env(), "a")).toBe(true);
    expect(envSupports(env([]), "a")).toBe(true);
    expect(envSupports(env(["a"]), "a")).toBe(true);
    expect(envSupports(env(["b"]), "a")).toBe(false);
    expect(envSupports(undefined, "a")).toBe(true);
    expect(envMismatch({ environments: [env(["b"])], activeEnvId: "e" }, "a")?.name).toBe("Prod");
    expect(envMismatch({ environments: [env(["b"])], activeEnvId: null }, "a")).toBeNull();
  });
});

describe("collection auth and headers", () => {
  const api = parseSpecText(`
openapi: 3.0.0
info: { title: t, version: "1" }
paths:
  /x:
    get:
      responses: { "200": { description: ok } }
`);
  const s = buildSpec(api);
  const op = getOperation(s, "GET /x")!;
  const base: Collection = { id: "c", name: "x", version: "", source: { kind: "paste" }, hash: "", importedAt: 0, syncedAt: 0, baseUrl: "http://h", monitor: false };
  const build = (collection: Collection, st = state(), auth = {}) =>
    buildRequest({ op, collection, doc: api, timeoutSec: 5, schemes: {}, vars: { k: "K" }, auth, state: st, client: { native: true, version: "1.2.3" } });
  const header = (b: ReturnType<typeof build>, name: string) => b.req.headers.find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

  it("offers custom auth on endpoints the spec leaves open", async () => {
    const { authAlternatives } = await import("./request");
    const c: Collection = { ...base, customAuth: [{ id: "a", title: "Key", kind: "apiKey", in: "header", param: "X-Key" }] };
    expect(authAlternatives([], c)).toEqual([{}, { "custom:a": [] }]);
    expect(header(build(c, state(), { c: { "custom:a": { value: "{{k}}" } } }), "X-Key")).toBe("K");
    expect(header(build(c), "X-Key")).toBeUndefined(); // nothing configured: no auth
  });
  it("sends client headers, changeable or off, below collection and request headers", () => {
    expect(header(build(base), "User-Agent")).toBe("Reqoon/1.2.3");
    expect(header(build(base), "Accept")).toBe("*/*");
    const c: Collection = {
      ...base,
      headers: {
        client: { "user-agent": { value: "MyApp/{{k}}" }, "accept-encoding": { off: true }, accept: { off: true } },
        extra: [{ id: "1", key: "X-Team", value: "core", enabled: true }, { id: "2", key: "Accept", value: "application/json", enabled: true }],
      },
    };
    const b = build(c);
    expect(header(b, "User-Agent")).toBe("MyApp/K");
    expect(header(b, "Accept-Encoding")).toBeUndefined();
    expect(b.req.noCompression).toBe(true);
    expect(header(b, "Accept")).toBe("application/json"); // collection header beats the automatic one, which can't be off
    expect(header(b, "X-Team")).toBe("core");
    const own = build(c, state({ extraHeaders: [{ id: "h", key: "X-Team", value: "mine", enabled: true }] }));
    expect(own.req.headers.filter(([k]) => k === "X-Team")).toEqual([["X-Team", "mine"]]);
  });
  it("lets one request leave out collection and client headers", () => {
    const c: Collection = { ...base, headers: { extra: [{ id: "1", key: "X-Team", value: "core", enabled: true }] } };
    const b = build(c, state({ offHeaders: ["x-team", "user-agent", "accept-encoding", "accept"] }));
    expect(header(b, "X-Team")).toBeUndefined();
    expect(header(b, "User-Agent")).toBeUndefined();
    expect(b.req.noCompression).toBe(true);
    expect(header(b, "Accept")).toBe("*/*"); // can't be left out
    expect(b.implicitHeaders.find((h) => h.name === "X-Team")).toMatchObject({ switchable: true, off: true });
    expect(b.implicitHeaders.find((h) => h.name === "Accept")?.switchable).toBeUndefined();
  });
});
