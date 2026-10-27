// Request history: every request sent, with what came back, kept on disk next to the app state.
// Credentials never get here: values the request carried from the Auth settings are masked.
import { create } from "zustand";
import * as platform from "../lib/platform";
import type { HttpRequest } from "../lib/platform";
import type { RequestState, ResponseData } from "../lib/models";

export interface HistoryEntry {
  id: string;
  at: number;
  collectionId: string;
  endpointId: string;
  envName?: string;
  /** The editor values at send time (with {{vars}} unresolved), to reopen the request. */
  state: RequestState;
  request: { method: string; url: string; headers: [string, string][]; body?: string };
  response?: Omit<ResponseData, "at" | "url" | "method">;
  error?: string;
  /** The stored response body was cut to fit (or dropped to keep the file small). */
  truncated?: boolean;
}

const MAX_ENTRIES = 500;
const MAX_BODY = 64 * 1024; // per response
const MAX_TOTAL = 15 * 1024 * 1024; // all bodies together; older entries lose theirs first
const FILE = "history";

export const useHistory = create<{ entries: HistoryEntry[]; loaded: boolean }>(() => ({ entries: [], loaded: false }));

let saveTimer: ReturnType<typeof setTimeout> | undefined;

async function load() {
  try {
    const raw = await platform.loadState(FILE);
    const stored = raw ? (JSON.parse(raw) as HistoryEntry[]) : [];
    // Requests sent while loading go in front of what was stored.
    useHistory.setState((s) => ({ entries: [...s.entries, ...(Array.isArray(stored) ? stored : [])].slice(0, MAX_ENTRIES), loaded: true }));
  } catch {
    // Unreadable history: start a new one rather than failing; the old file is replaced on the next save.
    useHistory.setState({ entries: [], loaded: true });
  }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void platform.saveState(FILE, JSON.stringify(useHistory.getState().entries)).catch(() => undefined);
  }, 800);
}

if (typeof window !== "undefined") void load();

const MASK = "••••";

function maskAll(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 3) out = out.split(s).join(MASK);
  return out;
}

/** Keeps the newest bodies within the size budget; older entries keep only their metadata. */
function fitBudget(entries: HistoryEntry[]): HistoryEntry[] {
  let total = 0;
  return entries.map((e) => {
    const size = e.response?.body.length ?? 0;
    if (!e.response || total + size <= MAX_TOTAL) {
      total += size;
      return e;
    }
    return { ...e, response: { ...e.response, body: "" }, truncated: true };
  });
}

export function recordHistory(input: {
  collectionId: string;
  endpointId: string;
  envName?: string;
  state: RequestState;
  req: HttpRequest;
  secrets: string[];
  response?: ResponseData;
  error?: string;
}) {
  const { req, secrets } = input;
  let response: HistoryEntry["response"];
  let truncated = false;
  if (input.response) {
    const { at: _at, url: _url, method: _method, ...rest } = input.response;
    truncated = rest.body.length > MAX_BODY;
    response = { ...rest, body: truncated ? rest.body.slice(0, MAX_BODY) : rest.body };
  }
  const { tabTitle: _title, ...state } = input.state;
  const entry: HistoryEntry = {
    id: crypto.randomUUID(),
    at: Date.now(),
    collectionId: input.collectionId,
    endpointId: input.endpointId,
    envName: input.envName,
    state: structuredClone(state),
    request: {
      method: req.method,
      url: maskAll(req.url, secrets),
      headers: req.headers.map(([k, v]) => [k, maskAll(v, secrets)]),
      body: req.body === undefined ? undefined : maskAll(req.body, secrets),
    },
    response,
    error: input.error,
    ...(truncated ? { truncated } : {}),
  };
  useHistory.setState((s) => ({ entries: fitBudget([entry, ...s.entries].slice(0, MAX_ENTRIES)) }));
  scheduleSave();
  return entry;
}

export function deleteHistoryEntry(id: string) {
  useHistory.setState((s) => ({ entries: s.entries.filter((e) => e.id !== id) }));
  scheduleSave();
}

export function clearHistory(collectionId?: string) {
  useHistory.setState((s) => ({ entries: collectionId ? s.entries.filter((e) => e.collectionId !== collectionId) : [] }));
  scheduleSave();
}
