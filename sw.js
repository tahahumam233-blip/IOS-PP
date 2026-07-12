const CACHE_NAME = "payment-tracker-pwa-20260712-sheet-snapshot-1";
const STATIC_ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./styles.css",
  "./live-preview.css",
  "./location-map.css",
  "./users.js",
  "./app.js",
  "./live-preview.js",
  "./location-map.js",
  "./location-map.html",
  "./assets/icon-180.png",
  "./assets/icon-192.png",
  "./assets/icon-512.png",
  "./assets/logo-red.png",
  "./assets/logo-white-red.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.map((key) => (key === CACHE_NAME ? null : caches.delete(key)))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== "GET" || url.origin !== self.location.origin) {
    return;
  }

  if (
    request.mode === "navigate" ||
    url.pathname.endsWith("/index.html") ||
    url.pathname.endsWith("/users.js") ||
    url.pathname.endsWith("/app.js") ||
    url.pathname.endsWith("/sheet-data.json") ||
    url.pathname.endsWith("/styles.css") ||
    url.pathname.endsWith("/live-preview.css") ||
    url.pathname.endsWith("/location-map.html") ||
    url.pathname.endsWith("/location-map.css") ||
    url.pathname.endsWith("/location-map.js") ||
    url.pathname.endsWith("/live-preview.js") ||
    url.pathname.endsWith("/sw.js")
  ) {
    event.respondWith(
      fetch(request, { cache: "no-store" }).catch(() => caches.match("./index.html"))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        return response;
      });
    })
  );
});
