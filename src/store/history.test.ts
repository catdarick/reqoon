import { describe, expect, it } from "vitest";
import { clearHistory, recordHistory, useHistory } from "./history";
import type { RequestState } from "../lib/models";

const state: RequestState = { params: {}, paramEnabled: {}, extraQuery: [], extraHeaders: [], bodyText: "", bodyMode: "form", updatedAt: 0, tabTitle: "mine" };
const res = (body: string) => ({ status: 200, statusText: "OK", headers: [], body, size: body.length, timeMs: 5, at: 1, url: "u", method: "GET" });

describe("request history", () => {
  it("masks credentials and keeps the editor values", () => {
    clearHistory();
    const e = recordHistory({
      collectionId: "c",
      endpointId: "GET /x",
      state,
      req: { id: "1", method: "GET", url: "https://h/x?api_key=sk_live_123", headers: [["Authorization", "Bearer tok_abc"]] },
      secrets: ["sk_live_123", "tok_abc"],
      response: res("{}"),
    });
    expect(e.request.url).toBe("https://h/x?api_key=••••");
    expect(e.request.headers).toEqual([["Authorization", "Bearer ••••"]]);
    expect(e.state.tabTitle).toBeUndefined();
    expect(useHistory.getState().entries[0].id).toBe(e.id);
  });
  it("cuts big bodies and keeps the newest first", () => {
    clearHistory();
    const big = "x".repeat(100 * 1024);
    recordHistory({ collectionId: "c", endpointId: "GET /a", state, req: { id: "1", method: "GET", url: "u", headers: [] }, secrets: [], response: res(big) });
    recordHistory({ collectionId: "c", endpointId: "GET /b", state, req: { id: "2", method: "GET", url: "u", headers: [] }, secrets: [], error: "boom" });
    const [b, a] = useHistory.getState().entries;
    expect(b.endpointId).toBe("GET /b");
    expect(b.error).toBe("boom");
    expect(a.truncated).toBe(true);
    expect(a.response!.body.length).toBe(64 * 1024);
  });
});
