import { spawn } from "node:child_process";
import { app } from "electron";
import log from "electron-log/main.js";

/**
 * AppImage hosts (especially `APPIMAGE_EXTRACT_AND_RUN`) often fail to come
 * back after Electron's `app.relaunch()` — the process exits and nothing
 * starts. Prefer a soft library repoint in that case, or spawn the AppImage
 * path when a hard restart is required.
 */
export function preferSoftLibraryRepoint(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (env.ELECTRON_RENDERER_URL) return true;
  return platform === "linux" && Boolean(env.APPIMAGE);
}

export function relaunchPackagedApp(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): void {
  const appImage = env.APPIMAGE;
  if (platform === "linux" && appImage) {
    log.info("[pond] spawning AppImage for relaunch", appImage);
    const child = spawn(appImage, process.argv.slice(1), {
      detached: true,
      stdio: "ignore",
      env,
    });
    child.unref();
    app.exit(0);
    return;
  }
  app.relaunch();
  app.exit(0);
}
