// @vitest-environment node
// public/sw.js against a host that sometimes answers an existing file with
// the app's HTML page (owner 2026-10-19: pages said they need internet
// while it was on). The worker asks again, never saves the HTML, and drops
// HTML an earlier worker saved in place of a file.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(join(process.cwd(), "public", "sw.js"), "utf8");
const BASE = "https://prosm.net/time-app/";
const ASSET = BASE + "assets/Page-abc.js";

const js = () => new Response("export default 1;", { headers: { "content-type": "text/javascript" } });
const html = () => new Response("<!doctype html>", { headers: { "content-type": "text/html; charset=utf-8" } });

function fakeCaches() {
  const stores = new Map<string, Map<string, Response>>();
  const open = async (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name)!;
    const key = (request: Request | string) => (typeof request === "string" ? request : request.url);
    return {
      match: async (request: Request | string) => store.get(key(request))?.clone(),
      put: async (request: Request | string, response: Response) => void store.set(key(request), response.clone()),
      add: async (request: Request | string) => void store.set(key(request), html()),
      delete: async (request: Request | string) => store.delete(key(request)),
      keys: async () => [...store.keys()].map((url) => new Request(url)),
    };
  };
  const match = async (request: Request | string) => {
    for (const name of stores.keys()) {
      const hit = await (await open(name)).match(request);
      if (hit) return hit;
    }
    return undefined;
  };
  return { stores, api: { open, match, delete: async (name: string) => stores.delete(name) } };
}

function loadWorker(answers: Array<() => Response>) {
  const handlers: Record<string, (event: unknown) => void> = {};
  const caches = fakeCaches();
  const requested: string[] = [];
  const self = {
    location: { href: BASE + "sw.js", origin: "https://prosm.net" },
    addEventListener: (type: string, handler: (event: unknown) => void) => (handlers[type] = handler),
    skipWaiting: async () => undefined,
    clients: { claim: async () => undefined },
  };
  const fetch = async (request: Request | string) => {
    requested.push(typeof request === "string" ? request : request.url);
    return (answers.shift() ?? js)();
  };
  runInNewContext(SOURCE, { self, caches: caches.api, fetch, Request, Response, URL, setTimeout });
  const run = async (type: string, request?: Request) => {
    let pending: Promise<unknown> | undefined;
    let responded: Promise<Response> | undefined;
    handlers[type]({ request, waitUntil: (p: Promise<unknown>) => (pending = p), respondWith: (p: Promise<Response>) => (responded = p) });
    await pending;
    return responded;
  };
  return { caches, requested, run };
}

describe("web service worker and a host that answers files with HTML", () => {
  it("asks again until the real file comes, and saves only the file", async () => {
    const worker = loadWorker([html, html, js]);
    const response = await (await worker.run("fetch", new Request(ASSET)))!;
    expect(response.headers.get("content-type")).toContain("javascript");
    expect(worker.requested).toHaveLength(3);
    const saved = worker.caches.stores.get("prosm-time-assets-v2")?.get(ASSET);
    expect(saved?.headers.get("content-type")).toContain("javascript");
  });

  it("drops HTML saved in place of a file, and the old worker's cache", async () => {
    const worker = loadWorker([js]);
    const assets = await worker.caches.api.open("prosm-time-assets-v2");
    await assets.put(ASSET, html());
    await worker.caches.api.open("prosm-time-assets");
    await worker.run("activate");
    expect(worker.caches.stores.has("prosm-time-assets")).toBe(false);
    const response = await (await worker.run("fetch", new Request(ASSET)))!;
    expect(response.headers.get("content-type")).toContain("javascript");
  });

  it("never saves the HTML answer when the file does not come", async () => {
    const worker = loadWorker([html, html, html, html, html]);
    const response = await (await worker.run("fetch", new Request(ASSET)))!;
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(worker.caches.stores.get("prosm-time-assets-v2")?.has(ASSET)).toBe(false);
  });
});
