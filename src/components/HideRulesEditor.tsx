import { useMemo } from "react";
import { setHideRules, toggleShowHidden, useApp } from "../store/app";
import { addHideRule, hasRule, hiddenSet, parseRules } from "../lib/hide";

const HELP = `# One rule per line; the last matching rule wins.
# @deprecated            deprecated endpoints
# @untagged              endpoints without tags
# @tag:Internal          endpoints with a tag
# /admin                 a path and everything below it
# /v2/*/list/v*          * = within a segment, ** = any depth
# DELETE /users/{id}     one endpoint (GET,POST /x for several methods)
# DELETE /admin/**       a method, everything below a path
# !GET /admin/health     show again`;

/** Collection's gitignore-style hide rules with a live count. */
export default function HideRulesEditor({ collectionId }: { collectionId: string }) {
  const c = useApp((s) => s.collections.find((x) => x.id === collectionId))!;
  const spec = useApp((s) => s.specs[collectionId]);
  const text = c.hideRules ?? "";
  const endpoints = spec?.endpoints ?? [];
  const hidden = useMemo(() => hiddenSet(text, endpoints), [text, endpoints]);
  const { errors } = useMemo(() => parseRules(text), [text]);
  const deprecated = endpoints.filter((e) => e.deprecated).length;
  const hidesDeprecated = hasRule(text, "@deprecated");

  return (
    <div className="col" style={{ gap: 6 }}>
      <label className="row">
        <input
          type="checkbox"
          className="checkbox"
          checked={hidesDeprecated}
          disabled={!deprecated && !hidesDeprecated}
          onChange={(e) =>
            setHideRules(
              c.id,
              e.target.checked ? addHideRule(text, "@deprecated") : text.split("\n").filter((l) => l.trim() !== "@deprecated").join("\n"),
            )
          }
        />
        Hide deprecated endpoints <span className="muted">({deprecated})</span>
      </label>
      <textarea
        className="textarea mono"
        rows={Math.min(12, Math.max(4, text.split("\n").length + 1))}
        value={text}
        placeholder={HELP}
        spellCheck={false}
        onChange={(e) => setHideRules(c.id, e.target.value)}
      />
      {errors.map((e) => (
        <div key={e.line} className="field-error">
          Line {e.line}: {e.message}
        </div>
      ))}
      <div className="row small">
        <span className="muted grow">
          {hidden.size} of {endpoints.length} endpoints hidden. Right-click endpoints or folders in the sidebar to hide them quickly.
        </span>
        {hidden.size > 0 && (
          <button className="btn sm ghost" onClick={() => toggleShowHidden(c.id, true)}>
            Show in sidebar
          </button>
        )}
      </div>
    </div>
  );
}
