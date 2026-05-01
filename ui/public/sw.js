const CACHE_NAME = "paperclip-v4";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

// Always returns a Response. Tries network first; on failure, falls back
// to cache; if the cache also misses, returns a synthetic 503 so
// respondWith() never resolves to `undefined` (which throws "Failed to
// convert value to 'Response'." in workerd / Chrome).
async function handleFetch(request, url) {
  try {
    const response = await fetch(request);
    if (response.ok && url.origin === self.location.origin) {
      // Don't await: cache write is best-effort, doesn't block the response.
      const clone = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(request, clone)).catch(() => {});
    }
    return response;
  } catch {
    // Network failed (offline, server down, etc). Try cache.
    const cached = request.mode === "navigate"
      ? await caches.match("/")
      : await caches.match(request);
    if (cached) return cached;
    return new Response("Offline", {
      status: 503,
      headers: { "Content-Type": "text/plain" },
    });
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests and API calls (let them go straight to network).
  if (request.method !== "GET" || url.pathname.startsWith("/api")) {
    return;
  }

  event.respondWith(handleFetch(request, url));
});
