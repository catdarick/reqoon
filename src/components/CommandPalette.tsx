import { useEffect, useMemo, useRef, useState } from "react";
import { openEndpoint, setModal, useApp } from "../store/app";
import { matchEndpoint } from "../lib/search";
import { splitRequestKey } from "../lib/models";
import type { Endpoint } from "../lib/openapi";
import { hiddenSet } from "../lib/hide";

interface Item {
  collectionId: string;
  collectionName: string;
  endpoint: Endpoint;
  hits: number[];
  score: number;
  hidden: boolean;
}

export default function CommandPalette() {
  const collections = useApp((s) => s.collections);
  const specs = useApp((s) => s.specs);
  const requests = useApp((s) => s.requests);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const multi = collections.length > 1;
  const hidden = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const c of collections) m.set(c.id, hiddenSet(c.hideRules, specs[c.id]?.endpoints ?? []));
    return m;
  }, [collections, specs]);
  const isHidden = (cid: string, eid: string) => !!hidden.get(cid)?.has(eid);

  const items = useMemo((): Item[] => {
    const out: Item[] = [];
    if (!q.trim()) {
      // Most recently edited requests first.
      const recent = Object.entries(requests)
        .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
        .map(([k]) => splitRequestKey(k));
      for (const [cid, eid] of recent) {
        const e = specs[cid]?.endpoints.find((x) => x.id === eid);
        const c = collections.find((x) => x.id === cid);
        // Several tabs of an endpoint share its entry.
        if (out.some((o) => o.collectionId === cid && o.endpoint.id === eid)) continue;
        if (e && c && !isHidden(cid, eid)) out.push({ collectionId: cid, collectionName: c.name, endpoint: e, hits: [], score: 0, hidden: false });
        if (out.length >= 8) break;
      }
      for (const c of collections) {
        for (const e of specs[c.id]?.endpoints ?? []) {
          if (out.length >= 50) break;
          if (!isHidden(c.id, e.id) && !out.some((o) => o.collectionId === c.id && o.endpoint.id === e.id))
            out.push({ collectionId: c.id, collectionName: c.name, endpoint: e, hits: [], score: 0, hidden: false });
        }
      }
      return out;
    }
    for (const c of collections) {
      for (const e of specs[c.id]?.endpoints ?? []) {
        const m = matchEndpoint(e, q, c.name);
        // Hidden endpoints stay reachable from search, just ranked below visible ones.
        const h = isHidden(c.id, e.id);
        if (m) out.push({ collectionId: c.id, collectionName: c.name, endpoint: e, hits: m.pathHits, score: m.score - (h ? 1000 : 0), hidden: h });
      }
    }
    return out.sort((a, b) => b.score - a.score).slice(0, 80);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, collections, specs, requests, hidden]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    list.current?.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const choose = (it: Item | undefined, newTab = false) => {
    if (!it) return;
    openEndpoint(it.collectionId, it.endpoint.id, { newTab });
    setModal(null);
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && setModal(null)}>
      <div className="modal palette" role="dialog" aria-label="Search endpoints">
        <input
          autoFocus
          className="palette-input"
          placeholder="Search endpoints by path, name or method…  (e.g. “post users”)"
          value={q}
          spellCheck={false}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
              e.preventDefault();
              setSel((i) => Math.min(items.length - 1, i + 1));
            } else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
              e.preventDefault();
              setSel((i) => Math.max(0, i - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              choose(items[sel], e.altKey);
            } else if (e.key === "Escape") {
              e.preventDefault();
              setModal(null);
            }
          }}
        />
        <div className="palette-list" ref={list}>
          {items.length === 0 && <div className="muted" style={{ padding: 14 }}>{collections.length ? "No matching endpoints" : "Import a spec first"}</div>}
          {items.map((it, i) => (
            <div
              key={`${it.collectionId}${it.endpoint.id}`}
              className={`palette-item ${i === sel ? "sel" : ""}`}
              onMouseMove={() => i !== sel && setSel(i)}
              onClick={(e) => choose(it, e.altKey)}
            >
              <span className={`method m-${it.endpoint.method}`}>{it.endpoint.method}</span>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="path truncate">
                  <Highlighted text={it.endpoint.path} hits={it.hits} />
                </div>
                {(it.endpoint.summary || multi) && (
                  <div className="sub truncate">
                    {it.endpoint.summary}
                    {multi && <span> · {it.collectionName}</span>}
                  </div>
                )}
              </div>
              {it.endpoint.deprecated && <span className="badge warn">deprecated</span>}
              {it.hidden && <span className="badge">hidden</span>}
            </div>
          ))}
        </div>
        <div className="palette-foot">
          <span><span className="kbd">↑↓</span> navigate</span>
          <span><span className="kbd">↩</span> open</span>
          <span><span className="kbd">⌥↩</span> new tab</span>
          <span><span className="kbd">esc</span> close</span>
          <span className="spacer" />
          <span>Tip: start with a method — “del order”</span>
        </div>
      </div>
    </div>
  );
}

function Highlighted({ text, hits }: { text: string; hits: number[] }) {
  if (!hits.length) return <>{text}</>;
  const set = new Set(hits);
  const out: React.ReactNode[] = [];
  let buf = "";
  let on = false;
  for (let i = 0; i <= text.length; i++) {
    const h = set.has(i);
    if (i === text.length || h !== on) {
      if (buf) out.push(on ? <mark key={i}>{buf}</mark> : buf);
      buf = "";
      on = h;
    }
    if (i < text.length) buf += text[i];
  }
  return <>{out}</>;
}
