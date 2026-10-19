/* global self, caches, fetch, Request, Response, URL, setTimeout */
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
//
// Owner 2026-10-19 ("some pages say they need internet while it's on"):
// the web host sometimes answers a file that exists with the app's HTML
// page instead (about 1 request in 3 when measured). A built file is never
// HTML, so such an answer is asked for again, and never saved - an earlier
// version saved it, which broke that page on the device for good; those
// saved copies are dropped (new cache name, and checked on every use).
const SCOPE = new URL("./", self.location.href).pathname;
const SHELL_CACHE = "prosm-time-shell";
const ASSET_CACHE = "prosm-time-assets-v2";
const OLD_CACHES = ["prosm-time-assets"];
const INDEX_URL = SCOPE + "index.html";
const META_CACHE = "prosm-time-meta";
const ATTEMPTS = 5;

const isHtml = (response) => (response.headers.get("content-type") || "").includes("text/html");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A built file from the network, asked for again while the host answers with HTML.
async function fetchAsset(url) {
  let last;
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    if (attempt > 0) await wait(150 * attempt);
    last = await fetch(new Request(url, { cache: "no-store" }));
    if (!last.ok || !isHtml(last)) return last;
  }
  return last;
}

async function saveAsset(cache, url) {
  const response = await fetchAsset(url);
  if (response.ok && !isHtml(response)) await cache.put(url, response);
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const shell = await caches.open(SHELL_CACHE);
      await shell.add(new Request(INDEX_URL, { cache: "reload" }));
      try {
        const response = await fetch(SCOPE + "sw-assets.json", { cache: "no-store" });
        if (response.ok && !isHtml(response)) {
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
              await saveAsset(assets, new URL(SCOPE + file, self.location.href).href);
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

// Files of versions older than the previous one are removed, and so are the
// caches of earlier workers (which may hold HTML saved in place of a file).
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      try {
        for (const name of OLD_CACHES) await caches.delete(name);
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
        const assets = await caches.open(ASSET_CACHE);
        const saved = await assets.match(request.url);
        if (saved && !isHtml(saved)) return saved;
        if (saved) await assets.delete(request.url);
        const response = await fetchAsset(request.url);
        if (response.ok && !isHtml(response)) await assets.put(request.url, response.clone());
        return response;
      })(),
    );
  }
});
