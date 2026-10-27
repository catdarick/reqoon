import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { updateSettings, useApp } from "../store/app";
import JsonTree from "./JsonTree";
import { parseJson, stringifyJson } from "../lib/json";
import { Close, Copy, Down, Search, Up } from "./Icons";
import { formatCombo } from "../lib/shortcuts";

type View = "pretty" | "raw" | "headers";

export const FIND_EVENT = "reqoon:find-in-response";

export default function ResponsePanel({ tabKey }: { tabKey: string }) {
  const res = useApp((s) => s.responses[tabKey]);
  const loading = useApp((s) => !!s.inflight[tabKey]);
  const wrap = useApp((s) => s.settings.wrapResponse);
  const sendKey = useApp((s) => s.settings.shortcuts.send);
  const [view, setView] = useState<View>("pretty");
  const [find, setFind] = useState<{ q: string; cur: number } | null>(null);
  const [count, setCount] = useState(0);
  const findInput = useRef<HTMLInputElement>(null);
  const onMatches = useCallback((n: number) => setCount(n), []);

  useEffect(() => {
    const open = () => {
      setFind((f) => f ?? { q: "", cur: 0 });
      setView((v) => (v === "headers" ? "pretty" : v));
      setTimeout(() => findInput.current?.select(), 0);
    };
    window.addEventListener(FIND_EVENT, open);
    return () => window.removeEventListener(FIND_EVENT, open);
  }, []);

  const parsed = useMemo(() => {
    if (!res || "error" in res) return undefined;
    const ct = res.headers.find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "";
    const t = res.body.trimStart();
    if (!/json/i.test(ct) && !(t.startsWith("{") || t.startsWith("["))) return undefined;
    try {
      return { value: parseJson(res.body) };
    } catch {
      return undefined;
    }
  }, [res]);

  if (!res) {
    return (
      <section className="pane" aria-label="Response">
        <div className="resp-head">
          <span className="muted">Response</span>
          {loading && <span className="spin" style={{ color: "var(--accent)" }} />}
        </div>
        <div className="empty">
          <p>
            {loading ? "Sending…" : <>Press <span className="kbd">{formatCombo(sendKey)}</span> to send the request.</>}
          </p>
        </div>
      </section>
    );
  }

  if ("error" in res) {
    return (
      <section className="pane" aria-label="Response">
        <div className="resp-head">
          <span className="status err">Error</span>
          {loading && <span className="spin" style={{ color: "var(--accent)" }} />}
        </div>
        <div className="resp-body">
          <div className="banner danger" style={{ margin: 0 }}>
            <span className="selectable" style={{ wordBreak: "break-word" }}>{res.error}</span>
          </div>
          <div className="field-desc mono" style={{ marginTop: 8 }}>
            {res.method} {res.url}
          </div>
        </div>
      </section>
    );
  }

  const sc = Math.floor(res.status / 100);
  const copy = () => navigator.clipboard.writeText(parsed && view === "pretty" ? stringifyJson(parsed.value, 2) : res.body);

  return (
    <section className="pane" aria-label="Response">
      <div className="resp-head">
        <span className={`status s${sc}`}>
          {res.status} {res.statusText}
        </span>
        <span className="stat">
          <b>{formatMs(res.timeMs)}</b>
        </span>
        <span className="stat">
          <b>{formatSize(res.size)}</b>
        </span>
        {loading && <span className="spin" style={{ color: "var(--accent)" }} />}
        <span className="spacer" />
        <div className="seg">
          <button className={view === "pretty" ? "active" : ""} onClick={() => setView("pretty")}>
            Pretty
          </button>
          <button className={view === "raw" ? "active" : ""} onClick={() => setView("raw")}>
            Raw
          </button>
          <button className={view === "headers" ? "active" : ""} onClick={() => setView("headers")}>
            Headers <span className="muted">{res.headers.length}</span>
          </button>
        </div>
        <button
          className={`icon-btn ${find ? "on" : ""}`}
          title={`Find (${formatCombo(useApp.getState().settings.shortcuts.findInResponse)})`}
          onClick={() => (find ? setFind(null) : window.dispatchEvent(new Event(FIND_EVENT)))}
        >
          <Search />
        </button>
        <button className="icon-btn" title="Copy body" onClick={copy}>
          <Copy />
        </button>
      </div>
      {find && view !== "headers" && (
        <div className="find-bar">
          <Search size={12} />
          <input
            ref={findInput}
            className="find-input"
            placeholder="Find"
            value={find.q}
            spellCheck={false}
            autoFocus
            onChange={(e) => setFind({ q: e.target.value, cur: 0 })}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                setFind({ ...find, cur: find.cur + (e.shiftKey ? -1 : 1) });
              } else if (e.key === "Escape") {
                e.preventDefault();
                setFind(null);
              }
            }}
          />
          <span className="small muted find-count">{find.q ? (count ? `${(((find.cur % count) + count) % count) + 1} / ${count}${count >= 5000 ? "+" : ""}` : "No results") : ""}</span>
          <button className="icon-btn sm" title="Previous (⇧↩)" disabled={!count} onClick={() => setFind({ ...find, cur: find.cur - 1 })}>
            <Up size={12} />
          </button>
          <button className="icon-btn sm" title="Next (↩)" disabled={!count} onClick={() => setFind({ ...find, cur: find.cur + 1 })}>
            <Down size={12} />
          </button>
          <button className="icon-btn sm" title="Close (Esc)" onClick={() => setFind(null)}>
            <Close size={12} />
          </button>
        </div>
      )}
      <div className="resp-body selectable">
        {view === "headers" ? (
          <table className="headers-table">
            <tbody>
              {res.headers.map(([k, v], i) => (
                <tr key={i}>
                  <td>{k}</td>
                  <td>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : view === "pretty" && parsed ? (
          <JsonTree key={res.at} value={parsed.value} query={find?.q ?? ""} current={find?.cur ?? 0} onMatches={onMatches} />
        ) : (
          <>
            {view === "raw" && (
              <label className="row small muted" style={{ marginBottom: 8 }}>
                <input type="checkbox" className="checkbox" checked={wrap} onChange={(e) => updateSettings({ wrapResponse: e.target.checked })} />
                Wrap lines
              </label>
            )}
            <RawBody
              text={res.body.length > 2_000_000 ? res.body.slice(0, 2_000_000) + "\n… (truncated)" : res.body}
              wrap={wrap || view === "pretty"}
              query={find?.q ?? ""}
              current={find?.cur ?? 0}
              onMatches={onMatches}
            />
          </>
        )}
      </div>
    </section>
  );
}

const MAX_RAW_MARKS = 5000;

function RawBody({ text, wrap, query, current, onMatches }: { text: string; wrap: boolean; query: string; current: number; onMatches: (n: number) => void }) {
  const box = useRef<HTMLPreElement>(null);
  const hits = useMemo(() => {
    if (!query) return [];
    const out: number[] = [];
    const lower = text.toLowerCase();
    const needle = query.toLowerCase();
    for (let i = lower.indexOf(needle); i >= 0 && out.length < MAX_RAW_MARKS; i = lower.indexOf(needle, i + needle.length)) out.push(i);
    return out;
  }, [text, query]);
  useEffect(() => onMatches(hits.length), [hits, onMatches]);
  const cur = hits.length ? ((current % hits.length) + hits.length) % hits.length : -1;
  useEffect(() => {
    box.current?.querySelector(".jt-hit.cur")?.scrollIntoView({ block: "nearest" });
  }, [cur, hits]);
  if (!text) return <pre className="pre"><span className="muted">(empty body)</span></pre>;
  if (!hits.length) return <pre className={`pre ${wrap ? "wrap" : ""}`}>{text}</pre>;
  const parts: React.ReactNode[] = [];
  let at = 0;
  hits.forEach((h, i) => {
    if (h > at) parts.push(text.slice(at, h));
    parts.push(
      <mark key={h} className={`jt-hit ${i === cur ? "cur" : ""}`}>
        {text.slice(h, h + query.length)}
      </mark>,
    );
    at = h + query.length;
  });
  parts.push(text.slice(at));
  return (
    <pre ref={box} className={`pre ${wrap ? "wrap" : ""}`}>
      {parts}
    </pre>
  );
}

function formatMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
