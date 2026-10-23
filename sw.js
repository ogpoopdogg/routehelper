// Service worker for E&C Route Helper.
// Jobs:
//  1. Satisfy the browser's PWA installability requirement (an active, controlling
//     service worker) so `beforeinstallprompt` can fire.
//  2. Open the app instantly, with or without signal: the page, its pictures, the Firebase
//     code and the fonts all come from the copy saved on the phone. Nothing waits on the
//     network, so weak signal (bars but no data) can't hold the app on a blank screen.
//  3. Fetch the newest page in the background on every open. When it differs from the saved
//     copy, the saved copy is replaced and the open app is told, so it can offer a Refresh
//     (index.html shows "A new version of Route Helper is ready"). The next open uses it.
// Bumping CACHE_NAME also deletes the old cache.
const CACHE_NAME = 'ec-route-helper-v4';
const APP_SHELL = [
    './',
    './index.html',
    './manifest.json',
    './icon2.png',
    './icon-192.png',
    './apple-touch-icon.png'
];
// Code and fonts from other sites that the page needs before it can start. The Firebase
// files never change at a given version number, so a saved copy is always right.
const FIREBASE_SDK = /^https:\/\/www\.gstatic\.com\/firebasejs\//;
const FONT_CSS = /^https:\/\/fonts\.googleapis\.com\/css2/;
const FONT_FILE = /^https:\/\/fonts\.gstatic\.com\//;
const THIRD_PARTY_SHELL = [
    'https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js',
    'https://www.gstatic.com/firebasejs/9.23.0/firebase-auth-compat.js',
    'https://www.gstatic.com/firebasejs/9.23.0/firebase-database-compat.js',
    'https://fonts.googleapis.com/css2?family=Creepster&family=Inter:wght@400;500;600;700;800&display=swap'
];

// Asks another site for a file in a way that gives a readable answer (so a failed download
// is never saved). If that site doesn't allow it, the page gets the plain answer, unsaved.
function fetchThirdParty(request) {
    return fetch(request.url, { mode: 'cors', credentials: 'omit' })
        .then(response => {
            if (!response.ok) throw new Error('HTTP ' + response.status);
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(request.url, clone));
            return response;
        })
        .catch(() => fetch(request));
}

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => Promise.all([
            // cache: 'reload' skips the browser's own HTTP cache so the saved copy is the current one
            cache.addAll(APP_SHELL.map(url => new Request(url, { cache: 'reload' })))
                .catch(err => console.warn('SW precache failed:', err)),
            // One by one, so one missing file doesn't stop the others being saved.
            ...THIRD_PARTY_SHELL.map(url =>
                fetch(url, { mode: 'cors', credentials: 'omit' })
                    .then(response => { if (response.ok) return cache.put(url, response); })
                    .catch(err => console.warn('SW precache failed:', url, err)))
        ]))
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

// Downloads the newest page, saves it, and tells the open app when it changed.
function refreshPage(request, cacheKey, savedText) {
    return fetch(request, { cache: 'no-cache' })
        .then(response => {
            if (!response || !response.ok || response.redirected) return;
            return response.clone().text().then(text => {
                if (text === savedText) return;
                return caches.open(CACHE_NAME)
                    .then(cache => cache.put(cacheKey, response))
                    .then(() => self.clients.matchAll({ type: 'window' }))
                    .then(clients => clients.forEach(client => client.postMessage({ type: 'ec-page-updated' })));
            });
        })
        .catch(() => { /* no signal - the saved copy stays */ });
}

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);

    if (url.origin !== self.location.origin) {
        // Firebase code and font files: the saved copy, or download and save it.
        if (FIREBASE_SDK.test(request.url) || FONT_FILE.test(request.url)) {
            event.respondWith(caches.match(request.url).then(hit => hit || fetchThirdParty(request)));
        } else if (FONT_CSS.test(request.url)) {
            // The font list: the saved copy now, refreshed in the background. With nothing
            // saved and no answer within 3 seconds the page goes on with its own fonts,
            // because the page can't draw anything until this arrives.
            event.respondWith(caches.match(request.url).then(hit => {
                const fresh = fetchThirdParty(request);
                if (hit) { event.waitUntil(fresh.catch(() => {})); return hit; }
                const fallback = new Promise(resolve => setTimeout(() =>
                    resolve(new Response('', { headers: { 'Content-Type': 'text/css' } })), 3000));
                return Promise.race([fresh.catch(() => fallback), fallback]);
            }));
        }
        // Everything else from other sites (maps, Firebase data, sign-in) is live, never saved.
        return;
    }

    if (request.mode === 'navigate') {
        // The page itself: the saved copy straight away, then the newest copy fetched in the
        // background for next time. Saved under the address without any ?query part, so
        // there is only ever one saved copy of each page.
        const cacheKey = url.origin + url.pathname;
        event.respondWith(
            caches.match(cacheKey)
                .then(hit => hit || caches.match(request, { ignoreSearch: true }))
                .then(hit => hit || caches.match('./index.html'))
                .then(hit => {
                    if (!hit) {
                        // First open on this phone: nothing saved yet, so wait for the network.
                        return fetch(request, { cache: 'no-cache' }).then(response => {
                            if (response && response.ok) {
                                const clone = response.clone();
                                caches.open(CACHE_NAME).then(cache => cache.put(cacheKey, clone));
                            }
                            return response;
                        });
                    }
                    event.waitUntil(hit.clone().text().then(savedText => refreshPage(request, cacheKey, savedText)));
                    return hit;
                })
        );
        return;
    }

    // Pictures and the manifest: the saved copy straight away, refreshed in the background.
    event.respondWith(
        caches.match(request).then(hit => {
            const fresh = fetch(request)
                .then(response => {
                    if (response && response.ok) {
                        const clone = response.clone();
                        caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
                    }
                    return response;
                });
            if (hit) {
                event.waitUntil(fresh.catch(() => {}));
                return hit;
            }
            return fresh.catch(() => caches.match(request));
        })
    );
});
