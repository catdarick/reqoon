// Whole-body find for response views.

export interface Hits {
  /** Match start offsets, ascending; only the first `n` entries are used. */
  pos: Int32Array;
  n: number;
  /** Match length (case-insensitive matching never changes the length). */
  len: number;
}

export const NO_HITS: Hits = { pos: new Int32Array(0), n: 0, len: 0 };

/** All case-insensitive, non-overlapping occurrences of `query` in `text`. Matching runs on the
 *  text itself: a lowercased copy would cost as much memory as the body, and lowercasing can
 *  change lengths ("İ" becomes two characters), which shifts every later offset. */
export function findAll(text: string, query: string): Hits {
  if (!query) return NO_HITS;
  const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  let pos = new Int32Array(1024);
  let n = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (n === pos.length) {
      const grown = new Int32Array(n * 2);
      grown.set(pos);
      pos = grown;
    }
    pos[n++] = m.index;
  }
  return { pos, n, len: query.length };
}

/** Index of the first entry of `sorted[0..n)` that is >= `at`. */
export function firstAtOrAfter(sorted: ArrayLike<number>, n: number, at: number): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < at) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
