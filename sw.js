const CACHE_NAME = "horizon-v6";

// App shell files to cache for instant offline loading
const APP_SHELL = [
    "/",
    "/index.html",
    "/index.css",
    "/app.js",
    "/worker.js",
    "/icon-512.png",
    "/manifest.json",
];

// Install: pre-cache the app shell
self.addEventListener("install", (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            console.log("[SW] Caching app shell v5");
            return cache.addAll(APP_SHELL);
        })
    );
    // Activate immediately
    self.skipWaiting();
});

// Activate: clean up old caches
self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches.keys().then((names) =>
            Promise.all(
                names
                    .filter((name) => name !== CACHE_NAME)
                    .map((name) => caches.delete(name))
            )
        )
    );
    // Take control of all clients immediately
    self.clients.claim();
});

// Fetch: Network First, falling back to cache
self.addEventListener("fetch", (event) => {
    const url = new URL(event.request.url);

    // Let WebLLM CDN / model downloads go straight to network
    if (url.origin !== self.location.origin) {
        return;
    }

    event.respondWith(
        fetch(event.request)
            .then((response) => {
                // If network fetch succeeds, cache the fresh response
                if (response.ok && event.request.method === "GET") {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
                }
                return response;
            })
            .catch(() => {
                // If network fails (offline), fall back to cache
                return caches.match(event.request);
            })
    );
});
