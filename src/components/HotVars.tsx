import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { rememberVarValue, setModal, updateVar, useApp, varValue } from "../store/app";
import type { EnvVar } from "../lib/models";
import { openContextMenu } from "./ContextMenu";

/** Focuses the first hot variable in the toolbar, or opens the environments editor if there's none. */
export function focusHotVars() {
  const input = document.querySelector<HTMLInputElement>(".hot-var input");
  if (input) input.focus();
  else setModal("environments");
}

/** Hot variables of the active environment, editable right in the toolbar. */
export default function HotVars() {
  const env = useApp((s) => s.environments.find((e) => e.id === s.activeEnvId));
  useApp((s) => s.vault); // secret values live in the vault
  const hot = env?.vars.filter((v) => v.hot && v.enabled && v.key) ?? [];
  if (!env || !hot.length) return null;
  return (
    <div className="hot-vars">
      {hot.map((v) => (
        <HotVar key={v.id} envId={env.id} v={v} />
      ))}
    </div>
  );
}

function HotVar({ envId, v }: { envId: string; v: EnvVar }) {
  const value = varValue(envId, v);
  const before = useRef(value); // value when editing started: Escape restores it, blur records it
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [sel, setSel] = useState(-1);
  const box = useRef<HTMLDivElement>(null);
  const recent = v.secret ? [] : (v.recent ?? []).filter((r) => r !== value);

  const set = (val: string) => updateVar(envId, v.id, { value: val });
  const commit = () => {
    rememberVarValue(envId, v.id, before.current);
    before.current = varValue(envId, v);
    setMenu(null);
  };
  const openMenu = () => {
    const r = box.current!.getBoundingClientRect();
    setMenu({ x: r.left, y: r.bottom + 4 });
    setSel(-1);
  };

  return (
    <div
      ref={box}
      className="hot-var"
      onContextMenu={(e) =>
        openContextMenu(e, [
          { label: "Unpin from toolbar", onClick: () => updateVar(envId, v.id, { hot: false }) },
          ...(v.recent?.length ? [{ label: "Clear recent values", onClick: () => updateVar(envId, v.id, { recent: [] }) }] : []),
          "separator" as const,
          { label: "Manage environments…", onClick: () => setModal("environments") },
        ])
      }
    >
      <label className="hot-key mono" htmlFor={`hot-${v.id}`}>
        {v.key}
      </label>
      <input
        id={`hot-${v.id}`}
        className="hot-input mono"
        type={v.secret ? "password" : "text"}
        value={value}
        placeholder="not set"
        spellCheck={false}
        autoComplete="off"
        style={{ width: `calc(${Math.min(22, Math.max(7, value.length + 1))}ch + 16px)` }}
        onFocus={(e) => {
          before.current = value;
          e.currentTarget.select();
          if (recent.length) openMenu();
        }}
        onBlur={commit}
        onChange={(e) => set(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            if (menu && sel >= 0 && recent[sel] !== undefined) set(recent[sel]);
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            set(before.current);
            setMenu(null);
            e.currentTarget.blur();
          } else if (e.key === "ArrowDown" && recent.length) {
            e.preventDefault();
            if (!menu) openMenu();
            setSel((i) => Math.min(recent.length - 1, i + 1));
          } else if (e.key === "ArrowUp" && menu) {
            e.preventDefault();
            setSel((i) => Math.max(-1, i - 1));
          }
        }}
      />
      {menu && recent.length > 0 && createPortal(
        // Portalled: the toolbar clips overflow and its ancestors offset fixed positioning.
        <div className="menu hot-menu" style={{ left: menu.x, top: menu.y }}>
          <div className="section-title" style={{ padding: "4px 8px" }}>Recent</div>
          {recent.map((r, i) => (
            <div
              key={r}
              className={`menu-item mono small ${i === sel ? "sel" : ""}`}
              onMouseEnter={() => setSel(i)}
              // mousedown keeps focus in the input until the value is set
              onMouseDown={(e) => {
                e.preventDefault();
                set(r);
                (document.getElementById(`hot-${v.id}`) as HTMLInputElement | null)?.blur();
              }}
            >
              {r}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
