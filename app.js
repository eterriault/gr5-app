// ─────────────────────────────────────────────────────────────
// GR5 Rando — app.js
// Architecture : modules objet, vanilla JS ES2020, zéro framework
// Dépendance unique : Leaflet (chargé via CDN, mis en cache par SW)
// ─────────────────────────────────────────────────────────────

'use strict';

// ── Diagnostic : premier signe de vie du script ──────────────
console.log('[GR5] app.js chargé, Leaflet présent :', typeof L !== 'undefined');

/* ═══════════════════════════════════════════════════════════════
   CONFIGURATION
   ══════════════════════════════════════════════════════════════ */
const TRACE_COLORS = ['#e53935','#1e88e5','#43a047','#fb8c00','#8e24aa','#00acc1','#e91e63','#f4511e'];

/* ═══════════════════════════════════════════════════════════════
   UTILITAIRES ICÔNES CARTE
   ══════════════════════════════════════════════════════════════ */
function makeHebergeIcon(h) {
  const emojis  = { refuge: '🏔', gite: '🏠', camping: '⛺', hotel: '🏨' };
  const emoji   = emojis[h.type] ?? '🏠';
  const unverified = h.coords_verified === false;
  return L.divIcon({
    className: '',
    html: `<div style="position:relative;display:inline-block;filter:drop-shadow(0 1px 3px rgba(0,0,0,0.6))">
      <div style="font-size:18px;line-height:1">${emoji}</div>
      ${unverified ? `<div style="
        position:absolute;top:-4px;right:-6px;
        background:#ffa726;color:#1a1a1a;
        font-size:8px;font-weight:800;
        border-radius:50%;width:12px;height:12px;
        display:flex;align-items:center;justify-content:center;line-height:1
      ">?</div>` : ''}
    </div>`,
    iconSize:   [24, 24],
    iconAnchor: [12, 12],
    popupAnchor:[0, -14],
  });
}

const CONFIG = {
  // Carte : centré sur le début du Stage 1 (secteur Thonon–Abondance)
  mapCenter: [46.20, 6.72],
  mapZoom: 10,
  tileUrl: 'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0'
          + '&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2&STYLE=normal&FORMAT=image%2Fpng'
          + '&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}',
  tileAttribution: '© <a href="https://www.geoportail.gouv.fr/">IGN</a>',
  maxZoom: 18,

  // Trace GPX
  gpxColor: '#e53935',
  gpxWeight: 3.5,
  gpxOpacity: 0.85,

  // Météo (Open-Meteo, gratuit, sans clé API)
  weatherApiBase: 'https://api.open-meteo.com/v1/forecast',
  weatherParams: 'daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weathercode'
                + '&timezone=Europe%2FParis&forecast_days=7',

  // Hébergements : rayon d'affichage devant la position (km)
  hebergeRadius: 30,
};

/* ═══════════════════════════════════════════════════════════════
   ÉTAT GLOBAL
   ══════════════════════════════════════════════════════════════ */
const state = {
  map: null,
  gpsMarker: null,
  gpsAccuracyCircle: null,
  gpsWatchId: null,
  currentPosition: null,      // { lat, lon, accuracy, altitude }

  traces: [],                 // [{ name, filename, points, distance, ascent, color, layer }]
  visibleTraces: new Set(),   // indices des traces actuellement affichées sur la carte

  hebergements: [],
  ravitaillement: [],
  // Initialisé dans MapModule.init() pour éviter un crash si Leaflet charge en retard
  hebergeMarkers: null,
  hebergementsVisible: true,
};

/* ═══════════════════════════════════════════════════════════════
   INDEXEDDB — stockage persistant des tuiles de carte
   Contrairement au Cache Storage du SW, IndexedDB n'est pas purgé
   arbitrairement par iOS — traité comme données utilisateur.
   ══════════════════════════════════════════════════════════════ */
const TileDB = (() => {
  const DB_NAME = 'gr5-tiles';
  const STORE   = 'tiles';
  let _db = null;

  async function open() {
    if (_db) return _db;
    return new Promise((res, rej) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = e => e.target.result.createObjectStore(STORE);
      req.onsuccess  = e => { _db = e.target.result; res(_db); };
      req.onerror    = ()  => rej(req.error);
    });
  }

  return {
    async get(key) {
      const db  = await open();
      return new Promise((res, rej) => {
        const req = db.transaction(STORE).objectStore(STORE).get(key);
        req.onsuccess = () => res(req.result);
        req.onerror   = () => rej(req.error);
      });
    },
    async put(key, blob) {
      const db  = await open();
      return new Promise((res, rej) => {
        const req = db.transaction(STORE, 'readwrite').objectStore(STORE).put(blob, key);
        req.onsuccess = () => res();
        req.onerror   = () => rej(req.error);
      });
    },
    async count() {
      const db  = await open();
      return new Promise((res, rej) => {
        const req = db.transaction(STORE).objectStore(STORE).count();
        req.onsuccess = () => res(req.result);
        req.onerror   = () => rej(req.error);
      });
    },
    // Retourne un Set de toutes les clés — beaucoup plus rapide que N get() individuels
    async getAllKeys() {
      const db  = await open();
      return new Promise((res, rej) => {
        const req = db.transaction(STORE).objectStore(STORE).getAllKeys();
        req.onsuccess = () => res(new Set(req.result));
        req.onerror   = () => rej(req.error);
      });
    },
  };
})();

/* ═══════════════════════════════════════════════════════════════
   TILE LAYER AVEC FALLBACK ZOOM INFÉRIEUR (hors-ligne)
   Lit les tuiles depuis IndexedDB. Si absente, fetch réseau et
   stocke. En cas d'échec, affiche le zoom inférieur recadré.
   ══════════════════════════════════════════════════════════════ */
let FallbackTileLayer;
function getFallbackTileLayer() {
  if (!FallbackTileLayer) {
    FallbackTileLayer = L.TileLayer.extend({

      createTile(coords, done) {
        const tile = document.createElement('img');
        tile.alt = '';
        tile.setAttribute('role', 'presentation');
        const key = `${coords.z}/${coords.x}/${coords.y}`;
        TileDB.get(key)
          .then(blob => blob
            ? this._showBlob(tile, blob, () => done(null, tile),
                             () => this._fallback(tile, coords, coords.z - 1, done))
            : this._fetchAndCache(tile, coords, key, done))
          .catch(() => this._fetchAndCache(tile, coords, key, done));
        return tile;
      },

      _showBlob(tile, blob, onload, onerror) {
        const url = URL.createObjectURL(blob);
        tile.onload  = () => { URL.revokeObjectURL(url); onload(); };
        tile.onerror = () => { URL.revokeObjectURL(url); onerror(); };
        tile.src = url;
      },

      _fetchAndCache(tile, coords, key, done) {
        fetch(this.getTileUrl(coords))
          .then(r => { if (!r.ok) throw r.status; return r.blob(); })
          .then(blob => {
            TileDB.put(key, blob).catch(() => {});
            this._showBlob(tile, blob, () => done(null, tile),
                           () => this._fallback(tile, coords, coords.z - 1, done));
          })
          .catch(() => this._fallback(tile, coords, coords.z - 1, done));
      },

      _fallback(tile, orig, tryZ, done) {
        if (tryZ < 8) { done(null, tile); return; }
        const scale  = 1 << (orig.z - tryZ);
        const fbKey  = `${tryZ}/${Math.floor(orig.x / scale)}/${Math.floor(orig.y / scale)}`;
        TileDB.get(fbKey)
          .then(blob => {
            if (!blob) { this._fallback(tile, orig, tryZ - 1, done); return; }
            const url = URL.createObjectURL(blob);
            const img = new Image();
            img.onload = () => {
              URL.revokeObjectURL(url);
              const canvas = document.createElement('canvas');
              canvas.width = canvas.height = 256;
              const ctx = canvas.getContext('2d');
              const ts  = 256 / scale;
              ctx.imageSmoothingQuality = 'high';
              ctx.drawImage(img, (orig.x % scale) * ts, (orig.y % scale) * ts, ts, ts, 0, 0, 256, 256);
              tile.onload = () => done(null, tile);
              tile.onerror = null;
              tile.src = canvas.toDataURL();
            };
            img.onerror = () => { URL.revokeObjectURL(url); this._fallback(tile, orig, tryZ - 1, done); };
            img.src = url;
          })
          .catch(() => this._fallback(tile, orig, tryZ - 1, done));
      },
    });
  }
  return FallbackTileLayer;
}

/* ═══════════════════════════════════════════════════════════════
   MODULE CARTE
   ══════════════════════════════════════════════════════════════ */
const MapModule = {
  init() {
    state.map = L.map('map', {
      center: CONFIG.mapCenter,
      zoom: CONFIG.mapZoom,
      zoomControl: false,
      attributionControl: true,
    });

    new (getFallbackTileLayer())(CONFIG.tileUrl, {
      attribution: CONFIG.tileAttribution,
      maxZoom: CONFIG.maxZoom,
      crossOrigin: 'anonymous',
    }).addTo(state.map);

    L.control.zoom({ position: 'topleft' }).addTo(state.map);
    L.control.scale({ position: 'bottomleft', imperial: false }).addTo(state.map);
    state.hebergeMarkers = L.layerGroup().addTo(state.map);

    // Clic → coordonnées GPS discrètes
    const coordsEl = document.getElementById('map-coords');
    state.map.on('click', (e) => {
      const { lat, lng } = e.latlng;
      coordsEl.textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
      coordsEl.classList.remove('hidden');
    });

    console.log('[GR5] MapModule.init() OK');

    // Safari iOS décharge parfois la carte lors du retour au premier plan
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) state.map.invalidateSize();
    });
  },

  centerOn(lat, lon, zoom = 14) {
    state.map.setView([lat, lon], Math.max(state.map.getZoom(), zoom));
  },

  updateGPSMarker(lat, lon, accuracy) {
    if (state.gpsMarker) {
      state.gpsMarker.setLatLng([lat, lon]);
      state.gpsAccuracyCircle.setLatLng([lat, lon]).setRadius(accuracy);
      return;
    }

    state.gpsAccuracyCircle = L.circle([lat, lon], {
      radius: accuracy,
      color: '#1565c0',
      fillColor: '#42a5f5',
      fillOpacity: 0.15,
      weight: 1,
    }).addTo(state.map);

    // Point bleu "ma position" (CSS inline pour éviter les images externes)
    const icon = L.divIcon({
      className: '',
      html: `<div style="
        width:16px; height:16px;
        background:#1976d2; border:3px solid #fff;
        border-radius:50%; box-shadow:0 2px 6px rgba(0,0,0,0.5);
      "></div>`,
      iconSize: [16, 16],
      iconAnchor: [8, 8],
    });
    state.gpsMarker = L.marker([lat, lon], { icon, zIndexOffset: 1000 })
      .addTo(state.map);
  },

  showHebergements(hebergements) {
    state.hebergeMarkers.clearLayers();

    hebergements.forEach(h => {
      const tel      = h.telephone
        ? `<br><a href="tel:${h.telephone.replace(/\s/g,'')}" style="color:#81c784">${h.telephone}</a>`
        : '';
      const dp       = h.demi_pension ? ' · demi-pension' : '';
      const places   = h.places ? ` · ${h.places} places` : '';
      const bivouac  = h.bivouac ? `<br>🏕 ${h.bivouac}` : '';
      const unverif  = h.coords_verified === false
        ? `<br><span style="color:#ffa726;font-size:11px">⚠ Position approximative</span>`
        : '';

      L.marker([h.lat, h.lon], { icon: makeHebergeIcon(h) })
        .bindPopup(`
          <strong>${h.nom}</strong><br>
          ${h.altitude} m${places}${dp}
          ${tel}
          ${h.ouverture ? `<br><small>${h.ouverture}</small>` : ''}
          ${bivouac}
          ${h.notes ? `<br><em style="font-size:11px">${h.notes}</em>` : ''}
          ${unverif}
          <br><a href="#" onclick="event.preventDefault();HebModule.showAndScrollTo('${h.id}')" style="color:#81c784;font-size:12px">Voir la fiche →</a>
        `, { maxWidth: 220 })
        .addTo(state.hebergeMarkers);
    });
  },
};

/* ═══════════════════════════════════════════════════════════════
   MODULE GPS
   ══════════════════════════════════════════════════════════════ */
const GPSModule = {
  start() {
    if (!navigator.geolocation) {
      UIModule.toast('GPS non disponible sur cet appareil.', 'error');
      return;
    }
    UIModule.setGPSStatus('searching');

    state.gpsWatchId = navigator.geolocation.watchPosition(
      this._onSuccess.bind(this),
      this._onError.bind(this),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 }
    );
  },

  stop() {
    if (state.gpsWatchId !== null) {
      navigator.geolocation.clearWatch(state.gpsWatchId);
      state.gpsWatchId = null;
    }
    UIModule.setGPSStatus('off');
    state.currentPosition = null;
  },

  _onSuccess({ coords }) {
    const { latitude: lat, longitude: lon, accuracy, altitude } = coords;
    state.currentPosition = { lat, lon, accuracy, altitude };
    UIModule.setGPSStatus('on');
    MapModule.updateGPSMarker(lat, lon, accuracy);
  },

  _onError({ code }) {
    const msg = {
      1: 'Accès GPS refusé. Autorisez la localisation dans Réglages > Safari.',
      2: 'Position GPS indisponible.',
      3: "Délai d'expiration GPS dépassé.",
    };
    UIModule.toast(msg[code] ?? 'Erreur GPS inconnue.', 'error');
    UIModule.setGPSStatus('off');
  },
};

/* ═══════════════════════════════════════════════════════════════
   MODULE GPX
   ══════════════════════════════════════════════════════════════ */
const GPXModule = {
  // ── Parsing ────────────────────────────────────────────────

  parse(xmlString) {
    const doc = new DOMParser().parseFromString(xmlString, 'text/xml');

    // Récupère les trackpoints (format standard GR5 : <trk><trkseg><trkpt>)
    const trkpts = doc.querySelectorAll('trkpt');
    const points = Array.from(trkpts)
      .map(pt => ({
        lat: parseFloat(pt.getAttribute('lat')),
        lon: parseFloat(pt.getAttribute('lon')),
        ele: parseFloat(pt.querySelector('ele')?.textContent ?? 0),
      }))
      .filter(p => !isNaN(p.lat) && !isNaN(p.lon));

    const nameEl = doc.querySelector('trk > name, metadata > name');
    const name   = nameEl?.textContent?.trim() ?? 'Trace sans nom';

    return {
      name,
      points,
      distance: Geo.traceDistance(points),
      ascent:   Geo.traceAscent(points),
    };
  },

  // ── Chargement ─────────────────────────────────────────────

  async loadFromFile(file) {
    const xml   = await file.text();
    const trace = this.parse(xml);
    trace.filename = file.name;
    this._register(trace);
    return trace;
  },

  async loadFromURL(url, meta = {}) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
    const xml   = await res.text();
    const trace = this.parse(xml);
    trace.filename = url.split('/').pop();
    Object.assign(trace, meta);
    this._register(trace);
    return trace;
  },

  // ── Enregistrement + layer Leaflet ─────────────────────────

  _register(trace) {
    const color   = TRACE_COLORS[state.traces.length % TRACE_COLORS.length];
    const latlngs = trace.points.map(p => [p.lat, p.lon]);
    trace.color = color;
    trace.layer = L.polyline(latlngs, {
      color,
      weight:  CONFIG.gpxWeight,
      opacity: CONFIG.gpxOpacity,
    });

    const index = state.traces.push(trace) - 1;
    UIModule.addGPXItem(trace, index);
  },

  // ── Visibilité des traces ───────────────────────────────────

  setVisible(index, visible) {
    const trace = state.traces[index];
    if (!trace) return;
    if (visible) {
      trace.layer.addTo(state.map);
      state.visibleTraces.add(index);
    } else {
      state.map.removeLayer(trace.layer);
      state.visibleTraces.delete(index);
    }
    UIModule.updateGPXList();
  },

  showAll() {
    state.traces.forEach((t, i) => {
      t.layer.addTo(state.map);
      state.visibleTraces.add(i);
    });
    this._fitVisible();
    UIModule.updateGPXList();
  },

  hideAll() {
    state.traces.forEach((t, i) => {
      state.map.removeLayer(t.layer);
      state.visibleTraces.delete(i);
    });
    UIModule.updateGPXList();
  },

  _fitVisible() {
    const layers = [...state.visibleTraces].map(i => state.traces[i].layer);
    if (layers.length === 0) return;
    state.map.fitBounds(L.featureGroup(layers).getBounds(), { padding: [20, 20] });
  },

  getVisible() {
    return [...state.visibleTraces].sort((a, b) => a - b).map(i => state.traces[i]);
  },

  // ── Extraction d'un tronçon par coordonnées ─────────────────

  sliceByCoords(trace, fromCoords, toCoords) {
    const from = { lat: fromCoords[0], lon: fromCoords[1] };
    const to   = { lat: toCoords[0],   lon: toCoords[1] };

    let fromIdx = 0, toIdx = trace.points.length - 1;
    let minFrom = Infinity, minTo = Infinity;

    trace.points.forEach((p, i) => {
      const dFrom = Geo.haversine(p, from);
      const dTo   = Geo.haversine(p, to);
      if (dFrom < minFrom) { minFrom = dFrom; fromIdx = i; }
      if (dTo   < minTo)   { minTo   = dTo;   toIdx   = i; }
    });

    if (fromIdx > toIdx) [fromIdx, toIdx] = [toIdx, fromIdx];

    const points = trace.points.slice(fromIdx, toIdx + 1);
    return { ...trace, points, distance: Geo.traceDistance(points), ascent: Geo.traceAscent(points) };
  },
};

/* ═══════════════════════════════════════════════════════════════
   MODULE PROFIL ALTIMÉTRIQUE
   ══════════════════════════════════════════════════════════════ */
const ElevationModule = {
  // État interne
  _trace:  null,
  _canvas: null,
  _W: 0, _H: 0,
  _minEle: 0, _range: 1,
  _pad: { t: 8, r: 8, b: 28, l: 40 },
  onHover: null,   // callback(point | null) branché par StagesModule

  draw(trace, canvasId = 'day-elevation-canvas') {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    // Redimensionnement HiDPI
    const W   = canvas.offsetWidth;
    const H   = canvas.offsetHeight;
    const dpr = window.devicePixelRatio || 1;
    canvas.width  = W * dpr;
    canvas.height = H * dpr;
    canvas.getContext('2d').scale(dpr, dpr);

    const eles   = trace.points.map(p => p.ele);
    const minEle = Math.min(...eles);
    const range  = Math.max(...eles) - minEle;

    // Pas de données d'altitude
    if (range === 0) {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = '#888';
      ctx.font = '13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText("Données d'altitude non disponibles", W / 2, H / 2);
      return;
    }

    // Stocker pour les redraws
    this._trace  = trace;
    this._canvas = canvas;
    this._W      = W;
    this._H      = H;
    this._minEle = minEle;
    this._range  = range;

    // Événements souris / tactile
    canvas.onmousemove  = (e) => this._onPointer(e.clientX, e.clientY);
    canvas.onmouseleave = ()  => this._onPointerEnd();
    canvas.ontouchmove  = (e) => { e.preventDefault(); this._onPointer(e.touches[0].clientX, e.touches[0].clientY); };
    canvas.ontouchend   = ()  => this._onPointerEnd();

    this._render(null);
  },

  _onPointer(clientX, clientY) {
    const rect = this._canvas.getBoundingClientRect();
    const cssX = clientX - rect.left;
    const pad  = this._pad;
    const cW   = this._W - pad.l - pad.r;
    const t    = Math.max(0, Math.min(1, (cssX - pad.l) / cW));
    const idx  = Math.round(t * (this._trace.points.length - 1));
    this._render(idx);
    this.onHover?.(this._trace.points[idx]);
  },

  _onPointerEnd() {
    this._render(null);
    this.onHover?.(null);
  },

  _render(crosshairIdx) {
    const canvas = this._canvas;
    if (!canvas) return;
    const ctx  = canvas.getContext('2d');
    const W    = this._W;
    const H    = this._H;
    const pad  = this._pad;
    const cW   = W - pad.l - pad.r;
    const cH   = H - pad.t - pad.b;
    const pts  = this._trace.points;
    const minE = this._minEle;
    const rng  = this._range;

    // Distances cumulées pour positionner les points par km réel
    const cumKm = [0];
    for (let i = 1; i < pts.length; i++)
      cumKm.push(cumKm[i - 1] + Geo.haversine(pts[i - 1], pts[i]));
    const totalKm = cumKm[cumKm.length - 1];

    const px = (i) => pad.l + (cumKm[i] / totalKm) * cW;
    const py = (p) => pad.t + cH - ((p.ele - minE) / rng) * cH;

    ctx.clearRect(0, 0, W, H);

    // Remplissage sous la courbe
    const grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + cH);
    grad.addColorStop(0, 'rgba(46,125,50,0.6)');
    grad.addColorStop(1, 'rgba(46,125,50,0.05)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    pts.forEach((p, i) => i === 0 ? ctx.moveTo(px(i), py(p)) : ctx.lineTo(px(i), py(p)));
    ctx.lineTo(px(pts.length - 1), pad.t + cH);
    ctx.lineTo(pad.l, pad.t + cH);
    ctx.closePath();
    ctx.fill();

    // Courbe
    ctx.strokeStyle = '#43a047';
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    pts.forEach((p, i) => i === 0 ? ctx.moveTo(px(i), py(p)) : ctx.lineTo(px(i), py(p)));
    ctx.stroke();

    // Étiquettes altitude
    ctx.fillStyle = '#888';
    ctx.font      = '10px -apple-system, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(`${Math.round(minE + rng)} m`, pad.l - 4, pad.t + 6);
    ctx.fillText(`${Math.round(minE)} m`,        pad.l - 4, pad.t + cH);

    // Étiquettes km sur l'axe X — coche à chaque km, label tous les 5km
    const labelStep = totalKm <= 10 ? 2 : 5;
    ctx.font = '9px -apple-system, sans-serif';
    for (let km = 0; km <= Math.ceil(totalKm); km++) {
      if (km > totalKm) break;
      const x       = pad.l + (km / totalKm) * cW;
      const isMajor = km % labelStep === 0;
      ctx.strokeStyle = isMajor ? '#666' : '#444';
      ctx.lineWidth   = 1;
      ctx.beginPath();
      ctx.moveTo(x, pad.t + cH);
      ctx.lineTo(x, pad.t + cH + (isMajor ? 4 : 2));
      ctx.stroke();
      if (isMajor) {
        ctx.fillStyle = '#888';
        ctx.textAlign = km === 0 ? 'left' : 'center';
        ctx.fillText(`${km} km`, x, pad.t + cH + 14);
      }
    }

    // Position GPS actuelle
    if (state.currentPosition) {
      let minDist = Infinity, gpsIdx = 0;
      pts.forEach((p, i) => {
        const d = Geo.haversine(state.currentPosition, p);
        if (d < minDist) { minDist = d; gpsIdx = i; }
      });
      ctx.fillStyle = '#1976d2';
      ctx.beginPath();
      ctx.arc(px(gpsIdx), py(pts[gpsIdx]), 5, 0, Math.PI * 2);
      ctx.fill();
    }

    // Crosshair hover
    if (crosshairIdx !== null) {
      const pt = pts[crosshairIdx];
      const x  = px(crosshairIdx);
      const y  = py(pt);

      // Ligne verticale
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth   = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x, pad.t);
      ctx.lineTo(x, pad.t + cH);
      ctx.stroke();
      ctx.setLineDash([]);

      // Point sur la courbe
      ctx.fillStyle   = '#fff';
      ctx.strokeStyle = '#43a047';
      ctx.lineWidth   = 2;
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // Label altitude
      const label = `${Math.round(pt.ele)} m`;
      ctx.font      = 'bold 11px system-ui, sans-serif';
      ctx.textAlign = x > W / 2 ? 'right' : 'left';
      ctx.fillStyle = '#fff';
      ctx.fillText(label, x + (x > W / 2 ? -8 : 8), Math.max(pad.t + 12, y - 6));
    }
  },

  drawPositionMarker(ctx, trace, pad, cW, cH, minEle, range) {
    // Gardé pour compatibilité — appelé nulle part, logique intégrée dans _render
  },
};

/* ═══════════════════════════════════════════════════════════════
   MODULE STATS ÉTAPES
   ══════════════════════════════════════════════════════════════ */
const StatsModule = {
  update(trace) {
    const grid = document.getElementById('etapes-stats');
    grid.classList.remove('hidden');

    document.getElementById('stat-distance').textContent = trace.distance;
    document.getElementById('stat-ascent').textContent   = trace.ascent;

    const nextHeberge = this._distanceToNextHeberge(trace);
    document.getElementById('stat-next-heberge').textContent =
      nextHeberge !== null ? nextHeberge : '—';

    // Cache le placeholder si une trace est chargée
    document.querySelector('#tab-etapes .placeholder')?.remove();
  },

  // Distance sur le tracé (pas à vol d'oiseau) jusqu'au prochain hébergement
  _distanceToNextHeberge(trace) {
    if (!state.currentPosition || state.hebergements.length === 0) return null;
    // TODO (sprint 2) : calcul sur le tracé GPX avec projection du point GPS
    return null;
  },
};

/* ═══════════════════════════════════════════════════════════════
   MODULE MÉTÉO (Open-Meteo)
   ══════════════════════════════════════════════════════════════ */
const WeatherModule = {
  // Codes WMO → emoji + description (sous-ensemble pertinent montagne)
  WMO_CODES: {
    0: ['☀️', 'Soleil'],
    1: ['🌤', 'Peu nuageux'],   2: ['⛅', 'Nuageux'],
    3: ['☁️', 'Couvert'],
    45: ['🌫', 'Brouillard'],   48: ['🌫', 'Brouillard givrant'],
    51: ['🌦', 'Bruine'],       53: ['🌦', 'Bruine mod.'],
    61: ['🌧', 'Pluie faible'], 63: ['🌧', 'Pluie'],   65: ['🌧', 'Pluie forte'],
    71: ['🌨', 'Neige faible'], 73: ['🌨', 'Neige'],   75: ['❄️', 'Neige forte'],
    77: ['🌨', 'Grésil'],
    80: ['🌦', 'Averses'],      81: ['🌦', 'Averses'],  82: ['⛈', 'Averses fortes'],
    85: ['🌨', 'Averses neige'],
    95: ['⛈', 'Orage'],        96: ['⛈', 'Orage grêle'],
  },

  async fetch(lat, lon) {
    const url = `${CONFIG.weatherApiBase}?latitude=${lat}&longitude=${lon}&${CONFIG.weatherParams}`;
    const placeholder = document.getElementById('meteo-placeholder');
    placeholder?.classList.remove('hidden');

    try {
      const res  = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      this._render(data);

      const ts = new Date().toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
      document.getElementById('meteo-last-update').textContent = `Dernière mise à jour : ${ts}`;
    } catch (err) {
      if (placeholder) placeholder.textContent = 'Météo indisponible hors-ligne. Dernière version en cache affichée.';
      console.warn('[Weather]', err);
    }
  },

  _render(data) {
    const container  = document.getElementById('meteo-content');
    const placeholder = document.getElementById('meteo-placeholder');
    const { daily }  = data;

    container.innerHTML = '';
    container.classList.remove('hidden');
    placeholder?.classList.add('hidden');

    daily.time.forEach((dateStr, i) => {
      const code   = daily.weathercode[i];
      const [icon, label] = this.WMO_CODES[code] ?? ['❓', 'Inconnu'];
      const tmax   = Math.round(daily.temperature_2m_max[i]);
      const tmin   = Math.round(daily.temperature_2m_min[i]);
      const precip = daily.precipitation_sum[i];
      const date   = new Date(dateStr);
      const label_day = date.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });

      const el = document.createElement('div');
      el.className = 'meteo-day';
      el.innerHTML = `
        <div class="meteo-day-date">${label_day}</div>
        <div class="meteo-day-icon">${icon}</div>
        <div class="meteo-day-temps">
          <span class="meteo-day-max">${tmax}°C</span>
          <span class="meteo-day-min">${tmin}°C — ${label}</span>
        </div>
        <div class="meteo-day-precip">${precip > 0 ? precip.toFixed(1) + ' mm' : ''}</div>
      `;
      container.appendChild(el);
    });
  },
};

/* ═══════════════════════════════════════════════════════════════
   MODULE ÉTAPES (données Dillon)
   ══════════════════════════════════════════════════════════════ */
const StagesModule = {

  async loadAll() {
    const stages = [];
    for (let i = 1; i <= 7; i++) {
      try {
        const r = await fetch(`./data/stages/stage_${i}.json`, { cache: 'no-cache' });
        if (!r.ok) continue;
        const stage = await r.json();
        stages.push(stage);
        console.log(`[Stages] Stage ${i} chargé — ${stage.days.length} jours`);
      } catch (e) {
        console.warn(`[Stages] Stage ${i} ignoré :`, e);
      }
    }
    console.log(`[Stages] ${stages.length} stage(s) — rendu en cours`);
    try {
      this._render(stages);
    } catch (e) {
      console.error('[Stages] Erreur dans _render :', e);
    }
  },

  _dayMap: null,
  _dayPolyline: null,

  _render(stages) {
    const container = document.getElementById('stages-list');
    container.innerHTML = '';

    if (stages.length === 0) {
      container.innerHTML = '<p class="placeholder">Aucune étape disponible.</p>';
      return;
    }

    stages.forEach(stage => {
      const group = document.createElement('div');
      group.className = 'stage-group';
      group.innerHTML = `<div class="stage-header">Stage ${stage.stage} — ${stage.name}</div>`;

      if (stage.description || stage.scans?.length) {
        group.appendChild(this._buildStageIntroCard(stage));
      }

      // Group days by day number (variants share same day number)
      const byDayNum = new Map();
      stage.days.forEach(day => {
        if (!byDayNum.has(day.day)) byDayNum.set(day.day, []);
        byDayNum.get(day.day).push(day);
      });

      [...byDayNum.keys()].sort((a, b) => a - b).forEach(dayNum => {
        const variants = byDayNum.get(dayNum);
        if (variants.length === 1) {
          group.appendChild(this._buildDayCard(variants[0]));
        } else {
          group.appendChild(this._buildVariantCard(dayNum, variants, stage));
        }
      });

      container.appendChild(group);
    });
  },

  _renderMarkdown(text) {
    const bold = s => s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    return text.split('\n\n').map(block => {
      const lines = block.split('\n');
      if (lines.every(l => l.startsWith('- '))) {
        return `<ul>${lines.map(l => `<li>${bold(l.slice(2))}</li>`).join('')}</ul>`;
      }
      return `<p>${bold(lines.join('<br>'))}</p>`;
    }).join('');
  },

  _buildStageIntroCard(stage) {
    const card = document.createElement('div');
    card.className = 'stage-intro-card';

    const header = document.createElement('div');
    header.className = 'stage-intro-header';
    header.innerHTML = `
      <span>Présentation du stage</span>
      <svg class="stage-intro-chevron" viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
        <path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z"/>
      </svg>`;

    const body = document.createElement('div');
    body.className = 'stage-intro-body hidden';

    if (stage.scans?.length && stage.scans_dir) {
      const gallery = document.createElement('div');
      gallery.className = 'stage-intro-gallery';
      stage.scans.forEach(filename => {
        const img = document.createElement('img');
        img.src = `${stage.scans_dir}/${filename}`;
        img.className = 'stage-intro-scan';
        img.alt = filename;
        gallery.appendChild(img);
      });
      body.appendChild(gallery);
    }

    if (stage.description) {
      const desc = document.createElement('div');
      desc.className = 'stage-intro-text';
      desc.innerHTML = this._renderMarkdown(stage.description);
      body.appendChild(desc);
    }

    header.addEventListener('click', () => {
      const open = !body.classList.contains('hidden');
      body.classList.toggle('hidden', open);
      card.classList.toggle('open', !open);
    });

    card.appendChild(header);
    card.appendChild(body);
    return card;
  },

  _buildDayCard(day) {
    const card = document.createElement('div');
    card.className = 'day-card';
    const timeStr = this._formatTime(day.time_hours);
    card.innerHTML = `
      <div class="day-card-header">
        <div class="day-header-top">
          <span class="day-number">Jour ${day.day}</span>
          <span class="day-kpis">${day.distance_km} km · ${timeStr} · ↑${day.ascent_m} m</span>
          <svg class="day-chevron" viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
            <path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z"/>
          </svg>
        </div>
        <div class="day-route">${day.from} → ${day.to}</div>
      </div>
    `;
    card.addEventListener('click', () => this._openDetail(day));
    return card;
  },

  _buildVariantCard(dayNum, variants, stage) {
    const card = document.createElement('div');
    card.className = 'day-card variant-card';
    let activeIdx = 0;

    const render = () => {
      const day = variants[activeIdx];
      const timeStr = this._formatTime(day.time_hours);
      const variantMeta = stage.variants?.find(v => v.id === day.variant);

      card.innerHTML = `
        <div class="day-card-header">
          <div class="day-header-top">
            <span class="day-number">Jour ${dayNum}</span>
            <div class="variant-tabs">
              ${variants.map((v, i) => `
                <button class="variant-tab${i === activeIdx ? ' active' : ''}" data-idx="${i}">
                  ${v.variant?.toUpperCase() ?? String(i + 1)}
                </button>`).join('')}
            </div>
            <svg class="day-chevron" viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
              <path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z"/>
            </svg>
          </div>
          <div class="day-route">${day.from} → ${day.to}</div>
          ${variantMeta ? `<div class="variant-name">${variantMeta.name}</div>` : ''}
          <div class="day-kpis-row">${day.distance_km} km · ${timeStr} · ↑${day.ascent_m} m</div>
        </div>
      `;

      card.querySelectorAll('.variant-tab').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          activeIdx = parseInt(btn.dataset.idx);
          render();
        });
      });

      card.querySelector('.day-card-header').addEventListener('click', () => {
        this._openDetail(variants[activeIdx]);
      });
    };

    render();
    return card;
  },

  _openDetail(day) {
    // En-tête
    const variantSuffix = day.variant ? ` (${day.variant.toUpperCase()})` : '';
    document.getElementById('day-detail-title').textContent =
      `Jour ${day.day}${variantSuffix} — ${day.from} → ${day.to}`;

    // Stats
    const timeStr = this._formatTime(day.time_hours);
    document.getElementById('day-detail-stats').innerHTML = `
      <div class="detail-stat">
        <span class="detail-stat-value">${day.distance_km}</span>
        <span class="detail-stat-label">km</span>
      </div>
      <div class="detail-stat">
        <span class="detail-stat-value">${timeStr}</span>
        <span class="detail-stat-label">durée</span>
      </div>
      <div class="detail-stat">
        <span class="detail-stat-value">↑${day.ascent_m}</span>
        <span class="detail-stat-label">m D+</span>
      </div>
      <div class="detail-stat">
        <span class="detail-stat-value">↓${day.descent_m}</span>
        <span class="detail-stat-label">m D-</span>
      </div>
    `;

    // Contenu détaillé
    document.getElementById('day-detail-info').innerHTML = this._buildDetailHTML(day);

    // Affiche le panel
    document.getElementById('day-detail-panel').classList.remove('hidden');

    // Trace GPX : fichier dédié si spécifié, sinon trace principale
    // Dans les deux cas, on découpe par from_coords/to_coords si disponibles
    let trace = null;
    const sourceTrace = day.gpx_file
      ? state.traces.find(t => t.filename === day.gpx_file) ?? null
      : state.traces.find(t => t.filename === 'GR5-GTA-route-only-614km.gpx') ?? null;

    if (sourceTrace) {
      if (day.from_coords && day.to_coords) {
        const sliced = GPXModule.sliceByCoords(sourceTrace, day.from_coords, day.to_coords);
        if (sliced.points.length > 1) trace = sliced;
      } else {
        trace = sourceTrace;
      }
    }

    // Bouton téléchargement par jour
    const btnDl = document.getElementById('btn-download-day');
    btnDl.onclick = () => trace && OfflineModule.downloadForDay(trace.points,
      `J${day.day} ${day.from}→${day.to}`);

    // Stats GPX (calculées depuis la trace)
    const gpxEl = document.getElementById('day-gpx-stats');
    if (trace && trace.points.length > 1) {
      gpxEl.textContent = `GPX : ${trace.distance} km · ↑${trace.ascent} m`;
      gpxEl.classList.remove('hidden');
    } else {
      gpxEl.classList.add('hidden');
    }

    // Callback hover élévation → marker sur mini-carte
    ElevationModule.onHover = (pt) => this._updateHoverMarker(pt);

    if (trace && trace.points.length > 1) {
      ElevationModule.draw(trace);
      this._updateDayMap(trace, day);
    } else {
      this._updateDayMap(null, day);
    }
  },

  _buildDetailHTML(day) {
    const parts = [];
    if (day.description) parts.push(`<p class="day-description">${day.description}</p>`);
    if (day.terrain)     parts.push(`<p class="day-terrain">${day.terrain}</p>`);
    if (day.food_drink)  parts.push(`
      <div class="day-section">
        <div class="day-section-label">Ravitaillement</div>
        <p class="day-section-text">${day.food_drink}</p>
      </div>`);
    if (day.accommodation?.length) parts.push(`
      <div class="day-section">
        <div class="day-section-label">Hébergements</div>
        <ul class="day-accom-list">
          ${day.accommodation.map(a => `
            <li class="day-accom-item">
              <span class="accom-dot accom-${a.type ?? 'other'}"></span>
              <span class="accom-name">${a.name}</span>
              <span class="accom-location">— ${a.location}</span>
              ${a.off_route ? '<span class="accom-off-route">hors-itinéraire</span>' : ''}
            </li>`).join('')}
        </ul>
      </div>`);
    if (day.notes) parts.push(`<div class="day-notes">${day.notes}</div>`);
    return parts.join('');
  },

  _updateDayMap(trace, day) {
    if (!this._dayMap) {
      this._dayMap = L.map('day-map', {
        zoomControl: false,
        attributionControl: false,
      });
      new (getFallbackTileLayer())(CONFIG.tileUrl, { maxZoom: CONFIG.maxZoom, crossOrigin: 'anonymous' }).addTo(this._dayMap);
      L.control.zoom({ position: 'topright' }).addTo(this._dayMap);
      L.control.scale({ position: 'bottomright', imperial: false }).addTo(this._dayMap);

      // Clic → coordonnées GPS discrètes
      const dayCoords = document.getElementById('day-map-coords');
      this._dayMap.on('click', (e) => {
        const { lat, lng } = e.latlng;
        dayCoords.textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
        dayCoords.classList.remove('hidden');
      });
    }

    // Nettoyer les anciens markers et la polyline
    if (this._dayPolyline) {
      this._dayMap.removeLayer(this._dayPolyline);
      this._dayPolyline = null;
    }
    if (this._dayMarkers) {
      this._dayMarkers.forEach(m => this._dayMap.removeLayer(m));
    }
    this._dayMarkers = [];

    if (!trace) return;

    const latlngs = trace.points.map(p => [p.lat, p.lon]);
    this._dayPolyline = L.polyline(latlngs, {
      color: CONFIG.gpxColor,
      weight: 4,
      opacity: 0.9,
    }).addTo(this._dayMap);

    // Correspond si h.day matche ce jour (ex: h.day=2 → jours 2A et 2B ; h.day="1B" → jour 1B seulement)
    const matchesDay = h => {
      if (h.day == null) return false;
      if (typeof h.day === 'number') return h.day === day.day;
      if (typeof h.day === 'string') {
        const num = parseInt(h.day);
        const variant = h.day.replace(/[0-9]/g, '');
        return num === day.day && (!variant || variant === (day.variant ?? ''));
      }
      return false;
    };

    const bounds = this._dayPolyline.getBounds().pad(0.15);
    const shownIds = new Set();
    state.hebergements
      .filter(h => matchesDay(h) || bounds.contains([h.lat, h.lon]))
      .forEach(h => {
        shownIds.add(h.id);
        this._dayMarkers.push(this._addRefugeMarker(h));
      });

    setTimeout(() => {
      this._dayMap.invalidateSize();
      this._dayMap.fitBounds(this._dayPolyline.getBounds(), { padding: [24, 24] });
    }, 50);
  },

  _addRefugeMarker(h) {
    const unverif = h.coords_verified === false
      ? `<br><span style="color:#ffa726;font-size:11px">⚠ Position approximative</span>` : '';
    const marker = L.marker([h.lat, h.lon], { icon: makeHebergeIcon(h) })
      .bindPopup(`<strong>${h.nom}</strong><br>${h.altitude} m${h.off_route ? '<br><em>hors-itinéraire</em>' : ''}${unverif}<br><a href="#" onclick="event.preventDefault();HebModule.showAndScrollTo('${h.id}')" style="color:#81c784;font-size:12px">Voir la fiche →</a>`, { maxWidth: 180 })
      .addTo(this._dayMap);
    return marker;
  },

  _hoverMarker: null,

  _updateHoverMarker(pt) {
    if (!this._dayMap) return;
    if (pt) {
      if (!this._hoverMarker) {
        this._hoverMarker = L.circleMarker([pt.lat, pt.lon], {
          radius: 7,
          color: '#fff',
          weight: 2,
          fillColor: '#43a047',
          fillOpacity: 1,
          interactive: false,
        }).addTo(this._dayMap);
      } else {
        this._hoverMarker.setLatLng([pt.lat, pt.lon]);
      }
    } else {
      if (this._hoverMarker) {
        this._dayMap.removeLayer(this._hoverMarker);
        this._hoverMarker = null;
      }
    }
  },

  _formatTime(hours) {
    const h = Math.floor(hours);
    const m = Math.round((hours - h) * 60);
    return m > 0 ? `${h}h${String(m).padStart(2, '0')}` : `${h}h`;
  },
};

/* ═══════════════════════════════════════════════════════════════
   MODULE HÉBERGEMENTS
   ══════════════════════════════════════════════════════════════ */
const HebModule = {

  render(hebs) {
    const container = document.getElementById('heb-list');
    if (!hebs?.length) {
      container.innerHTML = '<p class="placeholder">Aucun hébergement enregistré.</p>';
      return;
    }

    const sorted = [...hebs].sort((a, b) => (a.km_depuis_thonon ?? 9999) - (b.km_depuis_thonon ?? 9999));

    container.innerHTML = sorted.map(h => this._buildCard(h)).join('');
  },

  _buildCard(h) {
    const typeLabel = { refuge: 'Refuge', gite: 'Gîte', hotel: 'Hôtel' }[h.type] ?? h.type ?? '?';
    const unverif = h.coords_verified === false
      ? `<span class="heb-badge heb-badge-warn">⚠ coords approx.</span>` : '';
    const offRoute = h.off_route
      ? `<span class="heb-badge heb-badge-off">hors-itinéraire</span>` : '';
    const dayRef = h.stage != null
      ? `<span class="heb-meta">Stage ${h.stage}${h.day != null ? ` · Jour ${h.day}` : ''}</span>` : '';

    const rows = [];
    if (h.altitude)             rows.push(`<tr><td>Altitude</td><td>${h.altitude} m</td></tr>`);
    if (h.km_depuis_thonon != null) rows.push(`<tr><td>Depuis Thonon</td><td>${h.km_depuis_thonon} km${h.km_hors_route != null ? ` <span class="heb-dim">(+ ${h.km_hors_route} km hors-itinéraire)</span>` : ''}</td></tr>`);
    if (h.places)               rows.push(`<tr><td>Places</td><td>${h.places}</td></tr>`);
    if (h.ouverture)            rows.push(`<tr><td>Ouverture</td><td>${h.ouverture}</td></tr>`);
    if (h.bivouac != null)      rows.push(`<tr><td>Bivouac</td><td>${h.bivouac ? 'Toléré' : 'Non toléré'}</td></tr>`);
    if (h.demi_pension != null) rows.push(`<tr><td>Demi-pension</td><td>${h.tarif_demi_pension != null ? h.tarif_demi_pension + ' €' : 'oui'}</td></tr>`);
    if (h.tarif_repas_soir != null) rows.push(`<tr><td>Repas du soir</td><td>${h.tarif_repas_soir} €</td></tr>`);
    if (h.telephone)            rows.push(`<tr><td>Téléphone</td><td><a href="tel:${h.telephone}">${h.telephone}</a>${h.telephone_resa ? ` · résa : <a href="tel:${h.telephone_resa}">${h.telephone_resa}</a>` : ''}</td></tr>`);
    if (h.email)                rows.push(`<tr><td>Email</td><td><a href="mailto:${h.email}">${h.email}</a></td></tr>`);
    if (h.site_web)             rows.push(`<tr><td>Site web</td><td><a href="${h.site_web}" target="_blank" rel="noopener">Ouvrir ↗</a></td></tr>`);
    if (h.notes)                rows.push(`<tr><td colspan="2" class="heb-notes">${h.notes}</td></tr>`);

    return `
      <div class="heb-card" id="heb-${h.id}">
        <div class="heb-card-header">
          <div class="heb-name">${h.nom}</div>
          <div class="heb-badges">
            <span class="heb-badge heb-badge-type heb-type-${h.type ?? 'other'}">${typeLabel}</span>
            ${offRoute}${unverif}
          </div>
          ${dayRef}
        </div>
        ${rows.length ? `<table class="heb-table">${rows.join('')}</table>` : ''}
      </div>`;
  },

  showAndScrollTo(id) {
    UIModule.switchTab('hebergements');
    setTimeout(() => {
      const el = document.getElementById(`heb-${id}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        el.classList.add('heb-highlight');
        setTimeout(() => el.classList.remove('heb-highlight'), 1500);
      }
    }, 50);
  },
};

/* ═══════════════════════════════════════════════════════════════
   MODULE DONNÉES STATIQUES
   ══════════════════════════════════════════════════════════════ */
const DataModule = {
  async loadAll() {
    const [heberge, ravitail] = await Promise.allSettled([
      this._fetchJSON('./data/hebergements.json'),
      this._fetchJSON('./data/ravitaillement.json'),
    ]);

    if (heberge.status === 'fulfilled') {
      state.hebergements = heberge.value;
      console.log(`[Data] ${state.hebergements.length} hébergements chargés.`);
      MapModule.showHebergements(state.hebergements);
      HebModule.render(state.hebergements);
    }
    if (ravitail.status === 'fulfilled') {
      state.ravitaillement = ravitail.value;
      this._renderRavitaillement(state.ravitaillement);
      console.log(`[Data] ${state.ravitaillement.length} points ravitaillement chargés.`);
    }

    // Charge l'index des traces GPX disponibles
    await this._loadTracesIndex();

    // Charge les étapes Dillon
    await StagesModule.loadAll();
  },

  async _fetchJSON(url) {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
    return res.json();
  },

  _renderRavitaillement(items) {
    const list  = document.getElementById('ravitail-list');
    const ph    = document.getElementById('ravitail-placeholder');
    ph?.remove();

    if (items.length === 0) {
      list.innerHTML = '<p class="placeholder">Aucune donnée de ravitaillement.</p>';
      return;
    }

    items.forEach(item => {
      const div = document.createElement('div');
      div.className = 'ravitail-item';
      const tags = (item.services ?? [])
        .map(s => `<span class="ravitail-tag ${s}">${s.replace('_', ' ')}</span>`)
        .join('');
      div.innerHTML = `
        <h3>${item.nom} <small style="font-weight:400;color:var(--on-surface-dim)">— km ${item.km_depuis_thonon}</small></h3>
        <div class="ravitail-tags">${tags}</div>
      `;
      list.appendChild(div);
    });
  },

  // Charge data/traces/index.json si disponible (liste des GPX préconfigurés)
  async _loadTracesIndex() {
    try {
      const index = await this._fetchJSON('./data/traces/index.json');
      for (const entry of index) {
        await GPXModule.loadFromURL(`./data/traces/${entry.filename}`, { variant: entry.variant });
      }
      if (state.traces.length > 0) GPXModule.showAll();
    } catch {
      // Pas d'index, c'est normal au démarrage sans traces
    }
  },
};

/* ═══════════════════════════════════════════════════════════════
   UTILITAIRES GÉOGRAPHIQUES
   ══════════════════════════════════════════════════════════════ */
const Geo = {
  // Distance haversine entre deux points {lat, lon} → km
  haversine(a, b) {
    const R    = 6371;
    const dLat = this._rad(b.lat - a.lat);
    const dLon = this._rad(b.lon - a.lon);
    const h    = Math.sin(dLat / 2) ** 2
               + Math.cos(this._rad(a.lat)) * Math.cos(this._rad(b.lat))
               * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.asin(Math.sqrt(h));
  },

  // Distance totale d'un tableau de points → km (1 décimale)
  traceDistance(points) {
    let d = 0;
    for (let i = 1; i < points.length; i++) d += this.haversine(points[i - 1], points[i]);
    return Math.round(d * 10) / 10;
  },

  // Dénivelé positif cumulé → mètres entiers
  traceAscent(points) {
    let a = 0;
    for (let i = 1; i < points.length; i++) {
      const diff = points[i].ele - points[i - 1].ele;
      if (diff > 0) a += diff;
    }
    return Math.round(a);
  },

  _rad(deg) { return deg * Math.PI / 180; },
};

/* ═══════════════════════════════════════════════════════════════
   MODULE TÉLÉCHARGEMENT HORS-LIGNE
   ══════════════════════════════════════════════════════════════ */
const OfflineModule = {

  // Convertit lat/lon → [x, y] tuile Web Mercator
  _tileXY(lat, lon, z) {
    const n      = 1 << z;
    const x      = Math.floor((lon + 180) / 360 * n);
    const latRad = lat * Math.PI / 180;
    const y      = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
    return [x, y];
  },

  _tile(lat, lon, z) {
    const [x, y] = this._tileXY(lat, lon, z);
    return `${z}/${x}/${y}`;
  },

  _tileUrl(key) {
    const [z, x, y] = key.split('/');
    return `https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0`
      + `&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2&STYLE=normal&FORMAT=image%2Fpng`
      + `&TILEMATRIXSET=PM&TILEMATRIX=${z}&TILEROW=${y}&TILECOL=${x}`;
  },

  // Pour les fichiers GPX : fetch simple via SW (Cache Storage)
  async _fetchBatch(urls, onProgress) {
    const BATCH = 4;
    for (let i = 0; i < urls.length; i += BATCH) {
      await Promise.allSettled(urls.slice(i, i + BATCH).map(u => fetch(u).catch(() => {})));
      onProgress(Math.min(i + BATCH, urls.length), urls.length);
    }
  },

  // Télécharge une liste de clés tuiles manquantes dans IndexedDB
  async _downloadTiles(keys, onProgress) {
    const BATCH = 4;
    const DELAY = 50;
    const failed = [];

    for (let i = 0; i < keys.length; i += BATCH) {
      const batch = keys.slice(i, i + BATCH);
      await Promise.allSettled(batch.map(async key => {
        try {
          const r = await fetch(this._tileUrl(key));
          if (!r.ok) throw r.status;
          await TileDB.put(key, await r.blob());
        } catch { failed.push(key); }
      }));
      onProgress(Math.min(i + BATCH, keys.length), keys.length, failed.length);
      if (i + BATCH < keys.length) await new Promise(r => setTimeout(r, DELAY));
    }

    if (failed.length > 0) {
      UIModule.toast(`Retry de ${failed.length} tuiles échouées…`);
      await new Promise(r => setTimeout(r, 1000));
      for (let i = 0; i < failed.length; i += BATCH) {
        await Promise.allSettled(failed.slice(i, i + BATCH).map(async key => {
          try {
            const r = await fetch(this._tileUrl(key));
            if (!r.ok) throw r.status;
            await TileDB.put(key, await r.blob());
          } catch {}
        }));
        await new Promise(r => setTimeout(r, DELAY));
      }
    }
  },

  // Calcule les clés tuiles pour un tableau de points GPX
  _tileKeysForPoints(points) {
    const ZOOMS = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18];
    const keys  = new Set();
    for (let i = 0; i < points.length; i++) {
      for (const z of ZOOMS) {
        const [x1, y1] = this._tileXY(points[i].lat, points[i].lon, z);
        const [x2, y2] = i + 1 < points.length
          ? this._tileXY(points[i + 1].lat, points[i + 1].lon, z)
          : [x1, y1];
        const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1), 1);
        for (let s = 0; s <= steps; s++) {
          const t = s / steps;
          const x = Math.round(x1 + (x2 - x1) * t);
          const y = Math.round(y1 + (y2 - y1) * t);
          const buf = z >= 17 ? 1 : 0;
          for (let dx = -buf; dx <= buf; dx++)
            for (let dy = -buf; dy <= buf; dy++)
              keys.add(`${z}/${x + dx}/${y + dy}`);
        }
      }
    }
    return [...keys];
  },

  // Télécharge les tuiles d'une seule journée (depuis le panneau jour)
  async downloadForDay(points, label) {
    const btn = document.getElementById('btn-download-day');
    btn.disabled = true;

    let wakeLock = null;
    if ('wakeLock' in navigator) {
      try { wakeLock = await navigator.wakeLock.request('screen'); } catch {}
    }

    try {
      const keys = this._tileKeysForPoints(points);
      await this._downloadMissing(keys, label);
      UIModule.toast(`✓ ${label} disponible hors-ligne.`);
    } catch (err) {
      UIModule.toast('Erreur lors du téléchargement.', 'error');
    } finally {
      btn.disabled = false;
      if (wakeLock) wakeLock.release();
    }
  },

  // Point d'entrée commun : filtre les clés déjà en cache puis télécharge
  async _downloadMissing(allKeys, label) {
    UIModule.toast(`${label} — vérification du cache…`);
    const cached  = await TileDB.getAllKeys();
    const missing = allKeys.filter(k => !cached.has(k));

    if (missing.length === 0) {
      UIModule.toast(`✓ ${label} — déjà complet en cache.`);
      return 0;
    }

    UIModule.toast(`${label} — ${missing.length} tuiles à télécharger…`);
    await this._downloadTiles(missing, (done, tot, fails) => {
      if (done % 50 === 0 || done === tot) {
        const failStr = fails > 0 ? ` (${fails} échecs)` : '';
        UIModule.toast(`${label} ${done}/${tot}${failStr}`);
      }
    });
    return missing.length;
  },

  async prefetchAll() {
    const btn = document.getElementById('btn-offline-download');
    btn.disabled = true;
    btn.classList.add('map-btn-downloading');

    // Empêcher l'écran de s'éteindre pendant le téléchargement
    let wakeLock = null;
    if ('wakeLock' in navigator) {
      try { wakeLock = await navigator.wakeLock.request('screen'); } catch {}
    }

    try {
      // ── 1. Fichiers GPX (les JSON sont déjà précachés par le SW à l'install) ──
      UIModule.toast('Téléchargement des traces GPX…');
      const gpxUrls = state.traces.map(t => `./data/traces/${t.filename}`);
      await this._fetchBatch(gpxUrls, () => {});

      // ── 2. Tuiles de carte (toutes les traces, tous les zooms) ──────────────
      const allPoints = state.traces.flatMap(t => t.points);
      const allKeys   = this._tileKeysForPoints(allPoints);
      await this._downloadMissing(allKeys, 'Tuiles');

      const total = await TileDB.count();
      UIModule.toast(`✓ ${total} tuiles en IndexedDB — carte disponible hors-ligne.`);
      btn.classList.remove('map-btn-downloading');
      btn.classList.add('map-btn-done');
      btn.title = 'Données hors-ligne à jour';

    } catch (err) {
      console.error('[Offline]', err);
      UIModule.toast('Erreur lors du téléchargement hors-ligne.', 'error');
      btn.classList.remove('map-btn-downloading');
    } finally {
      btn.disabled = false;
      if (wakeLock) wakeLock.release();
    }
  },
};

/* ═══════════════════════════════════════════════════════════════
   MODULE RECHERCHE
   ══════════════════════════════════════════════════════════════ */
const SearchModule = {
  _results: [],
  _geoTimer: null,
  _marker: null,

  init() {
    const input    = document.getElementById('search-input');
    const dropdown = document.getElementById('search-dropdown');

    input.addEventListener('input', () => {
      clearTimeout(this._geoTimer);
      const q = input.value.trim();
      if (!q) { dropdown.classList.add('hidden'); return; }

      const coords = this._parseCoords(q);
      if (coords) {
        this._show([{ kind: 'coords', lat: coords.lat, lon: coords.lon,
          label: `📍 ${coords.lat.toFixed(5)}, ${coords.lon.toFixed(5)}` }]);
        return;
      }

      const ql = q.toLowerCase();
      const hebs = state.hebergements
        .filter(h => h.nom.toLowerCase().includes(ql))
        .slice(0, 5)
        .map(h => ({ kind: 'heb', h,
          label: h.nom,
          sub: `${h.type} · km ${h.km_depuis_thonon}` }));

      this._show(hebs);

      if (q.length >= 3) {
        this._geoTimer = setTimeout(() => this._geocode(q, hebs), 600);
      }
    });

    input.addEventListener('keydown', e => {
      if (e.key === 'Escape') { input.value = ''; dropdown.classList.add('hidden'); input.blur(); }
    });

    document.addEventListener('click', e => {
      if (!e.target.closest('#search-container')) dropdown.classList.add('hidden');
    });
  },

  _parseCoords(q) {
    const m = q.match(/^(-?\d{1,3}\.?\d*)[,\s]+(-?\d{1,3}\.?\d*)$/);
    if (!m) return null;
    const lat = parseFloat(m[1]), lon = parseFloat(m[2]);
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    return { lat, lon };
  },

  async _geocode(q, existing) {
    try {
      const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=3&countrycodes=fr,ch,it&accept-language=fr`;
      const res  = await fetch(url);
      const data = await res.json();
      const geo  = data.map(r => ({
        kind: 'geo',
        lat: parseFloat(r.lat),
        lon: parseFloat(r.lon),
        label: r.display_name.split(',').slice(0, 2).join(',').trim(),
      }));
      this._show([...existing, ...geo]);
    } catch { /* hors ligne */ }
  },

  _show(results) {
    this._results = results;
    const dropdown = document.getElementById('search-dropdown');
    if (!results.length) { dropdown.classList.add('hidden'); return; }
    dropdown.innerHTML = results.map((r, i) => `
      <div class="search-result" data-i="${i}">
        <span class="search-result-label search-result-type-${r.kind}">${r.label}</span>
        ${r.sub ? `<span class="search-result-sub">${r.sub}</span>` : ''}
      </div>`).join('');
    dropdown.classList.remove('hidden');
    dropdown.querySelectorAll('.search-result').forEach(el =>
      el.addEventListener('click', () => this._select(this._results[+el.dataset.i]))
    );
  },

  _select(r) {
    const input = document.getElementById('search-input');
    document.getElementById('search-dropdown').classList.add('hidden');
    input.value = '';
    input.blur();
    UIModule.switchTab('carte');

    if (r.kind === 'heb') {
      MapModule.centerOn(r.h.lat, r.h.lon, 15);
      state.hebergeMarkers.eachLayer(l => {
        const ll = l.getLatLng();
        if (Math.abs(ll.lat - r.h.lat) < 0.0001 && Math.abs(ll.lng - r.h.lon) < 0.0001)
          l.openPopup();
      });
      return;
    }

    MapModule.centerOn(r.lat, r.lon, 14);
    if (this._marker) state.map.removeLayer(this._marker);
    this._marker = L.marker([r.lat, r.lon])
      .addTo(state.map)
      .bindPopup(r.label)
      .openPopup();
  },
};

/* ═══════════════════════════════════════════════════════════════
   MODULE UI
   ══════════════════════════════════════════════════════════════ */
const UIModule = {
  init() {
    // ── Navigation onglets ─────────────────────────────────
    document.querySelectorAll('.nav-tab').forEach(tab =>
      tab.addEventListener('click', () => this.switchTab(tab.dataset.tab))
    );

    // ── Centrer sur GPS ────────────────────────────────────
    document.getElementById('btn-center-gps').addEventListener('click', () => {
      if (state.currentPosition) {
        MapModule.centerOn(state.currentPosition.lat, state.currentPosition.lon);
      } else {
        GPSModule.start();
        this.toast('Recherche de votre position…');
      }
    });

    // ── Fermer panneau détail étape ────────────────────────
    document.getElementById('btn-close-day').addEventListener('click', () => {
      document.getElementById('day-detail-panel').classList.add('hidden');
    });

    // ── Ouvrir/fermer modal GPX ────────────────────────────
    document.getElementById('btn-open-gpx').addEventListener('click', () =>
      document.getElementById('gpx-modal').classList.remove('hidden')
    );
    document.getElementById('btn-close-gpx-modal').addEventListener('click', () =>
      document.getElementById('gpx-modal').classList.add('hidden')
    );
    document.getElementById('btn-gpx-all').addEventListener('click', () => GPXModule.showAll());
    document.getElementById('btn-gpx-none').addEventListener('click', () => GPXModule.hideAll());
    document.getElementById('gpx-modal').addEventListener('click', e => {
      if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden');
    });

    // ── Téléchargement hors-ligne ──────────────────────────
    document.getElementById('btn-offline-download').addEventListener('click', () => {
      if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
        OfflineModule.prefetchAll();
      } else {
        UIModule.toast('Service Worker non actif — ouvrez l\'app avec une connexion, puis réessayez.', 'error');
      }
    });

    // ── Toggle hébergements ────────────────────────────────
    document.getElementById('btn-toggle-heberge').addEventListener('click', () => {
      state.hebergementsVisible = !state.hebergementsVisible;
      if (state.hebergementsVisible) {
        state.hebergeMarkers.addTo(state.map);
      } else {
        state.map.removeLayer(state.hebergeMarkers);
      }
      document.getElementById('btn-toggle-heberge')
        .classList.toggle('map-btn-active', state.hebergementsVisible);
    });

    // ── Import fichier GPX ─────────────────────────────────
    document.getElementById('gpx-file-input').addEventListener('change', async e => {
      const files = Array.from(e.target.files);
      let loaded = 0;
      for (const file of files) {
        try {
          await GPXModule.loadFromFile(file);
          loaded++;
        } catch (err) {
          this.toast(`Erreur GPX — ${file.name}`, 'error');
          console.error(err);
        }
      }
      if (loaded > 0) {
        GPXModule.showAll();
        this.toast(`${loaded} trace(s) importée(s).`);
      }
      e.target.value = '';  // permet de recharger le même fichier
    });
  },

  // ── Changement d'onglet ─────────────────────────────────

  switchTab(tabName) {
    document.querySelectorAll('.nav-tab').forEach(t =>
      t.classList.toggle('active', t.dataset.tab === tabName)
    );

    document.getElementById('map-controls').classList.toggle('hidden', tabName !== 'carte');
    document.getElementById('day-detail-panel').classList.add('hidden');

    const panel = document.getElementById('content-panel');

    if (tabName === 'carte') {
      panel.classList.add('hidden');
      document.getElementById('search-container').classList.remove('hidden');
      setTimeout(() => state.map.invalidateSize(), 50);
      return;
    }

    document.getElementById('search-container').classList.add('hidden');

    panel.classList.remove('hidden');
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.getElementById(`tab-${tabName}`)?.classList.add('active');

    // Chargements à la demande
    if (tabName === 'meteo') this._onOpenMeteo();
  },

  _onOpenMeteo() {
    if (!state.currentPosition) {
      document.getElementById('meteo-placeholder').textContent =
        'Position GPS requise pour charger la météo.';
      return;
    }
    const { lat, lon } = state.currentPosition;
    WeatherModule.fetch(lat, lon);
  },

  // ── Méthodes utilitaires ────────────────────────────────

  setGPSStatus(status) {
    const dot = document.getElementById('gps-status');
    dot.className = `status-dot status-${status}`;
    dot.title = { off: 'GPS inactif', searching: 'Recherche GPS…', on: 'GPS actif' }[status];
  },

  addGPXItem(trace, index) {
    const list = document.getElementById('gpx-list');
    document.getElementById('gpx-empty-msg')?.remove();

    // Trouve ou crée le groupe correspondant au variant
    const LABELS = { commun: 'Tronc commun', menton: '→ Menton (GR52)', nice: '→ Nice (GR5)', gr55: 'GR55 — Variante Vanoise', gr5e: 'GR5E — Chemin du Petit Bonheur' };
    const ORDER  = { commun: 0, nice: 1, menton: 2, gr55: 3, gr5e: 4 };
    const variant = trace.variant ?? 'other';
    const groupId = `gpx-group-${variant}`;

    let group = document.getElementById(groupId);
    if (!group) {
      group = document.createElement('div');
      group.className = 'gpx-group';
      group.id = groupId;
      group.innerHTML = `<div class="gpx-group-header">${LABELS[variant] ?? 'Importés'}</div>`;

      const myOrder = ORDER[variant] ?? 99;
      const sibling = [...list.querySelectorAll('.gpx-group')]
        .find(g => (ORDER[g.id.replace('gpx-group-', '')] ?? 99) > myOrder);
      list.insertBefore(group, sibling ?? null);
    }

    const item = document.createElement('label');
    item.className = 'gpx-item';
    item.dataset.index = index;
    item.innerHTML = `
      <input type="checkbox" class="gpx-checkbox" data-index="${index}">
      <span class="gpx-color-dot" style="background:${trace.color}"></span>
      <div class="gpx-item-info">
        <div class="gpx-item-name">${trace.name}</div>
        <div class="gpx-item-meta">${trace.distance} km&nbsp;&nbsp;+${trace.ascent} m</div>
      </div>
    `;
    item.querySelector('.gpx-checkbox').addEventListener('change', e => {
      GPXModule.setVisible(index, e.target.checked);
    });
    group.appendChild(item);
  },

  updateGPXList() {
    document.querySelectorAll('.gpx-checkbox').forEach(cb => {
      cb.checked = state.visibleTraces.has(+cb.dataset.index);
    });
  },

  toast(message, type = 'info') {
    document.getElementById('toast')?.remove();
    const el = document.createElement('div');
    el.id = 'toast';
    el.textContent = message;
    el.style.background = type === 'error' ? '#b71c1c' : '#2e7d32';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  },
};

/* ═══════════════════════════════════════════════════════════════
   POINT D'ENTRÉE
   ══════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', async () => {
  console.log('[GR5] DOMContentLoaded');

  // Enregistrement du Service Worker (désactivé sur localhost pour simplifier le dev)
  const isLocalDev = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  console.log('[GR5] isLocalDev :', isLocalDev);
  if ('serviceWorker' in navigator && !isLocalDev) {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js');
      console.log('[SW] Enregistré, scope :', reg.scope);
    } catch (err) {
      console.warn('[SW] Échec enregistrement :', err);
    }
  }

  try {
    MapModule.init();
    console.log('[GR5] MapModule OK');
  } catch (e) { console.error('[GR5] MapModule ERREUR :', e); }

  // La carte est l'onglet actif au démarrage
  document.getElementById('search-container').classList.remove('hidden');

  try {
    UIModule.init();
    console.log('[GR5] UIModule OK');
  } catch (e) { console.error('[GR5] UIModule ERREUR :', e); }

  // Demander au navigateur de ne pas purger le cache sans permission explicite
  if ('storage' in navigator && 'persist' in navigator.storage) {
    const granted = await navigator.storage.persist();
    UIModule.toast(granted
      ? '✓ Stockage hors-ligne persistant accordé.'
      : '⚠ Stockage hors-ligne non persistant — iOS peut effacer le cache.');
  }

  try {
    SearchModule.init();
    console.log('[GR5] SearchModule OK');
  } catch (e) { console.error('[GR5] SearchModule ERREUR :', e); }

  try {
    GPSModule.start();
    console.log('[GR5] GPSModule démarré');
  } catch (e) { console.error('[GR5] GPSModule ERREUR :', e); }

  try {
    await DataModule.loadAll();
    console.log('[GR5] DataModule OK');
  } catch (e) { console.error('[GR5] DataModule ERREUR :', e); }

  console.log('[GR5] Init complète.');
});
