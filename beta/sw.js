// Cachenamnet innehåller scope, så att beta (/beta/) och live inte rensar
// varandras cacher.
const CACHE_PREFIX = "skyttelogg-shell-";
const CACHE_VERSION = "v5";
const SCOPE = self.registration.scope;
const CACHE_NAME = `${CACHE_PREFIX}${CACHE_VERSION}|${SCOPE}`;
const SHELL_FILES = [
  "./index.html",
  "./style.css",
  "./app.js",
  "./config.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

// Rensar äldre versioner för samma scope. Äldre cachenamn utan scope rensas
// bara av rotversionen.
self.addEventListener("activate", event => {
  const isRootScope = !/\/beta\/$/.test(SCOPE);
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => {
        if (!k.startsWith(CACHE_PREFIX) || k === CACHE_NAME) return false;
        if (k.includes("|")) return k.endsWith("|" + SCOPE);
        return isRootScope;
      }).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Nätverk först, cache som reserv offline, så att uppdateringar slår igenom
// direkt. Anrop till andra ursprung (Google-API:er m.m.) hanteras inte här.
self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Cacha bara lyckade svar, så att ett felsvar aldrig ersätter en
        // fungerande fil.
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
