// ─────────────────────────────────────────────────────────────
// GR5 Rando — sw.js  (Service Worker)
//
// Stratégies de cache :
//   App shell (HTML/CSS/JS/Leaflet) → cache-first
//   Tuiles OSM                      → cache-first permanent
//   Données statiques (JSON/GPX)    → cache-first
//   Open-Meteo API                  → network-first + fallback cache
// ─────────────────────────────────────────────────────────────

const VER           = 'v2';
const CACHE_SHELL   = `gr5-shell-${VER}`;
const CACHE_TILES   = `gr5-tiles-${VER}`;   // tuiles carte : peut devenir volumineux
const CACHE_DATA    = `gr5-data-${VER}`;    // JSON + GPX
const CACHE_WEATHER = `gr5-weather-${VER}`; // réponses Open-Meteo

// ── Ressources précachées lors de l'installation ─────────────
// Tout ce qui doit être disponible sans réseau dès le premier lancement
const PRECACHE_URLS = [
  './',
  './index.html',
  './app.js',
  './style.css',
  './manifest.json',
  './data/hebergements.json',
  './data/ravitaillement.json',
  // Leaflet depuis CDN — mis en cache lors du premier chargement avec WiFi
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
        // Prend le contrôle immédiatement sans attendre le rechargement
        return self.skipWaiting();
      })
  );
});

/* ── activate : nettoyage des anciens caches ─────────────────── */
self.addEventListener('activate', event => {
  const current = new Set([CACHE_SHELL, CACHE_TILES, CACHE_DATA, CACHE_WEATHER]);
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

  // Tuiles OSM (*.tile.openstreetmap.org) → cache-first permanent
  // Les tuiles sont immuables : une fois en cache elles ne changent plus.
  if (url.hostname.endsWith('.tile.openstreetmap.org')) {
    event.respondWith(cacheFirst(request, CACHE_TILES));
    return;
  }

  // Open-Meteo API → network-first + fallback
  // On veut toujours la météo la plus récente si réseau disponible.
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

  // Tout le reste → réseau simple, pas de mise en cache
  // (ex: icônes inline, requêtes navigateur internes)
});

/* ─────────────────────────────────────────────────────────────
   Stratégie cache-first
   Retourne la version en cache si elle existe.
   Sinon, tente le réseau, stocke la réponse, et la retourne.
   En cas d'échec réseau sans cache → 503 explicite.
   ───────────────────────────────────────────────────────────── */
async function cacheFirst(request, cacheName) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    // Ne stocke que les réponses réussies (pas les erreurs 4xx/5xx)
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    return offlineResponse("Cette ressource n'est pas disponible hors-ligne.");
  }
}

/* ─────────────────────────────────────────────────────────────
   Stratégie network-first
   Tente le réseau, met à jour le cache en cas de succès.
   Si réseau indisponible, retourne la version en cache.
   Utilisé pour les données qui changent (météo).
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
