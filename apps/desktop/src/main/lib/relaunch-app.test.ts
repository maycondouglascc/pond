import { describe, expect, it } from "vitest";
import { preferSoftLibraryRepoint } from "./relaunch-app";

describe("preferSoftLibraryRepoint", () => {
  it("soft-repoints the Vite renderer session", () => {
    expect(
      preferSoftLibraryRepoint(
        { ELECTRON_RENDERER_URL: "http://localhost" },
        "darwin",
      ),
    ).toBe(true);
  });

  it("soft-repoints Linux AppImage hosts where process relaunch is unreliable", () => {
    expect(
      preferSoftLibraryRepoint({ APPIMAGE: "/tmp/Pond.AppImage" }, "linux"),
    ).toBe(true);
  });

  it("keeps a hard relaunch for packaged macOS and Windows builds", () => {
    expect(preferSoftLibraryRepoint({}, "darwin")).toBe(false);
    expect(preferSoftLibraryRepoint({}, "win32")).toBe(false);
    expect(preferSoftLibraryRepoint({}, "linux")).toBe(false);
  });
});
