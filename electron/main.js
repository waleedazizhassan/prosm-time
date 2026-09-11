// PROSM Time - Windows desktop shell. Loads the same built web app
// (dist/) this project already ships to the browser and to Android via
// Capacitor - no separate app logic here. electron-serve maps dist/ to
// a real app://- origin (root at "/") rather than a bare file:// path,
// so react-router-dom's BrowserRouter (already shared with the Web and
// Android builds) resolves paths exactly the way it does when served
// over http, with no app-code changes and no risk to those other
// targets. Capacitor.isNativePlatform() is false here (no Capacitor
// bridge is injected) - every plugin call already falls back to its
// own web implementation (e.g. saveGeneratedFile's blob-URL download),
// which Electron's default session already turns into a real file
// save the same way a normal browser tab would.
// Hardening (docs/SECURITY_HARDENING.md): DevTools, the application
// menu, window popups and off-origin navigation are all disabled in a
// packaged build, so the bundled app cannot be inspected, re-pointed or
// scraped from inside the shell. Behaviour of the app itself is
// unchanged. Set PROSM_TIME_DEVTOOLS=1 when running from source if you
// need the inspector back during development.
import { app, BrowserWindow, Menu, session, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import serve from "electron-serve";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const loadURL = serve({ directory: path.join(__dirname, "..", "dist") });

// § TEMPORARY diagnostic build, 2026-09-11 - a real user is hitting a
// persistent crash (React ErrorBoundary) in the packaged app that
// hasn't reproduced in any local/source-run test yet, on any of 3
// prior hardening-related hypotheses (all ruled out - obfuscation,
// R8/ProGuard, asar were each disabled and the crash still happens).
// DevTools is forced open here, even packaged, specifically to capture
// the real console error directly from the user's own machine. This
// must be reverted once the real error is captured - it is NOT meant
// to ship long-term.
const ALLOW_DEVTOOLS = true;
const FORCE_OPEN_DEVTOOLS_FOR_DIAGNOSIS = true;

function createWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    // § real bug, user-reported - "no close button from the Welcome
    // page." True OS fullscreen (the earlier approach) hides the
    // ENTIRE window frame on Windows, including the close button, with
    // no discoverable way out. Maximizing instead still fills the
    // screen but keeps the title bar and its close button visible at
    // all times - see win.maximize() below (fullscreen:true would
    // otherwise ignore the initial width/height and start maximized
    // is the one that actually shows a frame).
    icon: path.join(__dirname, "..", "build", "icon.ico"),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: ALLOW_DEVTOOLS,
    },
  });

  win.maximize();

  // Clock in/out (geolocation) and camera evidence both call browser
  // APIs that Electron blocks by default unless explicitly allowed.
  win.webContents.session.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "media" || permission === "geolocation");
  });

  // No popups, and no navigating the shell away from the packaged app.
  // External links still open in the user's real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("app://")) {
      event.preventDefault();
      if (url.startsWith("https://")) shell.openExternal(url);
    }
  });

  // F11 still offers real (frameless) fullscreen for anyone who wants
  // it, same as a browser tab; Escape always exits back to the normal
  // maximized window with its title bar/close button. DevTools
  // shortcuts are swallowed in a packaged build.
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const isDevToolsShortcut =
      input.key === "F12" ||
      (input.control && input.shift && ["I", "J", "C"].includes(String(input.key).toUpperCase())) ||
      (input.control && String(input.key).toUpperCase() === "U");
    if (isDevToolsShortcut && !ALLOW_DEVTOOLS) {
      event.preventDefault();
      return;
    }
    if (input.key === "F11") {
      win.setFullScreen(!win.isFullScreen());
    } else if (input.key === "Escape" && win.isFullScreen()) {
      win.setFullScreen(false);
    }
  });

  // Belt and braces: even a programmatic openDevTools() closes again.
  if (!ALLOW_DEVTOOLS) {
    win.webContents.on("devtools-opened", () => win.webContents.closeDevTools());
  }

  if (FORCE_OPEN_DEVTOOLS_FOR_DIAGNOSIS) {
    win.webContents.on("did-finish-load", () => {
      win.webContents.openDevTools({ mode: "bottom" });
    });
  }

  loadURL(win);
  return win;
}

app.whenReady().then(() => {
  app.setName("PROSM Time");

  if (!ALLOW_DEVTOOLS) {
    Menu.setApplicationMenu(null);
  }

  // § live UX review, user-directed - a real Windows desktop build.
  // setPermissionRequestHandler above only covers foreground requests;
  // this also keeps the OS-level permission check from silently
  // denying camera/geolocation access later.
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => permission === "media" || permission === "geolocation");

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
