import { useState } from "react";
import { setAuth, setModal, updateCollection, useApp } from "../store/app";
import { authAlternatives, authChoiceKey, chooseAuth, collectionSchemes } from "../lib/request";
import type { OperationInfo, SecurityScheme } from "../lib/openapi";
import { Eye, EyeOff, Lock } from "./Icons";
import Markdown from "./Markdown";

/** True when credentials for `scheme` have been entered. */
export function useConfigured(collectionId: string) {
  const cfg = useApp((s) => s.vault.auth[collectionId] ?? {});
  return (scheme: string) => {
    const c = cfg[scheme];
    return !!c && (c.value !== "" || !!c.username || !!c.password);
  };
}

export default function AuthEditor({
  collectionId,
  op,
  schemes: specSchemes,
}: {
  collectionId: string;
  op: OperationInfo;
  schemes: Record<string, SecurityScheme>;
}) {
  const collection = useApp((s) => s.collections.find((c) => c.id === collectionId));
  const configured = useConfigured(collectionId);
  if (!collection) return null;
  const schemes = collectionSchemes(collection, specSchemes);
  const alternatives = authAlternatives(op.security, collection);
  // What will actually be sent; with nothing set up yet, show the first option's fields.
  const chosen =
    chooseAuth(alternatives, configured, collection.authChoice) ?? alternatives.find((alt) => Object.keys(alt).length) ?? alternatives[0];
  const chosenKey = chosen ? authChoiceKey(chosen) : undefined;
  const names = chosen ? Object.keys(chosen) : [];
  return (
    <div className="section">
      <div className="banner info" style={{ margin: "0 0 14px" }}>
        <Lock size={14} />
        <span>
          Credentials are shared by all endpoints of this collection and stored in your system keychain. Use{" "}
          <span className="mono">{"{{variable}}"}</span> to pull values from the active{" "}
          <a href="#" onClick={(e) => (e.preventDefault(), setModal("environments"))} style={{ color: "inherit" }}>
            environment
          </a>
          . Add your own methods in{" "}
          <a href="#" onClick={(e) => (e.preventDefault(), setModal({ collection: collectionId, section: "auth" }))} style={{ color: "inherit" }}>
            collection settings
          </a>
          .
        </span>
      </div>
      {alternatives.length > 1 && (
        <div className="auth-choice">
          <div className="section-title">Authenticate with</div>
          <div className="seg" role="radiogroup">
            {alternatives.map((alt) => {
              const key = authChoiceKey(alt);
              return (
                <button
                  key={key}
                  role="radio"
                  aria-checked={key === chosenKey}
                  className={key === chosenKey ? "active" : ""}
                  onClick={() => updateCollection(collectionId, { authChoice: key })}
                >
                  {altLabel(alt, schemes)}
                </button>
              );
            })}
          </div>
          <div className="field-desc">The API accepts any one of these; only the selected one is sent.</div>
        </div>
      )}
      {names.length > 1 && <div className="field-desc" style={{ marginBottom: 12 }}>This option needs all of the following.</div>}
      {chosen && !names.length && <div className="muted small">No credentials are sent.</div>}
      {names.map((name) =>
        schemes[name] ? (
          <div key={name} style={{ marginBottom: 18 }}>
            <SchemeHeader name={name} scheme={schemes[name]} />
            <SchemeFields collectionId={collectionId} name={name} scheme={schemes[name]} />
          </div>
        ) : (
          <div key={name} className="field-error">
            Unknown security scheme “{name}”
          </div>
        ),
      )}
    </div>
  );
}

export function SchemeHeader({ name, scheme }: { name: string; scheme: SecurityScheme }) {
  return (
    <>
      <div className="section-title" style={{ marginBottom: 4 }}>
        {scheme.title ?? name}
        <span className="badge">{schemeLabel(scheme)}</span>
      </div>
      {scheme.description && <Markdown className="field-desc auth-desc" text={scheme.description} />}
    </>
  );
}

/** Credential inputs for one scheme (stored per collection in the keychain vault). */
export function SchemeFields({ collectionId, name, scheme }: { collectionId: string; name: string; scheme: SecurityScheme }) {
  const c = useApp((s) => s.vault.auth[collectionId]?.[name]) ?? { value: "" };
  const basic = scheme.type === "http" && scheme.scheme?.toLowerCase() === "basic";
  return (
    <>
      {basic ? (
        <div className="col">
          <SecretInput placeholder="Username" value={c.username ?? ""} plain onChange={(v) => setAuth(collectionId, name, { username: v })} />
          <SecretInput placeholder="Password" value={c.password ?? ""} onChange={(v) => setAuth(collectionId, name, { password: v })} />
        </div>
      ) : (
        <SecretInput
          placeholder={scheme.type === "apiKey" ? `${scheme.name} value, e.g. {{apiKey}}` : "Token, e.g. {{token}}"}
          value={c.value}
          onChange={(v) => setAuth(collectionId, name, { value: v })}
        />
      )}
      {(scheme.type === "oauth2" || scheme.type === "openIdConnect") && (
        <div className="field-desc">Paste an access token; it is sent as a Bearer token.</div>
      )}
    </>
  );
}

/** A human name for one scheme: "Bearer token", "API key (header X-Key)". */
export function schemeTitle(s: SecurityScheme | undefined, fallback: string): string {
  if (!s) return fallback;
  if (s.title) return s.title;
  if (s.type === "http") {
    const scheme = s.scheme?.toLowerCase();
    return scheme === "basic" ? "Basic auth" : scheme === "bearer" ? "Bearer token" : `HTTP ${s.scheme}`;
  }
  if (s.type === "apiKey") return `API key (${s.in} ${s.name})`;
  if (s.type === "oauth2") return "OAuth 2";
  if (s.type === "openIdConnect") return "OpenID Connect";
  return fallback;
}

/** A human name for a requirement set: "Bearer token", "API key (header X-Key) + Basic auth", "No auth". */
export function altLabel(alt: Record<string, unknown>, schemes: Record<string, SecurityScheme>): string {
  const names = Object.keys(alt);
  if (!names.length) return "No auth";
  return names.map((n) => schemeTitle(schemes[n], n)).join(" + ");
}

export function schemeLabel(s: SecurityScheme): string {
  if (s.type === "apiKey") return `API key · ${s.in} “${s.name}”`;
  if (s.type === "http") return `HTTP ${s.scheme}${s.bearerFormat ? ` (${s.bearerFormat})` : ""}`;
  return s.type;
}

export function SecretInput({ value, onChange, placeholder, plain }: { value: string; onChange: (v: string) => void; placeholder?: string; plain?: boolean }) {
  const [show, setShow] = useState(false);
  const isRef = /^\s*\{\{[^}]+\}\}\s*$/.test(value);
  return (
    <div className="row" style={{ gap: 4 }}>
      <input
        className="input mono"
        type={plain || show || isRef ? "text" : "password"}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
      />
      {!plain && (
        <button className="icon-btn" onClick={() => setShow(!show)} aria-label={show ? "Hide" : "Show"}>
          {show ? <EyeOff /> : <Eye />}
        </button>
      )}
    </div>
  );
}
