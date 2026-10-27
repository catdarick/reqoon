import { ReactNode, useEffect } from "react";
import { setModal } from "../store/app";
import { Close } from "./Icons";

export default function Modal({
  title,
  children,
  footer,
  wide,
  onClose = () => setModal(null),
  headExtra,
}: {
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  onClose?: () => void;
  headExtra?: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !e.defaultPrevented && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? "wide" : ""}`} role="dialog" aria-modal="true">
        <div className="modal-head">
          <h3>{title}</h3>
          <span className="spacer" />
          {headExtra}
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Close />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}
