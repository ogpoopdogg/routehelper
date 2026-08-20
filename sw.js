// Minimal service worker for E&C Route Planner.
// Its main job is to satisfy the browser's PWA installability requirement
// (an active, controlling service worker) so `beforeinstallprompt` can fire.
const CACHE_NAME = 'ec-route-planner-v1';
const APP_SHELL = [
    './',
    './index.html',
    './manifest.json',
    './icon2.png'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(APP_SHELL))
            .catch(err => console.warn('SW precache failed:', err))
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))
        )
    );
    self.clients.claim();
});

// Network-first for navigation/API calls, falling back to cache when offline.
// This app is live-data driven (Firebase, Google Maps/Routes), so we deliberately
// avoid aggressively caching anything beyond the static app shell.
self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;
    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin) return; // don't intercept third-party APIs

    event.respondWith(
        fetch(event.request)
            .then(response => {
                const clone = response.clone();
                caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                return response;
            })
            .catch(() => caches.match(event.request))
    );
});
