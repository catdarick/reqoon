import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { create } from "zustand";

export interface MenuItem {
  label: string;
  onClick?: () => void;
  danger?: boolean;
  hint?: string;
  disabled?: boolean;
}
export type MenuEntry = MenuItem | "separator";

const useMenu = create<{ x: number; y: number; items: MenuEntry[] } | null>(() => null);

export function openContextMenu(e: React.MouseEvent, items: MenuEntry[]) {
  e.preventDefault();
  e.stopPropagation();
  useMenu.setState({ x: e.clientX, y: e.clientY, items }, true);
}

function close() {
  useMenu.setState(null, true);
}

/** Single app-wide context menu; rendered once in App. */
export default function ContextMenu() {
  const menu = useMenu();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!menu || !ref.current) return setPos(null);
    // Keep the menu inside the window.
    const r = ref.current.getBoundingClientRect();
    setPos({
      left: Math.min(menu.x, window.innerWidth - r.width - 8),
      top: menu.y + r.height > window.innerHeight - 8 ? Math.max(8, menu.y - r.height) : menu.y,
    });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [menu]);

  if (!menu) return null;
  return (
    <div
      ref={ref}
      className="menu"
      role="menu"
      style={{ position: "fixed", left: pos?.left ?? menu.x, top: pos?.top ?? menu.y, right: "auto", visibility: pos ? "visible" : "hidden", zIndex: 70 }}
    >
      {menu.items.map((it, i) =>
        it === "separator" ? (
          <div key={i} className="menu-sep" />
        ) : (
          <div
            key={i}
            role="menuitem"
            className={`menu-item ${it.disabled ? "disabled" : ""}`}
            aria-disabled={it.disabled}
            style={it.danger ? { color: "var(--danger)" } : undefined}
            onClick={() => {
              if (it.disabled) return;
              close();
              it.onClick?.();
            }}
          >
            <span className="grow">{it.label}</span>
            {it.hint && <span className="muted small mono">{it.hint}</span>}
          </div>
        ),
      )}
    </div>
  );
}
