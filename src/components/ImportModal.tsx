import { useState } from "react";
import { importCollection, setModal, toast } from "../store/app";
import { isTauri, pickSpecFile } from "../lib/platform";
import { SAMPLE_SPEC } from "../sample";
import Modal from "./Modal";
import { Clipboard, File, Globe } from "./Icons";

type Mode = "url" | "file" | "paste";

export default function ImportModal() {
  const [mode, setMode] = useState<Mode>("url");
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setModal(null);
      toast("success", "Collection imported");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const importFile = async () => {
    if (isTauri) {
      const path = await pickSpecFile();
      if (path) run(() => importCollection({ kind: "file", location: path }));
      return;
    }
    // Browser fallback: read the file once (no change monitoring possible).
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,.yaml,.yml";
    input.onchange = () => {
      const f = input.files?.[0];
      if (f) run(async () => importCollection({ kind: "paste", location: f.name }, await f.text()));
    };
    input.click();
  };

  return (
    <Modal
      title="Import OpenAPI specification"
      footer={
        <>
          <button className="btn ghost" style={{ marginRight: "auto" }} disabled={busy} onClick={() => run(() => importCollection({ kind: "paste", location: "sample" }, SAMPLE_SPEC))}>
            Try the sample API
          </button>
          <button className="btn" onClick={() => setModal(null)}>
            Cancel
          </button>
          {mode !== "file" && (
            <button
              className="btn primary"
              disabled={busy || (mode === "url" ? !url.trim() : !text.trim())}
              onClick={() =>
                run(() => (mode === "url" ? importCollection({ kind: "url", location: url.trim() }) : importCollection({ kind: "paste" }, text)))
              }
            >
              {busy ? <span className="spin" /> : null} Import
            </button>
          )}
        </>
      }
    >
      <div className="seg" style={{ marginBottom: 16 }}>
        <button className={mode === "url" ? "active" : ""} onClick={() => setMode("url")}>
          <Globe size={12} /> URL
        </button>
        <button className={mode === "file" ? "active" : ""} onClick={() => setMode("file")}>
          <File size={12} /> File
        </button>
        <button className={mode === "paste" ? "active" : ""} onClick={() => setMode("paste")}>
          <Clipboard size={12} /> Paste
        </button>
      </div>
      {mode === "url" && (
        <form onSubmit={(e) => (e.preventDefault(), url.trim() && run(() => importCollection({ kind: "url", location: url.trim() })))}>
          <input
            autoFocus
            className="input mono"
            style={{ height: 34 }}
            placeholder="https://api.example.com/openapi.json"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <div className="form-hint">JSON or YAML. Reqoon checks the URL periodically and lets you review changes before syncing.</div>
          <div className="form-hint">
            Example:{" "}
            <a href="#" style={{ color: "var(--accent)" }} onClick={(e) => (e.preventDefault(), setUrl("https://petstore3.swagger.io/api/v3/openapi.json"))}>
              petstore3.swagger.io/api/v3/openapi.json
            </a>
          </div>
        </form>
      )}
      {mode === "file" && (
        <div className="col" style={{ alignItems: "flex-start" }}>
          <button className="btn primary" disabled={busy} onClick={importFile}>
            <File size={13} /> Choose a .json / .yaml file…
          </button>
          <div className="form-hint">
            {isTauri ? "The file is watched; edits show up as reviewable updates." : "Running in a browser: the file is imported once and not watched."}
          </div>
        </div>
      )}
      {mode === "paste" && (
        <textarea
          autoFocus
          className="textarea mono"
          rows={14}
          placeholder="Paste an OpenAPI 3.x document (JSON or YAML)"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      )}
      {error && (
        <div className="banner danger" style={{ margin: "12px 0 0" }}>
          <span className="selectable">{error}</span>
        </div>
      )}
    </Modal>
  );
}
