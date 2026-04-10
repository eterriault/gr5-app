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
const CONFIG = {
  // Carte : centré sur le milieu du GR5 (secteur Modane)
  mapCenter: [45.20, 6.68],
  mapZoom: 9,
  tileUrl: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
  tileAttribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
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

  traces: [],                 // [{ name, filename, points, distance, ascent, layer }]
  activeTraceIndex: -1,

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
      crossOrigin: true,       // requis pour que le SW intercepte les tuiles
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

    const icons = { refuge: '🏔', gite: '🏠', camping: '⛺', hotel: '🏨' };

    hebergements.forEach(h => {
      const emoji  = icons[h.type] ?? '🏠';
      const icon   = L.divIcon({
        className: '',
        html: `<div style="
          font-size:18px; line-height:1;
          filter: drop-shadow(0 1px 3px rgba(0,0,0,0.6));
        ">${emoji}</div>`,
        iconSize:   [22, 22],
        iconAnchor: [11, 11],
        popupAnchor:[0, -12],
      });

      const ouverture = h.ouverture ? `<br><small>${h.ouverture}</small>` : '';
      const tel       = h.telephone
        ? `<br><a href="tel:${h.telephone.replace(/\s/g,'')}" style="color:#81c784">${h.telephone}</a>`
        : '';
      const dp        = h.demi_pension ? ' · demi-pension' : '';

      L.marker([h.lat, h.lon], { icon })
        .bindPopup(`
          <strong>${h.nom}</strong><br>
          ${h.altitude} m · ${h.places} places${dp}
          ${tel}${ouverture}
          ${h.notes ? `<br><em style="font-size:11px">${h.notes}</em>` : ''}
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

  async loadFromURL(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
    const xml   = await res.text();
    const trace = this.parse(xml);
    trace.filename = url.split('/').pop();
    this._register(trace);
    return trace;
  },

  // ── Enregistrement + layer Leaflet ─────────────────────────

  _register(trace) {
    const latlngs = trace.points.map(p => [p.lat, p.lon]);
    trace.layer = L.polyline(latlngs, {
      color:   CONFIG.gpxColor,
      weight:  CONFIG.gpxWeight,
      opacity: CONFIG.gpxOpacity,
    });

    const index = state.traces.push(trace) - 1;
    UIModule.addGPXItem(trace, index);
  },

  // ── Activation d'une trace ──────────────────────────────────

  setActive(index) {
    // Retire toutes les traces de la carte
    state.traces.forEach(t => state.map.removeLayer(t.layer));

    const trace = state.traces[index];
    if (!trace) return;

    trace.layer.addTo(state.map);
    state.map.fitBounds(trace.layer.getBounds(), { padding: [20, 20] });
    state.activeTraceIndex = index;

    document.getElementById('section-name').textContent = trace.name;
    UIModule.updateGPXList();
    ElevationModule.draw(trace);
    StatsModule.update(trace);
  },

  getActive() {
    return state.traces[state.activeTraceIndex] ?? null;
  },
};

/* ═══════════════════════════════════════════════════════════════
   MODULE PROFIL ALTIMÉTRIQUE
   ══════════════════════════════════════════════════════════════ */
const ElevationModule = {
  draw(trace) {
    const canvas = document.getElementById('elevation-canvas');
    const ctx    = canvas.getContext('2d');

    canvas.classList.remove('hidden');

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

    // Essaie de charger l'index des traces GPX disponibles
    await this._loadTracesIndex();
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
        await GPXModule.loadFromURL(`./data/traces/${entry.filename}`);
      }
      // Active automatiquement la première trace
      if (state.traces.length > 0 && state.activeTraceIndex === -1) {
        GPXModule.setActive(0);
      }
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

    // ── Ouvrir/fermer modal GPX ────────────────────────────
    document.getElementById('btn-open-gpx').addEventListener('click', () =>
      document.getElementById('gpx-modal').classList.remove('hidden')
    );
    document.getElementById('btn-close-gpx-modal').addEventListener('click', () =>
      document.getElementById('gpx-modal').classList.add('hidden')
    );
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
        // Active la première trace si aucune n'est active
        if (state.activeTraceIndex === -1) GPXModule.setActive(0);
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
    if (tabName === 'etapes' && state.activeTraceIndex !== -1) {
      ElevationModule.draw(GPXModule.getActive());
    }
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
    document.getElementById('gpx-empty-msg')?.remove();
    const list = document.getElementById('gpx-list');
    const item = document.createElement('div');
    item.className = 'gpx-item';
    item.dataset.index = index;
    item.innerHTML = `
      <div class="gpx-item-name">${trace.name}</div>
      <div class="gpx-item-meta">${trace.distance} km&nbsp;&nbsp;+${trace.ascent} m</div>
    `;
    item.addEventListener('click', () => {
      GPXModule.setActive(index);
      document.getElementById('gpx-modal').classList.add('hidden');
    });
    list.appendChild(item);
  },

  updateGPXList() {
    document.querySelectorAll('.gpx-item').forEach(item => {
      item.classList.toggle('active', +item.dataset.index === state.activeTraceIndex);
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
