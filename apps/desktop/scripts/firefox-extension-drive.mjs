/**
 * Drives the built Firefox extension through the real native host.
 * Pond is already listening; this process only talks to Firefox.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { createInterface } from "node:readline";

const title = process.env.POND_CAPTURE_TITLE;
const sandbox = process.env.POND_SANDBOX;
const firefoxBin = process.env.FIREFOX_BIN;
const geckodriver = process.env.GECKODRIVER;
const extensionDir = process.env.POND_EXTENSION_DIR;
const hostBin = process.env.POND_NATIVE_HOST;
if (
  !title ||
  !sandbox ||
  !firefoxBin ||
  !geckodriver ||
  !extensionDir ||
  !hostBin
) {
  throw new Error("Firefox capture driver is missing its environment.");
}

const firefoxHome = join(sandbox, "firefox-home");
const xdg = join(sandbox, "xdg");
const manifestDir = join(firefoxHome, ".mozilla/native-messaging-hosts");
mkdirSync(manifestDir, { recursive: true });
mkdirSync(join(xdg, "Pond"), { recursive: true });
const socketPath = join(sandbox, "native.sock");
const socketReady = Date.now() + 20_000;
while (!existsSync(socketPath)) {
  if (Date.now() > socketReady)
    throw new Error(`Native socket missing: ${socketPath}`);
  await new Promise((resolve) => setTimeout(resolve, 100));
}
symlinkSync(socketPath, join(xdg, "Pond", "native.sock"));
writeFileSync(
  join(manifestDir, "so.pond.host.json"),
  `${JSON.stringify(
    {
      name: "so.pond.host",
      description: "Pond",
      path: hostBin,
      type: "stdio",
      allowed_extensions: ["desktop@pond.so"],
    },
    null,
    2,
  )}\n`,
);

const page = `<!doctype html>
<meta charset="utf-8">
<title>${title}</title>
<body style="margin:0;background:#f4efe6;color:#1c1915;font:28px sans-serif">
  <main style="padding:64px">
    <p>Firefox capture</p>
    <h1>${title}</h1>
  </main>
</body>`;

const site = createServer((_, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(page);
});
await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
const address = site.address();
if (!address || typeof address === "string")
  throw new Error("Fixture page did not bind.");
const pageUrl = `http://127.0.0.1:${address.port}/`;

const xauthority =
  process.env.XAUTHORITY || join(process.env.HOME ?? "", ".Xauthority");
const driver = spawn(geckodriver, ["--port", "0", "--allow-system-access"], {
  env: {
    ...process.env,
    HOME: firefoxHome,
    XDG_CONFIG_HOME: xdg,
    XAUTHORITY: xauthority,
    DISPLAY: process.env.DISPLAY || ":1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let driverLog = "";
driver.stderr.on("data", (chunk) => {
  driverLog += chunk.toString();
});
const portLine = await new Promise((resolve, reject) => {
  const lines = createInterface({ input: driver.stdout });
  const timer = setTimeout(
    () => reject(new Error("geckodriver did not listen")),
    15000,
  );
  lines.on("line", (line) => {
    const match = /Listening on .*:(\d+)\s*$/.exec(line);
    if (!match) return;
    clearTimeout(timer);
    resolve(Number(match[1]));
  });
  driver.once("exit", (code) => {
    clearTimeout(timer);
    reject(new Error(`geckodriver exited ${code}: ${driverLog}`));
  });
});

const base = `http://127.0.0.1:${portLine}`;
let sessionId = "";

async function webdriver(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${method} ${path} failed (${response.status}): ${text}`);
  }
  return text ? JSON.parse(text) : {};
}

function payloadValue(payload) {
  return payload && typeof payload === "object" && "value" in payload
    ? payload.value
    : payload;
}

async function script(source, context) {
  await webdriver("POST", `/session/${sessionId}/moz/context`, { context });
  const payload = await webdriver(
    "POST",
    `/session/${sessionId}/execute/sync`,
    {
      script: source,
      args: [],
    },
  );
  return payloadValue(payload);
}

async function shutdown(code) {
  if (sessionId) {
    await webdriver("DELETE", `/session/${sessionId}`).catch(() => undefined);
  }
  driver.kill("SIGTERM");
  site.close();
  process.exit(code);
}

process.on("SIGTERM", () => void shutdown(0));
process.on("SIGINT", () => void shutdown(0));

try {
  const created = await webdriver("POST", "/session", {
    capabilities: {
      alwaysMatch: {
        browserName: "firefox",
        "moz:firefoxOptions": {
          binary: firefoxBin,
          args: ["-width", "940", "-height", "1080"],
          prefs: {
            "xpinstall.signatures.required": false,
            "extensions.autoDisableScopes": 0,
            "extensions.enabledScopes": 15,
            "browser.shell.checkDefaultBrowser": false,
            "browser.aboutwelcome.enabled": false,
            "datareporting.policy.dataSubmissionPolicyBypassNotification": true,
            "toolkit.telemetry.reportingpolicy.firstRun": false,
            "browser.startup.homepage_override.mstone": "ignore",
            "extensions.webextensions.remote": false,
          },
        },
      },
    },
  });
  const createdValue = payloadValue(created);
  sessionId = createdValue.sessionId ?? created.sessionId;
  if (!sessionId)
    throw new Error(`Firefox session had no id: ${JSON.stringify(created)}`);

  await webdriver("POST", `/session/${sessionId}/window/rect`, {
    x: 24,
    y: 40,
    width: 920,
    height: 1080,
  });
  const installed = await webdriver(
    "POST",
    `/session/${sessionId}/moz/addon/install`,
    { path: extensionDir, temporary: true },
  );
  if (payloadValue(installed) !== "desktop@pond.so") {
    throw new Error(
      `Firefox installed ${JSON.stringify(installed)}, not desktop@pond.so`,
    );
  }
  await webdriver("POST", `/session/${sessionId}/url`, { url: pageUrl });
  const opened = await script(
    `const win = Services.wm.getMostRecentBrowserWindow();
     win.focus();
     const widgetId = "desktop_pond_so-browser-action";
     const widget = win.CustomizableUI.getWidget(widgetId);
     if (widget.areaType === win.CustomizableUI.TYPE_PANEL) {
       win.gUnifiedExtensions.openPanel(null, "extension_browser_action_popup");
     } else {
       win.CustomizableUI.addWidgetToArea(widgetId, "nav-bar");
     }
     const node = widget.forWindow(win).node;
     const button = node && (node.querySelector(".unified-extensions-item-action-button") || node);
     if (!button) return "missing-button";
     button.dispatchEvent(new win.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, view: win }));
     button.dispatchEvent(new win.MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0, view: win }));
     button.dispatchEvent(new win.CustomEvent("command", {
       bubbles: true,
       cancelable: true,
       detail: { openPopupWithoutUserInteraction: true },
     }));
     return "clicked area=" + widget.areaType;`,
    "chrome",
  );
  if (!String(opened).startsWith("clicked")) throw new Error(String(opened));

  let popup = "waiting";
  for (
    let attempt = 0;
    attempt < 30 && popup !== "clicked-save-page";
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    popup = await script(
      `const win = Services.wm.getMostRecentBrowserWindow();
       const docs = [];
       for (const browser of win.document.querySelectorAll("browser")) {
         try {
           if (browser.contentDocument) docs.push(browser.contentDocument);
         } catch (error) {}
       }
       const buttons = docs.flatMap((doc) => [...doc.querySelectorAll("button")]);
       const savePage = buttons.find((button) =>
         (button.innerText || button.textContent || "").includes("Save Page"),
       );
       if (savePage) {
         savePage.click();
         return "clicked-save-page";
       }
       const action = win.document.querySelector('[data-extensionid="desktop@pond.so"]');
       if (action) {
         action.dispatchEvent(new win.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, view: win }));
         action.dispatchEvent(new win.CustomEvent("command", {
           bubbles: true,
           cancelable: true,
           detail: { openPopupWithoutUserInteraction: true },
         }));
       }
       const labels = buttons.map((button) => (button.innerText || "").trim()).filter(Boolean).slice(0, 6);
       const extPanel = win.document.getElementById("unified-extensions-panel");
       return "waiting action=" + Boolean(action) + " panel=" + (extPanel && extPanel.state) + " labels=" + labels.join("|");`,
      "chrome",
    );
  }
  if (popup !== "clicked-save-page") throw new Error(String(popup));

  let saved = "waiting";
  for (let attempt = 0; attempt < 30 && saved !== "saved"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    saved = await script(
      `function label(node) {
         return (node.innerText || node.textContent || "").trim();
       }
       function buttonsIn(root, found) {
         if (!root || !root.querySelectorAll) return;
         for (const button of root.querySelectorAll("button")) found.push(button);
         for (const node of root.querySelectorAll("*")) {
           if (node.shadowRoot) buttonsIn(node.shadowRoot, found);
         }
       }
       const found = [];
       buttonsIn(document, found);
       const confirm = found.find((button) => label(button) === "Save");
       if (!confirm) return "waiting:" + found.map(label).filter(Boolean).slice(0, 8).join("|");
       confirm.click();
       return "saved";`,
      "content",
    );
  }
  if (saved !== "saved") throw new Error(`Overlay did not save (${saved})`);
  console.log("FIREFOX_CAPTURE_SENT");
  await new Promise((resolve) => process.stdin.once("end", resolve));
  await shutdown(0);
} catch (error) {
  console.error(
    "FIREFOX_CAPTURE_FAILED",
    error instanceof Error ? error.message : error,
  );
  if (driverLog) console.error(driverLog);
  await shutdown(1);
}
