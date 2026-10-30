// Parsing a large YAML spec takes a second or more (Stripe's 8 MB spec: ~1 s), so big ones are
// parsed in a worker and handed back as JSON text, which is far cheaper to pass between threads
// than the document and parses in milliseconds. JSON, small specs and tests run inline.
import { parseSpecText } from "./openapi";
import type { Json } from "./schema";

/** YAML texts at least this long are parsed in the worker. */
export const WORKER_FROM = 200_000;

type Reply = { id: number; json: string } | { id: number; error: { name: string; message: string } };

let worker: Worker | null | undefined;
let seq = 0;
const waiting = new Map<number, (r: Reply | null) => void>();

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = new Worker(new URL("../workers/parse.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<Reply>) => {
      waiting.get(e.data.id)?.(e.data);
      waiting.delete(e.data.id);
      // Its heap still holds the parsed document; a new worker starts in milliseconds.
      if (!waiting.size) {
        worker?.terminate();
        worker = undefined;
      }
    };
    worker.onerror = () => {
      // The requests in flight are parsed inline instead; later ones too.
      for (const resolve of waiting.values()) resolve(null);
      waiting.clear();
      worker = null;
    };
  } catch {
    worker = null;
  }
  return worker;
}

/** `parseSpecText` that keeps the UI responsive for large YAML. */
export async function parseSpecAsync(text: string): Promise<Json> {
  const w = text.length >= WORKER_FROM && !text.trimStart().startsWith("{") && typeof Worker !== "undefined" ? getWorker() : null;
  if (!w) return parseSpecText(text);
  const id = ++seq;
  const reply = await new Promise<Reply | null>((resolve) => {
    waiting.set(id, resolve);
    w.postMessage({ id, text });
  });
  if (!reply) return parseSpecText(text);
  if ("error" in reply) throw Object.assign(new Error(reply.error.message), { name: reply.error.name });
  return JSON.parse(reply.json);
}
