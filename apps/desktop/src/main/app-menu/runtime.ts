import { app, BrowserWindow, shell, type WebContents } from "electron";
import log from "electron-log/main.js";
import {
  IPC,
  type MenuActionEvent,
  type MenuActionId,
} from "../../shared/constants";
import {
  resolveShortcuts,
  type ShortcutId,
  type ShortcutPreferences,
} from "../../shared/shortcuts";
import { routeCombineImagesZoom } from "../core/combine-images-window";
import { reconcileLibrary } from "../core/scan";
import { menuAccelerator } from "../lib/menu-accelerator";
import { libraryRoot } from "../paths";
import type { AppMenuContext } from "./types";

export interface AppMenuRuntimeDeps {
  focusedOrMain: () => BrowserWindow | null;
  openLibraryWindow: () => void;
  shortcuts: ShortcutPreferences;
}

function withFocusedWebContents(
  run: (contents: WebContents) => void,
): () => void {
  return () => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win || win.isDestroyed()) return;
    run(win.webContents);
  };
}

export function createAppMenuContext(deps: AppMenuRuntimeDeps): AppMenuContext {
  const bindings = resolveShortcuts(deps.shortcuts);
  const accelerator = (id: ShortcutId) => menuAccelerator(bindings[id]);
  const navTo = (path: string) => async () => {
    await deps.openLibraryWindow();
    deps.focusedOrMain()?.webContents.send(IPC.nav, path);
  };
  const sendMenuAction: AppMenuContext["sendMenuAction"] =
    (id: MenuActionId) => async (_item, _window, event) => {
      if (routeCombineImagesZoom(id)) return;
      await deps.openLibraryWindow();
      const action: MenuActionEvent = {
        id,
        source: event.triggeredByAccelerator ? "accelerator" : "menu",
      };
      deps.focusedOrMain()?.webContents.send(IPC.menuAction, action);
    };

  return {
    accelerator,
    appName: app.name,
    edit: {
      copy: withFocusedWebContents((contents) => contents.copy()),
      cut: withFocusedWebContents((contents) => contents.cut()),
      paste: withFocusedWebContents((contents) => contents.paste()),
      redo: withFocusedWebContents((contents) => {
        contents.redo();
        contents.send(IPC.editRedoRequested);
      }),
      selectAll: withFocusedWebContents((contents) => contents.selectAll()),
      undo: withFocusedWebContents((contents) => {
        contents.undo();
        contents.send(IPC.editUndoRequested);
      }),
    },
    isMac: process.platform === "darwin",
    isPackaged: app.isPackaged,
    revealInFileManagerLabel:
      process.platform === "darwin"
        ? "Reveal in Finder"
        : process.platform === "win32"
          ? "Reveal in File Explorer"
          : "Show in File Manager",
    showLogsInFileManagerLabel:
      process.platform === "darwin"
        ? "Show Logs in Finder"
        : process.platform === "win32"
          ? "Show Logs in File Explorer"
          : "Show Logs in File Manager",
    navTo,
    openExternalUrl: (url: string) => () => {
      void shell.openExternal(url);
    },
    openLibraryWindow: deps.openLibraryWindow,
    openRecent: (id: string) => () => {
      deps.focusedOrMain()?.webContents.send(IPC.menuOpenSave, id);
    },
    rescanLibrary: () => {
      void reconcileLibrary().catch((error) =>
        log.warn("[pond menu] rescan failed", error),
      );
    },
    reloadLibrary: () => {
      deps.focusedOrMain()?.webContents.reload();
    },
    revealLibrary: () => {
      void shell.openPath(libraryRoot());
    },
    sendMenuAction,
    showLogs: () => {
      void shell.openPath(app.getPath("logs"));
    },
    verifyLibrary: async () => {
      try {
        const { verifyLibraryIntegrity } = await import("../core/library-ops");
        await verifyLibraryIntegrity();
      } catch (error) {
        log.warn("[pond menu] verify failed", error);
      }
    },
  };
}
