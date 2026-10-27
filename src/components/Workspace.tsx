import { useEffect, useRef, useState } from "react";
import { closeTab, closeTabs, duplicateTab, getOp, hasClosedTabs, moveTab, renameTab, reopenClosedTab, setModal, useApp } from "../store/app";
import { useReorder } from "./useReorder";
import { baseRequestKey, splitRequestKey } from "../lib/models";
import { openContextMenu } from "./ContextMenu";
import { formatCombo } from "../lib/shortcuts";
import { Close, Import, Search } from "./Icons";
import EnvSwitcher from "./EnvSwitcher";
import HotVars from "./HotVars";
import RequestPanel from "./RequestPanel";
import ResponsePanel from "./ResponsePanel";
import OrphanPanel from "./OrphanPanel";

export default function Workspace() {
  const tabs = useApp((s) => s.tabs);
  const active = useApp((s) => s.activeTab);
  const quick = useApp((s) => s.settings.shortcuts.quickOpen);
  const pendingCount = useApp((s) => s.collections.filter((c) => c.pending).length);
  const firstPending = useApp((s) => s.collections.find((c) => c.pending)?.id);
  useApp((s) => s.specs); // re-render when specs change (sync / load)
  const tabBar = useRef<HTMLDivElement>(null);
  const reorder = useReorder({ axis: "x", container: tabBar, onMove: moveTab });

  return (
    <main className="main">
      <div className="topbar">
        <button className="btn ghost" onClick={() => setModal("palette")} style={{ color: "var(--text-3)", minWidth: 220, justifyContent: "flex-start" }}>
          <Search size={13} /> Search endpoints… <span className="spacer" /> <span className="kbd">{formatCombo(quick)}</span>
        </button>
        <span className="spacer" />
        {pendingCount > 0 && (
          <button className="btn sm pulse" onClick={() => firstPending && setModal({ sync: firstPending })}>
            {pendingCount} spec update{pendingCount > 1 ? "s" : ""}
          </button>
        )}
        <HotVars />
        <EnvSwitcher />
      </div>
      {tabs.length > 0 && (
        <div className="tabs" role="tablist" ref={tabBar}>
          {tabs.map((t, i) => (
            <Tab
              key={t}
              tabKey={t}
              active={t === active}
              linked={i > 0 && baseRequestKey(tabs[i - 1]) === baseRequestKey(t)}
              dragClass={reorder.itemClass(t, i === tabs.length - 1)}
              onDragStart={reorder.onPointerDown}
            />
          ))}
        </div>
      )}
      {active ? <ActiveRequest key={active} tabKey={active} /> : <EmptyState />}
    </main>
  );
}

function tabMenu(tabKey: string, shortcuts: Record<string, string>) {
  const { tabs } = useApp.getState();
  const i = tabs.indexOf(tabKey);
  return [
    { label: "Close", hint: formatCombo(shortcuts.closeTab), onClick: () => closeTab(tabKey) },
    { label: "Close others", disabled: tabs.length < 2, onClick: () => closeTabs(tabs.filter((t) => t !== tabKey)) },
    { label: "Close to the right", disabled: i === tabs.length - 1, onClick: () => closeTabs(tabs.slice(i + 1)) },
    { label: "Close all", hint: formatCombo(shortcuts.closeAllTabs), onClick: () => closeTabs(tabs) },
    "separator" as const,
    { label: "Duplicate tab", onClick: () => duplicateTab(tabKey) },
    { label: "Rename…", hint: "double-click", onClick: () => window.dispatchEvent(new CustomEvent(RENAME_EVENT, { detail: tabKey })) },
    "separator" as const,
    { label: "Reopen closed tab", hint: formatCombo(shortcuts.reopenTab), disabled: !hasClosedTabs(), onClick: reopenClosedTab },
  ];
}

const RENAME_EVENT = "reqoon:rename-tab";

function Tab({
  tabKey,
  active,
  linked,
  dragClass,
  onDragStart,
}: {
  tabKey: string;
  active: boolean;
  linked: boolean;
  dragClass: string;
  onDragStart: (key: string, e: React.PointerEvent) => void;
}) {
  const [, eid] = splitRequestKey(tabKey);
  const [method, ...rest] = eid.split(" ");
  const path = rest.join(" ");
  const loading = useApp((s) => !!s.inflight[tabKey]);
  const title = useApp((s) => s.requests[tabKey]?.tabTitle);
  // Position among the open tabs of the same endpoint (numbered only when there are several).
  const ordinal = useApp((s) => {
    const own = s.tabs.filter((t) => baseRequestKey(t) === baseRequestKey(tabKey));
    return own.length > 1 ? own.indexOf(tabKey) + 1 : 0;
  });
  const shortcuts = useApp((s) => s.settings.shortcuts);
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);
  useEffect(() => {
    const onRename = (e: Event) => (e as CustomEvent<string>).detail === tabKey && setEditing(true);
    window.addEventListener(RENAME_EVENT, onRename);
    return () => window.removeEventListener(RENAME_EVENT, onRename);
  }, [tabKey]);
  const short = path.split("/").filter(Boolean).slice(-2).join("/") || "/";
  return (
    <div
      ref={ref}
      role="tab"
      aria-selected={active}
      data-reorder-key={tabKey}
      className={`tab ${active ? "active" : ""} ${linked ? "linked" : ""} ${ordinal ? "multi" : ""} ${dragClass}`}
      onPointerDown={(e) => !editing && onDragStart(tabKey, e)}
      onClick={() => useApp.setState({ activeTab: tabKey })}
      onMouseDown={(e) => e.button === 1 && e.preventDefault()}
      onAuxClick={(e) => e.button === 1 && closeTab(tabKey)}
      onDoubleClick={() => setEditing(true)}
      onContextMenu={(e) => openContextMenu(e, tabMenu(tabKey, shortcuts))}
      title={`${eid}${title ? ` — ${title}` : ""}`}
    >
      <span className={`method m-${method}`}>{method}</span>
      {editing ? (
        <input
          className="tab-rename mono small"
          autoFocus
          defaultValue={title ?? ""}
          placeholder={short}
          onClick={(e) => e.stopPropagation()}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => (renameTab(tabKey, e.currentTarget.value), setEditing(false))}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") setEditing(false);
          }}
        />
      ) : (
        <span className={`truncate grow small ${title ? "tab-title" : "mono"}`}>{title ?? short}</span>
      )}
      {ordinal > 0 && !editing && <span className="tab-n">{ordinal}</span>}
      {loading ? (
        <span className="spin" style={{ color: "var(--text-3)", margin: "0 7px" }} />
      ) : (
        <button
          className="icon-btn sm"
          onClick={(e) => {
            e.stopPropagation();
            closeTab(tabKey);
          }}
          aria-label="Close tab"
        >
          <Close size={11} />
        </button>
      )}
    </div>
  );
}

function ActiveRequest({ tabKey }: { tabKey: string }) {
  const info = getOp(tabKey);
  const [split, setSplit] = useState(() => Number(localStorageGet("reqoon:split") ?? 0.52));
  const [vertical, setVertical] = useState(false);
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setVertical(e.contentRect.width < 820));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (!info) return <OrphanPanel tabKey={tabKey} />;

  const onDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const rect = container.current!.getBoundingClientRect();
    const move = (ev: MouseEvent) => {
      const r = vertical ? (ev.clientY - rect.top) / rect.height : (ev.clientX - rect.left) / rect.width;
      setSplit(Math.min(0.8, Math.max(0.2, r)));
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      setSplit((v) => (localStorageSet("reqoon:split", String(v)), v));
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const tpl = `${split}fr 1px ${1 - split}fr`;
  return (
    <div
      ref={container}
      className={`split ${vertical ? "vertical" : ""}`}
      style={vertical ? { gridTemplateRows: tpl } : { gridTemplateColumns: tpl }}
    >
      <RequestPanel tabKey={tabKey} />
      <div className="split-handle" onMouseDown={onDrag} style={vertical ? { cursor: "row-resize" } : undefined} />
      <ResponsePanel tabKey={tabKey} />
    </div>
  );
}

function EmptyState() {
  const hasCollections = useApp((s) => s.collections.length > 0);
  const quick = useApp((s) => s.settings.shortcuts.quickOpen);
  return (
    <div className="empty">
      <div>
        <h2>{hasCollections ? "Pick an endpoint" : "Welcome to Reqoon"}</h2>
        <p>
          {hasCollections ? (
            <>
              Choose one from the sidebar or press <span className="kbd">{formatCombo(quick)}</span> to search.
            </>
          ) : (
            "Import an OpenAPI 3.0 / 3.1 spec to generate a collection of requests."
          )}
        </p>
        {!hasCollections && (
          <button className="btn primary" onClick={() => setModal("import")}>
            <Import /> Import OpenAPI spec
          </button>
        )}
      </div>
    </div>
  );
}

function localStorageGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}

function localStorageSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
}
