/* global self, caches, fetch, Request, Response, URL */
// PROSM Time web service worker (owner 2026-10-18: "the app doesn't open
// offline"). Keeps the app's own files on the device so the web version
// opens without a connection - clock in/out and breaks then work offline
// as in the phone app. Only the app's files, from this same address, are
// handled; data requests (Supabase) and other sites are never touched.
//
// * The page itself: from the network when possible (so a new version is
//   picked up), otherwise the saved copy.
// * Built files (assets/<hash>.js|css|...): their names change with every
//   version, so a saved copy is always right; every file of the current
//   version is saved when it is installed (sw-assets.json, written by the
//   build). The previous version's files are kept, so a tab opened before
//   an update still finds them.
const SCOPE = new URL("./", self.location.href).pathname;
const SHELL_CACHE = "prosm-time-shell";
const ASSET_CACHE = "prosm-time-assets";
const INDEX_URL = SCOPE + "index.html";
const META_CACHE = "prosm-time-meta";

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const shell = await caches.open(SHELL_CACHE);
      await shell.add(new Request(INDEX_URL, { cache: "reload" }));
      try {
        const response = await fetch(SCOPE + "sw-assets.json", { cache: "no-store" });
        if (response.ok) {
          const files = await response.json();
          // Remember this version's list (and the one before it) for the clean-up on activate.
          const meta = await caches.open(META_CACHE);
          const current = await meta.match("current");
          if (current) await meta.put("previous", current);
          await meta.put("current", new Response(JSON.stringify(files)));
          const assets = await caches.open(ASSET_CACHE);
          // One at a time keeps a weak connection usable; a file that fails is fetched later on use.
          for (const file of files) {
            try {
              await assets.add(SCOPE + file);
            } catch {
              // fetched and saved the first time it is used
            }
          }
        }
      } catch {
        // no list: files are saved as they are used
      }
      await self.skipWaiting();
    })(),
  );
});

// Files of versions older than the previous one are removed.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const meta = await caches.open(META_CACHE);
        const lists = await Promise.all(["current", "previous"].map(async (key) => {
          const saved = await meta.match(key);
          return saved ? saved.json() : [];
        }));
        const keep = new Set(lists.flat().map((file) => new URL(SCOPE + file, self.location.href).href));
        if (keep.size > 0) {
          const assets = await caches.open(ASSET_CACHE);
          for (const request of await assets.keys()) {
            if (!keep.has(request.url)) await assets.delete(request);
          }
        }
      } catch {
        // clean-up is best effort
      }
      await self.clients.claim();
    })(),
  );
});

const isAppAsset = (url) => url.origin === self.location.origin && url.pathname.startsWith(SCOPE + "assets/");

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(SCOPE)) return;

  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          if (response.ok) {
            const shell = await caches.open(SHELL_CACHE);
            await shell.put(INDEX_URL, response.clone());
          }
          return response;
        } catch {
          const saved = await caches.match(INDEX_URL);
          return saved || Response.error();
        }
      })(),
    );
    return;
  }

  if (isAppAsset(url)) {
    event.respondWith(
      (async () => {
        const saved = await caches.match(request);
        if (saved) return saved;
        const response = await fetch(request);
        // Never save the HTML page some hosts return for a missing file.
        const type = response.headers.get("content-type") || "";
        if (response.ok && !type.includes("text/html")) {
          const assets = await caches.open(ASSET_CACHE);
          await assets.put(request, response.clone());
        }
        return response;
      })(),
    );
  }
});
