import { createHeatmapRaster, slideLineTwice } from '../www.openstreetmap.org/slide/algorithm.js';
import { loadSlideTiles } from '../www.openstreetmap.org/slide/tiles.js';

export async function slideSegment(locations, layer, signal, onProgress) {
  const source = {
    url: ([x, y, z]) => layer.template
      .replace('{x}', x).replace('{y}', y).replace('{z}', z),
  };
  try {
    const { tiles, bounds, zoom } = await loadSlideTiles(locations, source, signal);
    onProgress('Following the heatmap trail...');
    const raster = createHeatmapRaster(tiles, zoom, bounds);
    const result = await slideLineTwice(locations, raster, {
      fixedIndices: [0, 1], signal,
    });
    return { coordinates: result.map(({ loc }) => loc) };
  } catch (error) {
    if (error.code !== 'SLIDE_NO_SIGNAL') throw error;
    return { coordinates: locations, message: 'No heatmap trail found; segment stays straight.' };
  }
}

export function installBrouterSlide(routing, map, getLayer, fit = slideSegment) {
  if (routing.__stravaHeatmapSlide) return routing.__stravaHeatmapSlide;
  const L = window.L;
  const straightButton = document.querySelector('#mdi-vector-line')?.closest('button');
  if (!straightButton) throw new Error('BRouter straight-line button was not found.');
  const states = new WeakMap();
  const pending = new Set();
  let reversing;
  let enabled = false;
  const status = document.createElement('div');
  status.className = 'strava-slide-status leaflet-bar';
  const statusControl = L.control({ position: 'topright' });
  statusControl.onAdd = () => status;
  statusControl.addTo(map);
  const showStatus = (message, error = false) => {
    status.textContent = message;
    status.hidden = !message;
    status.setAttribute('role', error ? 'alert' : 'status');
  };
  showStatus('');
  const button = L.easyButton({
    states: [{
      stateName: 'slide',
      icon: '<span class="strava-slide-icon" aria-hidden="true"></span>',
      title: 'Toggle Slide mode (S key)',
      onClick: () => toggle(),
    }],
  });
  straightButton.after(button.button);
  button.button.setAttribute('aria-label', 'Toggle Slide mode (S key)');
  const toggleBeeline = routing.toggleBeelineDrawing;
  const syncButton = () => {
    button.button.classList.toggle('strava-slide-active', enabled);
    button.button.setAttribute('aria-pressed', String(enabled));
    if (routing.isDrawing()) button.enable();
    else button.disable();
  };
  const toggle = () => {
    if (!routing.isDrawing()) return;
    enabled = !enabled;
    if (routing._draw._beelineMode !== enabled) toggleBeeline.call(routing);
    syncButton();
    showStatus(enabled ? 'Slide mode: click the next point to follow the selected heatmap.' : '');
  };
  map.on('routing:draw-start routing:draw-end', syncButton);
  syncButton();
  routing.toggleBeelineDrawing = function (...args) {
    // B, or the native straight-line button, switches out of Slide.
    const wasSlide = enabled;
    enabled = false;
    syncButton();
    showStatus('');
    return wasSlide ? this._draw._beelineMode : toggleBeeline.apply(this, args);
  };
  const keydown = (event) => {
    if ((event.key?.toLowerCase() !== 's' && event.keyCode !== 83) ||
        !window.BR.Util.keyboardShortcutsAllowed(event) ||
        event.target?.isContentEditable ||
        event.target?.closest('input, textarea, select, [contenteditable="true"]')) return;
    event.preventDefault();
    toggle();
  };
  document.addEventListener('keydown', keydown);
  const click = routing._draw._onMouseClick;
  routing._draw._onMouseClick = function (event) {
    if (!this._hidden) {
      const last = this._parent.getLast();
      if (last) {
        const modifier = this.options.shortcut.draw.beelineModifierName;
        const slide = enabled && !(modifier && event.originalEvent?.[modifier]);
        states.get(last)?.controller?.abort();
        states.set(last, { slide });
      }
    }
    return click.call(this, event);
  };
  // The draw handler registered its click callback before this integration loaded.
  map.off('click', click, routing._draw);
  if (routing.isDrawing()) map.on('click', routing._draw._onMouseClick, routing._draw);

  const addWaypoint = routing.addWaypoint;
  routing.addWaypoint = function (point, beeline, prev, next, cb) {
    const saved = reversing?.get(point);
    if (saved || (prev && next && states.get(prev)?.slide)) {
      if (point instanceof L.LatLng) {
        point = L.marker(point, { title: this.options.tooltips.waypoint, draggable: true });
      }
      states.set(point, saved ?? { slide: true });
    }
    return addWaypoint.call(this, point, beeline, prev, next, cb);
  };
  const locationsOf = (a, b) => [a, b].map((marker) => {
    const point = marker.getLatLng();
    return [point.lng, point.lat];
  });
  const signature = (a, b) => JSON.stringify(locationsOf(a, b));
  const current = (a, b) => !a._removed && !b._removed &&
    a._routing.nextMarker === b && routing._waypoints.hasLayer(a) &&
    routing._waypoints.hasLayer(b);
  const routeSegment = routing._routeSegment;
  routing._routeSegment = function (a, b, cb) {
    const state = a && states.get(a);
    if (!a || !b || !state?.slide || !a._routing.beeline) {
      return routeSegment.call(this, a, b, cb);
    }
    const layer = getLayer();
    const key = signature(a, b);
    if (state.end === b && state.key === key && state.template === layer?.template &&
        state.coordinates) return cb();
    state.controller?.abort();
    const controller = new AbortController();
    state.controller = controller;
    pending.add(controller);
    Object.assign(state, { end: b, key, template: layer?.template, coordinates: undefined });
    showStatus(layer ? `Slide: loading ${layer.name}...` : 'Choose a Strava heatmap overlay before using Slide.', !layer);
    const valid = () => !controller.signal.aborted && current(a, b) &&
      state.key === signature(a, b) && state.template === getLayer()?.template &&
      states.get(a) === state;
    Promise.resolve().then(() => {
      if (!layer) throw new Error('Choose a Strava heatmap overlay before using Slide.');
      return fit(locationsOf(a, b), layer, controller.signal, (message) => {
        if (!controller.signal.aborted) showStatus(message);
      });
    }).then((result) => {
      if (!valid()) return cb('aborted');
      state.coordinates = result.coordinates;
      showStatus(result.message ?? `Slide: following ${layer.name}.`);
      cb();
    }, (error) => {
      if (!valid()) return cb('aborted');
      console.warn('[StravaHeatmapExt] BRouter Slide failed.', error);
      state.coordinates = locationsOf(a, b);
      showStatus(`Slide: ${error.message} Segment stays straight.`, true);
      cb();
    }).finally(() => {
      pending.delete(controller);
      if (state.controller === controller) state.controller = undefined;
    });
  };
  const updateLayer = routing._updateLayer;
  routing._updateLayer = function (a, b, layer) {
    const state = states.get(a);
    if (a._routing.beeline && state?.slide && state.end === b &&
        state.key === signature(a, b) && state.coordinates &&
        state.template === getLayer()?.template) {
      const points = layer.getLatLngs();
      const coordinates = [
        [points[0].lng, points[0].lat],
        ...state.coordinates.slice(1, -1),
        [points.at(-1).lng, points.at(-1).lat],
      ];
      layer.setLatLngs(coordinates.map(([lng, lat]) => L.latLng(lat, lng)));
      layer.feature.geometry.coordinates = coordinates;
      const distance = layer.getLatLngs().slice(1).reduce((total, point, i) =>
        total + this._distance(layer.getLatLngs()[i], point), 0);
      layer.feature.properties['track-length'] = distance;
      layer.feature.properties.messages[1][3] = distance;
      for (const point of layer.getLatLngs()) {
        point.feature = window.BR.TrackEdges.getFeature(layer.feature.properties.messages[1]);
        point.message = layer.feature.properties.messages[1];
      }
    }
    return updateLayer.call(this, a, b, layer);
  };
  const reverse = routing.reverse;
  routing.reverse = function (...args) {
    reversing = new Map();
    this._eachSegment((a, b) => {
      if (states.get(a)?.slide) reversing.set(b.getLatLng(), { slide: true });
    });
    try {
      return reverse.apply(this, args);
    } finally {
      reversing = undefined;
    }
  };
  const clear = routing.clear;
  routing.clear = function (...args) {
    for (const controller of pending) controller.abort();
    showStatus('');
    return clear.apply(this, args);
  };
  const invalidate = () => {
    for (const controller of pending) controller.abort();
    routing._eachSegment((a, b) => {
      if (!states.get(a)?.slide) return;
      states.get(a).coordinates = undefined;
      routing._routeSegment(a, b, (err) => {
        routing._updateBeelines();
        routing.fire('routing:rerouteSegmentEnd', { err });
      });
    });
  };
  routing.__stravaHeatmapSlide = { invalidate };
  return routing.__stravaHeatmapSlide;
}
