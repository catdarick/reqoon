import { createContext, memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  defaultValue,
  describeType,
  escapeKey,
  hasNullAlternative,
  itemSchema,
  Json,
  jsonType,
  matchVariant,
  normalize,
  NSchema,
  switchVariant,
  ValidationError,
  Variant,
  variantsOf,
} from "../lib/schema";
import { BigInt64Value, integerFromText, isBig, isPlainObject, parseJson, stringifyJson } from "../lib/json";
import { ChevronRight, Close, Down, Plus, Up } from "./Icons";
import { markdownToText } from "../lib/markdown";
import Markdown from "./Markdown";

interface Ctx {
  doc: Json;
  errors: Map<string, string[]>;
  errorPrefixes: Set<string>;
}
const FormCtx = createContext<Ctx>({ doc: {}, errors: new Map(), errorPrefixes: new Set() });

const WHOLE_VAR = /^\{\{\s*[^{}\s]+\s*\}\}$/;

export default function SchemaForm({
  doc,
  schema,
  value,
  errors,
  onChange,
}: {
  doc: Json;
  schema: Json;
  value: Json;
  errors: ValidationError[];
  onChange: (v: Json) => void;
}) {
  const ctx = useMemo(() => {
    const map = new Map<string, string[]>();
    const prefixes = new Set<string>();
    for (const e of errors) {
      map.set(e.path, [...(map.get(e.path) ?? []), e.message]);
      const parts = e.path.split("/");
      for (let i = 1; i < parts.length; i++) prefixes.add(parts.slice(0, i).join("/"));
    }
    return { doc, errors: map, errorPrefixes: prefixes };
  }, [doc, errors]);

  return (
    <FormCtx.Provider value={ctx}>
      <div className="sf">
        <Field schema={schema} value={value} onChange={onChange} path="" depth={0} />
      </div>
    </FormCtx.Provider>
  );
}

interface FieldProps {
  schema: Json;
  value: Json;
  onChange: (v: Json) => void;
  path: string;
  depth: number;
  name?: string;
  required?: boolean;
  onRemove?: () => void;
  labelExtra?: React.ReactNode;
  /** Object keys not to render (variant tags already chosen in the variant picker). */
  hiddenKeys?: string[];
}

const Field = memo(function Field(props: FieldProps) {
  const { doc, errors, errorPrefixes } = useContext(FormCtx);
  const { schema, value, onChange, path, depth, name, required, onRemove } = props;
  const s = normalize(doc, schema);
  const [collapsed, setCollapsed] = useState(depth > 8);
  const own = errors.get(path) ?? [];
  const nestedError = errorPrefixes.has(path) && own.length === 0;
  const union = value !== null ? variantsOf(doc, s) : null;
  const variants = union && union.list.length ? union.list : null;
  // The user's explicit choice wins while the value still fits it (see matchVariant).
  const [chosen, setChosen] = useState<number | undefined>(undefined);
  const vIdx = variants ? matchVariant(doc, s, variants, value, chosen) : -1;
  const isContainer = value !== null && (!!variants || (s._types.length === 1 && (s._types[0] === "object" || s._types[0] === "array")));
  const nullable = s._nullable || hasNullAlternative(doc, s);
  const setValue = () => onChange(defaultValue(doc, schema, 1, { nonNull: true }));
  const named = name !== undefined;
  const typeText = describeType(doc, schema);

  // The variant picker sits in the field's label (or on its own line for unnamed values), so
  // the list of alternatives isn't repeated as a type.
  const picker = variants && (
    <select
      className="select sf-picker"
      value={value === undefined ? "" : vIdx}
      onChange={(e) => {
        const i = Number(e.target.value);
        setChosen(i);
        onChange(switchVariant(doc, s, variants, value, i));
      }}
    >
      {value === undefined && (
        <option value="" disabled>
          Choose…
        </option>
      )}
      {variants.map((v, i) => (
        <option key={i} value={i}>
          {v.label}
        </option>
      ))}
    </select>
  );

  const actions = (
    <span className="actions">
      {nullable && value !== undefined && value !== null && (
        <button className="btn sm ghost" title="Set to null" onClick={() => onChange(null)}>
          null
        </button>
      )}
      {onRemove && (
        <button className="icon-btn sm" title="Remove field" onClick={onRemove}>
          <Close size={11} />
        </button>
      )}
    </span>
  );

  const nameEl = named && (
    <span
      className="name"
      style={{ cursor: isContainer ? "pointer" : undefined }}
      onClick={() => isContainer && setCollapsed(!collapsed)}
    >
      {name}
      {required && <span className="req-star">*</span>}
    </span>
  );

  let editor: React.ReactNode;
  if (value === null) {
    // Always offer a way out of null, even for fields that don't allow it.
    editor = (
      <div className="row">
        <span className="null-pill">null</span>
        <button className="btn sm ghost" onClick={setValue}>
          set value
        </button>
      </div>
    );
  } else {
    editor = (
      <ValueEditor
        s={s}
        schema={schema}
        value={value}
        onChange={onChange}
        path={path}
        depth={depth}
        invalid={own.length > 0}
        required={!!required || !named}
        hiddenKeys={props.hiddenKeys}
        variant={variants ? { idx: vIdx, list: variants, picker: named ? null : picker } : undefined}
      />
    );
  }
  const messages = (
    <>
      {own.map((m, i) => (
        <div key={i} className="field-error">
          {m}
        </div>
      ))}
    </>
  );

  // Simple values: a label | editor row in the parent object's grid.
  if (named && !isContainer) {
    return (
      <div className="sf-field sf-row">
        <div className="sf-label">
          {nameEl}
          {s.deprecated && <span className="badge warn">deprecated</span>}
          {props.labelExtra}
        </div>
        <div className="sf-body">
          <div className="sf-control">
            <div className="grow">{editor}</div>
            {actions}
          </div>
          {messages}
          {s.description && <Markdown className="field-desc" text={s.description} />}
        </div>
      </div>
    );
  }

  return (
    <div className="sf-field sf-block">
      {named && (
        <div className="sf-label">
          <button className="icon-btn sm sf-chev" onClick={() => setCollapsed(!collapsed)} aria-label={collapsed ? "Expand" : "Collapse"}>
            <ChevronRight size={11} className={`chev ${collapsed ? "" : "open"}`} />
          </button>
          {nameEl}
          {picker}
          {!picker && s._types[0] === "array" && <span className="type">{typeText}</span>}
          {s.deprecated && <span className="badge warn">deprecated</span>}
          {collapsed && value !== undefined && <span className="muted small">{summarize(value)}</span>}
          {props.labelExtra}
          {actions}
        </div>
      )}
      {named && s.description && !collapsed && <Markdown className="field-desc sf-block-desc" text={s.description} />}
      {!(named && collapsed) && <div className={named ? `sf-nest ${nestedError ? "err" : ""}` : undefined}>{editor}</div>}
      {messages}
    </div>
  );
});

function summarize(v: Json): string {
  if (Array.isArray(v)) return `[${v.length} item${v.length === 1 ? "" : "s"}]`;
  if (isPlainObject(v)) return `{${Object.keys(v).length} field${Object.keys(v).length === 1 ? "" : "s"}}`;
  return "";
}

interface EditorProps {
  s: NSchema;
  schema: Json;
  value: Json;
  onChange: (v: Json) => void;
  path: string;
  depth: number;
  invalid: boolean;
  /** Whether the field must stay present (required property, array item or root). */
  required: boolean;
  hiddenKeys?: string[];
  /** For unions: the matched variant and, for unnamed values, the picker to show above it. */
  variant?: { idx: number; list: Variant[]; picker: React.ReactNode };
}

function ValueEditor(props: EditorProps) {
  const { s } = props;

  if (props.variant) return <VariantEditor {...props} variant={props.variant} />;
  if (Array.isArray(s.enum) && s.enum.some((v: Json) => v !== null)) return <EnumEditor {...props} />;
  // Multiple primitive types (e.g. ["string", "integer"]): let the user pick one.
  if (s._types.length > 1) return <MultiTypeEditor {...props} />;

  switch (s._types[0]) {
    case "object":
      return <ObjectEditor {...props} />;
    case "array":
      return <ArrayEditor {...props} />;
    case "string":
      return <StringEditor {...props} />;
    case "integer":
    case "number":
      return <NumberEditor {...props} />;
    case "boolean":
      return (
        <div className="row">
          <button
            className={`toggle ${props.value === true ? "on" : ""}`}
            role="switch"
            aria-checked={props.value === true}
            onClick={() => props.onChange(!(props.value === true))}
          />
          <span className="mono small muted">{props.value === undefined ? "unset" : String(props.value)}</span>
        </div>
      );
    default:
      return <AnyEditor {...props} />;
  }
}

const INVALID = "__invalid";

function EnumEditor({ s, value, onChange, invalid }: EditorProps) {
  const opts: Json[] = s.enum.filter((v: Json) => v !== null);
  const key = (v: Json) => stringifyJson(v);
  const idx = value === undefined ? -1 : opts.findIndex((o) => key(o) === key(value));
  const current = value === undefined ? "" : idx >= 0 ? String(idx) : INVALID;
  return (
    <select
      className={`select ${invalid || current === INVALID ? "invalid" : ""}`}
      value={current}
      onChange={(e) => {
        const i = Number(e.target.value);
        if (!isNaN(i) && opts[i] !== undefined) onChange(opts[i]);
      }}
    >
      {value === undefined && (
        <option value="" disabled>
          Select…
        </option>
      )}
      {opts.map((o, i) => (
        <option key={i} value={i}>
          {typeof o === "string" ? (o === "" ? "(empty string)" : o) : stringifyJson(o)}
        </option>
      ))}
      {current === INVALID && (
        <option value={INVALID} disabled>
          {stringifyJson(value)} (not allowed)
        </option>
      )}
    </select>
  );
}

function VariantEditor(props: EditorProps & { variant: NonNullable<EditorProps["variant"]> }) {
  const { value, onChange } = props;
  const { idx, list, picker } = props.variant;
  const variant = list[idx];
  // Tags shown by the picker aren't repeated as fields, unless the value disagrees with them.
  const hidden = isPlainObject(value)
    ? Object.keys(variant.tags).filter((k) => k in value && stringifyJson(value[k]) === stringifyJson(variant.tags[k]))
    : [];
  return (
    <div>
      {picker && <div className="sf-variant">{picker}</div>}
      {value !== undefined && (
        <Field key={idx} schema={variant.schema} value={value} onChange={onChange} path={props.path} depth={props.depth + 1} hiddenKeys={hidden} />
      )}
    </div>
  );
}

function MultiTypeEditor(props: EditorProps) {
  const { doc } = useContext(FormCtx);
  const { s, value, onChange } = props;
  const vt = value === undefined ? s._types[0] : jsonType(value) === "integer" && !s._types.includes("integer") ? "number" : jsonType(value);
  const cur = s._types.includes(vt) ? vt : s._types[0];
  return (
    <div>
      <div className="sf-variant">
        <span className="muted small">Type</span>
        <select
          className="select"
          value={cur}
          onChange={(e) => onChange(defaultValue(doc, { ...s, type: e.target.value, enum: undefined, default: undefined }, 1, { nonNull: true }))}
        >
          {s._types.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </div>
      <ValueEditor key={cur} {...props} s={{ ...s, _types: [cur] }} />
    </div>
  );
}

function ObjectEditor({ s, value, onChange, path, depth, hiddenKeys }: EditorProps) {
  const { doc } = useContext(FormCtx);
  const [newKey, setNewKey] = useState("");
  if (!isPlainObject(value)) {
    return (
      <button className="btn sm" onClick={() => onChange(defaultValue(doc, s, depth, { nonNull: true }))}>
        <Plus size={12} /> {value === undefined ? "Add object" : `Replace ${jsonType(value)} with object`}
      </button>
    );
  }
  const obj = value as Record<string, Json>;
  const props: Record<string, Json> = s.properties ?? {};
  const required = new Set<string>(s.required ?? []);
  const hidden = new Set(hiddenKeys ?? []);
  const allKeys = Object.keys(props);
  const keys = allKeys.filter((k) => !normalize(doc, props[k]).readOnly && !hidden.has(k));
  const shown = keys.filter((k) => required.has(k) || k in obj);
  const optional = keys.filter((k) => !shown.includes(k));
  const extra = Object.keys(obj).filter((k) => !(k in props));
  const allowExtra = s.additionalProperties !== false && (s.additionalProperties !== undefined || allKeys.length === 0);
  const extraSchema = typeof s.additionalProperties === "object" ? s.additionalProperties : {};
  const undeclared = s.additionalProperties === undefined && allKeys.length > 0;

  const set = (k: string, v: Json) => onChange({ ...obj, [k]: v });
  const remove = (k: string) => {
    const next = { ...obj };
    delete next[k];
    onChange(next);
  };
  const add = (k: string) => {
    // Insert in schema order so the JSON stays tidy; keys we don't render (readOnly, tags) are kept.
    const v = defaultValue(doc, props[k], depth + 1, { nonNull: true });
    const next: Record<string, Json> = {};
    for (const key of [...allKeys, ...extra]) {
      if (key === k) next[key] = v;
      else if (key in obj) next[key] = obj[key];
    }
    onChange(next);
  };

  return (
    <div className="sf-obj">
      {shown.map((k) => (
        <Field
          key={k}
          name={k}
          schema={props[k]}
          value={obj[k]}
          required={required.has(k)}
          path={`${path}/${escapeKey(k)}`}
          depth={depth + 1}
          onChange={(v) => set(k, v)}
          onRemove={required.has(k) ? undefined : () => remove(k)}
        />
      ))}
      {extra.map((k) => (
        <Field
          key={`+${k}`}
          name={k}
          schema={extraSchema}
          value={obj[k]}
          required
          path={`${path}/${escapeKey(k)}`}
          depth={depth + 1}
          onChange={(v) => set(k, v)}
          onRemove={() => remove(k)}
          labelExtra={
            undeclared ? (
              <span className="badge warn" title="This property isn't declared in the schema; the server may reject or ignore it">
                not in schema
              </span>
            ) : null
          }
        />
      ))}
      {(optional.length > 0 || allowExtra) && (
        <div className="sf-optional">
          {optional.map((k) => (
            <button key={k} className="chip" title={normalize(doc, props[k]).description ? markdownToText(normalize(doc, props[k]).description) : describeType(doc, props[k])} onClick={() => add(k)}>
              <Plus size={10} /> {k}
            </button>
          ))}
          {allowExtra && (
            <form
              className="row"
              style={{ gap: 4 }}
              onSubmit={(e) => {
                e.preventDefault();
                const k = newKey.trim();
                if (!k || k in obj) return;
                onChange({ ...obj, [k]: defaultValue(doc, extraSchema, depth + 1, { nonNull: true }) });
                setNewKey("");
              }}
            >
              <input
                className="input mono"
                style={{ height: 22, width: 140, fontSize: 11.5 }}
                placeholder="+ property name"
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
              />
            </form>
          )}
        </div>
      )}
      {shown.length === 0 && extra.length === 0 && optional.length === 0 && !allowExtra && <span className="muted small">No fields</span>}
    </div>
  );
}

const ARRAY_PAGE = 100;
let rowSeq = 0;
const newRowId = () => `r${++rowSeq}`;

function ArrayEditor({ s, value, onChange, path, depth }: EditorProps) {
  const { doc } = useContext(FormCtx);
  const [limit, setLimit] = useState(ARRAY_PAGE);
  // Stable row ids so reordering/removing keeps each row's local state and focus with its item.
  const ids = useRef<string[]>([]);
  if (!Array.isArray(value)) {
    return (
      <button className="btn sm" onClick={() => onChange([])}>
        <Plus size={12} /> {value === undefined ? "Add list" : `Replace ${jsonType(value)} with list`}
      </button>
    );
  }
  const rows = ids.current;
  while (rows.length < value.length) rows.push(newRowId());
  rows.length = value.length;

  const max = typeof s.maxItems === "number" ? s.maxItems : Infinity;
  const min = typeof s.minItems === "number" ? s.minItems : 0;
  const setAt = (i: number, v: Json) => onChange(value.map((x, j) => (j === i ? v : x)));
  const move = (i: number, d: number) => {
    const next = value.slice();
    [next[i], next[i + d]] = [next[i + d], next[i]];
    [rows[i], rows[i + d]] = [rows[i + d], rows[i]];
    onChange(next);
  };
  const removeAt = (i: number) => {
    rows.splice(i, 1);
    onChange(value.filter((_, j) => j !== i));
  };
  return (
    <div>
      {value.slice(0, limit).map((item, i) => (
        <div key={rows[i]} className="sf-item">
          <span className="sf-item-idx">{i}</span>
          <div className="sf-item-body">
            <Field schema={itemSchema(s, i)} value={item} path={`${path}/${i}`} depth={depth + 1} onChange={(v) => setAt(i, v)} required />
          </div>
          <div className="row" style={{ gap: 0, paddingTop: 2 }}>
            <button className="icon-btn sm" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">
              <Up size={11} />
            </button>
            <button className="icon-btn sm" disabled={i === value.length - 1} onClick={() => move(i, 1)} aria-label="Move down">
              <Down size={11} />
            </button>
            <button className="icon-btn sm" disabled={value.length <= min} onClick={() => removeAt(i)} aria-label="Remove item">
              <Close size={11} />
            </button>
          </div>
        </div>
      ))}
      {value.length > limit && (
        <button className="btn sm ghost" onClick={() => setLimit(limit + ARRAY_PAGE)}>
          Show {Math.min(ARRAY_PAGE, value.length - limit)} more of {value.length - limit}
        </button>
      )}
      <button
        className="btn sm"
        disabled={value.length >= max}
        onClick={() => {
          rows.push(newRowId());
          onChange([...value, defaultValue(doc, itemSchema(s, value.length), depth + 1, { nonNull: true })]);
        }}
      >
        <Plus size={12} /> Add item
      </button>
    </div>
  );
}

/** A textarea that grows with its content, so short and long strings use the same element
 *  (switching element types mid-typing would drop focus). */
function AutoTextarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { multiline: boolean }) {
  const { multiline, ...rest } = props;
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight + 2, 320)}px`;
  }, [props.value]);
  return (
    <textarea
      ref={ref}
      rows={1}
      {...rest}
      className={`textarea auto ${rest.className ?? ""}`}
      onKeyDown={(e) => {
        // Single-line fields: Enter doesn't insert a newline (Shift+Enter still does).
        if (e.key === "Enter" && !e.shiftKey && !multiline && !e.metaKey && !e.ctrlKey) e.preventDefault();
        rest.onKeyDown?.(e);
      }}
    />
  );
}

function StringEditor({ s, schema, value, onChange, invalid }: EditorProps) {
  const { doc } = useContext(FormCtx);
  const v = typeof value === "string" ? value : value === undefined ? "" : stringifyJson(value);
  const multiline = (typeof s.maxLength === "number" && s.maxLength > 200) || s.format === "textarea" || v.includes("\n");
  // Empty fields show their type (the label no longer does).
  const placeholder = describeType(doc, schema);
  const cls = `mono ${invalid ? "invalid" : ""}`;
  if (s.format === "binary" || s.format === "byte") {
    return (
      <div>
        <AutoTextarea multiline={false} className={cls} value={v} placeholder={s.format === "byte" ? "base64 data" : "file content"} onChange={(e) => onChange(e.target.value)} />
        <div className="field-desc">Binary content is sent as text.</div>
      </div>
    );
  }
  const helper =
    s.format === "date-time" || s.format === "date" ? (
      <button className="btn sm ghost" onClick={() => onChange(s.format === "date" ? new Date().toISOString().slice(0, 10) : new Date().toISOString())}>
        now
      </button>
    ) : s.format === "uuid" ? (
      <button className="btn sm ghost" onClick={() => onChange(crypto.randomUUID())}>
        random
      </button>
    ) : null;
  return (
    <div className="row" style={{ alignItems: "flex-start" }}>
      <AutoTextarea multiline={multiline} className={cls} value={v} placeholder={placeholder} spellCheck={false} onChange={(e) => onChange(e.target.value)} />
      {helper}
    </div>
  );
}

/** Identity of a primitive value for "did it change from outside?" checks. */
function valueKey(v: Json): string {
  return v === undefined ? "u" : stringifyJson(v);
}

function NumberEditor({ s, schema, value, onChange, invalid, required }: EditorProps) {
  const { doc } = useContext(FormCtx);
  const fmt = (v: Json) => (v === undefined ? "" : isBig(v) ? v.raw : typeof v === "string" ? v : String(v));
  const [text, setText] = useState(fmt(value));
  const last = useRef(valueKey(value));
  useEffect(() => {
    // Adopt external changes (Raw edits, Example, variant switches), but not our own echoes.
    const k = valueKey(value);
    if (k !== last.current) {
      last.current = k;
      setText(fmt(value));
    }
  }, [value]);
  const isInt = s._types[0] === "integer";
  const parse = (raw: string): { ok: true; v: number | string | BigInt64Value } | { ok: false; msg: string } => {
    const r = raw.trim();
    if (r === "") return { ok: false, msg: required ? "Enter a value" : "Enter a value or remove the field" };
    if (WHOLE_VAR.test(r)) return { ok: true, v: r }; // resolved to a number at send time
    if (isInt) {
      if (!/^[-+]?\d+$/.test(r)) return { ok: false, msg: "Enter a whole number" };
      return { ok: true, v: integerFromText(r) };
    }
    if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(r)) return { ok: false, msg: "Enter a number" };
    return { ok: true, v: Number(r) };
  };
  const parsed = parse(text);
  const commit = (raw: string) => {
    setText(raw);
    const p = parse(raw);
    // Incomplete input stays local: the body keeps its last valid value, so the field never
    // disappears or turns into null while the user is typing.
    if (!p.ok) return;
    last.current = valueKey(p.v);
    onChange(p.v);
  };
  return (
    <div>
      <input
        className={`input mono ${invalid || !parsed.ok ? "invalid" : ""}`}
        inputMode={isInt ? "numeric" : "decimal"}
        value={text}
        placeholder={describeType(doc, schema)}
        spellCheck={false}
        onChange={(e) => commit(e.target.value)}
        onBlur={() => {
          // Leaving an emptied field restores the value the body still holds.
          if (!parse(text).ok && value !== undefined) setText(fmt(value));
        }}
      />
      {!parsed.ok && <div className="field-error">{parsed.msg}</div>}
    </div>
  );
}

function AnyEditor({ value, onChange, invalid, required }: EditorProps) {
  const show = (v: Json) => (v === undefined ? "" : stringifyJson(v, 2));
  const [text, setText] = useState(show(value));
  const [err, setErr] = useState<string | null>(null);
  const last = useRef(valueKey(value));
  useEffect(() => {
    const k = valueKey(value);
    if (k !== last.current) {
      last.current = k;
      setText(show(value));
      setErr(null);
    }
  }, [value]);
  return (
    <div>
      <textarea
        className={`textarea mono ${invalid || err ? "invalid" : ""}`}
        rows={Math.min(8, Math.max(2, text.split("\n").length))}
        value={text}
        placeholder="Any JSON value"
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          if (e.target.value.trim() === "") {
            setErr(required ? "Enter a JSON value" : "Enter a JSON value or remove the field");
            return;
          }
          try {
            const v = parseJson(e.target.value);
            setErr(null);
            last.current = valueKey(v);
            onChange(v);
          } catch {
            setErr("Invalid JSON");
          }
        }}
      />
      {err && <div className="field-error">{err}</div>}
    </div>
  );
}
