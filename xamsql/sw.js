/* XamSQL — service worker généré par scripts/pwa.mjs (version ce1d559bf8d4). */
const CACHE = "xamsql-ce1d559bf8d4";
const PRECACHE = ["./","assets/ibm-plex-mono-latin-400-normal-DMJ8VG8y.woff2","assets/ibm-plex-mono-latin-500-normal-DSY6xOcd.woff2","assets/ibm-plex-mono-latin-600-normal-BgSNZQsw.woff2","assets/ibm-plex-sans-latin-400-italic-CZTNEAuW.woff2","assets/ibm-plex-sans-latin-400-normal-CDDApCn2.woff2","assets/ibm-plex-sans-latin-500-normal-6ng42L7E.woff2","assets/ibm-plex-sans-latin-600-normal-CuJfVYMP.woff2","assets/ibm-plex-sans-latin-700-normal-Bxkt5Cjx.woff2","assets/index-BQ7dBQHH.js","assets/index-DLzaiDV6.css","assets/sql-wasm-DfANybxk.wasm","assets/worker-CU7ehfp0.js","brand/xamsql-app-192.png","brand/xamsql-app-512.png","brand/xamsql-favicon-512.png","brand/xamsql-favicon-64.png","brand/xamsql-icon-dark.png","data/boutique.sqlite","data/content.json","data/ecole.sqlite","data/manifest.json","data/manuel.json","manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("xamsql-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || !url.pathname.startsWith(new URL(self.registration.scope).pathname)) return;
  // Pages : réseau d'abord (nouvelle version dès qu'elle est publiée), sinon l'application en cache.
  if (req.mode === "navigate") {
    event.respondWith(fetch(req).then((r) => (r.ok ? r : caches.match("./"))).catch(() => caches.match("./")));
    return;
  }
  // Fichiers : cache d'abord (ils sont versionnés), réseau sinon.
  event.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req)));
});
