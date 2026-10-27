import { useEffect } from "react";
import {
  closeTab,
  closeTabs,
  reopenClosedTab,
  copyCurl,
  getOp,
  sendRequest,
  setModal,
  updateSettings,
  useApp,
  checkForUpdates,
} from "./store/app";
import { canonical, eventToCombo, needsModifier } from "./lib/shortcuts";
import { onMenu } from "./lib/platform";
import Sidebar from "./components/Sidebar";
import Workspace from "./components/Workspace";
import CommandPalette from "./components/CommandPalette";
import ImportModal from "./components/ImportModal";
import EnvironmentsModal from "./components/EnvironmentsModal";
import SettingsModal from "./components/SettingsModal";
import SyncModal from "./components/SyncModal";
import CollectionModal from "./components/CollectionModal";
import Toasts from "./components/Toasts";
import ContextMenu from "./components/ContextMenu";
import Tooltip from "./components/Tooltip";
import { openEnvSwitcher } from "./components/EnvSwitcher";
import { focusHotVars } from "./components/HotVars";
import { FIND_EVENT } from "./components/ResponsePanel";
import TabSwitcher, { switchTab } from "./components/TabSwitcher";
import { toggleBodyMode } from "./components/BodyEditor";

export default function App() {
  const loaded = useApp((s) => s.loaded);
  const modal = useApp((s) => s.modal);
  const sidebarWidth = useApp((s) => s.settings.sidebarWidth);
  useTheme();
  useNoNativeContextMenu();
  useEffect(() => void onMenu((id) => id === "settings" && setModal("settings")), []);
  useShortcuts();
  useMonitor();

  if (!loaded) return null;
  return (
    <>
      <div className="app" style={{ "--sidebar-w": `${sidebarWidth}px` } as React.CSSProperties}>
        <Sidebar />
        <Workspace />
      </div>
      {modal === "palette" && <CommandPalette />}
      {modal === "import" && <ImportModal />}
      {modal === "environments" && <EnvironmentsModal />}
      {modal === "settings" && <SettingsModal />}
      {modal && typeof modal === "object" && "sync" in modal && <SyncModal collectionId={modal.sync} />}
      {modal && typeof modal === "object" && "collection" in modal && <CollectionModal key={modal.collection} collectionId={modal.collection} section={modal.section} />}
      <Toasts />
      <ContextMenu />
      <Tooltip />
      <TabSwitcher />
    </>
  );
}

/** The webview's own menu (Reload, Inspect Element) is not part of the app; text fields keep it for copy/paste. */
function useNoNativeContextMenu() {
  useEffect(() => {
    const onMenu = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, [contenteditable=true], .cm-editor")) return;
      e.preventDefault();
    };
    window.addEventListener("contextmenu", onMenu);
    return () => window.removeEventListener("contextmenu", onMenu);
  }, []);
}

function useTheme() {
  const theme = useApp((s) => s.settings.theme);
  const fontSize = useApp((s) => s.settings.fontSize);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = theme === "dark" || (theme === "system" && mq.matches);
      document.documentElement.dataset.theme = dark ? "dark" : "light";
      document.documentElement.style.colorScheme = dark ? "dark" : "light";
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [theme]);
  useEffect(() => {
    document.documentElement.style.setProperty("--fs", `${fontSize}px`);
  }, [fontSize]);
}

export const SHORTCUT_EVENT = "reqoon:shortcut";

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useApp.getState();
      // While the settings dialog is recording a shortcut, let it take the keystroke.
      if ((e.target as HTMLElement)?.dataset?.recording) return;
      const combo = eventToCombo(e);
      if (!combo) return;
      const c = canonical(combo);
      const action = Object.entries(s.settings.shortcuts).find(([, v]) => v && canonical(v) === c)?.[0];
      if (!action) return;
      // A binding saved without a real modifier must not eat typing in text fields.
      if (needsModifier(c) && (e.target as HTMLElement)?.closest?.("input, textarea, [contenteditable=true], .cm-editor")) return;
      // Text editors keep their own find (CodeMirror's search panel); the response view uses ours.
      if (action === "findInResponse" && (e.target as HTMLElement)?.closest?.(".cm-editor") && !(e.target as HTMLElement).closest(".resp-view")) return;
      e.preventDefault();
      e.stopPropagation();
      const tab = s.activeTab;
      switch (action) {
        case "quickOpen":
          setModal(s.modal === "palette" ? null : "palette");
          break;
        case "send":
          if (tab && getOp(tab)) sendRequest(tab);
          break;
        case "toggleBodyMode":
          if (tab) toggleBodyMode(tab);
          break;
        case "switchEnv":
          openEnvSwitcher();
          break;
        case "findInResponse":
          window.dispatchEvent(new Event(FIND_EVENT));
          break;
        case "focusHotVar":
          focusHotVars();
          break;
        case "history":
          setModal(null);
          useApp.setState((st) => ({ sidebarView: st.sidebarView === "history" ? "collections" : "history" }));
          break;
        case "focusSearch":
          setModal(null);
          document.getElementById("sidebar-search")?.focus();
          break;
        case "import":
          setModal("import");
          break;
        case "environments":
          setModal("environments");
          break;
        case "copyCurl":
          if (tab) copyCurl(tab);
          break;
        case "closeTab":
          if (tab) closeTab(tab);
          break;
        case "closeAllTabs":
          closeTabs(s.tabs);
          break;
        case "reopenTab":
          reopenClosedTab();
          break;
        case "nextTab":
          switchTab(1, s.settings.shortcuts.nextTab);
          break;
        case "prevTab":
          switchTab(-1, s.settings.shortcuts.prevTab);
          break;
        case "toggleTheme": {
          const dark = document.documentElement.dataset.theme === "dark";
          updateSettings({ theme: dark ? "light" : "dark" });
          break;
        }
        case "settings":
          setModal("settings");
          break;
      }
      window.dispatchEvent(new CustomEvent(SHORTCUT_EVENT, { detail: action }));
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}

function useMonitor() {
  const enabled = useApp((s) => s.settings.monitorEnabled);
  const remoteMin = useApp((s) => s.settings.remoteCheckMinutes);
  const fileSec = useApp((s) => s.settings.fileCheckSeconds);
  useEffect(() => {
    if (!enabled) return;
    const check = (kind: "url" | "file") => {
      for (const c of useApp.getState().collections)
        if (c.monitor && c.source.kind === kind) checkForUpdates(c.id);
    };
    const first = setTimeout(() => (check("url"), check("file")), 1500);
    const remote = setInterval(() => check("url"), Math.max(1, remoteMin) * 60_000);
    const file = setInterval(() => check("file"), Math.max(1, fileSec) * 1000);
    // Re-check remote specs when the window regains focus after a while.
    let lastFocus = Date.now();
    const onFocus = () => {
      if (Date.now() - lastFocus > 60_000) check("url");
      lastFocus = Date.now();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      clearTimeout(first);
      clearInterval(remote);
      clearInterval(file);
      window.removeEventListener("focus", onFocus);
    };
  }, [enabled, remoteMin, fileSec]);
}
