import { useEffect, useMemo, useRef, useState } from "react";
import {
  activeVars,
  cancelRequest,
  copyCurl,
  envMismatch,
  getOp,
  prepareRequest,
  resetRequest,
  sendRequest,
  setModal,
  updateRequest,
  updateSettings,
  useApp,
} from "../store/app";
import type { Environment, KV, RequestState } from "../lib/models";
import { uid } from "../lib/models";
import type { OperationInfo, Param } from "../lib/openapi";
import { describeType, normalize, validate } from "../lib/schema";
import type { Json } from "../lib/schema";
import { authAlternatives, ImplicitHeader, isParamActive, paramKey, transportHeaders } from "../lib/request";
import { coerceParamValue } from "../lib/diff";
import { formatCombo } from "../lib/shortcuts";
import { interpolate, VAR_PATTERN } from "../lib/vars";
import { ChevronRight, Close, Copy, Dots, Eye, EyeOff, Plus, Refresh, Stop, Warning } from "./Icons";
import BodyEditor from "./BodyEditor";
import AuthEditor from "./AuthEditor";
import { markdownToText } from "../lib/markdown";
import Markdown from "./Markdown";
import { openEnvSwitcher } from "./EnvSwitcher";

type Sub = "params" | "headers" | "body" | "auth";

export default function RequestPanel({ tabKey }: { tabKey: string }) {
  const info = getOp(tabKey)!;
  const state = useApp((s) => s.requests[tabKey]);
  const { op, spec, collection } = info;
  const hasBody = !!op.body;
  const [sub, setSub] = useState<Sub>(hasBody ? "body" : "params");

  if (!state) return null;
  const pathQuery = op.params.filter((p) => p.in !== "header");
  const headerParams = op.params.filter((p) => p.in === "header");
  const stale = staleParams(op, state);
  // Auth credentials, collection settings and variables feed the auto-generated headers.
  useApp((s) => s.vault.auth[collection.id]);
  useApp((s) => s.collections.find((c) => c.id === collection.id));
  useApp((s) => s.environments);
  useApp((s) => s.activeEnvId);
  const built = prepareRequest(tabKey);
  const autoHeaders = built ? [...built.implicitHeaders, ...transportHeaders(built.req)] : [];
  // A foreign environment only matters when the request refers to its variables.
  const mismatch = useApp((s) => envMismatch(s, collection.id));
  const wrongEnv = mismatch && built?.usedVars.length ? mismatch : null;
  const autoCount = autoHeaders.filter((h) => h.source !== "client" && !h.overridden && !h.off).length;

  return (
    <section className="pane" aria-label="Request">
      <UrlBar tabKey={tabKey} op={op} state={state} baseUrl={collection.baseUrl} wrongEnv={!!wrongEnv} />
      {wrongEnv && <EnvNote env={wrongEnv} />}
      <div className="op-head">
        <div className="row">
          <div className="op-title truncate grow selectable">{op.endpoint.summary || op.endpoint.operationId || op.endpoint.path}</div>
          {op.endpoint.deprecated && <span className="badge warn">deprecated</span>}
          <MoreMenu tabKey={tabKey} collectionId={collection.id} />
        </div>
        {op.endpoint.description && op.endpoint.description !== op.endpoint.summary && <OpDescription text={op.endpoint.description} />}
      </div>
      <div className="subtabs" role="tablist">
        <SubTab id="params" cur={sub} set={setSub} label="Params" count={pathQuery.length + state.extraQuery.filter((k) => k.key).length} />
        <SubTab id="headers" cur={sub} set={setSub} label="Headers" count={headerParams.length + state.extraHeaders.filter((k) => k.key).length + autoCount} />
        {hasBody && <SubTab id="body" cur={sub} set={setSub} label="Body" />}
        {authAlternatives(op.security, collection).length > 0 && <SubTab id="auth" cur={sub} set={setSub} label="Auth" />}
      </div>
      {stale.length > 0 && (
        <div className="banner warn">
          <Warning size={14} />
          <span className="grow">
            Saved values for parameters no longer in the spec are kept but not sent: {stale.map((k) => k.replace(":", " ")).join(", ")}.
          </span>
          <button
            className="btn sm"
            onClick={() =>
              updateRequest(tabKey, (r) => {
                const params = { ...r.params };
                for (const k of stale) delete params[k];
                return { params };
              })
            }
          >
            Clear
          </button>
        </div>
      )}
      <div className="pane-body">
        {sub === "params" && (
          <div className="section">
            {pathQuery.length > 0 && (
              <ParamList tabKey={tabKey} params={pathQuery} state={state} doc={spec.doc} />
            )}
            <div className="section-title" style={{ marginTop: pathQuery.length ? 18 : 4 }}>
              Additional query parameters
            </div>
            <KVEditor rows={state.extraQuery} onChange={(extraQuery) => updateRequest(tabKey, { extraQuery })} />
          </div>
        )}
        {sub === "headers" && (
          <div className="section">
            {headerParams.length > 0 && <ParamList tabKey={tabKey} params={headerParams} state={state} doc={spec.doc} />}
            <div className="section-title" style={{ marginTop: headerParams.length ? 18 : 4 }}>
              Custom headers
            </div>
            <KVEditor rows={state.extraHeaders} onChange={(extraHeaders) => updateRequest(tabKey, { extraHeaders })} />
            <AutoHeaders
              headers={autoHeaders}
              onToggle={(h) =>
                updateRequest(tabKey, (r) => {
                  const name = h.name.toLowerCase();
                  const off = (r.offHeaders ?? []).filter((n) => n !== name);
                  return { offHeaders: h.off ? off : [...off, name] };
                })
              }
              onOverride={(h) =>
                updateRequest(tabKey, { extraHeaders: [...state.extraHeaders, { id: uid(), key: h.name, value: h.secret ? "" : h.value, enabled: true }] })
              }
            />
          </div>
        )}
        {sub === "body" && hasBody && <BodyEditor tabKey={tabKey} op={op} doc={spec.doc} />}
        {sub === "auth" && <AuthEditor collectionId={collection.id} op={op} schemes={spec.securitySchemes} />}
      </div>
    </section>
  );
}

function staleParams(op: OperationInfo, state: RequestState): string[] {
  const keys = new Set(op.params.map(paramKey));
  return Object.entries(state.params)
    .filter(([k, v]) => v !== "" && !keys.has(k))
    .map(([k]) => k);
}

/** Two lines of the endpoint description, expandable when there's more. */
function OpDescription({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, open]);
  // Collapsed: a plain-text preview clamped to two lines; expanded: the formatted description.
  // Paragraphs run together in the two-line preview, so it never shows a blank line and a lone "…".
  const preview = useMemo(() => markdownToText(text).replace(/\s*\n\s*/g, " "), [text]);
  return (
    <div className="op-desc-wrap">
      {open ? (
        <div ref={ref} className="op-desc small selectable open">
          <Markdown text={text} />
        </div>
      ) : (
        <div ref={ref} className="op-desc small selectable">
          {preview}
        </div>
      )}
      {(overflows || open) && (
        <button className="link-btn small" onClick={() => setOpen(!open)}>
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

function SubTab({ id, cur, set, label, count }: { id: Sub; cur: Sub; set: (s: Sub) => void; label: string; count?: number }) {
  return (
    <button role="tab" aria-selected={cur === id} className={`subtab ${cur === id ? "active" : ""}`} onClick={() => set(id)}>
      {label}
      {!!count && <span className="count">{count}</span>}
    </button>
  );
}

/** A quiet line under the URL when the request uses variables of an environment not meant for this collection. */
function EnvNote({ env: wrong }: { env: Environment }) {
  return (
    <div className="env-note">
      <Warning size={12} />
      <span>
        This request uses variables, and “{wrong.name}” isn't set up for this collection, so sending is off.{" "}
        <button className="link-btn" onClick={openEnvSwitcher}>
          Switch environment
        </button>
      </span>
    </div>
  );
}

function UrlBar({
  tabKey,
  op,
  state,
  baseUrl,
  wrongEnv,
}: {
  tabKey: string;
  op: OperationInfo;
  state: RequestState;
  baseUrl: string;
  wrongEnv: boolean;
}) {
  const loading = useApp((s) => !!s.inflight[tabKey]);
  const sendKey = useApp((s) => s.settings.shortcuts.send);
  useApp((s) => s.activeEnvId);
  useApp((s) => s.environments);
  const vars = activeVars();

  const segments = useMemo(() => {
    const out: { text: string; cls?: string }[] = [];
    pushTemplate(out, baseUrl.replace(/\/$/, "") || "{base URL}", vars, !baseUrl);
    const parts = op.endpoint.path.split(/(\{[^}]+\})/);
    for (const part of parts) {
      const m = part.match(/^\{(.+)\}$/);
      if (m) {
        const v = state.params[`path:${m[1]}`];
        if (v) pushTemplate(out, v, vars, false, "b");
        else out.push({ text: part, cls: "missing" });
      } else if (part) out.push({ text: part, cls: "b" });
    }
    const q = op.params
      .filter((p) => p.in === "query" && isParamActive(p, state))
      .map((p) => [p.name, state.params[paramKey(p)] ?? ""] as const)
      .concat(state.extraQuery.filter((k) => k.enabled && k.key).map((k) => [k.key, k.value] as const));
    q.forEach(([k, v], i) => {
      out.push({ text: `${i === 0 ? "?" : "&"}${k}=` });
      pushTemplate(out, v, vars, false);
    });
    return out;
  }, [baseUrl, op, state, vars]);

  return (
    <div className="urlbar">
      <div className="urlbox">
        <span className={`method m-${op.endpoint.method}`}>{op.endpoint.method}</span>
        <div className="url selectable">
          {segments.map((s, i) =>
            s.cls === "b" ? <b key={i}>{s.text}</b> : <span key={i} className={s.cls}>{s.text}</span>,
          )}
        </div>
      </div>
      {loading ? (
        <button className="btn send-btn" onClick={() => cancelRequest(tabKey)}>
          <Stop size={12} /> Cancel
        </button>
      ) : (
        <button className="btn primary send-btn" disabled={wrongEnv} onClick={() => sendRequest(tabKey)}>
          Send <span style={{ opacity: 0.7, fontSize: 11 }}>{formatCombo(sendKey)}</span>
        </button>
      )}
    </div>
  );
}

function pushTemplate(out: { text: string; cls?: string }[], text: string, vars: Record<string, string>, missing: boolean, cls?: string) {
  if (missing) {
    out.push({ text, cls: "missing" });
    return;
  }
  let last = 0;
  for (const m of text.matchAll(VAR_PATTERN)) {
    if (m.index! > last) out.push({ text: text.slice(last, m.index), cls });
    // Known only if everything it refers to resolves as well.
    const unresolved = new Set<string>();
    interpolate(m[0], vars, unresolved);
    const known = unresolved.size === 0;
    out.push({ text: m[0], cls: known ? "var" : "missing" });
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), cls });
}

function MoreMenu({ tabKey, collectionId }: { tabKey: string; collectionId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: "relative" }}>
      <button className="icon-btn" onClick={() => setOpen(!open)} aria-label="More actions" onBlur={() => setTimeout(() => setOpen(false), 150)}>
        <Dots />
      </button>
      {open && (
        <div className="menu">
          <div className="menu-item" onMouseDown={() => copyCurl(tabKey)}>
            <Copy size={13} /> Copy as cURL
          </div>
          <div className="menu-item" onMouseDown={() => setModal({ collection: collectionId })}>
            <Dots size={13} /> Collection settings…
          </div>
          <div className="menu-sep" />
          <div className="menu-item" style={{ color: "var(--danger)" }} onMouseDown={() => resetRequest(tabKey)}>
            <Refresh size={13} /> Reset request to spec defaults
          </div>
        </div>
      )}
    </div>
  );
}

function ParamList({ tabKey, params, state, doc }: { tabKey: string; params: Param[]; state: RequestState; doc: Json }) {
  const groups: Record<string, Param[]> = {};
  for (const p of params) (groups[p.in] ??= []).push(p);
  return (
    <>
      {Object.entries(groups).map(([where, list], gi) => (
        <div key={where} style={{ marginTop: gi ? 14 : 0 }}>
          <div className="section-title">{where === "path" ? "Path parameters" : where === "query" ? "Query parameters" : where === "header" ? "Header parameters" : "Cookies"}</div>
          <div className="param-grid">
            {list.map((p) => (
              <ParamRow key={paramKey(p)} tabKey={tabKey} p={p} state={state} doc={doc} />
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

function ParamRow({ tabKey, p, state, doc }: { tabKey: string; p: Param; state: RequestState; doc: Json }) {
  const key = paramKey(p);
  const value = state.params[key] ?? "";
  const active = isParamActive(p, state);
  const s = normalize(doc, p.schema);
  const errors = active && value !== "" ? validate(doc, p.schema, coerceParamValue(doc, p.schema, value)) : [];
  const set = (v: string) =>
    updateRequest(tabKey, (r) => ({
      params: { ...r.params, [key]: v },
      paramEnabled: p.required ? r.paramEnabled : { ...r.paramEnabled, [key]: v !== "" || r.paramEnabled[key] === true },
    }));
  const placeholder = p.example !== undefined ? String(typeof p.example === "object" ? JSON.stringify(p.example) : p.example) : s.default !== undefined ? String(s.default) : s._types[0] === "array" ? "a, b, c" : "";
  const enumVals: Json[] | undefined = s.enum ?? (s._types[0] === "array" ? normalize(doc, s.items).enum : undefined);
  const showMissing = p.required && value === "";

  return (
    <>
      <input
        type="checkbox"
        className="checkbox"
        style={{ marginTop: 7 }}
        checked={active}
        disabled={p.required}
        title={p.required ? "Required parameters are always sent" : undefined}
        onChange={(e) => updateRequest(tabKey, (r) => ({ paramEnabled: { ...r.paramEnabled, [key]: e.target.checked } }))}
      />
      <div className="param-name">
        <span className="name">
          {p.name}
          {p.required && <span className="req-star">*</span>}
        </span>
        <span className="meta">
          {describeType(doc, p.schema)}
          {p.deprecated ? " · deprecated" : ""}
        </span>
      </div>
      <div style={{ opacity: active ? 1 : 0.55, minWidth: 0 }}>
        {enumVals && s._types[0] !== "array" ? (
          <select className={`select ${errors.length ? "invalid" : ""}`} value={value} onChange={(e) => set(e.target.value)}>
            <option value="">{p.required ? "Select…" : "—"}</option>
            {enumVals.map((v) => (
              <option key={String(v)} value={String(v)}>
                {String(v)}
              </option>
            ))}
            {value && !enumVals.map(String).includes(value) && <option value={value}>{value}</option>}
          </select>
        ) : s._types[0] === "boolean" ? (
          <select className="select" value={value} onChange={(e) => set(e.target.value)}>
            <option value="">—</option>
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        ) : (
          <input
            className={`input mono ${errors.length || showMissing ? "invalid" : ""}`}
            value={value}
            placeholder={placeholder}
            spellCheck={false}
            onChange={(e) => set(e.target.value)}
          />
        )}
        {errors.map((e, i) => (
          <div key={i} className="field-error">
            {e.message}
          </div>
        ))}
        {enumVals && s._types[0] === "array" && <div className="field-desc">Options: {enumVals.map(String).join(", ")}</div>}
        {p.description && <Markdown className="field-desc" text={p.description} />}
      </div>
    </>
  );
}

const SOURCE_LABEL: Record<ImplicitHeader["source"], string> = {
  auth: "Auth",
  body: "Body",
  cookie: "Cookies",
  collection: "Collection",
  client: "Client",
};

const SOURCE_HINT: Record<ImplicitHeader["source"], string> = {
  auth: "From the Auth tab",
  body: "From the body's content type",
  cookie: "From cookie parameters and API keys",
  collection: "From the collection's header settings",
  client: "Added by the HTTP client; change it in collection settings",
};

/** Read-only list of the headers the app adds by itself; a custom header with the same name replaces one. */
function AutoHeaders({
  headers,
  onOverride,
  onToggle,
}: {
  headers: ImplicitHeader[];
  onOverride: (h: ImplicitHeader) => void;
  onToggle: (h: ImplicitHeader) => void;
}) {
  const open = useApp((s) => s.settings.showAutoHeaders);
  const [reveal, setReveal] = useState(false);
  if (!headers.length) return null;
  const mask = (v: string) => {
    const [scheme, ...rest] = v.split(" ");
    const secret = rest.length && /^(Bearer|Basic|Token|Digest|Negotiate)$/i.test(scheme) ? rest.join(" ") : v;
    const shown = secret === v ? "" : `${scheme} `;
    return secret ? `${shown}${"•".repeat(Math.min(24, Math.max(8, secret.length)))}` : v;
  };
  return (
    <div style={{ marginTop: 18 }}>
      <div className="section-title" style={{ cursor: "pointer" }} onClick={() => updateSettings({ showAutoHeaders: !open })}>
        <ChevronRight size={11} className={`chev ${open ? "open" : ""}`} />
        Auto-generated <span className="muted">{headers.filter((h) => !h.overridden && !h.off).length}</span>
        {open && headers.some((h) => h.secret) && (
          <button
            className="icon-btn sm"
            style={{ marginLeft: "auto" }}
            title={reveal ? "Hide credentials" : "Show credentials"}
            onClick={(e) => (e.stopPropagation(), setReveal(!reveal))}
          >
            {reveal ? <EyeOff size={12} /> : <Eye size={12} />}
          </button>
        )}
      </div>
      {open && (
        // One grid for all rows, so the source column is as wide as the longest label shown.
        <div className="auto-headers">
          {headers.map((h, i) => (
            <div key={`${h.name}${i}`} className={`auto-header ${h.overridden ? "overridden" : ""} ${h.off ? "off" : ""}`}>
              {/* Collection-wide and client headers can be left out of this one request. */}
              {h.switchable && !h.overridden ? (
                <input type="checkbox" className="checkbox" checked={!h.off} onChange={() => onToggle(h)} aria-label={`Send ${h.name}`} />
              ) : (
                <span />
              )}
              <span className="auto-src" title={SOURCE_HINT[h.source]}>
                {SOURCE_LABEL[h.source]}
              </span>
              <span className="ro mono truncate" title={h.name}>
                {h.name}
              </span>
              <span className="ro mono truncate" title={h.overridden ? "Replaced by your custom header" : h.secret && !reveal ? undefined : h.value}>
                {h.secret && !reveal ? mask(h.value) : h.value}
              </span>
              {h.overridden || h.off || h.name === "Host" || h.name === "Content-Length" ? (
                <span />
              ) : (
                <button className="icon-btn" title="Override with a custom header" onClick={() => onOverride(h)}>
                  <Plus size={12} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function KVEditor({ rows, onChange }: { rows: KV[]; onChange: (rows: KV[]) => void }) {
  // The trailing blank row keeps a stable id so typing into it doesn't remount the input.
  const blankId = useRef(uid());
  if (rows.some((r) => r.id === blankId.current)) blankId.current = uid();
  const list = [...rows, { id: blankId.current, key: "", value: "", enabled: true }];
  const update = (i: number, patch: Partial<KV>) => {
    onChange(list.map((r, j) => (j === i ? { ...r, ...patch } : r)).filter((r) => r.id !== blankId.current || r.key || r.value));
  };
  return (
    <div>
      {list.map((r, i) => {
        const blank = r.id === blankId.current;
        return (
          <div key={r.id} className="kv-row">
            {/* The blank row is where a new header is typed; it has nothing to enable yet. */}
            <input
              type="checkbox"
              className="checkbox"
              checked={r.enabled}
              onChange={(e) => update(i, { enabled: e.target.checked })}
              style={blank ? { visibility: "hidden" } : undefined}
              tabIndex={blank ? -1 : undefined}
            />
            <input className="input mono" placeholder="Name" value={r.key} spellCheck={false} onChange={(e) => update(i, { key: e.target.value })} />
            <input className="input mono" placeholder="Value" value={r.value} spellCheck={false} onChange={(e) => update(i, { value: e.target.value })} />
            {blank ? (
              <span className="muted" style={{ display: "grid", placeItems: "center" }}>
                <Plus size={12} />
              </span>
            ) : (
              <button className="icon-btn" aria-label="Remove" onClick={() => onChange(rows.filter((x) => x.id !== r.id))}>
                <Close size={12} />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
