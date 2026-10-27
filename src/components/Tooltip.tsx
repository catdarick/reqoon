import { useEffect, useRef, useState } from "react";

const DELAY = 350; // ms before the first tooltip appears
const WARM = 400; // ms after a shown tooltip hides during which the next shows at once (moving along a toolbar)

interface Tip {
  text: string;
  x: number;
  y: number;
  above: boolean;
}

/**
 * App-wide replacement for native `title` tooltips, whose delay the webview fixes at about a
 * second. Any element with a title gets this one instead: the attribute is moved aside while
 * the pointer is over the element (so the native one never shows) and put back afterwards.
 */
export default function Tooltip() {
  const [tip, setTip] = useState<Tip | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    let target: HTMLElement | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let visible = false; // a tooltip is on screen (not merely pending)
    let hiddenAt = 0; // when the last visible tooltip went away

    const restore = () => {
      if (target && target.dataset.tipTitle !== undefined) {
        // React may have set a new title meanwhile; keep that one.
        if (!target.hasAttribute("title")) target.setAttribute("title", target.dataset.tipTitle);
        delete target.dataset.tipTitle;
      }
    };
    const hide = (e?: Event) => {
      clearTimeout(timer);
      restore();
      // Only a tooltip that was actually seen makes the next one instant; and not after a click.
      if (e?.type === "mousedown" || e?.type === "keydown") hiddenAt = 0;
      else if (visible) hiddenAt = Date.now();
      visible = false;
      target = null;
      setTip(null);
    };
    const show = (el: HTMLElement) => {
      const text = el.dataset.tipTitle;
      if (!text || !el.isConnected) return;
      visible = true;
      const r = el.getBoundingClientRect();
      const above = r.bottom + 40 > window.innerHeight;
      setTip({ text, x: r.left + r.width / 2, y: above ? r.top - 6 : r.bottom + 6, above });
    };

    const onOver = (e: MouseEvent) => {
      const el = (e.target as Element | null)?.closest?.<HTMLElement>("[title], [data-tip-title]");
      if (el === target) return;
      hide(e);
      if (!el || document.body.classList.contains("reordering")) return;
      const title = el.getAttribute("title");
      if (title === null || !title.trim()) return;
      el.dataset.tipTitle = title;
      el.removeAttribute("title");
      target = el;
      timer = setTimeout(() => show(el), Date.now() - hiddenAt < WARM ? 0 : DELAY);
    };
    const onOut = (e: MouseEvent) => {
      // Leaving the window, or moving to something outside the current target.
      if (target && (!e.relatedTarget || !target.contains(e.relatedTarget as Node))) hide(e);
    };

    document.addEventListener("mouseover", onOver);
    document.addEventListener("mouseout", onOut);
    // Clicking, typing or scrolling dismisses, like native tooltips.
    document.addEventListener("mousedown", hide, true);
    document.addEventListener("keydown", hide, true);
    document.addEventListener("wheel", hide, { capture: true, passive: true });
    window.addEventListener("blur", hide);
    return () => {
      hide();
      document.removeEventListener("mouseover", onOver);
      document.removeEventListener("mouseout", onOut);
      document.removeEventListener("mousedown", hide, true);
      document.removeEventListener("keydown", hide, true);
      document.removeEventListener("wheel", hide, { capture: true });
      window.removeEventListener("blur", hide);
    };
  }, []);

  // Measure, then keep the bubble inside the window.
  useEffect(() => {
    if (!tip || !box.current) return setPos(null);
    const w = box.current.offsetWidth;
    const h = box.current.offsetHeight;
    const left = Math.min(Math.max(8, tip.x - w / 2), window.innerWidth - w - 8);
    const top = tip.above ? Math.max(8, tip.y - h) : Math.min(tip.y, window.innerHeight - h - 8);
    setPos({ left, top });
  }, [tip]);

  if (!tip) return null;
  return (
    <div
      ref={box}
      className="tooltip"
      role="tooltip"
      style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: "hidden" }}
    >
      {tip.text}
    </div>
  );
}
