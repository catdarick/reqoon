import { computeSyncDiffSync, SyncDiffInput } from "../lib/syncDiffCore";

self.onmessage = (e: MessageEvent<{ id: number; input: SyncDiffInput }>) => {
  self.postMessage({ id: e.data.id, result: computeSyncDiffSync(e.data.input) });
};
