import { useState } from "react";
import {
  addEnvironment,
  duplicateEnvironment,
  newVar,
  removeEnvironment,
  setActiveEnv,
  updateEnvironment,
  updateVar,
  useApp,
  varValue,
} from "../store/app";
import Modal from "./Modal";
import { Check, Close, Copy, Lock, Pin, Plus, Trash } from "./Icons";
import { SecretInput } from "./AuthEditor";
import type { Environment } from "../lib/models";

const COLORS = ["#22c55e", "#f59e0b", "#ef4444", "#6366f1", "#06b6d4", "#ec4899", "#71717a"];

export default function EnvironmentsModal() {
  const envs = useApp((s) => s.environments);
  const activeId = useApp((s) => s.activeEnvId);
  const [sel, setSel] = useState<string | null>(activeId ?? envs[0]?.id ?? null);
  const env = envs.find((e) => e.id === sel) ?? envs[0];
  useApp((s) => s.vault); // re-render on secret edits
  const [confirmDelete, setConfirmDelete] = useState(false);
  const vars = env?.vars ?? [];

  return (
    <Modal title="Environments" wide>
      <div className="env-layout" style={{ margin: -16 }}>
        <div className="env-list">
          {envs.map((e) => (
            <div key={e.id} className={`env-item ${env?.id === e.id ? "sel" : ""}`} onClick={() => (setSel(e.id), setConfirmDelete(false))}>
              <span className="dot" style={{ background: e.color }} />
              <span className="grow truncate">{e.name}</span>
              {e.id === activeId && <Check size={12} />}
            </div>
          ))}
          <button
            className="btn ghost sm"
            style={{ marginTop: 6, justifyContent: "flex-start" }}
            onClick={() => setSel(addEnvironment(envs.length ? `Environment ${envs.length + 1}` : "Development"))}
          >
            <Plus size={12} /> New environment
          </button>
        </div>
        <div style={{ padding: 16, minWidth: 0 }}>
          {!env ? (
            <div className="empty">
              <div>
                <p>Environments hold variables such as base URLs and tokens. Reference them anywhere with {"{{name}}"}.</p>
                <button className="btn primary" onClick={() => setSel(addEnvironment("Development"))}>
                  <Plus size={12} /> Create environment
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="row" style={{ marginBottom: 14 }}>
                <input className="input" style={{ fontWeight: 600, maxWidth: 260 }} value={env.name} onChange={(e) => updateEnvironment(env.id, { name: e.target.value })} />
                <div className="row" style={{ gap: 4 }}>
                  {COLORS.map((c) => (
                    <button
                      key={c}
                      className="dot"
                      aria-label={`Color ${c}`}
                      onClick={() => updateEnvironment(env.id, { color: c })}
                      style={{ width: 14, height: 14, background: c, border: env.color === c ? "2px solid var(--text)" : "none", cursor: "pointer", padding: 0 }}
                    />
                  ))}
                </div>
                <span className="spacer" />
                {env.id !== activeId ? (
                  <button className="btn sm" onClick={() => setActiveEnv(env.id)}>
                    Use this environment
                  </button>
                ) : (
                  <span className="badge ok">Active</span>
                )}
                <button className="icon-btn" title="Duplicate" onClick={() => duplicateEnvironment(env.id)}>
                  <Copy />
                </button>
                {confirmDelete ? (
                  <button className="btn sm danger" onClick={() => (removeEnvironment(env.id), setSel(null), setConfirmDelete(false))}>
                    Delete “{env.name}”?
                  </button>
                ) : (
                  <button className="icon-btn" title="Delete environment" onClick={() => setConfirmDelete(true)}>
                    <Trash />
                  </button>
                )}
              </div>
              <EnvCollections env={env} />
              <div className="var-row section-title" style={{ margin: "0 0 6px" }}>
                <span />
                <span>Variable</span>
                <span>Value</span>
                <span title="Hot: pinned to the toolbar for quick edits">
                  <Pin size={11} />
                </span>
                <span title="Secret (stored in keychain)">
                  <Lock size={11} />
                </span>
                <span />
              </div>
              {vars.map((v) => (
                <div key={v.id} className="var-row">
                  <input type="checkbox" className="checkbox" checked={v.enabled} onChange={(e) => updateVar(env.id, v.id, { enabled: e.target.checked })} />
                  <input className="input mono" placeholder="name" value={v.key} spellCheck={false} onChange={(e) => updateVar(env.id, v.id, { key: e.target.value.replace(/[\s{}]/g, "") })} />
                  {v.secret ? (
                    <SecretInput value={varValue(env.id, v)} placeholder="secret value" onChange={(val) => updateVar(env.id, v.id, { value: val })} />
                  ) : (
                    <input className="input mono" placeholder="value" value={v.value} spellCheck={false} onChange={(e) => updateVar(env.id, v.id, { value: e.target.value })} />
                  )}
                  <button
                    className={`icon-btn pin-toggle ${v.hot ? "on" : ""}`}
                    title={v.hot ? "Unpin from the toolbar" : "Pin to the toolbar as a hot variable"}
                    aria-pressed={!!v.hot}
                    onClick={() => updateVar(env.id, v.id, { hot: !v.hot })}
                  >
                    <Pin size={12} />
                  </button>
                  <input
                    type="checkbox"
                    className="checkbox"
                    title="Secret: stored in the OS keychain and masked"
                    checked={v.secret}
                    onChange={(e) => updateVar(env.id, v.id, { secret: e.target.checked })}
                  />
                  <button className="icon-btn" aria-label="Remove variable" onClick={() => updateEnvironment(env.id, { vars: env.vars.filter((x) => x.id !== v.id) })}>
                    <Close size={12} />
                  </button>
                </div>
              ))}
              <button className="btn sm" onClick={() => updateEnvironment(env.id, { vars: [...env.vars, newVar()] })}>
                <Plus size={12} /> Add variable
              </button>
              <div className="form-hint" style={{ marginTop: 14 }}>
                Use <span className="mono">{"{{name}}"}</span> in URLs, params, headers, bodies, auth and other variables. Built-ins:{" "}
                <span className="mono">{"{{$uuid}} {{$timestamp}} {{$isoTimestamp}} {{$randomInt}}"}</span>. Mark tokens as secret
                to keep them in your system keychain instead of the data file. Pin values you change often (like a user id)
                to edit them right from the toolbar.
              </div>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** Which collections the environment is for. None picked = all; picking narrows it down. */
function EnvCollections({ env }: { env: Environment }) {
  const collections = useApp((s) => s.collections);
  if (!collections.length) return null;
  const picked = new Set(env.collections ?? []);
  const all = !collections.some((c) => picked.has(c.id));
  const toggle = (id: string) => {
    const next = picked.has(id) ? [...picked].filter((x) => x !== id) : [...picked, id];
    updateEnvironment(env.id, { collections: next.length ? next : undefined });
  };
  return (
    <div className="env-colls">
      <span className="section-title">Used with</span>
      <button className={`pill ${all ? "on" : ""}`} aria-pressed={all} onClick={() => updateEnvironment(env.id, { collections: undefined })}>
        All collections
      </button>
      {collections.map((c) => (
        <button key={c.id} className={`pill ${picked.has(c.id) ? "on" : ""}`} aria-pressed={picked.has(c.id)} onClick={() => toggle(c.id)}>
          {c.name}
        </button>
      ))}
    </div>
  );
}
