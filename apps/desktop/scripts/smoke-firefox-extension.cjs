const { app } = require("electron");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const PAGE_TITLE = "Pond Firefox Capture";
const sandbox = mkdtempSync(join(tmpdir(), "pond-firefox-extension-"));
const extensionDir = resolve(__dirname, "../../extension/.output/firefox-mv3");
const hostBin = resolve(__dirname, "../resources/bin/pond-native-host");
const firefoxBin = process.env.FIREFOX_BIN;
const geckodriver = process.env.GECKODRIVER;

process.env.POND_SANDBOX = sandbox;
process.once("exit", () => {
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    // The native host socket can outlive the assertion by a moment.
  }
});

if (!firefoxBin || !geckodriver) {
  console.error(
    "SMOKE_FAILED: set FIREFOX_BIN and GECKODRIVER to drive the Firefox extension",
  );
  process.exit(1);
}

let setupSaved = false;
let complete = false;
const timer = setTimeout(() => {
  console.error("SMOKE_FAILED: Firefox capture did not land in Pond");
  app.exit(1);
}, 180_000);

function fail(error) {
  clearTimeout(timer);
  console.error("SMOKE_FAILED", error);
  app.exit(1);
}

app.on("web-contents-created", (_, contents) => {
  contents.on("did-fail-load", (_, code, description) =>
    console.error("LOAD_FAILED", code, description),
  );
  contents.on("did-finish-load", async () => {
    if (!contents.getURL().includes("index.html") || complete) return;
    try {
      if (!setupSaved) {
        await contents.executeJavaScript(`(async () => {
          const started = Date.now();
          while (!window.pond && Date.now() - started < 15000) {
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          if (!window.pond) throw new Error("Pond preload was not ready");
          await window.pond.query("settings.setPrefs", { setup: { version: 1 } });
        })()`);
        setupSaved = true;
        contents.reload();
        return;
      }

      const window = contents.getOwnerBrowserWindow();
      window.setBounds({ x: 980, y: 40, width: 900, height: 1080 });
      window.show();
      window.focus();
      await contents.executeJavaScript(`new Promise((resolve, reject) => {
        const started = Date.now();
        const poll = () => {
          if (document.querySelector('[data-slot="window"]') && document.body.innerText.trim()) resolve();
          else if (Date.now() - started > 15000) reject(new Error("React did not render visible content"));
          else setTimeout(poll, 50);
        };
        poll();
      })`);

      const driver = spawn(
        process.execPath,
        [join(__dirname, "firefox-extension-drive.mjs")],
        {
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: "1",
            POND_SANDBOX: sandbox,
            POND_CAPTURE_TITLE: PAGE_TITLE,
            FIREFOX_BIN: firefoxBin,
            GECKODRIVER: geckodriver,
            POND_EXTENSION_DIR: extensionDir,
            POND_NATIVE_HOST: hostBin,
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let sent = false;
      driver.stdout.on("data", (chunk) => {
        const text = chunk.toString();
        process.stdout.write(text);
        if (text.includes("FIREFOX_CAPTURE_SENT")) sent = true;
      });
      driver.stderr.on("data", (chunk) => process.stderr.write(chunk));
      const driverExit = new Promise((resolve) => {
        driver.once("exit", (code) => resolve(code));
      });
      const started = Date.now();
      while (!sent && Date.now() - started < 120_000) {
        if (driver.exitCode !== null) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (!sent) {
        driver.kill("SIGTERM");
        throw new Error("Firefox did not send the capture");
      }

      const landed = await contents.executeJavaScript(`(async () => {
        const title = ${JSON.stringify(PAGE_TITLE)};
        const started = Date.now();
        while (Date.now() - started < 30000) {
          const page = await window.pond.query("saves.listPage", { limit: 20 });
          const row = page.rows.find((item) =>
            (item.title || "").includes(title) || (item.url || "").includes("127.0.0.1"),
          );
          const visible = document.body.innerText.includes(title);
          if (row && visible) return { title: row.title, url: row.url, visible };
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        const page = await window.pond.query("saves.listPage", { limit: 20 });
        return {
          failed: true,
          text: document.body.innerText.slice(0, 500),
          rows: page.rows.map((item) => ({ title: item.title, url: item.url })),
        };
      })()`);
      assert.equal(landed.failed, undefined);
      assert.equal(landed.visible, true);
      assert.ok(String(landed.title).includes(PAGE_TITLE));
      window.show();
      window.focus();
      const hold = Number(process.env.POND_CAPTURE_HOLD_MS || 4000);
      await new Promise((resolve) => setTimeout(resolve, hold));
      driver.stdin.end();
      const code = await Promise.race([
        driverExit,
        new Promise((resolve) => setTimeout(() => resolve("timeout"), 10000)),
      ]);
      if (code === "timeout") driver.kill("SIGTERM");
      complete = true;
      clearTimeout(timer);
      console.log("SMOKE_PASSED", JSON.stringify(landed));
      app.exit(0);
    } catch (error) {
      fail(error);
    }
  });
});

import("../out/main/index.js").catch((error) => fail(error));
