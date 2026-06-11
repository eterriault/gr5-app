// ─────────────────────────────────────────────────────────────
// GR5 Rando — sw.js  (Service Worker)
//
// Stratégies de cache :
//   App shell (HTML/CSS/JS/Leaflet) → cache-first
//   Tuiles IGN / OSM               → cache-first permanent
//   Données statiques (JSON/GPX)   → cache-first
//   Open-Meteo API                 → network-first + fallback cache
// ─────────────────────────────────────────────────────────────

const VER           = 'v6';
const CACHE_SHELL   = `gr5-shell-${VER}`;
const CACHE_DATA    = `gr5-data-${VER}`;
const CACHE_WEATHER = `gr5-weather-${VER}`;
// Les tuiles sont maintenant stockées dans IndexedDB (TileDB) — plus dans le Cache Storage

// ── Ressources précachées lors de l'installation ─────────────
const PRECACHE_URLS = [
  './',
  './index.html',
  './app.js',
  './style.css',
  './manifest.json',
  './data/hebergements.json',
  './data/ravitaillement.json',
  './data/traces/index.json',
  './data/stages/stage_1.json',
  './data/stages/stage_2.json',
  './data/stages/stage_3.json',
  './data/stages/stage_4.json',
  './data/stages/stage_5.json',
  './data/stages/stage_6.json',
  './data/stages/stage_7.json',
  // Leaflet depuis CDN
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

/* ── install : précache de l'app shell ──────────────────────── */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_SHELL)
      .then(cache => cache.addAll(PRECACHE_URLS))
      .then(() => {
        console.log('[SW] Install — shell en cache.');
        return self.skipWaiting();
      })
  );
});

/* ── activate : nettoyage des anciens caches ─────────────────── */
self.addEventListener('activate', event => {
  const current = new Set([CACHE_SHELL, CACHE_DATA, CACHE_WEATHER]);
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => !current.has(k)).map(k => {
        console.log('[SW] Suppression ancien cache :', k);
        return caches.delete(k);
      }))
    ).then(() => self.clients.claim())
  );
});

/* ── fetch : routage des requêtes ───────────────────────────── */
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Tuiles IGN et OSM → gérées par IndexedDB dans app.js, pas par le SW

  // Open-Meteo API → network-first + fallback
  if (url.hostname === 'api.open-meteo.com') {
    event.respondWith(networkFirst(request, CACHE_WEATHER));
    return;
  }

  // Données statiques (JSON, GPX dans /data/) → cache-first
  if (url.pathname.includes('/data/')) {
    event.respondWith(cacheFirst(request, CACHE_DATA));
    return;
  }

  // App shell (document, scripts, styles, CDN) → cache-first
  const dest = request.destination;
  if (dest === 'document' || dest === 'script' || dest === 'style' || dest === 'font') {
    event.respondWith(cacheFirst(request, CACHE_SHELL));
    return;
  }
});

/* ─────────────────────────────────────────────────────────────
   Stratégie cache-first
   ───────────────────────────────────────────────────────────── */
async function cacheFirst(request, cacheName) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    return offlineResponse("Cette ressource n'est pas disponible hors-ligne.");
  }
}

/* ─────────────────────────────────────────────────────────────
   Stratégie network-first
   ───────────────────────────────────────────────────────────── */
async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    return offlineResponse('Données non disponibles hors-ligne.');
  }
}

function offlineResponse(message) {
  return new Response(message, {
    status: 503,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
