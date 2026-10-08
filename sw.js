// Minimal service worker for E&C Route Helper.
// Jobs:
//  1. Satisfy the browser's PWA installability requirement (an active, controlling
//     service worker) so `beforeinstallprompt` can fire.
//  2. Always hand the app the newest page when there is signal, and the last saved copy
//     when there isn't. This replaces the old "?_nocache=" reload that index.html did on
//     every open (it loaded the app twice, made a new cache entry every launch, and stopped
//     the app from opening offline).
// Bumping CACHE_NAME also deletes the old cache, which held one copy of the page per launch.
const CACHE_NAME = 'ec-route-helper-v4';
// How long to wait for a fresh page before opening the saved copy.
const NAVIGATE_TIMEOUT_MS = 3500;
const APP_SHELL = [
    './',
    './index.html',
    './manifest.json',
    './logo.png',
    './icon-192.png',
    './icon-512.png'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            // cache: 'reload' skips the browser's own HTTP cache so the saved copy is the current one
            .then(cache => cache.addAll(APP_SHELL.map(url => new Request(url, { cache: 'reload' }))))
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

// Network-first for same-origin GETs, falling back to the saved copy when offline.
// This app is live-data driven (Firebase, Google Maps/Routes), so we deliberately
// avoid caching anything beyond the static app shell.
self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return; // don't intercept third-party APIs

    if (request.mode === 'navigate') {
        // The page itself: ask the server every time (cache: 'no-cache' makes the browser
        // check with the server instead of reusing a stale copy). Save it under the address
        // without any ?query part, so there is only ever one saved copy of each page.
        // On a weak signal the request can hang for a long time, so if the server hasn't
        // answered within NAVIGATE_TIMEOUT_MS the saved copy opens instead. The request keeps
        // going in the background and still refreshes the saved copy for next time.
        const cacheKey = url.origin + url.pathname;
        const fromNetwork = fetch(request, { cache: 'no-cache' });
        // Registered first, so the copy is taken before the page starts reading the response.
        // waitUntil keeps the worker alive until it's saved, even after the page has opened.
        event.waitUntil(fromNetwork.then(response => {
            if (!response || !response.ok) return;
            const clone = response.clone();
            return caches.open(CACHE_NAME).then(cache => cache.put(cacheKey, clone));
        }).catch(() => { /* offline - nothing to save */ }));
        const fromCache = () =>
            caches.match(cacheKey)
                .then(hit => hit || caches.match(request, { ignoreSearch: true }))
                .then(hit => hit || caches.match('./index.html'));
        event.respondWith(new Promise(resolve => {
            let settled = false;
            const answer = response => { if (!settled && response) { settled = true; resolve(response); } };
            const timer = setTimeout(() => {
                fromCache().then(answer); // nothing saved yet: keep waiting for the network
            }, NAVIGATE_TIMEOUT_MS);
            fromNetwork.then(response => {
                clearTimeout(timer);
                answer(response);
            }).catch(() => {
                clearTimeout(timer);
                fromCache().then(hit => {
                    if (hit) answer(hit);
                    else if (!settled) { settled = true; resolve(Response.error()); }
                });
            });
        }));
        return;
    }

    event.respondWith(
        fetch(request)
            .then(response => {
                if (response && response.ok) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
                }
                return response;
            })
            .catch(() => caches.match(request))
    );
});
