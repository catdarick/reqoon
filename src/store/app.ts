import { create } from "zustand";
import {
  AuthConfig,
  Collection,
  CollectionSource,
  Environment,
  EnvVar,
  RequestState,
  ResponseData,
  Settings,
  requestKey,
  splitRequestKey,
  baseRequestKey,
  isCopyKey,
  newCopyKey,
  envSupports,
  CustomAuth,
  uid,
} from "../lib/models";
import { bundleRefs, hasExternalRefs } from "../lib/bundle";
import { buildSpec, getOperation, hashText, OperationInfo, ParsedSpec, storedSpecText } from "../lib/openapi";
import { parseSpecAsync } from "../lib/parseAsync";
import * as platform from "../lib/platform";
import { DEFAULT_SHORTCUTS } from "../lib/shortcuts";
import { defaultValue, Json } from "../lib/schema";
import { stringifyJson } from "../lib/json";
import { version } from "../../package.json";
import { computeSyncDiff, SyncDiffResult } from "../lib/syncDiff";
import { HistoryEntry, recordHistory } from "./history";
import { buildRequest, customSchemeKey, isStructuredType, toCurl } from "../lib/request";
import { envVarMap, secretKey } from "../lib/vars";
import { hasUserData } from "../lib/diff";

const STATE_VERSION = 1;

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  shortcuts: { ...DEFAULT_SHORTCUTS },
  monitorEnabled: true,
  remoteCheckMinutes: 15,
  fileCheckSeconds: 5,
  requestTimeoutSec: 60,
  defaultGroupMode: "tag",
  wrapResponse: false,
  fontSize: 13,
  sidebarWidth: 290,
  showAutoHeaders: true,
};

export type ResponseEntry = ResponseData | { error: string; at: number; url: string; method: string };

export interface Toast {
  id: string;
  kind: "info" | "success" | "error";
  text: string;
}

export type CollectionSection = "general" | "auth" | "headers" | "hidden" | "source";
type Modal = null | "import" | "environments" | "settings" | "palette" | { sync: string } | { collection: string; section?: CollectionSection };

interface Vault {
  secrets: Record<string, string>;
  auth: AuthConfig;
}

interface AppState {
  loaded: boolean;
  collections: Collection[];
  specs: Record<string, ParsedSpec>;
  specErrors: Record<string, string>;
  environments: Environment[];
  activeEnvId: string | null;
  vault: Vault;
  requests: Record<string, RequestState>;
  responses: Record<string, ResponseEntry>;
  inflight: Record<string, string>;
  tabs: string[];
  activeTab: string | null;
  settings: Settings;
  collapsed: Record<string, boolean>;
  /** Folders opened to reveal the active endpoint (not remembered as a user choice). */
  revealed: Record<string, boolean>;
  /** Collections currently showing their hidden endpoints (not persisted). */
  showHidden: Record<string, boolean>;
  /** Sidebar multi-selection within one collection: "e:<endpoint id>" / "f:<folder key>" (not persisted). */
  selection: Selection | null;
  modal: Modal;
  toasts: Toast[];
  sidebarSearch: string;
  sidebarView: "collections" | "history";
}

const initial: AppState = {
  loaded: false,
  collections: [],
  specs: {},
  specErrors: {},
  environments: [],
  activeEnvId: null,
  vault: { secrets: {}, auth: {} },
  requests: {},
  responses: {},
  inflight: {},
  tabs: [],
  activeTab: null,
  settings: DEFAULT_SETTINGS,
  collapsed: {},
  revealed: {},
  showHidden: {},
  selection: null,
  modal: null,
  toasts: [],
  sidebarSearch: "",
  sidebarView: "collections",
};

export const useApp = create<AppState>(() => initial);
const set = useApp.setState;
const get = useApp.getState;

// ---------------------------------------------------------------------------------------------
// Persistence

interface PersistedState {
  v: number;
  collections: Collection[];
  environments: Environment[];
  activeEnvId: string | null;
  requests: Record<string, RequestState>;
  tabs: string[];
  activeTab: string | null;
  settings: Settings;
  collapsed: Record<string, boolean>;
}

let loadedOk = false;
/** False when the keychain couldn't be read (denied, locked): writing then would replace every
 *  stored secret with just the ones edited this session. */
let vaultReadable = true;

export async function init() {
  try {
    const [raw, vaultRaw] = await Promise.all([platform.loadState("state"), platform.secretGet("vault").catch((e) => {
      vaultReadable = false;
      toast("error", `Could not read secrets from the keychain (${e}). Saved secrets are unavailable; edits will be saved once it can be read.`);
      return null;
    })]);
    const vault: Vault = vaultRaw ? { secrets: {}, auth: {}, ...JSON.parse(vaultRaw) } : { secrets: {}, auth: {} };
    if (raw) {
      const p = JSON.parse(raw) as PersistedState;
      const settings = { ...DEFAULT_SETTINGS, ...p.settings, shortcuts: { ...DEFAULT_SHORTCUTS, ...p.settings?.shortcuts } };
      // Pre-groupMode data stored a boolean.
      const legacy = p.settings as Partial<Settings> & { groupByTag?: boolean };
      if (legacy?.groupByTag === false && !legacy.defaultGroupMode) settings.defaultGroupMode = "none";
      delete (settings as { groupByTag?: boolean }).groupByTag;
      // "Show deprecated" used to be a global switch; it's now a per-collection hide rule.
      const hideDeprecated = (p.settings as { showDeprecated?: boolean } | undefined)?.showDeprecated === false;
      delete (settings as { showDeprecated?: boolean }).showDeprecated;
      if (hideDeprecated) p.collections = (p.collections ?? []).map((c) => (c.hideRules === undefined ? { ...c, hideRules: "@deprecated" } : c));
      set({
        // A pending update joins once its text is loaded (loadPending), so it's never compared empty.
        collections: (p.collections ?? []).map((c) => (c.pending ? { ...c, pending: undefined } : c)),
        environments: p.environments ?? [],
        activeEnvId: p.activeEnvId ?? null,
        requests: p.requests ?? {},
        tabs: p.tabs ?? [],
        activeTab: p.activeTab ?? null,
        settings,
        collapsed: p.collapsed ?? {},
        vault,
      });
      await Promise.all((p.collections ?? []).map((c) => Promise.all([loadSpec(c.id), loadPending(c)])));
    } else {
      set({ vault });
    }
    loadedOk = true;
  } catch (e) {
    // Never overwrite saved data we failed to read.
    toast("error", `Could not load saved data: ${e}`);
  }
  set({ loaded: true });
}

async function loadSpec(id: string) {
  const text = await platform.loadState(`spec_${id}`);
  if (text == null) {
    set((s) => ({ specErrors: { ...s.specErrors, [id]: "Spec file missing from local storage" } }));
    return;
  }
  try {
    const c = get().collections.find((x) => x.id === id);
    const doc = await parseSpecAsync(text);
    const spec = buildSpec(doc, c?.source.kind === "url" ? c.source.location : undefined);
    set((s) => ({ specs: { ...s.specs, [id]: spec } }));
    // Specs saved by older versions as YAML are rewritten once, so later launches parse JSON.
    const stored = storedSpecText(text, doc);
    if (stored !== text) await platform.saveState(`spec_${id}`, stored);
  } catch (e) {
    set((s) => ({ specErrors: { ...s.specErrors, [id]: String(e) } }));
  }
}

/** Pending update texts are kept in their own files, not in state.json (which is rewritten on
 *  every change and would carry megabytes of spec along). */
const pendingFile = (id: string) => `spec_${id}_pending`;

async function loadPending(c: Collection) {
  if (!c.pending) return;
  // Older versions kept the text inline in state.json.
  const inline = c.pending.specText;
  const specText = inline || (await platform.loadState(pendingFile(c.id)).catch(() => null));
  if (inline) await platform.saveState(pendingFile(c.id), inline);
  if (!specText) return;
  set((s) => ({ collections: s.collections.map((x) => (x.id === c.id ? { ...x, pending: { ...c.pending!, specText } } : x)) }));
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
let vaultTimer: ReturnType<typeof setTimeout> | undefined;

useApp.subscribe((s, prev) => {
  if (!loadedOk) return;
  if (
    s.collections !== prev.collections ||
    s.environments !== prev.environments ||
    s.activeEnvId !== prev.activeEnvId ||
    s.requests !== prev.requests ||
    s.tabs !== prev.tabs ||
    s.activeTab !== prev.activeTab ||
    s.settings !== prev.settings ||
    s.collapsed !== prev.collapsed
  ) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persistNow, 400);
  }
  if (s.vault !== prev.vault) {
    clearTimeout(vaultTimer);
    vaultTimer = setTimeout(() => void writeVault(), 600);
  }
});

async function writeVault() {
  vaultTimer = undefined;
  if (!vaultReadable) {
    // Merge with what's stored first, so the session's edits don't replace the rest.
    let raw: string | null;
    try {
      raw = await platform.secretGet("vault");
    } catch (e) {
      toast("error", `Secrets not saved: the keychain can't be read (${e})`);
      return;
    }
    vaultReadable = true;
    if (raw) set((s) => ({ vault: mergeVault(JSON.parse(raw!), s.vault) }));
  }
  await platform.secretSet("vault", JSON.stringify(get().vault)).catch((e) => toast("error", `Keychain error: ${e}`));
}

function mergeVault(stored: Partial<Vault>, edits: Vault): Vault {
  const auth: AuthConfig = { ...stored.auth };
  for (const [k, v] of Object.entries(edits.auth)) auth[k] = { ...auth[k], ...v };
  return { secrets: { ...stored.secrets, ...edits.secrets }, auth };
}

/** Writes anything still waiting on a debounce timer. */
async function flushPending() {
  if (!loadedOk) return;
  clearTimeout(saveTimer);
  const pendingVault = vaultTimer !== undefined;
  clearTimeout(vaultTimer);
  await Promise.all([persistNow(), pendingVault ? writeVault() : undefined]);
}

function persistNow() {
  const s = get();
  const data: PersistedState = {
    v: STATE_VERSION,
    collections: s.collections.map((c) => (c.pending ? { ...c, pending: { ...c.pending, specText: "" } } : c)),
    // Secret values never touch the state file; they live in the keychain vault.
    environments: s.environments.map((e) => ({ ...e, vars: e.vars.map((v) => (v.secret ? { ...v, value: "", recent: undefined } : v)) })),
    activeEnvId: s.activeEnvId,
    requests: s.requests,
    tabs: s.tabs,
    activeTab: s.activeTab,
    settings: s.settings,
    collapsed: s.collapsed,
  };
  return platform.saveState("state", JSON.stringify(data)).catch((e) => toast("error", `Could not save: ${e}`));
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => void flushPending());
  void platform.onExitRequested(flushPending);
}

// ---------------------------------------------------------------------------------------------
// UI helpers

export function toast(kind: Toast["kind"], text: string) {
  const id = uid();
  set((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, text }] }));
  setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === "error" ? 7000 : 3500);
}

export function setModal(modal: Modal) {
  set({ modal });
}

export function updateSettings(patch: Partial<Settings>) {
  set((s) => ({ settings: { ...s.settings, ...patch } }));
}

export function toggleCollapsed(key: string, value?: boolean) {
  setCollapsedMany([key], value ?? !get().collapsed[key]);
}

/** Records the user's open/closed choice for folders; overrides auto-expansion and reveals. */
export function setCollapsedMany(keys: string[], collapsed: boolean) {
  set((s) => {
    const c = { ...s.collapsed };
    const r = { ...s.revealed };
    for (const k of keys) {
      c[k] = collapsed;
      delete r[k];
    }
    return { collapsed: c, revealed: r };
  });
}

export function setHideRules(collectionId: string, rules: string) {
  updateCollection(collectionId, { hideRules: rules });
}

export function toggleShowHidden(collectionId: string, value?: boolean) {
  set((s) => ({ showHidden: { ...s.showHidden, [collectionId]: value ?? !s.showHidden[collectionId] } }));
}

export interface Selection {
  collectionId: string;
  keys: string[];
  anchor: string | null; // where shift-click ranges start
  /** Set by a plain click: remembers the clicked row as the anchor and the start of a ⌘-click
   *  selection, but isn't shown as a selection yet. */
  implicit?: boolean;
}

export function setSelection(selection: Selection | null) {
  if (!selection?.keys.length) selection = null;
  if (selection || get().selection) set({ selection });
}

export function reveal(keys: string[]) {
  const s = get();
  if (keys.every((k) => s.revealed[k] || s.collapsed[k] === false)) return;
  set({ revealed: { ...s.revealed, ...Object.fromEntries(keys.map((k) => [k, true])) } });
}

// ---------------------------------------------------------------------------------------------
// Collections

export async function loadSpecFromSource(
  source: CollectionSource,
  text?: string,
): Promise<{ text: string; modifiedMs?: number; refFilesModifiedMs?: Record<string, number> }> {
  if (text !== undefined) return { text };
  if (source.kind === "url") return { text: await withReferencedFiles(await platform.fetchText(source.location!), source.location!, platform.fetchText) };
  if (source.kind === "file") {
    const f = await platform.readTextFile(source.location!);
    const refFilesModifiedMs: Record<string, number> = {};
    const read = async (path: string) => {
      const r = await platform.readTextFile(path);
      refFilesModifiedMs[path] = r.modifiedMs;
      return r.content;
    };
    const text = await withReferencedFiles(f.content, source.location!, read);
    return { text, modifiedMs: f.modifiedMs, refFilesModifiedMs: Object.keys(refFilesModifiedMs).length ? refFilesModifiedMs : undefined };
  }
  throw new Error("Nothing to import");
}

/** A spec split across files, as one JSON document; other specs as they are. */
async function withReferencedFiles(text: string, location: string, load: (location: string) => Promise<string>): Promise<string> {
  // Parsing a large YAML spec takes seconds, so specs whose refs all start with "#" skip it.
  if (!/["']?\$ref["']?\s*:(?![\s"']*#)/.test(text)) return text;
  let doc: Json;
  try {
    doc = await parseSpecAsync(text);
  } catch {
    return text; // Reported by the caller, which parses it again.
  }
  const bundled = await bundleRefs(doc, location, load);
  return bundled === doc ? text : JSON.stringify(bundled);
}

export async function importCollection(source: CollectionSource, text?: string): Promise<string> {
  const loaded = await loadSpecFromSource(source, text);
  const doc = await parseSpecAsync(loaded.text);
  const spec = buildSpec(doc, source.kind === "url" ? source.location : undefined);
  if (hasExternalRefs(doc)) throw new Error("The spec references other files. Import it from its URL or file, so they can be loaded next to it.");
  const id = uid();
  const now = Date.now();
  const collection: Collection = {
    id,
    name: spec.title,
    version: spec.version,
    source,
    hash: hashText(loaded.text),
    importedAt: now,
    syncedAt: now,
    checkedAt: now,
    fileModifiedMs: loaded.modifiedMs,
    refFilesModifiedMs: loaded.refFilesModifiedMs,
    baseUrl: spec.servers[0]?.url ?? "",
    monitor: source.kind !== "paste",
  };
  await platform.saveState(`spec_${id}`, storedSpecText(loaded.text, doc));
  set((s) => ({ collections: [...s.collections, collection], specs: { ...s.specs, [id]: spec } }));
  if (spec.endpoints[0]) openEndpoint(id, spec.endpoints[0].id);
  return id;
}

export function updateCollection(id: string, patch: Partial<Collection>) {
  set((s) => ({ collections: s.collections.map((c) => (c.id === id ? { ...c, ...patch } : c)) }));
}

export function removeCollection(id: string) {
  // The spec files can be megabytes; there is no delete command, so they are emptied.
  for (const f of [`spec_${id}`, `spec_${id}_prev`, pendingFile(id)]) void platform.saveState(f, "").catch(() => undefined);
  set((s) => {
    const requests = Object.fromEntries(Object.entries(s.requests).filter(([k]) => !k.startsWith(`${id}::`)));
    const tabs = s.tabs.filter((t) => !t.startsWith(`${id}::`));
    const specs = { ...s.specs };
    delete specs[id];
    const auth = { ...s.vault.auth };
    delete auth[id];
    return {
      collections: s.collections.filter((c) => c.id !== id),
      specs,
      requests,
      tabs,
      activeTab: tabs.includes(s.activeTab ?? "") ? s.activeTab : tabs[0] ?? null,
      vault: { ...s.vault, auth },
      // An environment limited to removed collections only would otherwise fit nothing.
      environments: s.environments.map((e) =>
        e.collections?.includes(id) ? { ...e, collections: e.collections.filter((x) => x !== id) } : e,
      ),
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Tabs & request state

/**
 * Opens an endpoint. Without `newTab` it goes to the endpoint's most recently used tab (or opens
 * its main tab); with `newTab` it opens another tab, starting from the main tab's values.
 */
export function openEndpoint(collectionId: string, endpointId: string, opts: { newTab?: boolean } = {}) {
  const key = requestKey(collectionId, endpointId);
  ensureRequest(key);
  const { tabs } = get();
  if (opts.newTab) return void openCopy(key, get().requests[key]);
  const own = tabs.filter((t) => baseRequestKey(t) === key);
  const target = own.length ? (mruTabs().find((t) => own.includes(t)) ?? own[0]) : key;
  set((s) => ({ tabs: s.tabs.includes(target) ? s.tabs : [...s.tabs, target], activeTab: target }));
}

/** Another tab of the same endpoint with a copy of `from`'s values, placed after its siblings. */
function openCopy(of: string, from: RequestState | undefined, title?: string) {
  const info = getOp(of);
  if (!info) return;
  const key = newCopyKey(of);
  const state: RequestState = from ? { ...structuredClone(from), tabTitle: title } : initialRequestState(info.spec, info.op);
  set((s) => {
    const base = baseRequestKey(of);
    const lastSibling = s.tabs.reduce((at, t, i) => (baseRequestKey(t) === base ? i : at), -1);
    const tabs = [...s.tabs];
    tabs.splice(lastSibling < 0 ? tabs.length : lastSibling + 1, 0, key);
    return { tabs, activeTab: key, requests: { ...s.requests, [key]: { ...state, updatedAt: Date.now() } } };
  });
}

/** Opens a copy of a tab with its current values. */
export function duplicateTab(key: string) {
  const st = get().requests[key];
  openCopy(key, st, st?.tabTitle ? `${st.tabTitle} copy` : undefined);
}

export function renameTab(key: string, title: string) {
  updateRequest(key, { tabTitle: title.trim() || undefined });
}

// Recently closed tabs for reopening, one entry per close action ("Close all" comes back as a
// whole). Copies carry their values, since closing one deletes them from the store.
const closed: { key: string; index: number; state?: RequestState }[][] = [];

/** `list` with `item` moved in front of `before` (or to the end when `before` is null). */
function moveBefore<T>(list: T[], item: T, before: T | null): T[] {
  if (item === before || !list.includes(item)) return list;
  const rest = list.filter((x) => x !== item);
  const at = before === null ? rest.length : rest.indexOf(before);
  if (at < 0) return list;
  rest.splice(at, 0, item);
  return rest;
}

export function moveTab(key: string, before: string | null) {
  set((s) => ({ tabs: moveBefore(s.tabs, key, before) }));
}

export function moveCollection(id: string, before: string | null) {
  set((s) => {
    const ids = moveBefore(s.collections.map((c) => c.id), id, before);
    return { collections: ids.map((x) => s.collections.find((c) => c.id === x)!) };
  });
}

export function closeTab(key: string) {
  closeTabs([key]);
}

export function closeTabs(keys: string[]) {
  if (!keys.length) return;
  set((s) => {
    const drop = new Set(keys);
    const tabs = s.tabs.filter((t) => !drop.has(t));
    const requests = { ...s.requests };
    const responses = { ...s.responses };
    const batch: (typeof closed)[number] = [];
    for (const k of keys) {
      const index = s.tabs.indexOf(k);
      if (index < 0) continue;
      batch.push({ key: k, index, state: isCopyKey(k) ? s.requests[k] : undefined });
      if (isCopyKey(k)) {
        delete requests[k];
        delete responses[k];
      }
    }
    if (batch.length) closed.push(batch.sort((a, b) => a.index - b.index));
    closed.splice(0, Math.max(0, closed.length - 30));
    let activeTab = s.activeTab;
    if (activeTab && drop.has(activeTab)) {
      // Prefer the most recently used remaining tab, like editors do.
      activeTab = mruTabs().find((t) => tabs.includes(t)) ?? tabs[Math.min(s.tabs.indexOf(activeTab), tabs.length - 1)] ?? null;
    }
    return { tabs, activeTab, requests, responses };
  });
}

export function reopenClosedTab() {
  while (closed.length) {
    const s0 = get();
    const batch = closed.pop()!.filter((c) => !s0.tabs.includes(c.key) && s0.collections.some((x) => x.id === splitRequestKey(c.key)[0]));
    if (!batch.length) continue;
    set((s) => {
      const tabs = [...s.tabs];
      const requests = { ...s.requests };
      // Ascending original positions put every tab back where it was.
      for (const c of batch) {
        tabs.splice(Math.min(c.index, tabs.length), 0, c.key);
        if (c.state) requests[c.key] = c.state;
      }
      return { tabs, requests, activeTab: batch[batch.length - 1].key };
    });
    return;
  }
  toast("info", "No recently closed tabs");
}

export function hasClosedTabs(): boolean {
  return closed.length > 0;
}

// Most recently used order of tabs, for Ctrl+Tab (not persisted: starts from the open tab).
let mru: string[] = [];
useApp.subscribe((s, prev) => {
  if (s.activeTab && s.activeTab !== prev.activeTab) mru = [s.activeTab, ...mru.filter((t) => t !== s.activeTab)];
});

/** Open tabs, most recently used first; tabs never visited this session follow in tab order. */
export function mruTabs(): string[] {
  const { tabs, activeTab } = get();
  const seen = [activeTab, ...mru].filter((t, i, a): t is string => !!t && tabs.includes(t) && a.indexOf(t) === i);
  return [...seen, ...tabs.filter((t) => !seen.includes(t))];
}

export function getOp(key: string): { collection: Collection; spec: ParsedSpec; op: OperationInfo } | null {
  const [cid, eid] = splitRequestKey(key);
  const s = get();
  const collection = s.collections.find((c) => c.id === cid);
  const spec = s.specs[cid];
  if (!collection || !spec) return null;
  const op = getOperation(spec, eid);
  return op ? { collection, spec, op } : null;
}

/** Body text from the spec's example, or defaults generated from the schema for JSON-like bodies. */
export function exampleBodyText(doc: Json, content: { type: string; schema?: Json; example?: Json } | undefined): string {
  if (!content) return "";
  // stringifyJson keeps int64 values (BigInt64Value) as plain numbers.
  if (isStructuredType(content.type)) return stringifyJson(content.example ?? defaultValue(doc, content.schema) ?? {}, 2);
  if (content.example === undefined) return "";
  return typeof content.example === "string" ? content.example : stringifyJson(content.example, 2);
}

export function initialRequestState(spec: ParsedSpec, op: OperationInfo): RequestState {
  const content = op.body?.contents[0];
  const bodyText = exampleBodyText(spec.doc, content);
  return {
    params: {},
    paramEnabled: {},
    extraQuery: [],
    extraHeaders: [],
    contentType: content?.type,
    bodyText,
    bodyMode: "form",
    updatedAt: Date.now(),
  };
}

function ensureRequest(key: string) {
  if (get().requests[key]) return;
  const info = getOp(key);
  if (!info) return;
  set((s) => ({ requests: { ...s.requests, [key]: initialRequestState(info.spec, info.op) } }));
}

export function updateRequest(key: string, patch: Partial<RequestState> | ((r: RequestState) => Partial<RequestState>)) {
  set((s) => {
    const cur = s.requests[key];
    if (!cur) return {};
    const p = typeof patch === "function" ? patch(cur) : patch;
    return { requests: { ...s.requests, [key]: { ...cur, ...p, updatedAt: Date.now() } } };
  });
}

export function resetRequest(key: string) {
  const info = getOp(key);
  if (!info) return;
  set((s) => ({ requests: { ...s.requests, [key]: initialRequestState(info.spec, info.op) } }));
}

// ---------------------------------------------------------------------------------------------
// Environments & secrets

export function activeVars(): Record<string, string> {
  const s = get();
  return envVarMap(s.environments.find((e) => e.id === s.activeEnvId), s.vault.secrets);
}

export function addEnvironment(name: string): string {
  const id = uid();
  const colors = ["#22c55e", "#f59e0b", "#ef4444", "#6366f1", "#06b6d4", "#ec4899"];
  set((s) => ({
    environments: [
      ...s.environments,
      { id, name, color: colors[s.environments.length % colors.length], vars: [newVar()] },
    ],
    activeEnvId: s.activeEnvId ?? id,
  }));
  return id;
}

export function newVar(): EnvVar {
  return { id: uid(), key: "", value: "", secret: false, enabled: true };
}

export function updateEnvironment(id: string, patch: Partial<Environment>) {
  set((s) => ({ environments: s.environments.map((e) => (e.id === id ? { ...e, ...patch } : e)) }));
}

export function duplicateEnvironment(id: string) {
  const env = get().environments.find((e) => e.id === id);
  if (!env) return;
  const nid = uid();
  const secrets = { ...get().vault.secrets };
  const vars = env.vars.map((v) => {
    const nv = { ...v, id: uid() };
    if (v.secret) secrets[secretKey(nid, nv.id)] = secrets[secretKey(id, v.id)] ?? "";
    return nv;
  });
  set((s) => ({
    environments: [...s.environments, { ...env, id: nid, name: `${env.name} copy`, vars }],
    vault: { ...s.vault, secrets },
  }));
}

export function removeEnvironment(id: string) {
  set((s) => {
    const secrets = Object.fromEntries(Object.entries(s.vault.secrets).filter(([k]) => !k.startsWith(`env:${id}:`)));
    const environments = s.environments.filter((e) => e.id !== id);
    return {
      environments,
      activeEnvId: s.activeEnvId === id ? environments[0]?.id ?? null : s.activeEnvId,
      vault: { ...s.vault, secrets },
    };
  });
}

export function setActiveEnv(id: string | null) {
  set({ activeEnvId: id });
}

export function updateVar(envId: string, varId: string, patch: Partial<EnvVar>) {
  set((s) => {
    const env = s.environments.find((e) => e.id === envId);
    const cur = env?.vars.find((v) => v.id === varId);
    if (!env || !cur) return {};
    const next = { ...cur, ...patch };
    const sk = secretKey(envId, varId);
    const secrets = { ...s.vault.secrets };
    // Move the value between the state file and the keychain when the secret flag flips.
    if (!cur.secret && next.secret) {
      secrets[sk] = next.value;
      next.value = "";
      delete next.recent; // earlier plaintext values must not stay in the state file
    } else if (cur.secret && !next.secret) {
      next.value = patch.value ?? secrets[sk] ?? "";
      delete secrets[sk];
    } else if (next.secret && patch.value !== undefined) {
      secrets[sk] = patch.value;
      next.value = "";
    }
    return {
      environments: s.environments.map((e) =>
        e.id === envId ? { ...e, vars: e.vars.map((v) => (v.id === varId ? next : v)) } : e,
      ),
      vault: { ...s.vault, secrets },
    };
  });
}

/** Remembers the value a hot variable had before an edit, so it can be picked again. */
export function rememberVarValue(envId: string, varId: string, previous: string) {
  const v = get().environments.find((e) => e.id === envId)?.vars.find((x) => x.id === varId);
  if (!v || v.secret || !previous || previous === v.value) return;
  const recent = [previous, ...(v.recent ?? []).filter((x) => x !== previous && x !== v.value)].slice(0, 8);
  updateVar(envId, varId, { recent });
}

export function varValue(envId: string, v: EnvVar): string {
  return v.secret ? get().vault.secrets[secretKey(envId, v.id)] ?? "" : v.value;
}

export function addCustomAuth(collectionId: string): string {
  const id = uid();
  const c = get().collections.find((x) => x.id === collectionId);
  const n = (c?.customAuth?.length ?? 0) + 1;
  updateCollection(collectionId, { customAuth: [...(c?.customAuth ?? []), { id, title: n > 1 ? `Custom auth ${n}` : "Custom auth", kind: "bearer" }] });
  return id;
}

export function updateCustomAuth(collectionId: string, id: string, patch: Partial<CustomAuth>) {
  const c = get().collections.find((x) => x.id === collectionId);
  updateCollection(collectionId, { customAuth: c?.customAuth?.map((a) => (a.id === id ? { ...a, ...patch } : a)) });
}

/** Removes a user-added scheme together with its stored credentials. */
export function removeCustomAuth(collectionId: string, id: string) {
  const c = get().collections.find((x) => x.id === collectionId);
  const key = customSchemeKey(id);
  updateCollection(collectionId, {
    customAuth: c?.customAuth?.filter((a) => a.id !== id),
    authChoice: c?.authChoice === key ? undefined : c?.authChoice,
  });
  set((s) => {
    const own = { ...s.vault.auth[collectionId] };
    delete own[key];
    return { vault: { ...s.vault, auth: { ...s.vault.auth, [collectionId]: own } } };
  });
}

export function setAuth(collectionId: string, scheme: string, patch: { value?: string; username?: string; password?: string }) {
  set((s) => {
    const forCol = { ...(s.vault.auth[collectionId] ?? {}) };
    forCol[scheme] = { ...{ value: "" }, ...forCol[scheme], ...patch };
    return { vault: { ...s.vault, auth: { ...s.vault.auth, [collectionId]: forCol } } };
  });
}

// ---------------------------------------------------------------------------------------------
// Execution

export function prepareRequest(key: string) {
  const info = getOp(key);
  const state = get().requests[key];
  if (!info || !state) return null;
  const s = get();
  return buildRequest({
    op: info.op,
    state,
    collection: info.collection,
    vars: activeVars(),
    auth: s.vault.auth,
    schemes: info.spec.securitySchemes,
    doc: info.spec.doc,
    timeoutSec: s.settings.requestTimeoutSec,
    client: { native: platform.isTauri, version },
  });
}

/** The active environment when it isn't meant for this collection (requests using variables can't be sent then). */
export function envMismatch(s: Pick<AppState, "environments" | "activeEnvId">, collectionId: string): Environment | null {
  const env = s.environments.find((e) => e.id === s.activeEnvId);
  return env && !envSupports(env, collectionId) ? env : null;
}

export async function sendRequest(key: string) {
  if (get().inflight[key]) return;
  const built = prepareRequest(key);
  if (!built) return;
  const wrongEnv = envMismatch(get(), splitRequestKey(key)[0]);
  if (wrongEnv && built.usedVars.length)
    return toast("info", `“${wrongEnv.name}” isn't set up for this collection; switch the environment to send`);
  if (built.missingVars.length)
    toast("info", `Unresolved variables: ${built.missingVars.map((v) => `{{${v}}}`).join(", ")}`);
  const { req } = built;
  const [collectionId, endpointId] = splitRequestKey(key);
  const record = {
    collectionId,
    endpointId,
    envName: get().environments.find((e) => e.id === get().activeEnvId)?.name,
    state: get().requests[key],
    req,
    secrets: built.secretValues,
  };
  set((s) => ({ inflight: { ...s.inflight, [key]: req.id } }));
  try {
    const res = await platform.sendRequest(req);
    const response: ResponseData = { ...res, at: Date.now(), url: req.url, method: req.method };
    set((s) => ({ responses: { ...s.responses, [key]: response } }));
    historyOf.set(recordHistory({ ...record, response }).id, key);
  } catch (e) {
    const error = String(e);
    set((s) => ({
      responses: { ...s.responses, [key]: { error, at: Date.now(), url: req.url, method: req.method } },
    }));
    // A cancelled request isn't something that happened to the server.
    if (error !== "Request cancelled") historyOf.set(recordHistory({ ...record, error }).id, key);
  } finally {
    set((s) => {
      const inflight = { ...s.inflight };
      delete inflight[key];
      return { inflight };
    });
  }
}

/** History entry → the tab that sent it or shows it, to focus instead of opening it twice. */
const historyOf = new Map<string, string>();

/** Opens a history entry in its own tab: the request as it was sent, with its response. */
export function openHistoryEntry(entry: HistoryEntry) {
  const existing = historyOf.get(entry.id);
  if (existing && get().tabs.includes(existing) && isCopyKey(existing)) return void set({ activeTab: existing });
  const base = requestKey(entry.collectionId, entry.endpointId);
  if (!getOp(base)) return toast("info", "This endpoint is no longer in the collection's spec");
  const time = new Date(entry.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  openCopy(base, { ...entry.state, updatedAt: Date.now() }, `↺ ${time}`);
  const key = get().activeTab!;
  historyOf.set(entry.id, key);
  const meta = { at: entry.at, url: entry.request.url, method: entry.request.method };
  const response: ResponseEntry = entry.response ? { ...entry.response, ...meta } : { error: entry.error ?? "No response stored", ...meta };
  set((s) => ({ responses: { ...s.responses, [key]: response } }));
}

/** The history entry a tab came from or last sent, if any. */
export function historyEntryOf(tabKey: string): string | undefined {
  let id: string | undefined;
  for (const [entry, key] of historyOf) if (key === tabKey) id = entry;
  return id;
}

export function cancelRequest(key: string) {
  const id = get().inflight[key];
  if (id) platform.cancelRequest(id);
}

export async function copyCurl(key: string) {
  const built = prepareRequest(key);
  if (!built) return;
  await navigator.clipboard.writeText(toCurl(built.req));
  toast("success", "Copied as cURL");
}

// ---------------------------------------------------------------------------------------------
// Spec monitoring & sync

const checking = new Set<string>();

/** Fetches/reads the collection source and records a pending update when it differs. */
export async function checkForUpdates(id: string, opts: { manual?: boolean } = {}) {
  const c = get().collections.find((x) => x.id === id);
  if (!c || c.source.kind === "paste" || checking.has(id)) return;
  checking.add(id);
  try {
    if (c.source.kind === "file" && !opts.manual) {
      const refs = Object.entries(c.refFilesModifiedMs ?? {});
      const m = await platform.filesModified([c.source.location!, ...refs.map(([path]) => path)]);
      if (m[0] === c.fileModifiedMs && refs.every(([, ms], i) => m[i + 1] === ms)) return;
    }
    const loaded = await loadSpecFromSource(c.source);
    const hash = hashText(loaded.text);
    const patch: Partial<Collection> = { checkedAt: Date.now(), checkError: undefined, fileModifiedMs: loaded.modifiedMs ?? c.fileModifiedMs };
    if (c.source.kind === "file") patch.refFilesModifiedMs = loaded.refFilesModifiedMs;
    if (hash !== c.hash && hash !== c.dismissedHash && hash !== c.pending?.hash) {
      let specText: string;
      try {
        const doc = await parseSpecAsync(loaded.text);
        buildSpec(doc);
        // Parsed once here; the review and the sync then work from JSON.
        specText = storedSpecText(loaded.text, doc);
      } catch (e) {
        updateCollection(id, { ...patch, checkError: `Updated spec is invalid: ${e}` });
        return;
      }
      await platform.saveState(pendingFile(id), specText);
      patch.pending = { specText, hash, detectedAt: Date.now() };
      toast("info", `“${c.name}” has spec changes to review`);
    } else if (hash === c.hash && c.pending) {
      patch.pending = undefined;
    } else if (opts.manual) {
      toast("success", hash === c.hash ? `“${c.name}” is up to date` : `“${c.name}” changes were dismissed earlier`);
    }
    updateCollection(id, patch);
  } catch (e) {
    updateCollection(id, { checkedAt: Date.now(), checkError: String(e) });
    if (opts.manual) toast("error", `Check failed: ${e}`);
  } finally {
    checking.delete(id);
  }
}

/** Saved request state per endpoint: the main tab's, or a tab copy's when only the copy holds
 *  user data, so sync conflicts and orphaning see data typed into copies too. */
export function savedRequestsFor(collectionId: string): Record<string, RequestState> {
  const out: Record<string, RequestState> = {};
  for (const [k, v] of Object.entries(get().requests)) {
    const [cid, eid] = splitRequestKey(k);
    if (cid !== collectionId) continue;
    const cur = out[eid];
    if (!cur || (isCopyKey(k) ? !hasUserData(cur) && hasUserData(v) : !hasUserData(cur) || hasUserData(v))) out[eid] = v;
  }
  return out;
}

interface PendingDiff {
  key: string; // current hash | pending hash
  requests: AppState["requests"]; // saved values the conflicts were computed against
  promise: Promise<SyncDiffResult>;
  result?: SyncDiffResult;
}
const pendingDiffs = new Map<string, PendingDiff>();

/**
 * The comparison of a collection's pending update with its current spec, computed off the main
 * thread and cached. Started as soon as an update is detected, so reviewing it opens instantly.
 * Returns the previous result for the same versions too while saved values are re-checked.
 */
export function pendingDiff(id: string): { entry: PendingDiff; stale?: SyncDiffResult } | null {
  const s = get();
  const c = s.collections.find((x) => x.id === id);
  if (!c?.pending) return null;
  const key = `${c.hash}|${c.pending.hash}`;
  const prev = pendingDiffs.get(id);
  if (prev && prev.key === key && prev.requests === s.requests) return { entry: prev };
  const pending = c.pending;
  const entry: PendingDiff = {
    key,
    requests: s.requests,
    promise: platform.loadState(`spec_${id}`).then((oldText) =>
      oldText == null
        ? { error: "The current spec is missing from local storage" }
        : computeSyncDiff({
            oldText,
            newText: pending.specText,
            sourceUrl: c.source.kind === "url" ? c.source.location : undefined,
            saved: savedRequestsFor(id),
          }),
    ),
  };
  entry.promise.then((r) => (entry.result = r));
  pendingDiffs.set(id, entry);
  return { entry, stale: prev?.key === key ? prev.result : undefined };
}

// Start comparing as soon as an update shows up.
useApp.subscribe((s, prev) => {
  if (s.collections === prev.collections) return;
  for (const c of s.collections) {
    if (!c.pending) pendingDiffs.delete(c.id);
    else if (pendingDiffs.get(c.id)?.key !== `${c.hash}|${c.pending.hash}`) pendingDiff(c.id);
  }
  // Applied, dismissed or gone: drop its text from disk too.
  for (const c of prev.collections) {
    if (c.pending && !s.collections.find((x) => x.id === c.id)?.pending) void platform.saveState(pendingFile(c.id), "").catch(() => undefined);
  }
});

/** Applies a pending update. Request data is never deleted: values for removed endpoints or
 *  params stay in the store, and removed endpoints with data are listed as orphaned. */
export async function applySync(id: string) {
  const c = get().collections.find((x) => x.id === id);
  const oldSpec = get().specs[id];
  if (!c?.pending) return;
  const newSpec = buildSpec(await parseSpecAsync(c.pending.specText), c.source.kind === "url" ? c.source.location : undefined);
  const prevText = await platform.loadState(`spec_${id}`);
  if (prevText != null) await platform.saveState(`spec_${id}_prev`, prevText);
  await platform.saveState(`spec_${id}`, c.pending.specText);

  const newIds = new Set(newSpec.endpoints.map((e) => e.id));
  const saved = savedRequestsFor(id);
  const orphaned = new Set(c.orphanedEndpoints ?? []);
  for (const [eid, st] of Object.entries(saved)) {
    if (newIds.has(eid)) orphaned.delete(eid);
    else if (hasUserData(st)) orphaned.add(eid);
  }
  const oldServer = oldSpec?.servers[0]?.url;
  set((s) => {
    const tabs = s.tabs.filter((t) => {
      const [cid, eid] = splitRequestKey(t);
      return cid !== id || newIds.has(eid) || orphaned.has(eid);
    });
    const activeTab =
      s.activeTab && !tabs.includes(s.activeTab) ? mruTabs().find((t) => tabs.includes(t)) ?? tabs[tabs.length - 1] ?? null : s.activeTab;
    // Copies of removed endpoints that were closed above and hold nothing are gone for good.
    const requests = { ...s.requests };
    for (const [k, st] of Object.entries(s.requests)) {
      const [cid, eid] = splitRequestKey(k);
      if (cid === id && isCopyKey(k) && !newIds.has(eid) && !tabs.includes(k) && !hasUserData(st)) delete requests[k];
    }
    return { specs: { ...s.specs, [id]: newSpec }, specErrors: { ...s.specErrors, [id]: "" }, tabs, activeTab, requests };
  });
  updateCollection(id, {
    hash: c.pending.hash,
    name: c.name === oldSpec?.title ? newSpec.title : c.name,
    version: newSpec.version,
    syncedAt: Date.now(),
    pending: undefined,
    dismissedHash: undefined,
    orphanedEndpoints: [...orphaned],
    previous: { hash: c.hash, version: c.version, syncedAt: c.syncedAt },
    // Follow the spec's server only if the user never customised the base URL.
    baseUrl: c.baseUrl === oldServer ? newSpec.servers[0]?.url ?? c.baseUrl : c.baseUrl,
  });
  // Content type may have disappeared; keep body text, just point at a supported type.
  set((s) => {
    const requests = { ...s.requests };
    for (const [k, st] of Object.entries(s.requests)) {
      const [cid, eid] = splitRequestKey(k);
      if (cid !== id) continue;
      const op = getOperation(newSpec, eid);
      const types = op?.body?.contents.map((x) => x.type) ?? [];
      if (op && types.length && st.contentType && !types.includes(st.contentType)) requests[k] = { ...st, contentType: types[0] };
    }
    return { requests };
  });
  toast("success", `Synchronized “${newSpec.title}”`);
}

export async function revertSync(id: string) {
  const c = get().collections.find((x) => x.id === id);
  const prevText = await platform.loadState(`spec_${id}_prev`);
  if (!c?.previous || prevText == null) return;
  const curText = await platform.loadState(`spec_${id}`);
  const doc = await parseSpecAsync(prevText);
  const spec = buildSpec(doc, c.source.kind === "url" ? c.source.location : undefined);
  await platform.saveState(`spec_${id}`, storedSpecText(prevText, doc));
  set((s) => ({ specs: { ...s.specs, [id]: spec }, specErrors: { ...s.specErrors, [id]: "" } }));
  const restored = new Set(spec.endpoints.map((e) => e.id));
  updateCollection(id, {
    // Endpoints that are back aren't orphans any more.
    orphanedEndpoints: (c.orphanedEndpoints ?? []).filter((eid) => !restored.has(eid)),
    hash: c.previous.hash,
    version: c.previous.version,
    syncedAt: Date.now(),
    previous: undefined,
    // Offer the newer version again as a pending update so nothing is lost.
    pending: curText != null ? { specText: curText, hash: c.hash, detectedAt: Date.now() } : undefined,
    dismissedHash: c.hash,
  });
  toast("success", "Reverted to the previous spec version");
}

export function dismissUpdate(id: string) {
  const c = get().collections.find((x) => x.id === id);
  if (!c?.pending) return;
  updateCollection(id, { dismissedHash: c.pending.hash, pending: undefined });
}

export function discardOrphan(collectionId: string, endpointId: string) {
  const key = requestKey(collectionId, endpointId);
  set((s) => {
    const requests = { ...s.requests };
    delete requests[key];
    return {
      requests,
      tabs: s.tabs.filter((t) => t !== key),
      activeTab: s.activeTab === key ? null : s.activeTab,
      collections: s.collections.map((c) =>
        c.id === collectionId ? { ...c, orphanedEndpoints: (c.orphanedEndpoints ?? []).filter((e) => e !== endpointId) } : c,
      ),
    };
  });
}
