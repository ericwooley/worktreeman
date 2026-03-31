const CACHE_NAME = "worktreeman-pwa-v1";
const APP_SHELL_URLS = ["/", "/manifest.webmanifest", "/logo.png", "/logo-light.png"];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL_URLS)),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      caches.keys().then((cacheNames) => Promise.all(
        cacheNames
          .filter((cacheName) => cacheName !== CACHE_NAME)
          .map((cacheName) => caches.delete(cacheName)),
      )),
    ]),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const requestUrl = new URL(request.url);

  if (
    request.method !== "GET"
    || requestUrl.origin !== self.location.origin
    || requestUrl.pathname.startsWith("/api")
    || requestUrl.pathname.startsWith("/ws")
  ) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        const cache = await caches.open(CACHE_NAME);
        cache.put("/", response.clone());
        return response;
      } catch {
        const cachedResponse = await caches.match("/");
        if (cachedResponse) {
          return cachedResponse;
        }

        throw new Error("Offline and no cached app shell available.");
      }
    })());
    return;
  }

  if (request.destination === "image" || requestUrl.pathname === "/manifest.webmanifest") {
    event.respondWith((async () => {
      const cachedResponse = await caches.match(request);
      if (cachedResponse) {
        return cachedResponse;
      }

      const response = await fetch(request);
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
      return response;
    })());
  }
});
