import { useState } from "react";
import {
  addCustomAuth,
  checkForUpdates,
  CollectionSection,
  removeCollection,
  removeCustomAuth,
  revertSync,
  setModal,
  updateCollection,
  updateCustomAuth,
  useApp,
} from "../store/app";
import Modal from "./Modal";
import type { GroupMode } from "../lib/tree";
import type { Collection, CustomAuth } from "../lib/models";
import { GROUP_MODES } from "./GroupModeMenu";
import { Close, Plus, Refresh, Trash } from "./Icons";
import HideRulesEditor from "./HideRulesEditor";
import { KVEditor } from "./RequestPanel";
import { SchemeFields, SchemeHeader, schemeTitle } from "./AuthEditor";
import { markdownToText } from "../lib/markdown";
import { authChoiceKey, CLIENT_HEADERS, collectionSchemes, customSchemeKey } from "../lib/request";
import { isTauri } from "../lib/platform";
import { version } from "../../package.json";

const SECTIONS: { id: CollectionSection; label: string }[] = [
  { id: "general", label: "General" },
  { id: "auth", label: "Authentication" },
  { id: "headers", label: "Headers" },
  { id: "hidden", label: "Hidden endpoints" },
  { id: "source", label: "Source & sync" },
];

export default function CollectionModal({ collectionId, section = "general" }: { collectionId: string; section?: CollectionSection }) {
  const c = useApp((s) => s.collections.find((x) => x.id === collectionId));
  const [cur, setCur] = useState<CollectionSection>(section);
  if (!c) return null;
  return (
    <Modal title={<>Collection settings · <span style={{ fontWeight: 500 }}>{c.name}</span></>} wide>
      <div className="settings-layout">
        <nav className="settings-nav">
          {SECTIONS.map((s) => (
            <button key={s.id} className={`settings-nav-item ${cur === s.id ? "sel" : ""}`} onClick={() => setCur(s.id)}>
              {s.label}
              {s.id === "source" && c.pending && <span className="nav-dot" />}
            </button>
          ))}
        </nav>
        <div className="settings-body">
          {cur === "general" && <General c={c} />}
          {cur === "auth" && <Auth c={c} />}
          {cur === "headers" && <Headers c={c} />}
          {cur === "hidden" && (
            <Section title="Hidden endpoints" hint="Hidden endpoints stay out of the sidebar and search. One rule per line, like .gitignore.">
              <HideRulesEditor collectionId={c.id} />
            </Section>
          )}
          {cur === "source" && <Source c={c} />}
        </div>
      </div>
    </Modal>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="settings-section">
      <h4>{title}</h4>
      {hint && <p className="settings-hint">{hint}</p>}
      {children}
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="settings-field">
      <label>{label}</label>
      <div>
        {children}
        {hint && <div className="form-hint">{hint}</div>}
      </div>
    </div>
  );
}

function General({ c }: { c: Collection }) {
  const spec = useApp((s) => s.specs[c.id]);
  const defaultMode = useApp((s) => s.settings.defaultGroupMode);
  const [confirm, setConfirm] = useState(false);
  const servers = spec?.servers ?? [];
  const custom = !servers.some((s) => s.url === c.baseUrl);
  return (
    <>
      <Section title="General">
        <Field label="Name">
          <input className="input" value={c.name} onChange={(e) => updateCollection(c.id, { name: e.target.value })} />
        </Field>
        <Field
          label="Server"
          hint={
            <>
              Use <span className="mono">{"{{baseUrl}}"}</span> to switch servers per environment.
            </>
          }
        >
          <div className="col" style={{ gap: 6 }}>
            {servers.length > 0 && (
              <select
                className="select"
                value={custom ? "__custom" : c.baseUrl}
                onChange={(e) => updateCollection(c.id, { baseUrl: e.target.value === "__custom" ? "" : e.target.value })}
              >
                {servers.map((s) => (
                  <option key={s.url} value={s.url}>
                    {s.url}
                    {s.description ? ` — ${markdownToText(s.description)}` : ""}
                  </option>
                ))}
                <option value="__custom">Custom…</option>
              </select>
            )}
            {(custom || !servers.length) && (
              <input
                className="input mono"
                placeholder="{{baseUrl}} or https://api.example.com"
                value={c.baseUrl}
                autoFocus={custom && !c.baseUrl}
                onChange={(e) => updateCollection(c.id, { baseUrl: e.target.value })}
              />
            )}
          </div>
        </Field>
        <Field label="Group endpoints">
          <select
            className="select"
            value={c.groupMode ?? ""}
            onChange={(e) => updateCollection(c.id, { groupMode: (e.target.value || undefined) as GroupMode | undefined })}
          >
            <option value="">Default ({GROUP_MODES.find((m) => m.id === defaultMode)?.label})</option>
            {GROUP_MODES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </Field>
      </Section>
      <Section title="Danger zone">
        {confirm ? (
          <div className="row">
            <span className="grow small">Remove the collection and all its saved request values?</span>
            <button className="btn sm" onClick={() => setConfirm(false)}>
              Cancel
            </button>
            <button className="btn sm danger" onClick={() => (removeCollection(c.id), setModal(null))}>
              Remove
            </button>
          </div>
        ) : (
          <button className="btn sm danger" onClick={() => setConfirm(true)}>
            <Trash size={12} /> Remove collection
          </button>
        )}
      </Section>
    </>
  );
}

function Auth({ c }: { c: Collection }) {
  const spec = useApp((s) => s.specs[c.id]);
  const schemes = collectionSchemes(c, spec?.securitySchemes ?? {});
  const specNames = Object.keys(spec?.securitySchemes ?? {});
  const options = [...specNames, ...(c.customAuth ?? []).map((a) => customSchemeKey(a.id))];
  return (
    <>
      <Section
        title="Authentication"
        hint="Credentials are shared by all endpoints of this collection and kept in your system keychain. Use {{variable}} to take values from the active environment."
      >
        {options.length > 1 && (
          <Field label="Prefer" hint="Used wherever an endpoint accepts it; otherwise the first configured method is sent.">
            <select
              className="select"
              value={c.authChoice ?? ""}
              onChange={(e) => updateCollection(c.id, { authChoice: e.target.value || undefined })}
            >
              <option value="">Automatic</option>
              {options.map((n) => (
                <option key={n} value={authChoiceKey({ [n]: [] })}>
                  {schemeTitle(schemes[n], n)}
                </option>
              ))}
            </select>
          </Field>
        )}
        {!specNames.length && !c.customAuth?.length && <p className="muted small">The spec defines no authentication.</p>}
        {specNames.map((n) => (
          <div key={n} className="settings-card">
            <SchemeHeader name={n} scheme={schemes[n]} />
            <SchemeFields collectionId={c.id} name={n} scheme={schemes[n]} />
          </div>
        ))}
      </Section>
      <Section title="Custom methods" hint="For auth the spec doesn't describe. Each one is offered on every endpoint of the collection.">
        {(c.customAuth ?? []).map((a) => (
          <CustomAuthCard key={a.id} c={c} a={a} />
        ))}
        <button className="btn sm" onClick={() => addCustomAuth(c.id)}>
          <Plus size={12} /> Add auth method
        </button>
      </Section>
    </>
  );
}

function CustomAuthCard({ c, a }: { c: Collection; a: CustomAuth }) {
  const key = customSchemeKey(a.id);
  const scheme = collectionSchemes(c, {})[key];
  const set = (patch: Partial<CustomAuth>) => updateCustomAuth(c.id, a.id, patch);
  return (
    <div className="settings-card">
      <div className="row" style={{ marginBottom: 8 }}>
        <input className="input" style={{ fontWeight: 600 }} value={a.title} onChange={(e) => set({ title: e.target.value })} />
        <button className="icon-btn" aria-label="Remove auth method" onClick={() => removeCustomAuth(c.id, a.id)}>
          <Close size={12} />
        </button>
      </div>
      <div className="row" style={{ marginBottom: 8 }}>
        <select className="select" style={{ maxWidth: 170 }} value={a.kind} onChange={(e) => set({ kind: e.target.value as CustomAuth["kind"] })}>
          <option value="bearer">Bearer token</option>
          <option value="basic">Basic auth</option>
          <option value="apiKey">API key</option>
        </select>
        {a.kind === "apiKey" && (
          <>
            <select className="select" style={{ maxWidth: 110 }} value={a.in ?? "header"} onChange={(e) => set({ in: e.target.value as CustomAuth["in"] })}>
              <option value="header">Header</option>
              <option value="query">Query</option>
              <option value="cookie">Cookie</option>
            </select>
            <input className="input mono" placeholder="X-API-Key" value={a.param ?? ""} onChange={(e) => set({ param: e.target.value })} />
          </>
        )}
      </div>
      <SchemeFields collectionId={c.id} name={key} scheme={scheme} />
    </div>
  );
}

function Headers({ c }: { c: Collection }) {
  const client = c.headers?.client ?? {};
  const setClient = (name: string, patch: { off?: boolean; value?: string }) => {
    const k = name.toLowerCase();
    const next = { ...client[k], ...patch };
    const tidy = Object.fromEntries(Object.entries({ ...client, [k]: next }).filter(([, v]) => v.off || v.value));
    updateCollection(c.id, { headers: { ...c.headers, client: tidy } });
  };
  return (
    <>
      <Section title="Headers for every request" hint="Added to all requests of this collection. A header set on a request itself takes precedence.">
        <KVEditor rows={c.headers?.extra ?? []} onChange={(extra) => updateCollection(c.id, { headers: { ...c.headers, extra } })} />
      </Section>
      <Section title="Automatic headers" hint="Sent by the client unless turned off. Leave the value empty to use the default.">
        {CLIENT_HEADERS.map((h) => {
          const cfg = client[h.name.toLowerCase()] ?? {};
          const unavailable = h.nativeOnly && !isTauri;
          return (
            <div key={h.name} className="auto-cfg-row">
              <input
                type="checkbox"
                className="checkbox"
                checked={!cfg.off}
                disabled={!!h.required || unavailable}
                title={h.required}
                onChange={(e) => setClient(h.name, { off: !e.target.checked })}
              />
              <span className="mono small">{h.name}</span>
              <input
                className="input mono"
                placeholder={h.value(version)}
                value={cfg.value ?? ""}
                disabled={cfg.off || unavailable}
                spellCheck={false}
                onChange={(e) => setClient(h.name, { value: e.target.value })}
              />
            </div>
          );
        })}
        {!isTauri && <p className="form-hint">User-Agent and Accept-Encoding are set by the browser in the web preview.</p>}
      </Section>
    </>
  );
}

function Source({ c }: { c: Collection }) {
  const spec = useApp((s) => s.specs[c.id]);
  const watched = c.source.kind !== "paste";
  return (
    <>
      {c.pending && (
        <div className="banner info" style={{ margin: "0 0 16px" }}>
          <span className="grow">A newer version of this spec is waiting for review.</span>
          <button className="btn sm" onClick={() => setModal({ sync: c.id })}>
            Review
          </button>
        </div>
      )}
      <Section title="Source">
        <Field label="Location">
          <div className="mono small truncate selectable settings-value" title={c.source.location}>
            {c.source.kind === "paste" ? (c.source.location === "sample" ? "Bundled sample" : "Pasted / uploaded") : c.source.location}
          </div>
        </Field>
        <Field label="Version">
          <div className="small settings-value">
            {c.version || "—"}{" "}
            <span className="muted">
              · OpenAPI {spec?.openapi} · {spec?.endpoints.length ?? 0} endpoints · synced {new Date(c.syncedAt).toLocaleString()}
            </span>
          </div>
        </Field>
      </Section>
      {watched && (
        <Section title="Updates">
          <Field
            label="Watch for changes"
            hint={
              c.checkedAt ? (
                <>
                  Last checked {new Date(c.checkedAt).toLocaleString()}
                  {c.checkError && <div className="field-error">{c.checkError}</div>}
                </>
              ) : undefined
            }
          >
            <div className="row">
              <label className="row grow">
                <input type="checkbox" className="checkbox" checked={c.monitor} onChange={(e) => updateCollection(c.id, { monitor: e.target.checked })} />
                Check the source periodically
              </label>
              <button className="btn sm" onClick={() => checkForUpdates(c.id, { manual: true })}>
                <Refresh size={12} /> Check now
              </button>
            </div>
          </Field>
        </Section>
      )}
      {c.previous && (
        <Section title="Previous version">
          <div className="row">
            <span className="small muted grow">
              {c.previous.version || "unversioned"} (synced {new Date(c.previous.syncedAt).toLocaleDateString()})
            </span>
            <button className="btn sm" onClick={() => revertSync(c.id)}>
              Revert last sync
            </button>
          </div>
        </Section>
      )}
    </>
  );
}
