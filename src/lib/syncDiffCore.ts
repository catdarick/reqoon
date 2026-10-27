// Parsing and diffing for a pending spec update; runs inside the comparison worker.
import { buildSpec, parseSpecText } from "./openapi";
import { diffSpecs, SpecDiff } from "./diff";
import type { Json } from "./schema";
import type { RequestState } from "./models";

export interface SyncDiffInput {
  oldText: string;
  newText: string;
  sourceUrl?: string;
  saved: Record<string, RequestState>;
}

/** `doc` is the parsed new spec, reused when the update is applied. */
export type SyncDiffResult = { diff: SpecDiff } | { error: string };

export function computeSyncDiffSync({ oldText, newText, sourceUrl, saved }: SyncDiffInput): SyncDiffResult {
  let doc: Json;
  try {
    doc = parseSpecText(newText);
  } catch (e) {
    return { error: String(e) };
  }
  try {
    const diff = diffSpecs(buildSpec(parseSpecText(oldText), sourceUrl), buildSpec(doc, sourceUrl), saved);
    return { diff };
  } catch (e) {
    return { error: String(e) };
  }
}
