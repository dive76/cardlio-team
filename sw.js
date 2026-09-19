// team.cardlio.app — a small service worker so the page installs and its
// shell opens offline. Only same-origin shell files are cached; every
// iCloud call (apple-cloudkit.com, icloud.com) goes to the network.
const CACHE = "cardlio-team-v3";
const SHELL = ["/", "/index.html", "/app.css?v=3", "/app.js?v=3", "/config.js?v=1", "/manifest.webmanifest", "/assets/icon-192.png", "/assets/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== "GET") return;   // iCloud, the CloudKit CDN: network only
  // Network first for the shell (a new version lands on the next open), cache when offline.
  e.respondWith(fetch(e.request).then((res) => {
    const copy = res.clone();
    caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
    return res;
  }).catch(() => caches.match(e.request, { ignoreSearch: false }).then((hit) => hit || caches.match("/index.html"))));
});
