// Cachenamnet innehåller service workerns scope, så att en betaversion i
// en undermapp (t.ex. /skyttelogg/beta/) och live-versionen inte rensar
// varandras cacher när någon av dem uppdateras.
const CACHE_PREFIX = "skyttelogg-shell-";
const CACHE_VERSION = "v4";
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

// Rensar bara egna, äldre cacher: tidigare versioner för SAMMA scope, samt
// gamla cachenamn utan scope (v1–v3, från före den här ändringen) - de
// senare bara från rotversionen, aldrig från en undermapp.
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

// Nätverk först, cache bara som reserv om man är offline.
// Skalet (HTML/CSS/JS) blir alltid färskt vid uppdatering - ingen
// väntan på att webbläsaren ska "upptäcka" att något ändrats.
// Google/Sheets API-anrop rörs aldrig - alltid nätverket.
self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Cacha bara lyckade svar - annars kan t.ex. en 404 ersätta en
        // fungerande fil i offline-reserven.
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
