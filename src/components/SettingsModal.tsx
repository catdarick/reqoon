import { useState } from "react";
import { DEFAULT_SETTINGS, toast, updateSettings, useApp } from "../store/app";
import { canonical, DEFAULT_SHORTCUTS, eventToCombo, formatCombo, needsModifier, SHORTCUTS } from "../lib/shortcuts";
import { isTauri } from "../lib/platform";
import type { ThemePref } from "../lib/models";
import type { GroupMode } from "../lib/tree";
import { GROUP_MODES } from "./GroupModeMenu";
import Modal from "./Modal";
import { Refresh } from "./Icons";

type Section = "general" | "shortcuts" | "monitoring";

export default function SettingsModal() {
  const [section, setSection] = useState<Section>("general");
  return (
    <Modal title="Settings" wide>
      <div className="env-layout" style={{ margin: -16, gridTemplateColumns: "170px 1fr" }}>
        <div className="env-list">
          {(
            [
              ["general", "General"],
              ["shortcuts", "Keyboard shortcuts"],
              ["monitoring", "Spec monitoring"],
            ] as const
          ).map(([id, label]) => (
            <div key={id} className={`env-item ${section === id ? "sel" : ""}`} onClick={() => setSection(id)}>
              {label}
            </div>
          ))}
        </div>
        <div style={{ padding: 18, minWidth: 0 }}>
          {section === "general" && <General />}
          {section === "shortcuts" && <Shortcuts />}
          {section === "monitoring" && <Monitoring />}
        </div>
      </div>
    </Modal>
  );
}

function General() {
  const s = useApp((st) => st.settings);
  return (
    <>
      <div className="form-row">
        <label>Theme</label>
        <div className="seg" style={{ width: "fit-content" }}>
          {(["system", "light", "dark"] as ThemePref[]).map((t) => (
            <button key={t} className={s.theme === t ? "active" : ""} onClick={() => updateSettings({ theme: t })}>
              {t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
      </div>
      <div className="form-row">
        <label>Font size</label>
        <select className="select" style={{ width: 120 }} value={s.fontSize} onChange={(e) => updateSettings({ fontSize: Number(e.target.value) })}>
          {[12, 13, 14, 15].map((n) => (
            <option key={n} value={n}>
              {n}px
            </option>
          ))}
        </select>
      </div>
      <div className="form-row">
        <label>Request timeout</label>
        <div className="row">
          <input
            className="input"
            type="number"
            min={1}
            style={{ width: 100 }}
            value={s.requestTimeoutSec}
            onChange={(e) => updateSettings({ requestTimeoutSec: Math.max(1, Number(e.target.value) || 60) })}
          />
          <span className="muted">seconds</span>
        </div>
      </div>
      <div className="form-row">
        <label>Sidebar</label>
        <div className="col" style={{ gap: 6 }}>
          <label className="row">
            <span className="grow">Default grouping</span>
            <select
              className="select"
              style={{ width: 170 }}
              value={s.defaultGroupMode}
              onChange={(e) => updateSettings({ defaultGroupMode: e.target.value as GroupMode })}
            >
              {GROUP_MODES.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <div className="form-hint" style={{ marginTop: -2 }}>Each collection can override this from its menu in the sidebar.</div>
          <div className="form-hint" style={{ marginTop: 0 }}>
            To hide deprecated or unused endpoints, right-click them in the sidebar or edit a collection's hide rules.
          </div>
        </div>
      </div>
      <div className="form-row" style={{ alignItems: "flex-start" }}>
        <label>Privacy</label>
        <div className="form-hint" style={{ marginTop: 0 }}>
          Everything stays on this device. Collections and request values are saved in the app data folder; secrets and auth
          credentials are stored in the {isTauri ? "system keychain" : "browser session (keychain is available in the desktop app)"}.
          Requests are sent only to the servers you call.
        </div>
      </div>
    </>
  );
}

function Shortcuts() {
  const shortcuts = useApp((s) => s.settings.shortcuts);
  const [recording, setRecording] = useState<string | null>(null);

  const assign = (id: string, combo: string) => {
    const next = { ...shortcuts, [id]: combo };
    const clash = Object.entries(shortcuts).find(([k, v]) => k !== id && v && combo && canonical(v) === canonical(combo));
    if (clash) {
      next[clash[0]] = "";
      toast("info", `${formatCombo(combo)} was removed from “${SHORTCUTS.find((s) => s.id === clash[0])?.label}”`);
    }
    updateSettings({ shortcuts: next });
  };

  return (
    <>
      <div className="row" style={{ marginBottom: 10 }}>
        <span className="muted small grow">Click a shortcut and press the new key combination. Backspace clears, Esc cancels.</span>
        <button className="btn sm" onClick={() => updateSettings({ shortcuts: { ...DEFAULT_SHORTCUTS } })}>
          <Refresh size={12} /> Reset all
        </button>
      </div>
      {SHORTCUTS.map((def) => {
        const combo = shortcuts[def.id] ?? "";
        const rec = recording === def.id;
        return (
          <div key={def.id} className="shortcut-row">
            <span>{def.label}</span>
            <div
              tabIndex={0}
              role="button"
              data-recording={rec ? "1" : undefined}
              className={`shortcut-key ${rec ? "recording" : ""}`}
              onClick={() => setRecording(rec ? null : def.id)}
              onBlur={() => rec && setRecording(null)}
              onKeyDown={(e) => {
                if (!rec) {
                  if (e.key === "Enter" || e.key === " ") (e.preventDefault(), setRecording(def.id));
                  return;
                }
                e.preventDefault();
                e.stopPropagation();
                if (e.key === "Escape") return setRecording(null);
                if (e.key === "Backspace" || e.key === "Delete") {
                  assign(def.id, "");
                  return setRecording(null);
                }
                const c = eventToCombo(e.nativeEvent);
                if (!c) return;
                if (needsModifier(c)) {
                  toast("error", "Use ⌘/Ctrl or Alt — Shift alone would block typing");
                  return;
                }
                assign(def.id, c);
                setRecording(null);
              }}
            >
              {rec ? "Press keys…" : <span className="kbd" style={{ border: "none", background: "none" }}>{formatCombo(combo)}</span>}
            </div>
            {combo !== def.default ? (
              <button className="icon-btn" title={`Reset to ${formatCombo(def.default)}`} onClick={() => assign(def.id, def.default)}>
                <Refresh size={12} />
              </button>
            ) : (
              <span />
            )}
          </div>
        );
      })}
    </>
  );
}

function Monitoring() {
  const s = useApp((st) => st.settings);
  return (
    <>
      <div className="form-row">
        <label>Monitor specs</label>
        <label className="row">
          <input type="checkbox" className="checkbox" checked={s.monitorEnabled} onChange={(e) => updateSettings({ monitorEnabled: e.target.checked })} />
          Check imported specs for changes automatically
        </label>
      </div>
      <div className="form-row">
        <label>Remote specs (URL)</label>
        <div className="row">
          <span className="muted">every</span>
          <input
            className="input"
            type="number"
            min={1}
            style={{ width: 80 }}
            disabled={!s.monitorEnabled}
            value={s.remoteCheckMinutes}
            onChange={(e) => updateSettings({ remoteCheckMinutes: Math.max(1, Number(e.target.value) || DEFAULT_SETTINGS.remoteCheckMinutes) })}
          />
          <span className="muted">minutes, and when the window regains focus</span>
        </div>
      </div>
      <div className="form-row">
        <label>Local spec files</label>
        <div className="row">
          <span className="muted">every</span>
          <input
            className="input"
            type="number"
            min={1}
            style={{ width: 80 }}
            disabled={!s.monitorEnabled}
            value={s.fileCheckSeconds}
            onChange={(e) => updateSettings({ fileCheckSeconds: Math.max(1, Number(e.target.value) || DEFAULT_SETTINGS.fileCheckSeconds) })}
          />
          <span className="muted">seconds</span>
        </div>
      </div>
      <div className="form-hint">
        Changes are never applied automatically. A badge appears on the collection; review added, modified and removed endpoints
        and conflicts with your saved values, then sync with one click. Monitoring can also be turned off per collection.
      </div>
    </>
  );
}
