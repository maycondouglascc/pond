import { describe, expect, it } from "vitest";
import {
  openWithListingKey,
  parseOpenWithPayload,
  rankOpenWithApps,
} from "./open-with-apps";

describe("rankOpenWithApps", () => {
  it("puts the default app first and keeps the .app name", () => {
    const apps = rankOpenWithApps({
      defaultPath: "/System/Applications/Preview.app",
      paths: [
        "/Applications/Photomator.app",
        "/System/Applications/Preview.app",
        "/Applications/CleanShot X.app",
      ],
    });
    expect(apps.map((app) => app.name)).toEqual([
      "Preview.app",
      "CleanShot X.app",
      "Photomator.app",
    ]);
    expect(apps[0]?.isDefault).toBe(true);
    expect(apps.slice(1).every((app) => !app.isDefault)).toBe(true);
  });

  it("ranks Linux .desktop handlers without requiring a .app suffix", () => {
    const apps = rankOpenWithApps(
      {
        defaultPath: "/usr/share/applications/org.gnome.eog.desktop",
        paths: [
          "/usr/share/applications/gimp.desktop",
          "/usr/share/applications/org.gnome.eog.desktop",
        ],
      },
      24,
      "linux",
    );
    expect(apps.map((app) => app.name)).toEqual(["org.gnome.eog", "gimp"]);
    expect(apps[0]?.isDefault).toBe(true);
  });

  it("reuses the lowercase extension as the listing key", () => {
    expect(openWithListingKey("/tmp/shot.PNG")).toBe(".png");
    expect(openWithListingKey("/tmp/no-extension")).toBe("/tmp/no-extension");
  });

  it("returns nothing for malformed payloads", () => {
    expect(parseOpenWithPayload("not-json")).toEqual({
      defaultPath: null,
      paths: [],
    });
    expect(rankOpenWithApps(parseOpenWithPayload("{}"))).toEqual([]);
  });
});
