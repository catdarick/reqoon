import { closeTab, discardOrphan, useApp } from "../store/app";
import { isCopyKey, splitRequestKey } from "../lib/models";
import { Trash, Warning } from "./Icons";

/** Shows saved request values for an endpoint that no longer exists in the spec. */
export default function OrphanPanel({ tabKey }: { tabKey: string }) {
  const state = useApp((s) => s.requests[tabKey]);
  const [cid, eid] = splitRequestKey(tabKey);
  const known = useApp((s) => s.specs[cid]);
  if (!known) return <div className="empty"><p>Collection is not available.</p></div>;
  return (
    <div className="pane" style={{ overflow: "auto" }}>
      <div className="banner warn">
        <Warning size={14} />
        <span className="grow">
          <b className="mono">{eid}</b> was removed from the spec. Its saved request values are kept here so nothing is lost.
        </span>
        <button className="btn sm danger" onClick={() => (isCopyKey(tabKey) ? closeTab(tabKey) : discardOrphan(cid, eid))}>
          <Trash size={12} /> Discard saved data
        </button>
      </div>
      {state ? (
        <div className="section">
          <div className="section-title">Saved values</div>
          <pre className="pre wrap selectable">{JSON.stringify({ params: state.params, extraQuery: state.extraQuery, extraHeaders: state.extraHeaders, contentType: state.contentType }, null, 2)}</pre>
          {state.bodyText && (
            <>
              <div className="section-title" style={{ marginTop: 16 }}>Body</div>
              <pre className="pre wrap selectable">{state.bodyText}</pre>
            </>
          )}
        </div>
      ) : (
        <div className="section muted">No saved values.</div>
      )}
    </div>
  );
}
