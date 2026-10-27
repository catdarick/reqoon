// Formatting a body of tens of megabytes takes a second or more, so large ones are formatted in
// a worker and the UI stays responsive; small ones (and tests, without workers) run inline.
import { FormatKind, FormattedText, formatText } from "./format";

/** Bodies at least this long are formatted in the worker. */
export const WORKER_FROM = 1_000_000;

let worker: Worker | null | undefined;
let seq = 0;
const waiting = new Map<number, (r: FormattedText | null) => void>();

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = new Worker(new URL("../workers/format.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<{ id: number; result: FormattedText | null }>) => {
      waiting.get(e.data.id)?.(e.data.result);
      waiting.delete(e.data.id);
      // Its heap still holds the body and the output; a new worker starts in milliseconds.
      if (!waiting.size) {
        worker?.terminate();
        worker = undefined;
      }
    };
    worker.onerror = () => {
      // Fail the requests in flight (the body is then shown as is); later ones run inline.
      for (const resolve of waiting.values()) resolve(null);
      waiting.clear();
      worker = null;
    };
  } catch {
    worker = null;
  }
  return worker;
}

export function formatAsync(kind: FormatKind, text: string): Promise<FormattedText | null> {
  const w = text.length >= WORKER_FROM && typeof Worker !== "undefined" ? getWorker() : null;
  if (!w) return Promise.resolve(formatText(kind, text));
  const id = ++seq;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    w.postMessage({ id, kind, text });
  });
}
