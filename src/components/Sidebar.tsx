import { memo, useEffect, useMemo, useRef, useState } from "react";
import { checkForUpdates, moveCollection, openEndpoint, reveal, Selection, setCollapsedMany, setHideRules, setModal, setSelection, toast, toggleCollapsed, toggleShowHidden, updateSettings, useApp } from "../store/app";
import type { Collection } from "../lib/models";
import { baseRequestKey, requestKey, splitRequestKey } from "../lib/models";
import type { Endpoint, ParsedSpec } from "../lib/openapi";
import { matchEndpoint } from "../lib/search";
import { applyHidden, autoOpenChildren, buildTree, folderPathTo, subtreeKeys, TreeNode, UNTAGGED_FOLDER } from "../lib/tree";
import { addHideRule, endpointRule, hasRule, hiddenSet, HideTarget, hideMany, unhide, unhideMany } from "../lib/hide";
import { isMac } from "../lib/platform";
import { openContextMenu, MenuEntry } from "./ContextMenu";
import GroupModeMenu from "./GroupModeMenu";
import { useReorder } from "./useReorder";
import { methodBadge, methodWidth } from "./methods";
import HistoryList from "./HistoryList";
import { formatCombo } from "../lib/shortcuts";
import { ChevronRight, Close, Dots, Eye, EyeOff, Import, Layers, Plus, Refresh, Search, Settings, Warning } from "./Icons";

export default function Sidebar() {
  const collections = useApp((s) => s.collections);
  const query = useApp((s) => s.sidebarSearch);
  const searchKey = useApp((s) => s.settings.shortcuts.focusSearch);
  const view = useApp((s) => s.sidebarView);
  const tree = useRef<HTMLDivElement>(null);
  const reorder = useReorder({ axis: "y", container: tree, onMove: moveCollection });

  return (
    <aside className="sidebar">
      <div className="brand">
        <img className="brand-logo" src="/logo.svg" alt="" draggable={false} />
        <span>Reqoon</span>
        <span className="spacer" />
        <button className="icon-btn" title="Import OpenAPI spec" onClick={() => setModal("import")}>
          <Plus />
        </button>
      </div>
      <div className="side-views seg" role="tablist">
        <button role="tab" aria-selected={view === "collections"} className={view === "collections" ? "active" : ""} onClick={() => useApp.setState({ sidebarView: "collections" })}>
          Collections
        </button>
        <button role="tab" aria-selected={view === "history"} className={view === "history" ? "active" : ""} onClick={() => useApp.setState({ sidebarView: "history" })}>
          History
        </button>
      </div>
      <div className="side-search">
        <div style={{ position: "relative" }}>
          <span style={{ position: "absolute", left: 8, top: 7, color: "var(--text-3)" }}>
            <Search size={13} />
          </span>
          <input
            id="sidebar-search"
            className="input"
            style={{ paddingLeft: 26 }}
            placeholder={`${view === "history" ? "Filter history" : "Filter endpoints"}  ${formatCombo(searchKey)}`}
            value={query}
            spellCheck={false}
            onChange={(e) => useApp.setState({ sidebarSearch: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                useApp.setState({ sidebarSearch: "" });
                e.currentTarget.blur();
              }
              if (e.key === "Enter") {
                const first = document.querySelector<HTMLElement>(".tree .tree-ep, .history .history-row");
                first?.click();
              }
            }}
          />
        </div>
      </div>
      {view === "history" ? (
        <div className="tree">
          <HistoryList query={query} />
        </div>
      ) : (
        <div className="tree" ref={tree}>
          {collections.length === 0 && (
            <div className="empty" style={{ height: "auto", paddingTop: 40 }}>
              <div>
                <p>No collections yet.</p>
                <button className="btn primary" onClick={() => setModal("import")}>
                  <Import /> Import OpenAPI
                </button>
              </div>
            </div>
          )}
          {collections.map((c, i) => (
            <CollectionNode
              key={c.id}
              collection={c}
              query={query}
              dragClass={reorder.itemClass(c.id, i === collections.length - 1)}
              onDragStart={collections.length > 1 && !query.trim() ? reorder.onPointerDown : undefined}
            />
          ))}
        </div>
      )}
      <SelectionBar />
      <SidebarResizer />
      <div className="side-footer">
        <button className="btn ghost sm" onClick={() => setModal("environments")}>
          <Layers size={13} /> Environments
        </button>
        <span className="spacer" />
        <button className="icon-btn" title="Settings" onClick={() => setModal("settings")}>
          <Settings />
        </button>
      </div>
    </aside>
  );
}

const CollectionNode = memo(function CollectionNode({
  collection: c,
  query,
  dragClass,
  onDragStart,
}: {
  collection: Collection;
  query: string;
  dragClass: string;
  onDragStart?: (key: string, e: React.PointerEvent) => void;
}) {
  const spec = useApp((s) => s.specs[c.id]);
  const specError = useApp((s) => s.specErrors[c.id]);
  const collapsed = useApp((s) => s.collapsed);
  const revealed = useApp((s) => s.revealed);
  const activeTab = useApp((s) => s.activeTab);
  const mode = useApp((s) => c.groupMode ?? s.settings.defaultGroupMode);
  const showHidden = useApp((s) => !!s.showHidden[c.id]);
  const selection = useApp((s) => (s.selection?.collectionId === c.id && !s.selection.implicit ? s.selection : null));
  const selected = useMemo(() => new Set(selection?.keys), [selection]);
  const searching = query.trim() !== "";

  const hidden = useMemo(() => (spec ? hiddenSet(c.hideRules, spec.endpoints) : new Set<string>()), [spec, c.hideRules]);
  const fullTree = useMemo(() => (spec && !searching ? buildTree(spec, mode) : null), [spec, mode, searching]);
  const tree = useMemo(() => (fullTree ? applyHidden(fullTree, hidden, showHidden) : null), [fullTree, hidden, showHidden]);
  const fullNodes = useMemo(() => {
    const m = new Map<string, TreeNode>();
    const walk = (n: TreeNode) => (m.set(n.key, n), n.folders.forEach(walk));
    if (fullTree) walk(fullTree);
    return m;
  }, [fullTree]);
  const allResults = useMemo(() => (spec && searching ? searchEndpoints(spec, query) : []), [spec, query, searching]);
  const activeBase = activeTab ? baseRequestKey(activeTab) : null;
  const results = showHidden ? allResults : allResults.filter((e) => !hidden.has(e.id));
  const hiddenResults = allResults.filter((e) => hidden.has(e.id)).length;
  const resultsMethodWidth = methodWidth(results);
  const stateKey = `${c.id}#${mode}`;

  // Opening an endpoint anywhere (⌘E, tabs, restore) reveals it in the tree.
  useEffect(() => {
    if (!activeTab || !tree) return;
    const [cid, eid] = splitRequestKey(activeTab);
    if (cid !== c.id) return;
    const path = folderPathTo(tree, eid);
    if (path) reveal([c.id, ...path.map((k) => stateKey + k)]);
  }, [activeTab, tree, c.id, stateKey]);

  if (searching && allResults.length === 0) return null;
  const open = searching || !!revealed[c.id] || !collapsed[c.id];
  const big = (spec?.endpoints.length ?? 0) > 120;
  const ctx: TreeCtx = { collection: c, fullNodes, endpoints: spec?.endpoints ?? [], stateKey, collapsed, revealed, activeTab, big, showHidden, selected };

  return (
    <div className={`tree-coll ${dragClass}`} data-reorder-key={c.id}>
      <div
        className="tree-row coll"
        onPointerDown={onDragStart && ((e) => onDragStart(c.id, e))}
        onClick={() => toggleCollapsed(c.id, open)}
        onContextMenu={(e) => openContextMenu(e, collectionMenu(c, fullTree))}
        title={c.source.location}
      >
        <ChevronRight size={12} className={`chev ${open ? "open" : ""}`} />
        <span className="truncate grow">{c.name}</span>
        {c.pending && (
          <span
            className="badge accent"
            onClick={(e) => {
              e.stopPropagation();
              setModal({ sync: c.id });
            }}
            style={{ cursor: "pointer" }}
          >
            Update
          </span>
        )}
        {hidden.size > 0 && (
          <span
            className={`hidden-badge ${showHidden ? "on" : ""}`}
            title={showHidden ? "Hide them again" : `${hidden.size} endpoints hidden by this collection's rules — click to show`}
            onClick={(e) => {
              e.stopPropagation();
              toggleShowHidden(c.id);
            }}
          >
            <EyeOff size={11} /> {hidden.size}
          </span>
        )}
        {c.checkError && !c.pending && (
          <span title={c.checkError} style={{ color: "var(--warn)", display: "flex" }}>
            <Warning size={13} />
          </span>
        )}
        <span className="actions">
          <GroupModeMenu collection={c} />
          {c.source.kind !== "paste" && (
            <button
              className="icon-btn sm"
              title="Check for spec updates"
              onClick={(e) => {
                e.stopPropagation();
                checkForUpdates(c.id, { manual: true });
              }}
            >
              <Refresh size={12} />
            </button>
          )}
          <button
            className="icon-btn sm"
            title="Collection settings"
            onClick={(e) => {
              e.stopPropagation();
              setModal({ collection: c.id });
            }}
          >
            <Dots size={13} />
          </button>
        </span>
      </div>
      {open && specError && <div className="field-error" style={{ padding: "2px 12px" }}>{specError}</div>}
      {open &&
        searching &&
        results.map((e) => (
          <EndpointRow
            key={e.id}
            ctx={ctx}
            endpoint={e}
            label={e.path}
            methodWidth={resultsMethodWidth}
            hidden={hidden.has(e.id)}
            selected={selected.has(`e:${e.id}`)}
            active={activeBase === requestKey(c.id, e.id)}
            depth={0}
          />
        ))}
      {open && searching && hiddenResults > 0 && <HiddenRow count={hiddenResults} depth={0} ctx={ctx} />}
      {open && tree && <TreeChildren node={tree} depth={0} explicit={false} ctx={ctx} />}
      {open && !searching && (c.orphanedEndpoints?.length ?? 0) > 0 && (
        <OrphanGroup collection={c} activeTab={activeTab} open={!collapsed[`${c.id}#__orphans`]} />
      )}
    </div>
  );
});

function OrphanGroup({ collection: c, activeTab, open }: { collection: Collection; activeTab: string | null; open: boolean }) {
  const gk = `${c.id}#__orphans`;
  return (
    <div>
      <div className="tree-row tag" style={{ paddingLeft: 14, color: "var(--warn)" }} onClick={() => toggleCollapsed(gk, open)}>
        <ChevronRight size={11} className={`chev ${open ? "open" : ""}`} />
        <span className="truncate grow" title="Endpoints removed from the spec whose saved request values were kept">
          Removed endpoints
        </span>
        <span className="small">{c.orphanedEndpoints!.length}</span>
      </div>
      {open &&
        c.orphanedEndpoints!.map((id) => {
          const [method, ...rest] = id.split(" ");
          const key = requestKey(c.id, id);
          return (
            <div
              key={id}
              className={`tree-row tree-ep deprecated ${activeTab === key ? "active" : ""}`}
              style={{ paddingLeft: 30 }}
              onClick={() => useApp.setState((s) => ({ tabs: s.tabs.includes(key) ? s.tabs : [...s.tabs, key], activeTab: key }))}
            >
              <span className={`method m-${method}`}>{method}</span>
              <span className="truncate mono small ep-label">{rest.join(" ")}</span>
            </div>
          );
        })}
    </div>
  );
}

interface TreeCtx {
  collection: Collection;
  fullNodes: Map<string, TreeNode>; // folders of the unfiltered tree, by key
  endpoints: Endpoint[];
  stateKey: string; // collapse state is remembered per collection and grouping mode
  collapsed: Record<string, boolean>;
  revealed: Record<string, boolean>;
  activeTab: string | null;
  big: boolean;
  showHidden: boolean;
  selected: Set<string>; // multi-selection keys in this collection
}

const INDENT = 12;

function TreeChildren({ node, depth, ctx, explicit }: { node: TreeNode; depth: number; ctx: TreeCtx; explicit: boolean }) {
  const auto = autoOpenChildren(node, { explicit, big: ctx.big });
  const mw = methodWidth(node.items.map((i) => i.endpoint));
  return (
    <>
      {node.folders.map((f) => (
        <FolderNode key={f.key} node={f} depth={depth} ctx={ctx} autoOpen={auto.has(f.key)} />
      ))}
      {node.items.map((it) => (
        <EndpointRow
          key={it.endpoint.id}
          ctx={ctx}
          endpoint={it.endpoint}
          label={it.label}
          methodWidth={mw}
          hidden={!!it.hidden}
          selected={ctx.selected.has(`e:${it.endpoint.id}`)}
          active={!!ctx.activeTab && baseRequestKey(ctx.activeTab) === requestKey(ctx.collection.id, it.endpoint.id)}
          depth={depth}
        />
      ))}
      {!!node.hiddenHere && <HiddenRow count={node.hiddenHere} depth={depth} ctx={ctx} />}
    </>
  );
}

/** "N hidden" row where hidden endpoints are; toggles showing them (dimmed, in place) and
 *  stays put while they're shown so the same click hides them again. */
function HiddenRow({ count, depth, ctx }: { count: number; depth: number; ctx: TreeCtx }) {
  const shown = ctx.showHidden;
  return (
    <div
      className={`tree-row hidden-more ${shown ? "on" : ""}`}
      style={{ paddingLeft: 18 + depth * INDENT }}
      title={shown ? "Hide the hidden endpoints again" : "Hidden by this collection's hide rules — click to show them"}
      onClick={() => toggleShowHidden(ctx.collection.id, !shown)}
    >
      {shown ? <Eye size={11} /> : <EyeOff size={11} />}
      {shown ? `Hide ${count} again` : `${count} hidden`}
    </div>
  );
}

function editRules(c: Collection, next: string, message: string) {
  setHideRules(c.id, next);
  toast("success", message);
}

function endpointsIn(node: TreeNode): Endpoint[] {
  return [...node.items.map((i) => i.endpoint), ...node.folders.flatMap(endpointsIn)];
}

function collectionMenu(c: Collection, tree: TreeNode | null): MenuEntry[] {
  const mode = c.groupMode ?? useApp.getState().settings.defaultGroupMode;
  const folders = tree ? subtreeKeys(tree).slice(1).map((k) => `${c.id}#${mode}${k}`) : [];
  const items: MenuEntry[] = [];
  if (c.pending) items.push({ label: "Review update…", onClick: () => setModal({ sync: c.id }) });
  if (c.source.kind !== "paste") items.push({ label: "Check for updates", onClick: () => checkForUpdates(c.id, { manual: true }) });
  if (items.length) items.push("separator");
  if (folders.length)
    items.push(
      { label: "Expand all", onClick: () => (toggleCollapsed(c.id, false), setCollapsedMany(folders, false)) },
      { label: "Collapse all", onClick: () => setCollapsedMany(folders, true) },
      "separator",
    );
  // Hidden endpoints have their own badge on the row, and their rules live in the settings.
  items.push({ label: "Collection settings…", onClick: () => setModal({ collection: c.id }) });
  return items;
}

/**
 * The one rule that hides exactly this folder, or null when there's none: a path folder inside a
 * tag (combined mode) has a path that other tags' endpoints share, so it's hidden endpoint by endpoint.
 */
function folderRule(node: TreeNode, all: Endpoint[]): string | null {
  const rule = node.key === UNTAGGED_FOLDER ? "@untagged" : node.kind === "tag" ? `@tag:${node.label}` : node.path;
  if (!rule) return null;
  const inside = new Set(endpointsIn(node).map((e) => e.id));
  for (const id of hiddenSet(rule, all)) if (!inside.has(id)) return null;
  return rule;
}

function folderTargets(node: TreeNode, all: Endpoint[]): HideTarget[] {
  const rule = folderRule(node, all);
  const eps = endpointsIn(node);
  return rule ? [{ rule, endpoints: eps }] : eps.map((e) => ({ rule: endpointRule(e), endpoints: [e] }));
}

function folderMenu(node: TreeNode, ctx: TreeCtx, open: boolean): MenuEntry[] {
  const c = ctx.collection;
  // Look at the unfiltered folder: hidden endpoints aren't in `node` while they're not shown.
  const full = ctx.fullNodes.get(node.key) ?? node;
  const rule = folderRule(full, ctx.endpoints);
  const inside = endpointsIn(full);
  const hiddenNow = hiddenSet(c.hideRules, inside);
  const hiddenInside = inside.filter((e) => hiddenNow.has(e.id));
  const items: MenuEntry[] = [];
  if (!node.allHidden && inside.length)
    items.push({
      label: node.kind === "tag" ? `Hide tag “${node.label}”` : `Hide ${node.path ?? node.label}`,
      hint: `${node.count}`,
      onClick: () => editRules(c, hideMany(c.hideRules, folderTargets(full, ctx.endpoints)), `Hidden ${node.count} endpoints`),
    });
  if (hiddenInside.length)
    items.push({
      label: node.allHidden ? "Unhide folder" : "Unhide everything inside",
      hint: `${hiddenInside.length}`,
      onClick: () => editRules(c, unhide(c.hideRules, hiddenInside, rule ?? undefined), `Unhidden ${hiddenInside.length} endpoints`),
    });
  items.push(
    "separator",
    { label: open ? "Collapse all inside" : "Expand all inside", hint: "⌥ click", onClick: () => setCollapsedMany(subtreeKeys(node).map((k) => ctx.stateKey + k), open) },
    { label: "Edit hide rules…", onClick: () => setModal({ collection: c.id, section: "hidden" }) },
  );
  return items;
}

function FolderNode({ node, depth, ctx, autoOpen }: { node: TreeNode; depth: number; ctx: TreeCtx; autoOpen: boolean }) {
  const key = `${ctx.stateKey}${node.key}`;
  const choice = ctx.collapsed[key]; // true = closed by user, false = opened by user
  const open = !!ctx.revealed[key] || (choice === undefined ? autoOpen : !choice);
  const selKey = `f:${node.key}`;
  return (
    <div>
      <div
        className={`tree-row ${node.kind === "path" ? "folder" : "tag"} ${node.allHidden ? "is-hidden" : ""} ${ctx.selected.has(selKey) ? "selected" : ""}`}
        style={{ paddingLeft: 14 + depth * INDENT }}
        data-sel={selKey}
        onMouseDown={preventShiftSelect}
        onClick={(e) => {
          if (selectClick(e, ctx.collection.id, selKey)) return;
          // Alt-click opens or closes the whole subtree.
          if (e.altKey) setCollapsedMany(subtreeKeys(node).map((k) => ctx.stateKey + k), open);
          else toggleCollapsed(key, open);
        }}
        onContextMenu={(e) => rowMenu(e, ctx, selKey, () => folderMenu(node, ctx, open))}
      >
        <ChevronRight size={11} className={`chev ${open ? "open" : ""}`} />
        <span className={`truncate grow ${node.kind === "path" ? "mono small" : ""}`}>
          {node.label}
          {node.prefix && <span className="muted mono small"> {node.prefix}</span>}
        </span>
        {node.allHidden && <EyeOff size={11} />}
        <span className="muted small">{node.count}</span>
      </div>
      {/* Children only get the row budget when the user opened this folder themselves. */}
      {open && <TreeChildren node={node} depth={depth + 1} ctx={ctx} explicit={choice === false} />}
    </div>
  );
}

function endpointMenu(e: Endpoint, hidden: boolean, ctx: TreeCtx): MenuEntry[] {
  const c = ctx.collection;
  const items: MenuEntry[] = [
    { label: "Open", onClick: () => openEndpoint(c.id, e.id) },
    { label: "Open in new tab", hint: "⌥ click", onClick: () => openEndpoint(c.id, e.id, { newTab: true }) },
    "separator",
  ];
  if (hidden) items.push({ label: "Unhide endpoint", onClick: () => editRules(c, unhide(c.hideRules, [e]), `Unhidden ${endpointRule(e)}`) });
  else items.push({ label: "Hide endpoint", onClick: () => editRules(c, addHideRule(c.hideRules, endpointRule(e)), `Hidden ${endpointRule(e)}`) });
  if (e.deprecated && !hasRule(c.hideRules, "@deprecated")) {
    const n = ctx.endpoints.filter((x) => x.deprecated).length;
    items.push({ label: "Hide all deprecated endpoints", hint: `${n}`, onClick: () => editRules(c, addHideRule(c.hideRules, "@deprecated"), `Hidden ${n} deprecated endpoints`) });
  }
  items.push(
    "separator",
    { label: "Copy path", onClick: () => navigator.clipboard.writeText(e.path) },
    { label: "Edit hide rules…", onClick: () => setModal({ collection: c.id, section: "hidden" }) },
  );
  return items;
}

const EndpointRow = memo(function EndpointRow({
  ctx,
  endpoint: e,
  label,
  methodWidth,
  hidden,
  selected,
  active,
  depth,
}: {
  ctx: TreeCtx;
  endpoint: Endpoint;
  label: string;
  methodWidth: string;
  hidden: boolean;
  selected: boolean;
  active: boolean;
  depth: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest" });
  }, [active]);
  return (
    <div
      ref={ref}
      className={`tree-row tree-ep ${active ? "active" : ""} ${e.deprecated ? "deprecated" : ""} ${hidden ? "is-hidden" : ""} ${selected ? "selected" : ""}`}
      style={{ paddingLeft: 18 + depth * INDENT }}
      data-sel={`e:${e.id}`}
      title={e.summary || undefined}
      onMouseDown={(ev) => (preventShiftSelect(ev), ev.button === 1 && ev.preventDefault())}
      // ⌥-click or middle-click opens another tab of the endpoint.
      onClick={(ev) => selectClick(ev, ctx.collection.id, `e:${e.id}`) || openEndpoint(ctx.collection.id, e.id, { newTab: ev.altKey })}
      onAuxClick={(ev) => ev.button === 1 && openEndpoint(ctx.collection.id, e.id, { newTab: true })}
      onContextMenu={(ev) => rowMenu(ev, ctx, `e:${e.id}`, () => endpointMenu(e, hidden, ctx))}
    >
      <span className={`method m-${e.method}`} style={{ width: methodWidth }}>
        {methodBadge(e.method)}
      </span>
      <span className="truncate mono small ep-label grow">{label}</span>
      {hidden && <EyeOff size={11} />}
    </div>
  );
});

// ---------------------------------------------------------------------------------------------
// Width: drag the right edge, double-click it to reset.

const SIDEBAR_MIN = 200;
const SIDEBAR_DEFAULT = 290;

function clampSidebar(w: number): number {
  return Math.round(Math.max(SIDEBAR_MIN, Math.min(w, Math.max(SIDEBAR_MIN, window.innerWidth - 420))));
}

function SidebarResizer() {
  const [dragging, setDragging] = useState(false);
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const app = e.currentTarget.closest<HTMLElement>(".app");
    const startX = e.clientX;
    const startW = Math.round(e.currentTarget.parentElement!.getBoundingClientRect().width);
    let width = startW;
    setDragging(true);
    document.body.classList.add("resizing-x");
    // Update the CSS variable while dragging; save the setting once on release.
    const move = (ev: PointerEvent) => {
      width = clampSidebar(startW + ev.clientX - startX);
      app?.style.setProperty("--sidebar-w", `${width}px`);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing-x");
      setDragging(false);
      if (width !== startW) updateSettings({ sidebarWidth: width });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <div
      className={`sidebar-resizer ${dragging ? "dragging" : ""}`}
      onPointerDown={onPointerDown}
      onDoubleClick={() => updateSettings({ sidebarWidth: SIDEBAR_DEFAULT })}
    />
  );
}

// ---------------------------------------------------------------------------------------------
// Multi-selection, as in file managers: a plain click picks a row (and opens it), ⌘/Ctrl-click
// adds or removes one row, Shift-click selects every visible row from the last clicked one.

function preventShiftSelect(e: React.MouseEvent) {
  if (e.shiftKey) e.preventDefault(); // no text selection on shift-click
}

/** Handles selection clicks; returns true when the click was one (and shouldn't open anything). */
function selectClick(e: React.MouseEvent<HTMLElement>, collectionId: string, key: string): boolean {
  // macOS Ctrl-click is a right-click; ignore the click some browsers send along with the menu.
  if (isMac && e.ctrlKey && !e.metaKey) return true;
  const sel = useApp.getState().selection;
  const same = sel?.collectionId === collectionId ? sel : null;
  const toggle = isMac ? e.metaKey : e.ctrlKey;
  if (e.shiftKey) {
    const anchor = same?.anchor ?? activeRowKey(collectionId) ?? key;
    const rows = [...(e.currentTarget.closest(".tree-coll")?.querySelectorAll<HTMLElement>("[data-sel]") ?? [])].map((r) => r.dataset.sel!);
    const b = rows.indexOf(key);
    const a = rows.indexOf(anchor) < 0 ? b : rows.indexOf(anchor);
    const range = rows.slice(Math.min(a, b), Math.max(a, b) + 1);
    // ⇧⌘-click adds the range to an explicit selection.
    const base = toggle && same && !same.implicit ? same.keys : [];
    setSelection({ collectionId, keys: [...new Set([...base, ...range])], anchor });
    return true;
  }
  if (toggle) {
    // The row picked by the last plain click (or the open endpoint) becomes part of the selection.
    const start = same ? same.keys : [activeRowKey(collectionId)].filter((k): k is string => !!k);
    const keys = start.includes(key) ? start.filter((k) => k !== key) : [...start, key];
    setSelection({ collectionId, keys, anchor: key });
    return true;
  }
  setSelection({ collectionId, keys: [key], anchor: key, implicit: true });
  return false;
}

/** Selection key of the open endpoint when it belongs to this collection. */
function activeRowKey(collectionId: string): string | null {
  const tab = useApp.getState().activeTab;
  if (!tab) return null;
  const [cid, eid] = splitRequestKey(tab);
  return cid === collectionId ? `e:${eid}` : null;
}

/** Right-click on a selected row acts on the whole selection; elsewhere it drops the selection. */
function rowMenu(e: React.MouseEvent<HTMLElement>, ctx: TreeCtx, key: string, single: () => MenuEntry[]) {
  const sel = useApp.getState().selection;
  if (sel && ctx.selected.has(key) && sel.keys.length > 1) {
    const plan = bulkPlan(sel);
    if (plan) return openContextMenu(e, bulkMenu(plan));
  }
  setSelection(null);
  openContextMenu(e, single());
}

interface BulkPlan {
  collection: Collection;
  targets: HideTarget[];
  total: number; // distinct endpoints covered by the selection
  hiddenCount: number;
}

function bulkPlan(sel: Selection): BulkPlan | null {
  const s = useApp.getState();
  const c = s.collections.find((x) => x.id === sel.collectionId);
  const spec = s.specs[sel.collectionId];
  if (!c || !spec) return null;
  const nodes = new Map<string, TreeNode>();
  const walk = (n: TreeNode) => (nodes.set(n.key, n), n.folders.forEach(walk));
  walk(buildTree(spec, c.groupMode ?? s.settings.defaultGroupMode));

  const folders = sel.keys.flatMap((k) => (k.startsWith("f:") && nodes.has(k.slice(2)) ? [nodes.get(k.slice(2))!] : []));
  // A folder inside another selected folder is covered by the outer one.
  const nested = new Set(folders.flatMap((f) => subtreeKeys(f).slice(1)));
  const targets: HideTarget[] = [];
  const covered = new Set<string>();
  for (const f of folders) {
    if (nested.has(f.key)) continue;
    endpointsIn(f).forEach((e) => covered.add(e.id));
    targets.push(...folderTargets(f, spec.endpoints));
  }
  for (const k of sel.keys) {
    if (!k.startsWith("e:") || covered.has(k.slice(2))) continue;
    const e = spec.endpoints.find((x) => x.id === k.slice(2));
    if (e) (covered.add(e.id), targets.push({ rule: endpointRule(e), endpoints: [e] }));
  }
  const hidden = hiddenSet(c.hideRules, spec.endpoints.filter((e) => covered.has(e.id)));
  return { collection: c, targets, total: covered.size, hiddenCount: hidden.size };
}

function runBulk(plan: BulkPlan, action: "hide" | "unhide") {
  const c = plan.collection;
  if (action === "hide") editRules(c, hideMany(c.hideRules, plan.targets), `Hidden ${plan.total - plan.hiddenCount} endpoints`);
  else editRules(c, unhideMany(c.hideRules, plan.targets), `Unhidden ${plan.hiddenCount} endpoints`);
  setSelection(null);
}

function bulkMenu(plan: BulkPlan): MenuEntry[] {
  const items: MenuEntry[] = [];
  if (plan.hiddenCount < plan.total) items.push({ label: "Hide selected", hint: `${plan.total - plan.hiddenCount}`, onClick: () => runBulk(plan, "hide") });
  if (plan.hiddenCount > 0) items.push({ label: "Unhide selected", hint: `${plan.hiddenCount}`, onClick: () => runBulk(plan, "unhide") });
  items.push("separator", { label: "Clear selection", hint: "Esc", onClick: () => setSelection(null) });
  return items;
}

function SelectionBar() {
  const sel = useApp((s) => s.selection);
  const collections = useApp((s) => s.collections);
  const specs = useApp((s) => s.specs);
  const mode = useApp((s) => s.settings.defaultGroupMode);
  const plan = useMemo(() => (sel && !sel.implicit ? bulkPlan(sel) : null), [sel, collections, specs, mode]);
  const active = !!sel && !sel.implicit;
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || useApp.getState().modal) return;
      if ((e.target as HTMLElement | null)?.closest?.("input, textarea, .cm-editor")) return;
      setSelection(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);
  if (!sel || sel.implicit || !plan) return null;
  return (
    <div className="sel-bar">
      <span className="grow small truncate">
        {sel.keys.length} selected
      </span>
      {plan.hiddenCount < plan.total && (
        <button className="btn sm" onClick={() => runBulk(plan, "hide")}>
          <EyeOff size={12} /> Hide {plan.total - plan.hiddenCount}
        </button>
      )}
      {plan.hiddenCount > 0 && (
        <button className="btn sm" onClick={() => runBulk(plan, "unhide")}>
          <Eye size={12} /> Unhide {plan.hiddenCount}
        </button>
      )}
      <button className="icon-btn sm" title="Clear selection (Esc)" onClick={() => setSelection(null)}>
        <Close size={12} />
      </button>
    </div>
  );
}

function searchEndpoints(spec: ParsedSpec, query: string): Endpoint[] {
  return spec.endpoints
    .map((e) => ({ e, m: matchEndpoint(e, query) }))
    .filter((x) => x.m)
    .sort((a, b) => b.m!.score - a.m!.score)
    .map((x) => x.e);
}
