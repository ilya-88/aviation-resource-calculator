const CACHE = "aviation-resource-template-exp33";
const ASSETS = [
  "./",
  "./index.html",
  "./src/styles.css",
  "./src/calculations.js",
  "./src/formulas.js",
  "./src/formula-editor.js",
  "./src/aircraft-templates.js",
  "./src/app.js",
  "./manifest.webmanifest",
  "./media/app-icon.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});
