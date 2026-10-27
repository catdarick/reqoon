// Comparing a pending spec update with the current one means parsing two large documents
// (YAML can take hundreds of ms) and diffing every operation. It runs in a worker so the UI
// stays responsive; without workers (tests) it runs inline.
import { computeSyncDiffSync, SyncDiffInput, SyncDiffResult } from "./syncDiffCore";

export type { SyncDiffInput, SyncDiffResult } from "./syncDiffCore";

let worker: Worker | null | undefined;
let seq = 0;
const waiting = new Map<number, (r: SyncDiffResult) => void>();

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = new Worker(new URL("../workers/syncDiff.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<{ id: number; result: SyncDiffResult }>) => {
      waiting.get(e.data.id)?.(e.data.result);
      waiting.delete(e.data.id);
      // Its heap still holds both parsed specs; a new worker starts in milliseconds.
      if (!waiting.size) {
        worker?.terminate();
        worker = undefined;
      }
    };
    worker.onerror = () => {
      // Fail the requests in flight; later ones run inline.
      for (const resolve of waiting.values()) resolve({ error: "Comparison worker failed" });
      waiting.clear();
      worker = null;
    };
  } catch {
    worker = null;
  }
  return worker;
}

export function computeSyncDiff(input: SyncDiffInput): Promise<SyncDiffResult> {
  const w = typeof Worker !== "undefined" ? getWorker() : null;
  if (!w) return Promise.resolve(computeSyncDiffSync(input));
  const id = ++seq;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    w.postMessage({ id, input });
  });
}
