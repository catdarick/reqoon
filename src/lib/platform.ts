// Thin wrapper over the Tauri backend. When the UI runs in a plain browser (vite dev without
// Tauri) it falls back to fetch/localStorage so the interface stays usable for development.

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

export interface HttpRequest {
  id: string;
  method: string;
  url: string;
  headers: [string, string][];
  body?: string;
  timeoutMs?: number;
  /** Don't negotiate compression (Accept-Encoding was turned off). */
  noCompression?: boolean;
}

export interface HttpResponse {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: string;
  size: number;
  timeMs: number;
}

const browserAborts = new Map<string, AbortController>();

export async function sendRequest(req: HttpRequest): Promise<HttpResponse> {
  if (isTauri) return invoke<HttpResponse>("send_request", { req });
  const ctrl = new AbortController();
  browserAborts.set(req.id, ctrl);
  const timer = setTimeout(() => ctrl.abort(), req.timeoutMs ?? 60000);
  const start = performance.now();
  try {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: ctrl.signal,
    });
    const body = await res.text();
    return {
      status: res.status,
      statusText: res.statusText,
      headers: [...res.headers.entries()],
      body,
      size: new TextEncoder().encode(body).length,
      timeMs: performance.now() - start,
    };
  } catch (e) {
    throw ctrl.signal.aborted ? "Request cancelled" : String(e);
  } finally {
    clearTimeout(timer);
    browserAborts.delete(req.id);
  }
}

export async function cancelRequest(id: string): Promise<void> {
  if (isTauri) return invoke("cancel_request", { id });
  browserAborts.get(id)?.abort();
}

export async function fetchText(url: string): Promise<string> {
  const res = await sendRequest({
    id: `fetch-${Math.random()}`,
    method: "GET",
    url,
    headers: [["Accept", "application/json, application/yaml, text/yaml, */*"]],
    timeoutMs: 30000,
  });
  if (res.status >= 400) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return res.body;
}

export async function readTextFile(path: string): Promise<{ content: string; modifiedMs: number }> {
  return invoke("read_text_file", { path });
}

export async function fileModified(path: string): Promise<number> {
  return invoke("file_modified", { path });
}

export async function pickSpecFile(): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const res = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "OpenAPI", extensions: ["json", "yaml", "yml"] }],
  });
  return typeof res === "string" ? res : null;
}

export async function loadState(name: string): Promise<string | null> {
  if (isTauri) return invoke<string | null>("load_state", { name });
  try {
    return localStorage.getItem(`reqoon:${name}`);
  } catch {
    return null;
  }
}

export async function saveState(name: string, content: string): Promise<void> {
  if (isTauri) return invoke("save_state", { name, content });
  try {
    localStorage.setItem(`reqoon:${name}`, content);
  } catch {
    /* storage unavailable */
  }
}

// Secrets live in the OS keychain (macOS Keychain, Windows Credential Manager, Secret Service).
export async function secretGet(key: string): Promise<string | null> {
  if (isTauri) return invoke<string | null>("secret_get", { key });
  try {
    return sessionStorage.getItem(`reqoon-secret:${key}`);
  } catch {
    return null;
  }
}

/** Calls `handler` with the id of a native menu item the user picked (Tauri only). */
export async function onMenu(handler: (id: string) => void) {
  if (!isTauri) return;
  const { listen } = await import("@tauri-apps/api/event");
  await listen<string>("reqoon://menu", (e) => handler(e.payload));
}

/** Runs `flush` when the app is about to close or quit, then lets it exit (Tauri only). */
export async function onExitRequested(flush: () => Promise<void>) {
  if (!isTauri) return;
  const { listen } = await import("@tauri-apps/api/event");
  await listen("reqoon://flush-before-exit", async () => {
    try {
      await flush();
    } finally {
      await invoke("exit_app");
    }
  });
}

export async function secretSet(key: string, value: string): Promise<void> {
  if (isTauri) return invoke("secret_set", { key, value });
  try {
    sessionStorage.setItem(`reqoon-secret:${key}`, value);
  } catch {
    /* storage unavailable */
  }
}

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
