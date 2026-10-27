import { useApp } from "../store/app";

export default function Toasts() {
  const toasts = useApp((s) => s.toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <span className="dot" />
          <span className="selectable">{t.text}</span>
        </div>
      ))}
    </div>
  );
}
