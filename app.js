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
};

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

    L.tileLayer(CONFIG.tileUrl, {
      attribution: CONFIG.tileAttribution,
      maxZoom: CONFIG.maxZoom,
    }).addTo(state.map);

    L.control.zoom({ position: 'topleft' }).addTo(state.map);
    state.hebergeMarkers = L.layerGroup().addTo(state.map);
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
  draw(trace, canvasId = 'day-elevation-canvas') {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx    = canvas.getContext('2d');

    // Redimensionnement HiDPI
    const W = canvas.offsetWidth;
    const H = canvas.offsetHeight;
    const dpr = window.devicePixelRatio || 1;
    canvas.width  = W * dpr;
    canvas.height = H * dpr;
    ctx.scale(dpr, dpr);

    const pts    = trace.points;
    const eles   = pts.map(p => p.ele);
    const minEle = Math.min(...eles);
    const maxEle = Math.max(...eles);
    const range  = maxEle - minEle || 1;

    const pad = { t: 8, r: 8, b: 24, l: 40 };
    const cW  = W - pad.l - pad.r;
    const cH  = H - pad.t - pad.b;

    ctx.clearRect(0, 0, W, H);

    // Remplissage sous la courbe
    const grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + cH);
    grad.addColorStop(0, 'rgba(46,125,50,0.6)');
    grad.addColorStop(1, 'rgba(46,125,50,0.05)');
    ctx.fillStyle = grad;
    ctx.beginPath();

    pts.forEach((p, i) => {
      const x = pad.l + (i / (pts.length - 1)) * cW;
      const y = pad.t + cH - ((p.ele - minEle) / range) * cH;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.lineTo(pad.l + cW, pad.t + cH);
    ctx.lineTo(pad.l, pad.t + cH);
    ctx.closePath();
    ctx.fill();

    // Courbe
    ctx.strokeStyle = '#43a047';
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = pad.l + (i / (pts.length - 1)) * cW;
      const y = pad.t + cH - ((p.ele - minEle) / range) * cH;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Étiquettes altitude
    ctx.fillStyle = '#888';
    ctx.font = `${10 * dpr / dpr}px -apple-system, sans-serif`;
    ctx.textAlign = 'right';
    ctx.fillText(`${Math.round(maxEle)} m`, pad.l - 4, pad.t + 6);
    ctx.fillText(`${Math.round(minEle)} m`, pad.l - 4, pad.t + cH);

    // Indicateur position GPS sur le profil
    if (state.currentPosition) {
      this.drawPositionMarker(ctx, trace, pad, cW, cH, minEle, range);
    }
  },

  drawPositionMarker(ctx, trace, pad, cW, cH, minEle, range) {
    const pos = state.currentPosition;
    // Trouve le point de la trace le plus proche de la position GPS
    let minDist = Infinity;
    let closestIdx = 0;
    trace.points.forEach((p, i) => {
      const d = Geo.haversine(pos, p);
      if (d < minDist) { minDist = d; closestIdx = i; }
    });

    const pts = trace.points;
    const x = pad.l + (closestIdx / (pts.length - 1)) * cW;
    const y = pad.t + cH - ((pts[closestIdx].ele - minEle) / range) * cH;

    ctx.fillStyle = '#1976d2';
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fill();
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
    for (let i = 1; i <= 6; i++) {
      try {
        const r = await fetch(`./data/stages/stage_${i}.json`);
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
      stage.days.forEach(day => group.appendChild(this._buildDayCard(day)));
      container.appendChild(group);
    });
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

  _openDetail(day) {
    // En-tête
    document.getElementById('day-detail-title').textContent =
      `Jour ${day.day} — ${day.from} → ${day.to}`;

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

    // Trace GPX slicée
    const mainTrace = state.traces.find(t => t.filename === 'GR5-GTA-route-only-614km.gpx');
    if (mainTrace && day.from_coords && day.to_coords) {
      const sliced = GPXModule.sliceByCoords(mainTrace, day.from_coords, day.to_coords);
      if (sliced.points.length > 1) {
        ElevationModule.draw(sliced);
        this._updateDayMap(sliced);
      }
    } else {
      this._updateDayMap(null);
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

  _updateDayMap(trace) {
    if (!this._dayMap) {
      this._dayMap = L.map('day-map', {
        zoomControl: false,
        attributionControl: false,
      });
      L.tileLayer(CONFIG.tileUrl, { maxZoom: CONFIG.maxZoom }).addTo(this._dayMap);
      L.control.zoom({ position: 'topright' }).addTo(this._dayMap);
    }

    if (this._dayPolyline) {
      this._dayMap.removeLayer(this._dayPolyline);
      this._dayPolyline = null;
    }

    if (!trace) return;

    const latlngs = trace.points.map(p => [p.lat, p.lon]);
    this._dayPolyline = L.polyline(latlngs, {
      color: CONFIG.gpxColor,
      weight: 4,
      opacity: 0.9,
    }).addTo(this._dayMap);

    // Refuges sur la mini-carte
    const bounds = this._dayPolyline.getBounds().pad(0.15);
    state.hebergements
      .filter(h => h.type === 'refuge' && bounds.contains([h.lat, h.lon]))
      .forEach(h => {
        const unverif = h.coords_verified === false
          ? `<br><span style="color:#ffa726;font-size:11px">⚠ Position approximative</span>` : '';
        L.marker([h.lat, h.lon], { icon: makeHebergeIcon(h) })
          .bindPopup(`<strong>${h.nom}</strong><br>${h.altitude} m${h.off_route ? '<br><em>hors-itinéraire</em>' : ''}${unverif}`, { maxWidth: 180 })
          .addTo(this._dayMap);
      });

    setTimeout(() => {
      this._dayMap.invalidateSize();
      this._dayMap.fitBounds(this._dayPolyline.getBounds(), { padding: [24, 24] });
    }, 50);
  },

  _formatTime(hours) {
    const h = Math.floor(hours);
    const m = Math.round((hours - h) * 60);
    return m > 0 ? `${h}h${String(m).padStart(2, '0')}` : `${h}h`;
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
    const res = await fetch(url);
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

    const panel = document.getElementById('content-panel');

    if (tabName === 'carte') {
      panel.classList.add('hidden');
      setTimeout(() => state.map.invalidateSize(), 50);
      return;
    }

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
    const LABELS = { commun: 'Tronc commun', menton: '→ Menton (GR52)', nice: '→ Nice (GR5)' };
    const ORDER  = { commun: 0, nice: 1, menton: 2 };
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

  try {
    UIModule.init();
    console.log('[GR5] UIModule OK');
  } catch (e) { console.error('[GR5] UIModule ERREUR :', e); }

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
