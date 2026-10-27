import { useEffect, useRef, useState } from "react";
import { mruTabs, useApp } from "../store/app";
import { splitRequestKey } from "../lib/models";
import { isMac } from "../lib/platform";

const SWITCH_EVENT = "reqoon:tab-switch";

/** Called for each Ctrl+Tab / Ctrl+Shift+Tab press (or whatever they're bound to). */
export function switchTab(dir: 1 | -1, combo: string) {
  window.dispatchEvent(new CustomEvent(SWITCH_EVENT, { detail: { dir, combo } }));
}

/** Modifiers that must stay down for the switcher to stay open (Shift only picks the direction). */
function heldModifiers(combo: string): ("ctrlKey" | "metaKey" | "altKey")[] {
  const out: ("ctrlKey" | "metaKey" | "altKey")[] = [];
  for (const part of combo.split("+")) {
    if (part === "Ctrl") out.push("ctrlKey");
    else if (part === "Meta" || part === "Cmd") out.push("metaKey");
    else if (part === "Alt") out.push("altKey");
    else if (part === "Mod") out.push(isMac ? "metaKey" : "ctrlKey");
  }
  return out;
}

interface SwitcherState {
  list: string[];
  index: number;
  mods: ReturnType<typeof heldModifiers>;
}

/**
 * VS Code-style tab switching: tabs in most recently used order, shown while the modifier is
 * held; each press moves the selection and releasing the modifier opens the selected tab.
 */
export default function TabSwitcher() {
  const [state, setRendered] = useState<SwitcherState | null>(null);
  // Key events can arrive faster than renders (a quick Ctrl+Tab tap), so handlers read the ref.
  const stateRef = useRef(state);
  const collections = useApp((s) => s.collections);
  const requests = useApp((s) => s.requests);

  useEffect(() => {
    const setState = (st: SwitcherState | null) => {
      stateRef.current = st;
      setRendered(st);
    };
    const commit = () => {
      const st = stateRef.current;
      if (st) useApp.setState({ activeTab: st.list[st.index] });
      setState(null);
    };
    const onSwitch = (e: Event) => {
      const { dir, combo } = (e as CustomEvent<{ dir: 1 | -1; combo: string }>).detail;
      const st = stateRef.current;
      if (st) {
        setState({ ...st, index: (st.index + dir + st.list.length) % st.list.length });
        return;
      }
      const list = mruTabs();
      if (list.length < 2) return;
      const mods = heldModifiers(combo);
      const index = dir === 1 ? 1 : list.length - 1;
      // Without a modifier to hold there is nothing to release: switch right away.
      if (!mods.length) return void useApp.setState({ activeTab: list[index] });
      setState({ list, index, mods });
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const st = stateRef.current;
      if (st && st.mods.every((m) => !e[m])) commit();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      const st = stateRef.current;
      if (!st) return;
      if (e.key === "Escape") {
        e.preventDefault();
        setState(null);
      } else if (e.key === "Enter") {
        e.preventDefault();
        commit();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const d = e.key === "ArrowDown" ? 1 : -1;
        setState({ ...st, index: (st.index + d + st.list.length) % st.list.length });
      }
    };
    const cancel = () => setState(null);
    window.addEventListener(SWITCH_EVENT, onSwitch);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener(SWITCH_EVENT, onSwitch);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", cancel);
    };
  }, []);

  if (!state) return null;
  const multi = collections.length > 1;
  return (
    <div className="tab-switcher" role="listbox" aria-label="Open tabs">
      {state.list.map((t, i) => {
        const [cid, eid] = splitRequestKey(t);
        const [method, ...rest] = eid.split(" ");
        return (
          <div
            key={t}
            role="option"
            aria-selected={i === state.index}
            className={`palette-item ${i === state.index ? "sel" : ""}`}
            onMouseDown={(e) => {
              e.preventDefault();
              useApp.setState({ activeTab: t });
              stateRef.current = null;
              setRendered(null);
            }}
          >
            <span className={`method m-${method}`}>{method}</span>
            <span className="grow truncate mono small">{rest.join(" ")}</span>
            {requests[t]?.tabTitle && <span className="small truncate">{requests[t].tabTitle}</span>}
            {multi && <span className="muted small truncate">{collections.find((c) => c.id === cid)?.name}</span>}
          </div>
        );
      })}
    </div>
  );
}
