export function methodBadge(method: string): string {
  return method === "DELETE" ? "DEL" : method;
}

/** Method column sized to the longest badge among sibling rows, so labels line up without
 *  reserving room for methods that aren't there. */
export function methodWidth(rows: { method: string }[]): string {
  const n = Math.max(3, ...rows.map((r) => methodBadge(r.method).length));
  return `calc(${n}ch + ${n * 0.02}em)`;
}
