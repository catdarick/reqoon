import { isMac } from "./platform";

export interface ShortcutDef {
  id: string;
  label: string;
  default: string;
}

// "Mod" is Cmd on macOS and Ctrl elsewhere.
export const SHORTCUTS: ShortcutDef[] = [
  { id: "quickOpen", label: "Quick endpoint search", default: "Mod+E" },
  { id: "send", label: "Send request", default: "Mod+Enter" },
  { id: "toggleBodyMode", label: "Toggle Form / Raw JSON", default: "Mod+Shift+J" },
  { id: "switchEnv", label: "Switch environment", default: "Mod+Shift+E" },
  { id: "focusHotVar", label: "Edit hot variables", default: "Mod+Shift+H" },
  { id: "findInResponse", label: "Find in response", default: "Mod+F" },
  { id: "focusSearch", label: "Focus sidebar search", default: "Mod+Shift+F" },
  { id: "history", label: "Show request history", default: "Mod+Y" },
  { id: "import", label: "Import OpenAPI spec", default: "Mod+O" },
  { id: "environments", label: "Manage environments", default: "Mod+Shift+V" },
  { id: "copyCurl", label: "Copy request as cURL", default: "Mod+Shift+C" },
  { id: "closeTab", label: "Close tab", default: "Mod+W" },
  { id: "closeAllTabs", label: "Close all tabs", default: "Mod+Shift+W" },
  { id: "reopenTab", label: "Reopen closed tab", default: "Mod+Shift+T" },
  { id: "nextTab", label: "Next tab", default: "Ctrl+Tab" },
  { id: "prevTab", label: "Previous tab", default: "Ctrl+Shift+Tab" },
  { id: "toggleTheme", label: "Toggle light / dark theme", default: "Mod+Shift+L" },
  { id: "settings", label: "Open settings", default: "Mod+," },
];

export const DEFAULT_SHORTCUTS: Record<string, string> = Object.fromEntries(SHORTCUTS.map((s) => [s.id, s.default]));

const KEY_ALIASES: Record<string, string> = {
  " ": "Space",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Escape: "Esc",
};

function keyName(e: KeyboardEvent): string | null {
  if (["Meta", "Control", "Shift", "Alt", "OS"].includes(e.key)) return null;
  // Use the physical key for letters/digits so Shift/Alt layouts still match.
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3);
  if (/^Digit\d$/.test(e.code)) return e.code.slice(5);
  if (e.code === "Comma") return ",";
  if (e.code === "Period") return ".";
  if (e.code === "Slash") return "/";
  if (e.code === "Backslash") return "\\";
  if (e.code === "BracketLeft") return "[";
  if (e.code === "BracketRight") return "]";
  if (e.code === "Semicolon") return ";";
  if (e.code === "Quote") return "'";
  if (e.code === "Minus") return "-";
  if (e.code === "Equal") return "=";
  if (e.code === "Backquote") return "`";
  return KEY_ALIASES[e.key] ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key);
}

/** Converts a keyboard event into the canonical "Mod+Shift+K" form; null for bare modifiers. */
export function eventToCombo(e: KeyboardEvent): string | null {
  const key = keyName(e);
  if (!key) return null;
  const parts: string[] = [];
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (mod) parts.push("Mod");
  if (isMac && e.ctrlKey) parts.push("Ctrl");
  if (!isMac && e.metaKey) parts.push("Meta");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  parts.push(key);
  return parts.join("+");
}

/** Ctrl on non-mac platforms is the same physical modifier as Mod. */
export function canonical(combo: string): string {
  if (isMac) return combo;
  const parts = combo.split("+").map((p) => (p === "Ctrl" ? "Mod" : p));
  const key = parts.pop()!;
  const mods = [...new Set(parts)];
  const order = ["Mod", "Meta", "Alt", "Shift"];
  mods.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return [...mods, key].join("+");
}

export function formatCombo(combo: string): string {
  if (!combo) return "—";
  const parts = combo.split("+");
  if (isMac) {
    const sym: Record<string, string> = { Mod: "⌘", Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Enter: "↩", Up: "↑", Down: "↓", Left: "←", Right: "→", Tab: "⇥", Esc: "⎋", Backspace: "⌫" };
    return parts.map((p) => sym[p] ?? p).join("");
  }
  return parts.map((p) => (p === "Mod" ? "Ctrl" : p)).join("+");
}

/** True if the combo is plain typing (a key alone or with only Shift), which text fields need. */
export function needsModifier(combo: string): boolean {
  const parts = combo.split("+");
  const key = parts[parts.length - 1];
  const realMods = parts.slice(0, -1).filter((p) => p !== "Shift");
  return realMods.length === 0 && !/^F\d+$/.test(key) && key !== "Esc";
}
