import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  CHROMIUM_EXTENSION_IDS,
  FIREFOX_EXTENSION_ID,
  NATIVE_HOST_NAME,
} from "@pond/schema/native";
import { app } from "electron";
import log from "electron-log/main.js";

const HOST_FILENAME = `${NATIVE_HOST_NAME}.json`;
const FIREFOX_HOST_FILENAME = `${NATIVE_HOST_NAME}.firefox.json`;
const execFileAsync = promisify(execFile);

const DARWIN_CHROMIUM_NMH_DIRS = [
  "Library/Application Support/Google/Chrome/NativeMessagingHosts",
  "Library/Application Support/Google/Chrome Canary/NativeMessagingHosts",
  "Library/Application Support/Google/Chrome for Testing/NativeMessagingHosts",
  "Library/Application Support/Chromium/NativeMessagingHosts",
  "Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts",
  "Library/Application Support/Microsoft Edge/NativeMessagingHosts",
  "Library/Application Support/Arc/User Data/NativeMessagingHosts",
  "Library/Application Support/Dia/User Data/NativeMessagingHosts",
  "Library/Application Support/Vivaldi/NativeMessagingHosts",
] as const;

const LINUX_CHROMIUM_NMH_DIRS = [
  ".config/google-chrome/NativeMessagingHosts",
  ".config/google-chrome-beta/NativeMessagingHosts",
  ".config/google-chrome-unstable/NativeMessagingHosts",
  ".config/chromium/NativeMessagingHosts",
  ".config/BraveSoftware/Brave-Browser/NativeMessagingHosts",
  ".config/microsoft-edge/NativeMessagingHosts",
  ".config/microsoft-edge-beta/NativeMessagingHosts",
  ".config/microsoft-edge-dev/NativeMessagingHosts",
  ".config/vivaldi/NativeMessagingHosts",
] as const;

const DARWIN_FIREFOX_NMH_TARGETS = [
  {
    dir: "Library/Application Support/Mozilla/NativeMessagingHosts",
    apps: [
      "Firefox.app",
      "Firefox Developer Edition.app",
      "Firefox Nightly.app",
    ],
  },
  {
    dir: "Library/Application Support/zen/NativeMessagingHosts",
    apps: ["Zen.app", "Zen Browser.app"],
  },
  {
    dir: "Library/Application Support/Zen/NativeMessagingHosts",
    apps: ["Zen.app", "Zen Browser.app"],
  },
  {
    dir: "Library/Application Support/LibreWolf/NativeMessagingHosts",
    apps: ["LibreWolf.app"],
  },
  {
    dir: "Library/Application Support/Floorp/NativeMessagingHosts",
    apps: ["Floorp.app"],
  },
] as const;

/**
 * Firefox's per-user host manifest. Ubuntu's WebExtensions portal reads this
 * path and launches the host outside the snap, so it has to exist even when
 * snap or Flatpak Firefox never created ~/.mozilla.
 */
const LINUX_FIREFOX_HOST_DIR = ".mozilla/native-messaging-hosts";

/** Forks keep their own profile directory and only get a manifest once that exists. */
const LINUX_FIREFOX_FORK_NMH_DIRS = [
  ".librewolf/native-messaging-hosts",
  ".floorp/native-messaging-hosts",
  ".zen/native-messaging-hosts",
] as const;

/** Install locations that mean Firefox is present before a profile directory is. */
const LINUX_FIREFOX_SIGNALS = [
  ".mozilla",
  "snap/firefox",
  ".var/app/org.mozilla.firefox",
  "/usr/bin/firefox",
  "/usr/bin/firefox-esr",
  "/snap/bin/firefox",
  "/var/lib/flatpak/exports/bin/org.mozilla.firefox",
] as const;

export const WINDOWS_NATIVE_MESSAGING_REGISTRY_KEYS = [
  `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
  `HKCU\\Software\\Google\\Chrome SxS\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
  `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
  `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
  `HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
  `HKCU\\Software\\Vivaldi\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
] as const;

/** Zen reads Firefox's key; the other forks keep their own. */
export const WINDOWS_FIREFOX_REGISTRY_KEYS = [
  `HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
  `HKCU\\Software\\LibreWolf\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
  `HKCU\\Software\\Floorp\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
] as const;

export function nativeHostFilename(platform: NodeJS.Platform): string {
  return platform === "win32" ? "pond-native-host.exe" : "pond-native-host";
}

function nativeHostBinaryPath(
  platform: NodeJS.Platform = process.platform,
): string {
  const filename = nativeHostFilename(platform);
  if (app.isPackaged) {
    return join(process.resourcesPath, "bin", filename);
  }
  const candidates = [
    join(app.getAppPath(), "resources", "bin", filename),
    join(app.getAppPath(), "..", "resources", "bin", filename),
    join(process.cwd(), "resources", "bin", filename),
  ];
  const found = candidates.find((p) => existsSync(p));
  return found ?? join(process.cwd(), "resources", "bin", filename);
}

export function windowsRegistryArgs(
  key: string,
  manifestPath: string,
): string[] {
  return ["ADD", key, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"];
}

function hostManifest(
  hostPath: string,
  allow: { allowed_origins: string[] } | { allowed_extensions: string[] },
): string {
  return `${JSON.stringify(
    {
      name: NATIVE_HOST_NAME,
      description: "Pond",
      path: hostPath,
      type: "stdio",
      ...allow,
    },
    null,
    2,
  )}\n`;
}

export function chromiumNativeHostManifest(hostPath: string): string {
  return hostManifest(hostPath, {
    allowed_origins: CHROMIUM_EXTENSION_IDS.map(
      (id) => `chrome-extension://${id}/`,
    ),
  });
}

function firefoxNativeHostManifest(hostPath: string): string {
  return hostManifest(hostPath, {
    allowed_extensions: [FIREFOX_EXTENSION_ID],
  });
}

interface NativeHostManifestDependencies {
  platform: NodeJS.Platform;
  hostPath: () => string;
  home: () => string;
  exists: (path: string) => boolean;
  makeDirectory: (path: string) => void;
  writeFile: (path: string, body: string) => void;
  warn: (...values: unknown[]) => void;
  userDataDirectory: () => string;
  /** The NSIS installer writes the registry keys, so a packaged app never spawns reg.exe, which antivirus flags. */
  installerRegistersKeys: () => boolean;
  runRegistry: (args: string[]) => Promise<void>;
}

const defaultDependencies: NativeHostManifestDependencies = {
  platform: process.platform,
  hostPath: nativeHostBinaryPath,
  home: homedir,
  exists: existsSync,
  makeDirectory: (path) => mkdirSync(path, { recursive: true }),
  writeFile: (path, body) => writeFileSync(path, body, { encoding: "utf8" }),
  warn: (...values) => log.warn(...values),
  userDataDirectory: () => app.getPath("userData"),
  installerRegistersKeys: () => app.isPackaged,
  runRegistry: async (args) => {
    await execFileAsync("reg.exe", args, {
      windowsHide: true,
      timeout: 5_000,
      killSignal: "SIGKILL",
    });
  },
};

export async function writeNativeHostManifests(
  overrides: Partial<NativeHostManifestDependencies> = {},
): Promise<void> {
  const dependencies = { ...defaultDependencies, ...overrides };
  if (
    dependencies.platform !== "darwin" &&
    dependencies.platform !== "win32" &&
    dependencies.platform !== "linux"
  ) {
    return;
  }

  const hostPath = dependencies.hostPath();
  if (!dependencies.exists(hostPath)) {
    dependencies.warn("[pond native] host binary missing", hostPath);
    return;
  }

  if (dependencies.platform === "win32") {
    await writeWindowsNativeHostManifest(hostPath, dependencies);
    return;
  }

  if (dependencies.platform === "linux") {
    writeLinuxNativeHostManifests(hostPath, dependencies);
    return;
  }

  writeDarwinNativeHostManifests(hostPath, dependencies);
}

/** Chromium hosts have no app-bundle gate, so this stays empty and typed for the shared target list. */
const NO_DARWIN_APPS: readonly string[] = [];

function writeDarwinNativeHostManifests(
  hostPath: string,
  dependencies: NativeHostManifestDependencies,
): void {
  const home = dependencies.home();
  const targets = [
    ...DARWIN_CHROMIUM_NMH_DIRS.map((dir) => ({
      dir,
      apps: NO_DARWIN_APPS,
      body: chromiumNativeHostManifest(hostPath),
    })),
    ...DARWIN_FIREFOX_NMH_TARGETS.map((target) => ({
      ...target,
      body: firefoxNativeHostManifest(hostPath),
    })),
  ];
  for (const { dir: relativeDirectory, apps, body } of targets) {
    const parent = join(home, relativeDirectory, "..");
    const installed = apps.some(
      (name) =>
        dependencies.exists(join("/Applications", name)) ||
        dependencies.exists(join(home, "Applications", name)),
    );
    if (!dependencies.exists(parent) && !installed) continue;
    const dir = join(home, relativeDirectory);
    try {
      dependencies.makeDirectory(dir);
      dependencies.writeFile(join(dir, HOST_FILENAME), body);
    } catch (err) {
      dependencies.warn(
        "[pond native] failed to write host manifest",
        dir,
        err,
      );
    }
  }
}

function linuxFirefoxInstalled(
  home: string,
  exists: (path: string) => boolean,
): boolean {
  return LINUX_FIREFOX_SIGNALS.some((signal) =>
    exists(signal.startsWith("/") ? signal : join(home, signal)),
  );
}

function writeLinuxNativeHostManifests(
  hostPath: string,
  dependencies: NativeHostManifestDependencies,
): void {
  const home = dependencies.home();
  const chromiumBody = chromiumNativeHostManifest(hostPath);
  const firefoxBody = firefoxNativeHostManifest(hostPath);
  const targets = [
    ...LINUX_CHROMIUM_NMH_DIRS.map((dir) => ({
      dir,
      body: chromiumBody,
      ready: dependencies.exists(join(home, dir, "..")),
    })),
    {
      dir: LINUX_FIREFOX_HOST_DIR,
      body: firefoxBody,
      ready: linuxFirefoxInstalled(home, dependencies.exists),
    },
    ...LINUX_FIREFOX_FORK_NMH_DIRS.map((dir) => ({
      dir,
      body: firefoxBody,
      ready: dependencies.exists(join(home, dir, "..")),
    })),
  ];
  for (const { dir: relativeDirectory, body, ready } of targets) {
    if (!ready) continue;
    const dir = join(home, relativeDirectory);
    try {
      dependencies.makeDirectory(dir);
      dependencies.writeFile(join(dir, HOST_FILENAME), body);
    } catch (err) {
      dependencies.warn(
        "[pond native] failed to write host manifest",
        dir,
        err,
      );
    }
  }
}

async function writeWindowsNativeHostManifest(
  hostPath: string,
  dependencies: NativeHostManifestDependencies,
): Promise<void> {
  const dir = join(dependencies.userDataDirectory(), "native-messaging");
  // Chromium and Firefox reject each other's allow-list field, so each family
  // registers its own manifest.
  const targets = [
    {
      manifestPath: join(dir, HOST_FILENAME),
      body: chromiumNativeHostManifest(hostPath),
      keys: WINDOWS_NATIVE_MESSAGING_REGISTRY_KEYS,
    },
    {
      manifestPath: join(dir, FIREFOX_HOST_FILENAME),
      body: firefoxNativeHostManifest(hostPath),
      keys: WINDOWS_FIREFOX_REGISTRY_KEYS,
    },
  ];
  for (const { manifestPath, body, keys } of targets) {
    try {
      dependencies.makeDirectory(dir);
      dependencies.writeFile(manifestPath, body);
    } catch (err) {
      dependencies.warn(
        "[pond native] failed to write host manifest",
        manifestPath,
        err,
      );
      continue;
    }

    if (dependencies.installerRegistersKeys()) continue;
    await Promise.all(
      keys.map(async (key) => {
        try {
          await dependencies.runRegistry(
            windowsRegistryArgs(key, manifestPath),
          );
        } catch (err) {
          dependencies.warn(
            "[pond native] failed to register host manifest",
            key,
            err,
          );
        }
      }),
    );
  }
}
