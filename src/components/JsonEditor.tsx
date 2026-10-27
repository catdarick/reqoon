import { useEffect, useRef } from "react";
import { basicSetup } from "codemirror";
import { EditorView, keymap } from "@codemirror/view";
import { EditorState, Extension } from "@codemirror/state";
import { json, jsonLanguage } from "@codemirror/lang-json";
import { syntaxHighlighting, HighlightStyle, syntaxTree } from "@codemirror/language";
import { indentWithTab } from "@codemirror/commands";
import { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { Diagnostic, linter } from "@codemirror/lint";
import { tags as t } from "@lezer/highlight";
import { cursorContext, locatePointers, Seg } from "../lib/jsontext";
import { defaultValue, describeType, itemSchema, Json, normalize, NSchema, validate, variantsOf } from "../lib/schema";
import { DYNAMIC_VARS } from "../lib/vars";
import { parseJson, stringifyJson } from "../lib/json";
import { activeVars } from "../store/app";

const highlight = HighlightStyle.define([
  { tag: t.propertyName, color: "var(--j-key)" },
  { tag: t.string, color: "var(--j-string)" },
  { tag: t.number, color: "var(--j-number)" },
  { tag: [t.bool, t.null], color: "var(--j-bool)" },
  { tag: [t.punctuation, t.separator, t.brace, t.squareBracket], color: "var(--j-punct)" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", color: "var(--text)" },
  ".cm-content": { padding: "10px 0", caretColor: "var(--text)" },
  ".cm-foldPlaceholder": { background: "var(--bg-active)", border: "none", color: "var(--text-2)" },
  ".cm-matchingBracket": { background: "var(--accent-soft) !important", outline: "none" },
  ".cm-searchMatch": { background: "color-mix(in srgb, var(--warn) 30%, transparent)" },
});

export default function JsonEditor({
  value,
  onChange,
  doc,
  schema,
  json: isJson = true,
  readOnly = false,
}: {
  value: string;
  onChange?: (v: string) => void;
  doc?: Json;
  schema?: Json;
  json?: boolean;
  readOnly?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const latest = useRef({ onChange, doc, schema });
  latest.current = { onChange, doc, schema };

  useEffect(() => {
    const exts: Extension[] = [
      basicSetup,
      keymap.of([indentWithTab]),
      syntaxHighlighting(highlight),
      theme,
      EditorView.updateListener.of((u) => {
        if (u.docChanged) latest.current.onChange?.(u.state.doc.toString());
      }),
      EditorState.readOnly.of(readOnly),
      EditorView.contentAttributes.of({ "aria-label": "Request body" }),
    ];
    if (isJson) {
      exts.push(json());
      exts.push(jsonLanguage.data.of({ autocomplete: (ctx: CompletionContext) => complete(ctx, latest.current.doc, latest.current.schema) }));
      exts.push(linter((v) => lint(v, latest.current.doc, latest.current.schema), { delay: 250 }));
    }
    const v = new EditorView({ parent: host.current!, state: EditorState.create({ doc: value, extensions: exts }) });
    view.current = v;
    return () => v.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isJson, readOnly]);

  // Apply external changes (e.g. edits made in Form mode or "Example").
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
    }
  }, [value]);

  return <div className="editor-wrap" ref={host} />;
}

/** Collects the candidate schemas at a path, taking the union across oneOf/anyOf branches. */
function schemasAt(doc: Json, root: Json, path: Seg[]): NSchema[] {
  let cur: NSchema[] = expand(doc, [normalize(doc, root)]);
  for (const seg of path) {
    const next: NSchema[] = [];
    for (const s of cur) {
      if (typeof seg === "number") {
        if (s.items || s.prefixItems) next.push(normalize(doc, itemSchema(s, seg)));
      } else {
        const p = s.properties?.[seg];
        if (p) next.push(normalize(doc, p));
        else if (s.additionalProperties && typeof s.additionalProperties === "object") next.push(normalize(doc, s.additionalProperties));
      }
    }
    cur = expand(doc, next);
    if (!cur.length) break;
  }
  return cur;
}

function expand(doc: Json, list: NSchema[], depth = 0): NSchema[] {
  const out: NSchema[] = [];
  for (const s of list) {
    const vs = variantsOf(doc, s);
    if (vs && depth < 4) out.push(...expand(doc, vs.list.map((v) => normalize(doc, v.schema)), depth + 1));
    else out.push(s);
  }
  return out;
}

function snippetFor(doc: Json, s: NSchema): { text: string; cursor: number } {
  const t = s._types[0];
  if (Array.isArray(s.enum) && s.enum.length) {
    const txt = JSON.stringify(s.enum[0]);
    return { text: txt, cursor: txt.length };
  }
  if (variantsOf(doc, s)) return { text: "", cursor: 0 };
  switch (t) {
    case "string":
      return { text: '""', cursor: 1 };
    case "object":
      return { text: "{}", cursor: 1 };
    case "array":
      return { text: "[]", cursor: 1 };
    case "boolean":
      return { text: "false", cursor: 5 };
    case "integer":
    case "number":
      return { text: "0", cursor: 1 };
    default:
      return { text: "", cursor: 0 };
  }
}

function complete(ctx: CompletionContext, doc: Json, schema: Json): CompletionResult | null {
  const text = ctx.state.doc.toString();
  const pos = ctx.pos;

  // {{variable}} completion inside strings.
  const before = text.slice(Math.max(0, pos - 64), pos);
  const vm = before.match(/\{\{([\w$.-]*)$/);
  if (vm) {
    const names = [...Object.keys(activeVars()), ...DYNAMIC_VARS];
    return {
      from: pos - vm[1].length,
      options: names.map((n) => ({ label: n, type: "variable", apply: `${n}}}`, detail: n.startsWith("$") ? "dynamic" : "env" })),
      validFor: /^[\w$.-]*$/,
    };
  }

  if (!doc || !schema) return null;
  const c = cursorContext(text, pos);
  if (c.kind === "none") return null;
  if (!ctx.explicit && c.kind === "value" && !c.inString && c.typed === "" && !/[:[,]\s*$/.test(text.slice(0, pos))) return null;
  const candidates = schemasAt(doc, schema, c.path);
  if (!candidates.length) return null;

  if (c.kind === "key") {
    const seen = new Set<string>(c.existingKeys);
    const options: Completion[] = [];
    for (const s of candidates) {
      const req = new Set<string>(s.required ?? []);
      for (const [k, raw] of Object.entries<Json>(s.properties ?? {})) {
        if (seen.has(k)) continue;
        seen.add(k);
        const ps = normalize(doc, raw);
        if (ps.readOnly) continue;
        const snip = snippetFor(doc, ps);
        const insert = `"${k}": ${snip.text}`;
        // Replace the partially typed key (including its quotes) and an existing ": " if present.
        options.push({
          label: k,
          type: "property",
          detail: describeType(doc, raw) + (req.has(k) ? " · required" : ""),
          info: ps.description,
          boost: req.has(k) ? 2 : 0,
          apply: (view, _completion, _from, to) => {
            const from = c.from;
            let end = to;
            const rest = view.state.doc.sliceString(to, to + 3);
            if (c.inString && rest.startsWith('"')) end += 1;
            view.dispatch({ changes: { from, to: end, insert }, selection: { anchor: from + insert.length - snip.text.length + snip.cursor } });
          },
        });
      }
    }
    // Filter on the text after the opening quote; apply() replaces the quote too.
    return { from: c.inString ? c.from + 1 : c.from, to: c.inString ? undefined : c.to, options, validFor: /^[\w$-]*$/ };
  }

  // Value completions.
  const options: Completion[] = [];
  const added = new Set<string>();
  const push = (label: string, detail?: string, boost = 0) => {
    if (added.has(label)) return;
    added.add(label);
    options.push({ label, type: "constant", detail, boost });
  };
  for (const s of candidates) {
    if (Array.isArray(s.enum)) s.enum.forEach((v: Json) => push(JSON.stringify(v), "enum", 3));
    if (s.const !== undefined) push(JSON.stringify(s.const), "const", 3);
    if (s.default !== undefined) push(JSON.stringify(s.default), "default", 2);
    if (s.example !== undefined && typeof s.example !== "object") push(JSON.stringify(s.example), "example", 1);
    if (s._types.includes("boolean")) (push("true"), push("false"));
    if (s._nullable) push("null");
    if (s._types.includes("object")) {
      const v = defaultValue(doc, s, 1);
      push(stringifyJson(v), "object", 0);
    }
    if (s._types.includes("array")) push("[]", "array");
    if (s.format === "date-time") push(JSON.stringify(new Date().toISOString()), "now");
    if (s.format === "uuid") push(JSON.stringify(crypto.randomUUID()), "random uuid");
  }
  if (candidates.some((s) => s._types.includes("string") || !s._types.length))
    for (const n of Object.keys(activeVars())) push(`"{{${n}}}"`, "env variable", -1);
  if (!options.length) return null;
  return { from: c.from, to: c.to, options, validFor: /^"?[^"]*"?$/ };
}

function lint(view: EditorView, doc: Json, schema: Json): Diagnostic[] {
  const text = view.state.doc.toString();
  if (!text.trim()) return [];
  const out: Diagnostic[] = [];
  try {
    const value = parseJson(text);
    if (!doc || !schema) return [];
    const errors = validate(doc, schema, value);
    if (!errors.length) return [];
    const locs = locatePointers(text);
    for (const e of errors) {
      let ptr = e.path;
      let loc = locs?.get(ptr);
      // Missing required keys don't exist in the text: point at the parent object instead.
      while (!loc && ptr) {
        ptr = ptr.slice(0, ptr.lastIndexOf("/"));
        loc = locs?.get(ptr);
      }
      const isMissing = loc && ptr !== e.path;
      const from = loc ? (isMissing ? loc.from : loc.keyFrom ?? loc.from) : 0;
      const to = loc ? (isMissing ? loc.from + 1 : loc.keyTo ?? loc.to) : Math.min(text.length, 1);
      const field = e.path.split("/").pop();
      out.push({ from, to, severity: "error", message: isMissing ? `Missing required property “${field}”` : `${e.path || "/"}: ${e.message}` });
    }
  } catch (err) {
    let reported = false;
    syntaxTree(view.state).iterate({
      enter: (n) => {
        if (!reported && n.type.isError) {
          out.push({ from: n.from, to: Math.max(n.to, n.from + 1), severity: "error", message: (err as Error).message.replace(/^JSON\.parse: /, "") });
          reported = true;
        }
      },
    });
    if (!reported) {
      const m = (err as Error).message.match(/position (\d+)/);
      const p = m ? Math.min(Number(m[1]), text.length) : text.length;
      out.push({ from: Math.max(0, p - 1), to: p, severity: "error", message: (err as Error).message });
    }
  }
  return out;
}
