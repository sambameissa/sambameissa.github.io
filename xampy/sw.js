/* XamPy — service worker généré par scripts/pwa.mjs (version 21059cfcb84d). */
const CACHE = "xampy-21059cfcb84d";
const PY_CACHE = "xampy-pyodide-314.0.8";
const PY_PREFIX = "https://cdn.jsdelivr.net/pyodide/v314.0.8/";
const PRECACHE = ["./","assets/ibm-plex-mono-latin-400-normal-DMJ8VG8y.woff2","assets/ibm-plex-mono-latin-500-normal-DSY6xOcd.woff2","assets/ibm-plex-mono-latin-600-normal-BgSNZQsw.woff2","assets/ibm-plex-sans-latin-400-italic-CZTNEAuW.woff2","assets/ibm-plex-sans-latin-400-normal-CDDApCn2.woff2","assets/ibm-plex-sans-latin-500-normal-6ng42L7E.woff2","assets/ibm-plex-sans-latin-600-normal-CuJfVYMP.woff2","assets/ibm-plex-sans-latin-700-normal-Bxkt5Cjx.woff2","assets/index-DLyW2iVH.css","assets/index-D_c9Lw-R.js","assets/worker-l2SztR2H.js","data/categories.csv","data/clients.csv","data/clients_bruts.csv","data/commandes.csv","data/commandes_api.json","data/content.json","data/lignes_commande.csv","data/paiements.csv","data/produits.csv","data/stocks_fr.csv","icon.svg","manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("xampy-") && k !== CACHE && k !== PY_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Python (Pyodide et ses paquets) : versionné par son adresse, gardé en cache dès le premier usage.
  if (req.url.startsWith(PY_PREFIX)) {
    event.respondWith(
      caches.open(PY_CACHE).then((c) =>
        c.match(req).then(
          (hit) =>
            hit ||
            fetch(req).then((r) => {
              if (r.ok) c.put(req, r.clone());
              return r;
            }),
        ),
      ),
    );
    return;
  }
  if (url.origin !== location.origin || !url.pathname.startsWith(new URL(self.registration.scope).pathname)) return;
  // Pages : réseau d'abord (nouvelle version dès qu'elle est publiée), sinon l'application en cache.
  if (req.mode === "navigate") {
    event.respondWith(fetch(req).then((r) => (r.ok ? r : caches.match("./"))).catch(() => caches.match("./")));
    return;
  }
  // Fichiers : cache d'abord (ils sont versionnés), réseau sinon.
  event.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req)));
});
