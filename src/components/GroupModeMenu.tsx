import { useEffect, useRef, useState } from "react";
import { updateCollection, useApp } from "../store/app";
import type { Collection } from "../lib/models";
import type { GroupMode } from "../lib/tree";
import { Check, Tree } from "./Icons";

export const GROUP_MODES: { id: GroupMode; label: string; hint: string }[] = [
  { id: "tag", label: "Tags", hint: "Folders from the spec's tags" },
  { id: "path", label: "Paths", hint: "Folders from URL segments" },
  { id: "combined", label: "Tags › Paths", hint: "Tag folders, grouped by path inside" },
  { id: "none", label: "Flat list", hint: "No folders" },
];

/** Per-collection grouping switcher shown in the sidebar row. */
export default function GroupModeMenu({ collection: c }: { collection: Collection }) {
  const fallback = useApp((s) => s.settings.defaultGroupMode);
  const mode = c.groupMode ?? fallback;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={ref} style={{ position: "relative", display: "flex" }} onClick={(e) => e.stopPropagation()}>
      <button
        className="icon-btn sm"
        title={`Group by: ${GROUP_MODES.find((m) => m.id === mode)?.label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Tree size={12} />
      </button>
      {open && (
        <div className="menu" role="menu" style={{ minWidth: 220 }}>
          <div className="muted small" style={{ padding: "4px 8px 6px" }}>
            Group endpoints by
          </div>
          {GROUP_MODES.map((m) => (
            <div
              key={m.id}
              role="menuitemradio"
              aria-checked={m.id === mode}
              className="menu-item"
              onClick={() => {
                updateCollection(c.id, { groupMode: m.id });
                setOpen(false);
              }}
            >
              <div className="grow">
                <div>{m.label}</div>
                <div className="muted small">{m.hint}</div>
              </div>
              {m.id === mode && <Check size={13} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
