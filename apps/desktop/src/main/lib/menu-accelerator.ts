import type { ShortcutDef } from "../../shared/shortcuts";

/**
 * Electron Menu accelerators only accept a single key combo. Chord sequences
 * like G then L stay renderer-owned and must not be passed to the native menu
 * (Linux logs "Invalid accelerator token" and drops them).
 */
export function menuAccelerator(shortcut: ShortcutDef): string | undefined {
  if (shortcut.sequence) return undefined;
  return shortcut.keys
    ?.split("+")
    .map((part) => {
      switch (part) {
        case "Mod":
          return "CommandOrControl";
        case "Meta":
          return process.platform === "darwin" ? "Command" : "Super";
        case "ArrowLeft":
          return "Left";
        case "ArrowRight":
          return "Right";
        case "ArrowUp":
          return "Up";
        case "ArrowDown":
          return "Down";
        default:
          return part;
      }
    })
    .join("+");
}
