import { useEffect, useState } from "react";
import { applySync, dismissUpdate, pendingDiff, setModal, useApp } from "../store/app";
import type { EndpointDiff, SpecDiff } from "../lib/diff";
import type { SyncDiffResult } from "../lib/syncDiff";
import Modal from "./Modal";
import { ChevronRight, Warning } from "./Icons";

export default function SyncModal({ collectionId }: { collectionId: string }) {
  const c = useApp((s) => s.collections.find((x) => x.id === collectionId));
  const spec = useApp((s) => s.specs[collectionId]);
  const pendingIds = useApp((s) => s.collections.filter((x) => x.pending).map((x) => x.id));
  const [busy, setBusy] = useState(false);

  // Usually computed in the background already; otherwise the dialog shows progress meanwhile.
  const [result, setResult] = useState<SyncDiffResult | null>(null);
  useEffect(() => {
    if (!c?.pending || !spec) return;
    const p = pendingDiff(collectionId);
    if (!p) return;
    let live = true;
    setResult(p.entry.result ?? p.stale ?? null);
    p.entry.promise.then((r) => live && setResult(r));
    return () => {
      live = false;
    };
  }, [c?.pending, c?.hash, spec, collectionId]);

  if (c?.pending && !spec) {
    // The stored spec failed to load, so there's nothing to compare against; let the update repair it.
    return (
      <Modal
        title={<>Apply update · <span style={{ fontWeight: 500 }}>{c.name}</span></>}
        footer={
          <>
            <button className="btn" onClick={() => setModal(null)}>
              Later
            </button>
            <button
              className="btn primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await applySync(collectionId);
                  setModal(null);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Apply without review
            </button>
          </>
        }
      >
        <p className="muted">
          The current version of this spec could not be loaded, so the changes can't be compared. Applying the new version
          replaces it; saved request values are kept.
        </p>
      </Modal>
    );
  }

  if (!c?.pending) {
    return (
      <Modal title="Spec updates">
        <p className="muted">No pending changes for this collection.</p>
      </Modal>
    );
  }

  const others = pendingIds.filter((id) => id !== collectionId);
  const next = () => setModal(others.length ? { sync: others[0] } : null);

  return (
    <Modal
      wide
      title={
        <>
          Review changes · <span style={{ fontWeight: 500 }}>{c.name}</span>
        </>
      }
      headExtra={<span className="muted small">detected {new Date(c.pending.detectedAt).toLocaleString()}</span>}
      footer={
        <>
          <span className="muted small" style={{ marginRight: "auto" }}>
            Environments, auth and saved request values are preserved. Data for removed endpoints is kept.
          </span>
          <button className="btn" onClick={() => (dismissUpdate(collectionId), next())} title="Ignore this version until the spec changes again">
            Dismiss
          </button>
          <button className="btn" onClick={() => setModal(null)}>
            Later
          </button>
          <button
            className="btn primary"
            disabled={busy || !result || "error" in result}
            onClick={async () => {
              setBusy(true);
              try {
                await applySync(collectionId);
                next();
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy && <span className="spin" />} Sync now
          </button>
        </>
      }
    >
      {!result ? (
        <div className="sync-loading muted">
          <span className="spin" /> Comparing versions…
        </div>
      ) : "error" in result ? (
        <div className="banner danger" style={{ margin: 0 }}>The updated spec could not be parsed: {result.error}</div>
      ) : (
        <DiffView diff={result.diff} />
      )}
    </Modal>
  );
}

function DiffView({ diff }: { diff: SpecDiff }) {
  const total = diff.added.length + diff.modified.length + diff.removed.length;
  return (
    <>
      <div className="summary-cards">
        <Card n={diff.added.length} label="Added" color="var(--ok)" />
        <Card n={diff.modified.length} label="Modified" color="var(--accent)" />
        <Card n={diff.removed.length} label="Removed" color="var(--danger)" />
        <Card n={diff.conflicts.length} label="Conflicts with saved data" color={diff.conflicts.length ? "var(--warn)" : undefined} />
      </div>
      {diff.breaking > 0 && (
        <div className="banner danger" style={{ margin: "0 0 14px" }}>
          <Warning size={14} />
          <span>
            {diff.breaking} potentially incompatible change{diff.breaking > 1 ? "s" : ""} (removed endpoints/parameters, type changes,
            new required fields).
          </span>
        </div>
      )}
      {diff.conflicts.length > 0 && (
        <div className="diff-group">
          <div className="section-title">Conflicts with your saved request values</div>
          {groupBy(diff.conflicts, (c) => c.endpointId).map(([id, list]) => (
            <div key={id} className="diff-item" style={{ borderColor: "color-mix(in srgb, var(--warn) 45%, var(--border))" }}>
              <div className="diff-item-head">
                <EndpointLabel id={id} />
              </div>
              <div className="diff-changes">
                {list.map((c, i) => (
                  <div key={i}>
                    <span className={`sev ${c.severity}`} />
                    {c.message}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      {diff.meta.length > 0 && (
        <div className="diff-group">
          <div className="section-title">Document</div>
          <div className="diff-changes" style={{ padding: 0 }}>
            {diff.meta.map((m, i) => (
              <div key={i}>
                <span className={`sev ${m.severity}`} />
                {m.message}
              </div>
            ))}
          </div>
        </div>
      )}
      <Group title="Removed endpoints" items={diff.removed} />
      <Group title="Modified endpoints" items={diff.modified} expandable />
      <Group title="Added endpoints" items={diff.added} />
      {total === 0 && diff.meta.length === 0 && <p className="muted">Only formatting or documentation changed.</p>}
    </>
  );
}

function Card({ n, label, color }: { n: number; label: string; color?: string }) {
  return (
    <div className="summary-card">
      <div className="n" style={{ color: n ? color : "var(--text-3)" }}>
        {n}
      </div>
      <div className="l">{label}</div>
    </div>
  );
}

function Group({ title, items, expandable }: { title: string; items: EndpointDiff[]; expandable?: boolean }) {
  if (!items.length) return null;
  return (
    <div className="diff-group">
      <div className="section-title">{title}</div>
      {items.map((d) => (
        <DiffItem key={d.id} d={d} expandable={expandable} />
      ))}
    </div>
  );
}

function DiffItem({ d, expandable }: { d: EndpointDiff; expandable?: boolean }) {
  const breaking = d.changes.filter((c) => c.severity === "breaking").length;
  const [open, setOpen] = useState(breaking > 0);
  return (
    <div className="diff-item">
      <div className="diff-item-head" onClick={() => expandable && setOpen(!open)} style={{ cursor: expandable ? "pointer" : "default" }}>
        {expandable && <ChevronRight size={11} className={`chev ${open ? "open" : ""}`} />}
        <EndpointLabel id={d.id} summary={d.endpoint.summary} />
        <span className="spacer" />
        {breaking > 0 && <span className="badge danger">{breaking} breaking</span>}
        {expandable && <span className="muted small">{d.changes.length} change{d.changes.length === 1 ? "" : "s"}</span>}
      </div>
      {open && expandable && (
        <div className="diff-changes">
          {d.changes.map((c, i) => (
            <div key={i}>
              <span className={`sev ${c.severity}`} />
              {c.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function EndpointLabel({ id, summary }: { id: string; summary?: string }) {
  const [method, ...rest] = id.split(" ");
  return (
    <>
      <span className={`method m-${method}`}>{method}</span>
      <span className="path">{rest.join(" ")}</span>
      {summary && <span className="muted small truncate">{summary}</span>}
    </>
  );
}

function groupBy<T>(list: T[], key: (t: T) => string): [string, T[]][] {
  const m = new Map<string, T[]>();
  for (const x of list) m.set(key(x), [...(m.get(key(x)) ?? []), x]);
  return [...m.entries()];
}
