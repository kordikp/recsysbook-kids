// Service Worker for p-book — offline-first caching
const CACHE_NAME = 'pbook-v1';

// Core assets to pre-cache on install
const PRECACHE = [
  '/',
  '/index.html',
  '/js/app.js',
  '/js/config.js',
  '/js/recombee.js',
  '/js/markdown.js',
  '/js/diagrams.js',
  '/js/tutor.js',
  '/css/style.css',
  '/content/book.json',
  '/favicon.svg',
  '/images/hero-recsys.svg',
  // Games
  '/games/ab-test.json',
  '/games/bubble-pop.json',
  '/games/cold-start.json',
  '/games/method-match.json',
  '/games/pipeline-order.json',
  '/games/privacy-spotter.json',
  '/games/signal-sort.json',
  '/games/taste-match.json',
];

// Install: pre-cache core assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE))
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
    ))
  );
  self.clients.claim();
});

// Fetch: network-first for API, cache-first for content
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // API calls (Recombee, auth, log) — network only, don't cache
  if (url.pathname.startsWith('/.netlify/') || url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(event.request).catch(() => new Response('{"error":"offline"}', {
      status: 503, headers: { 'Content-Type': 'application/json' }
    })));
    return;
  }

  // Content files (markdown, JSON, SVG, images) — cache-first, update in background
  event.respondWith(
    caches.match(event.request).then(cached => {
      const fetchPromise = fetch(event.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => cached); // network failed, use cache

      return cached || fetchPromise;
    })
  );
});
