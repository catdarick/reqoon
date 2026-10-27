import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

const THRESHOLD = 4; // px the pointer must travel before a press becomes a drag

interface Drag {
  key: string;
  /** Insert before this key; null = at the end; undefined = the item stays where it is. */
  before?: string | null;
}

/**
 * Drag to reorder with plain pointer events (HTML5 drag-and-drop is unreliable inside the Tauri
 * webview). Items are the elements under `container` carrying `data-reorder-key`; a press only
 * turns into a drag after a few pixels, so clicks keep working.
 */
export function useReorder(opts: { axis: "x" | "y"; container: React.RefObject<HTMLElement>; onMove: (key: string, before: string | null) => void }) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const cleanup = useRef<() => void>();
  useEffect(() => () => cleanup.current?.(), []);

  // Stable, so memoised rows don't re-render because of it.
  const onPointerDown = useCallback((key: string, e: ReactPointerEvent) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if ((e.target as HTMLElement).closest("button, input, textarea, select, [data-no-drag]")) return;
    const { axis } = optsRef.current;
    const start = axis === "x" ? e.clientX : e.clientY;
    let started = false;
    let current: Drag = { key };
    let raf = 0;
    let last = start;

    const items = () => [...(optsRef.current.container.current?.querySelectorAll<HTMLElement>("[data-reorder-key]") ?? [])];
    const target = (pos: number): string | null | undefined => {
      const els = items();
      const keys = els.map((el) => el.dataset.reorderKey!);
      let before: string | null = null;
      for (const el of els) {
        const r = el.getBoundingClientRect();
        const mid = axis === "x" ? r.left + r.width / 2 : r.top + Math.min(r.height / 2, 14);
        if (pos < mid) {
          before = el.dataset.reorderKey!;
          break;
        }
      }
      // Dropping right before or after itself changes nothing.
      const i = keys.indexOf(key);
      if (before === key || before === (keys[i + 1] ?? null)) return undefined;
      return before;
    };
    // Keep scrolling while the pointer rests near an edge of a scrollable list.
    const autoscroll = (pos: number) => {
      const box = optsRef.current.container.current;
      if (!box) return;
      const r = box.getBoundingClientRect();
      const [lo, hi] = axis === "x" ? [r.left, r.right] : [r.top, r.bottom];
      const d = pos < lo + 30 ? -8 : pos > hi - 30 ? 8 : 0;
      if (d) {
        if (axis === "x") box.scrollLeft += d;
        else box.scrollTop += d;
      }
    };

    const move = (ev: PointerEvent) => {
      const pos = axis === "x" ? ev.clientX : ev.clientY;
      last = pos;
      if (!started) {
        if (Math.abs(pos - start) < THRESHOLD) return;
        started = true;
        document.body.classList.add("reordering");
      }
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        autoscroll(pos);
        current = { key, before: target(pos) };
        setDrag(current);
      });
    };
    const up = () => {
      const was = started;
      if (was) current = { key, before: target(last) };
      cleanup.current?.();
      if (!was) return;
      if (current.before !== undefined) optsRef.current.onMove(key, current.before);
      // The release also fires a click on the item; it must not count as one.
      const swallow = (ev: MouseEvent) => (ev.stopPropagation(), ev.preventDefault());
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
    };
    const cancel = (ev: KeyboardEvent) => ev.key === "Escape" && cleanup.current?.();

    cleanup.current?.();
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    window.addEventListener("keydown", cancel);
    cleanup.current = () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("keydown", cancel);
      document.body.classList.remove("reordering");
      cleanup.current = undefined;
      setDrag(null);
    };
  }, []);

  /** Class names for an item: the dragged one, and the drop marker before it / after the last one. */
  const itemClass = (key: string, last: boolean) => {
    if (!drag) return "";
    const cls: string[] = [];
    if (drag.key === key) cls.push("dragging");
    if (drag.before === key) cls.push("drop-before");
    if (last && drag.before === null) cls.push("drop-after");
    return cls.join(" ");
  };

  return { onPointerDown, itemClass, dragging: drag?.key ?? null };
}
