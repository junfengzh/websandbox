// websandbox map: page script. The server renders every page (sidebar text is the source of
// truth); this script draws the MapLibre map from the #map-data JSON of the current page and
// turns sidebar links/forms into in-place navigation (fetch + swap #sidebar + pushState), so
// the map stays alive while searching and routing. Without it the site still works (plain
// links and GET forms), minus the map canvas.
(function () {
  'use strict';
  const DEFAULT = { zoom: 15, lat: 40.4443, lon: -79.9436 };
  const $ = (s, r) => (r || document).querySelector(s);
  let map = null, markers = [], popup = null, navSeq = 0, routeSeq = 0;

  const mapData = () => { try { return JSON.parse(($('#map-data') || {}).textContent || '{}'); } catch (e) { return {}; } };
  const whenReady = (fn) => { if (!map) return; if (map.loaded() || map.isStyleLoaded()) fn(); else map.once('load', fn); };
  const centerHeader = () => {
    if (!map) return {};
    const c = map.getCenter();
    return { 'X-Map-Center': `${c.lng.toFixed(5)},${c.lat.toFixed(5)}` };
  };

  // ------------------------------------------------------------------ map
  function initMap() {
    if (!window.maplibregl || !$('#map')) return false;
    map = new maplibregl.Map({
      container: 'map', style: '/style.json', center: [DEFAULT.lon, DEFAULT.lat], zoom: DEFAULT.zoom,
      hash: 'map', attributionControl: false, maxZoom: 19,
    });
    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    map.addControl(new maplibregl.AttributionControl({ compact: false }), 'bottom-right');
    map.on('click', onMapClick);
    window.wsbMap = map; // for tests / debugging
    return true;
  }

  function clearMap() {
    for (const m of markers) m.remove();
    markers = [];
    if (popup) { popup.remove(); popup = null; }
    if (map && map.getLayer('route-line')) { map.removeLayer('route-line'); map.removeLayer('route-casing'); }
    if (map && map.getSource('route')) map.removeSource('route');
  }

  function addMarker(m) {
    let mk;
    if (m.n) {
      const el = document.createElement('div');
      el.className = 'marker-num';
      el.textContent = m.n;
      el.title = m.label || '';
      if (m.href) el.addEventListener('click', (e) => { e.stopPropagation(); navigate(m.href); });
      mk = new maplibregl.Marker({ element: el });
    } else {
      mk = new maplibregl.Marker({ color: m.kind === 'from' ? '#2e9e44' : m.kind === 'to' ? '#d33' : m.kind === 'point' ? '#555' : '#3b78d8' });
    }
    mk.setLngLat([m.lon, m.lat]);
    if (m.label) mk.getElement().setAttribute('title', m.label);
    mk.addTo(map);
    markers.push(mk);
  }

  function apply(d, fit) {
    if (!map) return;
    clearMap();
    for (const m of d.markers || []) addMarker(m);
    if (d.route) drawRoute(d.route, fit);
    if (!fit) return;
    if (d.route && d.route.bbox) return fitBox(d.route.bbox);
    if (d.bbox) return fitBox(d.bbox, d.view && d.view.zoom);
    const ms = d.markers || [];
    if (d.fit && ms.length > 1) {
      let a = Infinity, b = Infinity, c = -Infinity, e = -Infinity;
      for (const m of ms) { a = Math.min(a, m.lon); b = Math.min(b, m.lat); c = Math.max(c, m.lon); e = Math.max(e, m.lat); }
      return fitBox([a, b, c, e]);
    }
    if (d.view) return map.jumpTo({ center: [d.view.lon, d.view.lat], zoom: d.view.zoom });
    if (ms.length === 1) return map.jumpTo({ center: [ms[0].lon, ms[0].lat], zoom: Math.max(map.getZoom(), 16) });
  }
  function fitBox(bb, maxZoom) {
    const pad = Math.min(60, Math.round(Math.min(map.getContainer().clientWidth, map.getContainer().clientHeight) / 8));
    if (bb[0] === bb[2] && bb[1] === bb[3]) return map.jumpTo({ center: [bb[0], bb[1]], zoom: maxZoom || 17 });
    map.fitBounds([[bb[0], bb[1]], [bb[2], bb[3]]], { padding: pad, maxZoom: maxZoom || 18, animate: false });
  }

  async function drawRoute(r) {
    const seq = ++routeSeq;
    let gj;
    try { gj = await (await fetch(r.url)).json(); } catch (e) { return; }
    if (seq !== routeSeq || !gj || gj.code !== 'Ok') return;
    whenReady(() => {
      if (seq !== routeSeq) return;
      const data = { type: 'Feature', properties: {}, geometry: gj.geometry };
      if (map.getSource('route')) { map.getSource('route').setData(data); return; }
      map.addSource('route', { type: 'geojson', data });
      map.addLayer({ id: 'route-casing', type: 'line', source: 'route', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#fff', 'line-width': 9, 'line-opacity': 0.9 } });
      map.addLayer({ id: 'route-line', type: 'line', source: 'route', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#0b65c2', 'line-width': 5, 'line-opacity': 0.85 } });
      document.body.dataset.routeDrawn = '1';
    });
  }

  // click on the map: OSM-like context menu
  function onMapClick(e) {
    const t = e.originalEvent && e.originalEvent.target;
    if (t && t.closest && t.closest('.maplibregl-marker, .maplibregl-popup')) return;
    const lat = e.lngLat.lat, lon = e.lngLat.lng;
    const ll = `${lat.toFixed(5)},${lon.toFixed(5)}`;
    const zoom = Math.round(map.getZoom());
    const df = $('#directions_form');
    const val = (n) => (df && df.elements[n] ? df.elements[n].value : '');
    const dir = (side) => {
      const u = new URLSearchParams();
      u.set('engine', val('engine') || 'fossgis_osrm_car');
      if (side === 'from') {
        u.set('route', `${ll};${val('to_ll')}`);
        if (val('to_ll') && val('to')) u.set('to', val('to'));
      } else {
        u.set('route', `${val('from_ll')};${ll}`);
        if (val('from_ll') && val('from')) u.set('from', val('from'));
      }
      return '/directions?' + u.toString().replace(/%2C/g, ',').replace(/%3B/g, ';');
    };
    const html = `<div class="map-popup" role="menu" aria-label="Map actions">
      <div class="coords">${lat.toFixed(5)}, ${lon.toFixed(5)}</div>
      <a role="menuitem" href="${dir('from')}">Directions from here</a>
      <a role="menuitem" href="${dir('to')}">Directions to here</a>
      <a role="menuitem" href="/search?lat=${lat.toFixed(5)}&amp;lon=${lon.toFixed(5)}&amp;zoom=${zoom}">Show address</a>
      <a role="menuitem" href="/query?lat=${lat.toFixed(5)}&amp;lon=${lon.toFixed(5)}">Query features</a>
      <a role="menuitem" href="#" data-action="center">Centre map here</a></div>`;
    if (popup) popup.remove();
    popup = new maplibregl.Popup({ closeOnClick: true, maxWidth: '240px' }).setLngLat(e.lngLat).setHTML(html).addTo(map);
    const c = popup.getElement().querySelector('[data-action=center]');
    c.addEventListener('click', (ev) => { ev.preventDefault(); map.easeTo({ center: e.lngLat }); popup.remove(); });
  }

  // ------------------------------------------------------------------ in-place navigation
  function setLoading(on, text) {
    document.body.classList.toggle('loading', on);
    const l = $('#sidebar_loader');
    if (!l) return;
    l.hidden = !on;
    if (text) $('.loader-text', l).textContent = text;
  }

  async function navigate(url, opts) {
    opts = opts || {};
    const u = new URL(url, location.href);
    if (u.origin !== location.origin || !map) { location.href = u.href; return; }
    const seq = ++navSeq;
    if (popup) { popup.remove(); popup = null; }
    setLoading(true, u.pathname === '/directions' && /route/.test(u.search) ? 'Calculating route…' : 'Loading…');
    let res, html;
    try {
      res = await fetch(u.pathname + u.search, { headers: { Accept: 'text/html', ...centerHeader() } });
      html = await res.text();
    } catch (e) { location.href = u.href; return; }
    if (seq !== navSeq) return;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const ns = doc.getElementById('sidebar');
    if (!ns) { location.href = u.href; return; }
    $('#sidebar').innerHTML = ns.innerHTML;
    document.title = doc.title;
    const fin = new URL(res.url || u.href);
    const target = fin.pathname + fin.search + location.hash;
    if (opts.push === false) history.replaceState({}, '', target); else history.pushState({}, '', target);
    for (const a of document.querySelectorAll('#header nav.primary a')) {
      if (a.getAttribute('href') === fin.pathname) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    }
    setLoading(false);
    bindSidebar();
    apply(mapData(), true);
    const h = $('#sidebar_content h2');
    if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
  }

  function skip(a, e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return true;
    if (a.target && a.target !== '_self') return true;
    if (a.hasAttribute('download')) return true;
    const href = a.getAttribute('href') || '';
    if (!href || href[0] === '#' || /^(mailto|tel|javascript):/i.test(href)) return true;
    const u = new URL(href, location.href);
    if (u.origin !== location.origin) return true;
    return /^\/(api|vendor|tiles|static|_kit|__rl|glyphs|sprites)\//.test(u.pathname);
  }
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a || !map || skip(a, e)) return;
    e.preventDefault();
    navigate(a.href);
  });
  document.addEventListener('submit', (e) => {
    const f = e.target;
    if (!map || (f.method || 'get').toLowerCase() !== 'get') return;
    e.preventDefault();
    const u = new URL(f.getAttribute('action') || location.pathname, location.href);
    u.search = new URLSearchParams(new FormData(f)).toString();
    navigate(u.href);
  });
  window.addEventListener('popstate', () => navigate(location.href, { push: false }));

  // ------------------------------------------------------------------ sidebar widgets
  function autocomplete(input) {
    const list = input.list;
    if (!list || input.dataset.ac) return;
    input.dataset.ac = '1';
    let timer = null, last = '';
    input.addEventListener('input', () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 3 || q === last) return;
      timer = setTimeout(async () => {
        last = q;
        try {
          const r = await (await fetch('/api/autocomplete?q=' + encodeURIComponent(q), { headers: centerHeader() })).json();
          if (input.value.trim() !== q) return;
          list.innerHTML = '';
          for (const x of r) { const o = document.createElement('option'); o.value = x.display_name; o.label = x.type; list.appendChild(o); }
        } catch (e) { /* ignore */ }
      }, 250);
    });
  }
  function bindSidebar() {
    for (const i of document.querySelectorAll('#sidebar input[list]')) autocomplete(i);
    const df = $('#directions_form');
    if (df) {
      const sel = df.elements.engine;
      sel.addEventListener('change', () => {
        if (df.elements.route_from.value.trim() && df.elements.route_to.value.trim()) {
          if (df.requestSubmit) df.requestSubmit(); else df.submit();
        }
      });
    }
  }

  // ------------------------------------------------------------------ start
  function start() {
    const hadHash = /(^#|&)map=/.test(location.hash);
    bindSidebar();
    if (!initMap()) return;
    history.replaceState({}, '', location.href);
    whenReady(() => {});
    apply(mapData(), !hadHash);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
