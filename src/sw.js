const cacheName = "navuryx-m3u-tool-v4";
const appFiles = ["./", "index.html", "css/styles.css", "js/m3u.js", "js/app.js", "js/streaming.js", "manifest.webmanifest", "assets/icons/icon-192.png", "assets/icons/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(cacheName).then((cache) => cache.addAll(appFiles)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== cacheName).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") {
    return;
  }
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin || requestUrl.pathname.startsWith("/api/") || requestUrl.pathname === "/playlist.m3u" || /\.(?:m3u8|ts|m4s|mp4)$/i.test(requestUrl.pathname)) {
    event.respondWith(fetch(event.request));
    return;
  }
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
    const copy = response.clone();
    caches.open(cacheName).then((cache) => cache.put(event.request, copy));
    return response;
  }).catch(() => event.request.mode === "navigate" ? caches.match("index.html") : Response.error())));
});
