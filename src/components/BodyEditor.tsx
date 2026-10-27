import { useMemo } from "react";
import { exampleBodyText, getOp, toast, updateRequest, useApp } from "../store/app";
import type { OperationInfo } from "../lib/openapi";
import { validate, Json, ValidationError } from "../lib/schema";
import { isStructuredType } from "../lib/request";
import { parseJson, stringifyJson } from "../lib/json";
import SchemaForm from "./SchemaForm";
import JsonEditor from "./JsonEditor";
import { Warning } from "./Icons";
import Markdown from "./Markdown";

export function toggleBodyMode(tabKey: string) {
  const st = useApp.getState().requests[tabKey];
  const info = getOp(tabKey);
  if (!st || !info?.op.body) return;
  const ct = st.contentType ?? info.op.body.contents[0]?.type;
  if (!isStructuredType(ct)) return;
  setBodyMode(tabKey, st.bodyMode === "form" ? "raw" : "form");
}

function setBodyMode(tabKey: string, mode: "form" | "raw") {
  const st = useApp.getState().requests[tabKey];
  if (!st || st.bodyMode === mode) return;
  if (mode === "form" && st.bodyText.trim() !== "") {
    try {
      JSON.parse(st.bodyText);
    } catch (e) {
      // Never drop the user's text: stay in raw mode until it parses.
      toast("error", `Fix the JSON before switching to Form: ${(e as Error).message}`);
      return;
    }
  }
  updateRequest(tabKey, { bodyMode: mode });
}

export default function BodyEditor({ tabKey, op, doc }: { tabKey: string; op: OperationInfo; doc: Json }) {
  const state = useApp((s) => s.requests[tabKey]);
  const body = op.body!;
  const ct = state.contentType ?? body.contents[0]?.type;
  const content = body.contents.find((c) => c.type === ct) ?? body.contents[0];
  const structured = isStructuredType(ct);
  const schema = content?.schema;

  const parsed = useMemo((): { ok: true; value: Json } | { ok: false; error: string } => {
    if (state.bodyText.trim() === "") return { ok: true, value: undefined };
    try {
      return { ok: true, value: parseJson(state.bodyText) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }, [state.bodyText]);

  const errors: ValidationError[] = useMemo(() => {
    if (!structured || !schema || !parsed.ok || parsed.value === undefined) return [];
    return validate(doc, schema, parsed.value);
  }, [structured, schema, parsed, doc]);

  const mode = structured ? state.bodyMode : "raw";
  const setText = (bodyText: string) => updateRequest(tabKey, { bodyText });

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div className="row" style={{ padding: "10px 14px", borderBottom: "1px solid var(--border)", flexWrap: "wrap" }}>
        {structured && (
          <div className="seg" role="tablist">
            <button className={mode === "form" ? "active" : ""} onClick={() => setBodyMode(tabKey, "form")}>
              Form
            </button>
            <button className={mode === "raw" ? "active" : ""} onClick={() => setBodyMode(tabKey, "raw")}>
              Raw JSON
            </button>
          </div>
        )}
        {body.contents.length > 1 ? (
          <select
            className="select"
            style={{ width: "auto", height: 26, fontSize: 12 }}
            value={ct}
            onChange={(e) => updateRequest(tabKey, { contentType: e.target.value })}
          >
            {body.contents.map((c) => (
              <option key={c.type}>{c.type}</option>
            ))}
          </select>
        ) : (
          <span className="muted small mono">{ct}</span>
        )}
        {body.required && <span className="badge">required</span>}
        <span className="spacer" />
        {errors.length > 0 && (
          <span className="small" style={{ color: "var(--danger)", display: "flex", gap: 4, alignItems: "center" }}>
            <Warning size={12} /> {errors.length} issue{errors.length > 1 ? "s" : ""}
          </span>
        )}
        {structured && mode === "raw" && parsed.ok && parsed.value !== undefined && (
          <button className="btn sm ghost" onClick={() => setText(stringifyJson(parsed.value, 2))}>
            Format
          </button>
        )}
        {schema && (
          <button
            className="btn sm ghost"
            title="Replace the body with the example / defaults from the spec"
            onClick={() => setText(exampleBodyText(doc, content))}
          >
            Example
          </button>
        )}
      </div>
      {body.description && <Markdown className="field-desc body-desc" text={body.description} />}
      {mode === "form" ? (
        <div className="section" style={{ flex: 1, overflow: "auto" }}>
          {!parsed.ok ? (
            <div className="banner danger" style={{ margin: 0 }}>Body is not valid JSON ({parsed.error}). Fix it in Raw mode.</div>
          ) : schema ? (
            <SchemaForm
              doc={doc}
              schema={schema}
              value={parsed.value}
              errors={errors}
              onChange={(v) => setText(v === undefined ? "" : stringifyJson(v, 2))}
            />
          ) : (
            <div className="muted">This body has no schema. Use Raw mode.</div>
          )}
        </div>
      ) : (
        <div style={{ flex: 1, minHeight: 0 }}>
          <JsonEditor
            key={`${tabKey}|${ct}`}
            value={state.bodyText}
            onChange={setText}
            doc={doc}
            schema={structured ? schema : undefined}
            json={structured}
          />
        </div>
      )}
    </div>
  );
}
