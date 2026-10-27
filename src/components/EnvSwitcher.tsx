import { useEffect, useRef, useState } from "react";
import { setActiveEnv, setModal, useApp } from "../store/app";
import { envSupports, splitRequestKey } from "../lib/models";
import { Check, ChevronDown, Settings, Warning } from "./Icons";

const OPEN_EVENT = "reqoon:open-env-switcher";

export function openEnvSwitcher() {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

export default function EnvSwitcher() {
  const envs = useApp((s) => s.environments);
  const activeId = useApp((s) => s.activeEnvId);
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const active = envs.find((e) => e.id === activeId);
  // The collection of the open tab: environments meant for others are marked, not hidden.
  const collectionId = useApp((s) => (s.activeTab ? splitRequestKey(s.activeTab)[0] : null));
  const fits = (id: string | null) => !collectionId || envSupports(envs.find((e) => e.id === id), collectionId);
  const options = [{ id: null as string | null, name: "No environment", color: "transparent" }, ...envs];

  useEffect(() => {
    const onOpen = () => {
      setOpen(true);
      setSel(Math.max(0, options.findIndex((o) => o.id === activeId)));
    };
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  });

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
      else if (e.key === "ArrowDown") (e.preventDefault(), setSel((i) => (i + 1) % options.length));
      else if (e.key === "ArrowUp") (e.preventDefault(), setSel((i) => (i - 1 + options.length) % options.length));
      else if (e.key === "Enter") {
        e.preventDefault();
        setActiveEnv(options[sel].id);
        setOpen(false);
      } else if (/^[1-9]$/.test(e.key) && options[Number(e.key)]) {
        setActiveEnv(options[Number(e.key)].id);
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, sel, options]);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button className={`env-switch ${fits(activeId) ? "" : "mismatch"}`} onClick={() => setOpen(!open)}>
        {fits(activeId) ? (
          <span className="dot" style={{ background: active?.color ?? "var(--border-strong)" }} />
        ) : (
          <span className="warn-mark">
            <Warning size={12} />
          </span>
        )}
        <span className="truncate" style={{ maxWidth: 160 }}>{active?.name ?? "No environment"}</span>
        <ChevronDown size={12} />
      </button>
      {open && (
        <div className="menu env-menu">
          {options.map((o, i) => (
            <div
              key={o.id ?? "none"}
              className={`menu-item ${i === sel ? "sel" : ""} ${fits(o.id) ? "" : "other-env"}`}
              onMouseEnter={() => setSel(i)}
              onClick={() => {
                setActiveEnv(o.id);
                setOpen(false);
              }}
            >
              <span className="dot" style={{ background: o.color, border: o.id ? "none" : "1px solid var(--border-strong)" }} />
              <span className="grow truncate">{o.name}</span>
              {!fits(o.id) && <span className="sub">other collections</span>}
              {o.id === activeId && <Check size={13} />}
              {i > 0 && i < 10 && <span className="kbd">{i}</span>}
            </div>
          ))}
          <div className="menu-sep" />
          <div
            className="menu-item"
            onClick={() => {
              setOpen(false);
              setModal("environments");
            }}
          >
            <Settings size={13} /> Manage environments…
          </div>
        </div>
      )}
    </div>
  );
}
