import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { updateSettings, useApp } from "../store/app";
import JsonTree from "./JsonTree";
import TextView, { FoldRequest, Highlight } from "./TextView";
import { parseJson, stringifyJson } from "../lib/json";
import { Json } from "../lib/schema";
import { Close, CollapseAll, Copy, Down, ExpandAll, Search, Up } from "./Icons";
import { formatCombo } from "../lib/shortcuts";
import { FormatKind, FormattedText, formatText, isXmlResponse } from "../lib/format";
import { formatAsync, WORKER_FROM } from "../lib/formatAsync";

type View = "pretty" | "raw" | "headers";

export const FIND_EVENT = "reqoon:find-in-response";

/** JSON up to this size is shown as a tree; larger JSON as formatted text, whose find stays fast. */
const TREE_MAX = 2_000_000;
/** Find waits for typing to pause on bodies this large. */
const DEBOUNCE_FROM = 1_000_000;

/** The Pretty view of a body: a JSON tree, formatted text, or null for the body as is. */
type Pretty = { tree: Json } | { formatted: FormattedText; highlight: Highlight } | null;

/** Pretty views per response, so switching views doesn't parse or reformat a large body again.
 *  A promise while a large body is being formatted in the worker. */
const prettyCache = new WeakMap<object, Pretty | Promise<void>>();

function prettyOf(res: object, body: string, contentType: string): Pretty | Promise<void> {
  const cached = prettyCache.get(res);
  if (cached !== undefined) return cached;
  const json = /json/i.test(contentType) || /^\s*[[{]/.test(body.slice(0, 256));
  const kind: FormatKind | null = json ? "json" : isXmlResponse(contentType, body) ? "xml" : null;
  let pretty: Pretty | Promise<void> = null;
  if (json && body.length <= TREE_MAX) {
    try {
      pretty = { tree: parseJson(body) };
    } catch {
      pretty = null;
    }
  } else if (kind && body.length < WORKER_FROM) {
    const formatted = formatText(kind, body);
    pretty = formatted && { formatted, highlight: kind };
  } else if (kind) {
    pretty = formatAsync(kind, body).then((formatted) => void prettyCache.set(res, formatted && { formatted, highlight: kind }));
  }
  prettyCache.set(res, pretty);
  return pretty;
}

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

  const body = res && !("error" in res) ? res.body : "";
  const contentType = res && !("error" in res) ? (res.headers.find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "") : "";
  // Parsed or formatted only when the Pretty view is shown.
  const [formatted, rerender] = useReducer((n: number) => n + 1, 0);
  const pretty = useMemo(
    () => (!res || "error" in res || view !== "pretty" ? null : prettyOf(res, res.body, contentType)),
    [res, view, contentType, formatted],
  );
  const formatting = pretty instanceof Promise;
  useEffect(() => {
    if (!(pretty instanceof Promise)) return;
    let live = true;
    pretty.then(() => live && rerender());
    return () => {
      live = false;
    };
  }, [pretty]);

  // Collapse/expand all, kept with the response it was clicked for.
  const [foldFor, setFoldFor] = useState<{ res: object; req: FoldRequest } | null>(null);
  const fold = res && foldFor?.res === res ? foldFor.req : undefined;
  const foldAll = (collapse: boolean) => res && setFoldFor({ res, req: { collapse, seq: (foldFor?.req.seq ?? 0) + 1 } });
  const foldable = view === "pretty" && !!pretty && !formatting;

  const typed = find?.q ?? "";
  const [query, setQuery] = useState(typed);
  const delay = body.length >= DEBOUNCE_FROM ? 150 : 0;
  useEffect(() => {
    if (!delay) return setQuery(typed);
    const t = setTimeout(() => setQuery(typed), delay);
    return () => clearTimeout(t);
  }, [typed, delay]);

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
  const copy = () =>
    navigator.clipboard.writeText(
      view !== "pretty" || !pretty || formatting ? res.body : "tree" in pretty ? stringifyJson(pretty.tree, 2) : pretty.formatted.text,
    );

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
        {/* Left of the view switch, so the buttons that stay don't move when these hide. */}
        {foldable && (
          <>
            <button className="icon-btn" title="Collapse all" onClick={() => foldAll(true)}>
              <CollapseAll />
            </button>
            <button className="icon-btn" title="Expand all" onClick={() => foldAll(false)}>
              <ExpandAll />
            </button>
          </>
        )}
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
          <span className="small muted find-count">{find.q ? (count ? `${(((find.cur % count) + count) % count) + 1} / ${count}` : "No results") : ""}</span>
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
      <div className={`resp-body selectable ${view === "headers" || (view === "pretty" && (formatting || (pretty && "tree" in pretty))) || !body ? "" : "flush"}`}>
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
        ) : !body ? (
          <pre className="pre">
            <span className="muted">(empty body)</span>
          </pre>
        ) : view === "pretty" && formatting ? (
          <div className="row muted small">
            <span className="spin" style={{ color: "var(--accent)" }} />
            Formatting {formatSize(res.size)}…
          </div>
        ) : view === "pretty" && pretty && "tree" in pretty ? (
          <JsonTree key={res.at} value={pretty.tree} query={query} current={find?.cur ?? 0} onMatches={onMatches} fold={fold} />
        ) : view === "pretty" && pretty && "formatted" in pretty ? (
          <TextView
            key="pretty"
            text={pretty.formatted.text}
            folds={pretty.formatted.folds}
            highlight={pretty.highlight}
            fold={fold}
            wrap
            query={query}
            current={find?.cur ?? 0}
            onMatches={onMatches}
          />
        ) : (
          <>
            {view === "raw" && (
              <label className="row small muted resp-wrap">
                <input type="checkbox" className="checkbox" checked={wrap} onChange={(e) => updateSettings({ wrapResponse: e.target.checked })} />
                Wrap lines
              </label>
            )}
            <TextView key="raw" text={body} wrap={wrap || view === "pretty"} query={query} current={find?.cur ?? 0} onMatches={onMatches} />
          </>
        )}
      </div>
    </section>
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
