import { useMemo, useState } from "react";
import { historyEntryOf, openHistoryEntry, toast, useApp } from "../store/app";
import { clearHistory, deleteHistoryEntry, HistoryEntry, useHistory } from "../store/history";
import { openContextMenu } from "./ContextMenu";
import { methodBadge, methodWidth } from "./methods";

/** Sent requests, newest first, grouped by day; a click reopens one with its response. */
export default function HistoryList({ query }: { query: string }) {
  const entries = useHistory((s) => s.entries);
  const collections = useApp((s) => s.collections);
  const activeTab = useApp((s) => s.activeTab);
  useApp((s) => s.responses); // the active entry changes when a tab sends again
  const [confirm, setConfirm] = useState(false);
  const activeEntry = activeTab ? historyEntryOf(activeTab) : undefined;
  const names = useMemo(() => new Map(collections.map((c) => [c.id, c.name])), [collections]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) =>
      `${e.request.method} ${e.endpointId} ${e.request.url} ${e.response?.status ?? "error"} ${names.get(e.collectionId) ?? ""}`.toLowerCase().includes(q),
    );
  }, [entries, query, names]);

  const groups = useMemo(() => {
    const out: { day: string; items: HistoryEntry[] }[] = [];
    for (const e of shown) {
      const day = dayLabel(e.at);
      if (out[out.length - 1]?.day !== day) out.push({ day, items: [] });
      out[out.length - 1].items.push(e);
    }
    return out;
  }, [shown]);
  const mw = methodWidth(shown.map((e) => ({ method: e.request.method })));

  if (!entries.length) {
    return (
      <div className="empty" style={{ height: "auto", paddingTop: 40 }}>
        <p className="muted small">Requests you send show up here.</p>
      </div>
    );
  }
  return (
    <div className="history">
      {!shown.length && <p className="muted small" style={{ padding: "8px 14px" }}>Nothing matches “{query}”.</p>}
      {groups.map((g) => (
        <div key={g.day}>
          <div className="history-day">{g.day}</div>
          {g.items.map((e) => (
            <HistoryRow
              key={e.id}
              e={e}
              active={e.id === activeEntry}
              methodWidth={mw}
              collection={collections.length > 1 ? names.get(e.collectionId) : undefined}
            />
          ))}
        </div>
      ))}
      <div className="history-foot">
        {confirm ? (
          <>
            <span className="small grow">Delete all {entries.length} entries?</span>
            <button className="btn sm" onClick={() => setConfirm(false)}>
              Cancel
            </button>
            <button className="btn sm danger" onClick={() => (clearHistory(), setConfirm(false))}>
              Clear
            </button>
          </>
        ) : (
          <button className="btn sm ghost" onClick={() => setConfirm(true)}>
            Clear history
          </button>
        )}
      </div>
    </div>
  );
}

function HistoryRow({ e, active, methodWidth, collection }: { e: HistoryEntry; active: boolean; methodWidth: string; collection?: string }) {
  const [, path = e.endpointId] = e.endpointId.split(" ");
  const status = e.response?.status;
  const cls = status === undefined ? "err" : `s${String(status)[0]}`;
  return (
    <div
      className={`tree-row history-row ${active ? "active" : ""}`}
      title={e.request.url}
      onClick={() => openHistoryEntry(e)}
      onContextMenu={(ev) =>
        openContextMenu(ev, [
          { label: "Open", onClick: () => openHistoryEntry(e) },
          {
            label: "Copy URL",
            onClick: () => void navigator.clipboard.writeText(e.request.url).then(() => toast("success", "URL copied")),
          },
          "separator",
          { label: "Delete entry", onClick: () => deleteHistoryEntry(e.id) },
        ])
      }
    >
      <span className={`method m-${e.request.method}`} style={{ width: methodWidth }}>
        {methodBadge(e.request.method)}
      </span>
      <span className="grow truncate">
        <span className="mono small">{path}</span>
        {collection && <span className="history-coll"> · {collection}</span>}
      </span>
      <span className={`history-status ${cls}`}>{status ?? "ERR"}</span>
      <span className="history-time">{new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
    </div>
  );
}

function dayLabel(at: number): string {
  const d = new Date(at);
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}
