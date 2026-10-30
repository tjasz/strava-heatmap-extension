import { loadSlideOptions } from './snap-network.js';
import { project, unproject } from '../www.openstreetmap.org/slide/algorithm.js';

const SOURCE = 'strava';
const NORMAL = { stroke: '#F0F000', 'stroke-opacity': 0.4, 'stroke-width': 7 };
const HOVER = { stroke: '#FFFF00', 'stroke-opacity': 0.8, 'stroke-width': 10 };
const BEGIN = 'Click anywhere to begin. Strava will suggest paths within a 1 km grid.';

export function installCalTopoSnap(manager, getLayer, propose = loadSlideOptions) {
  const auto = manager.autoDrawOverlay;
  const select = auto?.dropMenu?.container?.[0];
  if (!select || !['fetch', 'add', 'select', 'unselect', 'click', 'clear'].every(
    (name) => typeof auto[name] === 'function')) return null;
  if (manager.__stravaHeatmapSnap) return manager.__stravaHeatmapSnap;

  auto.data[SOURCE] = { tiles: {}, features: {}, nodes: {} };
  auto.dropMenu.addItem('Strava', SOURCE);
  select.style.width = 'auto';
  const status = document.createElement('span');
  status.className = 'strava-heatmap-snap-status';
  status.setAttribute('role', 'status');
  select.after(status);
  const showStatus = (message, error = false) => {
    status.setAttribute('role', error ? 'alert' : 'status');
    const layerName = getLayer()?.name;
    status.textContent = message && layerName
      ? `Snapping to ${layerName}. ${message}`
      : message;
  };
  let anchors = [];
  let controller;
  let work;
  let request;
  let optionIds = [];
  let hovered;
  let draft;
  let preview;
  let clickedAnchor;
  let committing = false;
  const map = manager.map;
  const clearPreview = () => {
    if (hovered && auto.mapObjs[hovered]) map.setStyle(auto.mapObjs[hovered], NORMAL);
    hovered = undefined;
    if (preview) {
      map.removeOverlay(preview);
      if (auto.selected === preview) auto.selected = undefined;
      preview = undefined;
    }
    if (draft) manager.setOverride(false);
    draft = undefined;
    if (auto.source === SOURCE) {
      auto.coordinates = undefined;
      auto.id = undefined;
    }
  };
  const clearOptions = () => {
    controller?.abort();
    controller = undefined;
    request = undefined;
    clearTimeout(auto.unselectTimeout);
    auto.unselectTimeout = undefined;
    clearPreview();
    for (const id of optionIds) {
      if (auto.mapObjs[id]) map.removeOverlay(auto.mapObjs[id]);
      delete auto.mapObjs[id];
    }
    optionIds = [];
    auto.data[SOURCE] = { tiles: {}, features: {}, nodes: {} };
    if (auto.source === SOURCE) {
      Object.assign(auto, auto.data[SOURCE]);
      auto.reference = undefined;
      auto.routing = undefined;
      auto.backupReference = undefined;
    }
  };
  const markAnchor = () => {
    // Native double-click finishing removes the moving cursor when snap exists.
    if (anchors.length) auto.reference = { coordinates: anchors.at(-1), snap: {} };
  };
  const signature = () => JSON.stringify([anchors.at(-1), map.getZoom() >= 15, getLayer()?.template]);
  const generate = () => {
    clearOptions();
    if (auto.source !== SOURCE || !auto.map) return;
    if (!anchors.length) {
      showStatus(BEGIN);
      return;
    }
    markAnchor();
    if (map.getZoom() < 15) {
      showStatus('Zoom in to level 15 or higher for Slide options. Click anywhere to draw a straight segment.');
      return;
    }
    const layer = getLayer();
    if (!layer) {
      showStatus('Choose a Strava heatmap layer first.', true);
      return;
    }
    const anchor = anchors.at(-1).slice();
    const polyline = manager.polyline, handler = manager.handler;
    const current = new AbortController();
    controller = current;
    request = signature();
    showStatus('Finding Slide options...');
    const progress = (message) => {
      if (!current.signal.aborted) showStatus(message);
    };
    work = Promise.resolve().then(() => {
      if (!current.signal.aborted) return propose(anchor, layer, current.signal, progress);
    }).then((options) => {
      if (current.signal.aborted || auto.source !== SOURCE || !auto.map ||
          manager.polyline !== polyline || manager.handler !== handler || request !== signature()) return;
      for (const [i, option] of options.entries()) {
        const id = `strava-option-${i}`;
        auto.features[id] = {
          type: 'Feature', properties: { score: option.score },
          geometry: { type: 'LineString', coordinates: option.coordinates },
        };
        optionIds.push(id);
        auto.add(id);
        map.setStyle(auto.mapObjs[id], NORMAL);
      }
      markAnchor();
      showStatus(options.length
        ? 'Hover a yellow Slide option to preview it, then click to confirm. Click elsewhere for a straight segment.'
        : 'No Slide options found here. Click anywhere to add a straight segment.');
    }).catch((error) => {
      if (current.signal.aborted) return;
      request = undefined;
      console.warn('[StravaHeatmapExt] CalTopo Slide options failed.', error);
      showStatus(`Strava: ${error.message} You can still click to add a straight segment.`, true);
    }).finally(() => {
      if (controller === current) controller = undefined;
    });
    return work;
  };
  const invalidate = (reload = true) => {
    clearOptions();
    showStatus('');
    if (reload) return generate();
  };
  // CalTopo changes source before clearing the previous source's graph.
  select.addEventListener('change', () => {
    if (auto.source === SOURCE) clearOptions();
  }, true);
  select.addEventListener('change', () => {
    anchors = [];
    clearOptions();
    if (auto.source !== SOURCE) return showStatus('');
    if (manager.polyline) {
      const coordinates = map.getCoordinates(manager.polyline);
      if (coordinates.length >= 2) anchors.push(coordinates.at(-2).slice());
    }
    generate();
  });
  const fetch = auto.fetch;
  auto.fetch = function (...args) {
    if (this.source !== SOURCE) return fetch.apply(this, args);
    if (!this.map) return;
    if (!anchors.length) return showStatus(BEGIN);
    if (request !== signature()) return generate();
  };
  const postFetch = auto.postFetch;
  auto.postFetch = function (...args) {
    // Responses from a previous native source must not enter this source's graph.
    if (this.source !== SOURCE) return postFetch.apply(this, args);
  };
  const clear = auto.clear;
  auto.clear = function (force, ...args) {
    if (this.source !== SOURCE) return clear.call(this, force, ...args);
    if (force || map.getZoom() < 15) {
      if (this.features !== this.data[SOURCE].features) clear.call(this, true, ...args);
      clearOptions();
      markAnchor();
    }
  };
  const click = auto.click;
  auto.click = function (point) {
    if (this.source !== SOURCE) return click.call(this, point);
    if (!point) return;
    anchors.push((clickedAnchor ?? point).slice());
    clickedAnchor = undefined;
    return generate();
  };
  const backup = auto.backup;
  auto.backup = function (...args) {
    if (this.source !== SOURCE) return backup.apply(this, args);
  };
  const closest = (point, id) => {
    const coordinates = auto.features[id]?.geometry.coordinates;
    if (!coordinates) return;
    const target = project(point);
    let best;
    for (let i = 1; i < coordinates.length; i++) {
      const a = project(coordinates[i - 1]), b = project(coordinates[i]);
      const dx = b[0] - a[0], dy = b[1] - a[1], length = dx * dx + dy * dy;
      const fraction = length ? Math.max(0, Math.min(1,
        ((target[0] - a[0]) * dx + (target[1] - a[1]) * dy) / length)) : 0;
      const at = [a[0] + fraction * dx, a[1] + fraction * dy];
      const distance = Math.hypot(target[0] - at[0], target[1] - at[1]);
      if (!best || distance < best.distance) {
        best = { distance, coordinates: [...coordinates.slice(0, i), unproject(at)] };
      }
    }
    return best;
  };
  const selectLine = auto.select;
  auto.select = function (point, id) {
    if (this.source !== SOURCE) return selectLine.call(this, point, id);
    // Native touch clicks reselect before consuming the already prepared path.
    if (committing) return;
    clearTimeout(this.unselectTimeout);
    this.unselectTimeout = undefined;
    clearPreview();
    const match = closest(point, id);
    if (!match) return;
    hovered = id;
    draft = match.coordinates;
    this.id = id;
    this.coordinates = draft;
    manager.setOverride(true);
    map.setStyle(this.mapObjs[id], HOVER);
    preview = map.addOverlay({ type: 'LineString', coordinates: draft }, {
      stroke: this.stroke, 'stroke-opacity': 1, 'stroke-width': 5, 'z-index': 5,
      clickable: false, interactive: false,
    });
    this.selected = preview;
  };
  const unselect = auto.unselect;
  auto.unselect = function (...args) {
    if (this.source !== SOURCE) return unselect.apply(this, args);
    clearPreview();
  };
  const handleClick = manager.handleClick;
  manager.handleClick = function (event) {
    if (auto.source !== SOURCE || !['polyline', 'polygon'].includes(this.handler?.mode) ||
        this.ignoreNextClick || event.target?.closest('form, button, .leaflet-control')) {
      return handleClick.call(this, event);
    }
    if ((event.detail ?? event.originalEvent?.detail) > 1) return;
    const offset = this.$div.offset();
    if (!offset) {
      showStatus('Could not locate the CalTopo drawing canvas.', true);
      return;
    }
    const point = map.fromContainerPixel([event.pageX - offset.left, event.pageY - offset.top]);
    let match;
    if (!event.shiftKey) for (const id of optionIds) {
      const candidate = closest(point, id);
      if (candidate && candidate.distance <= 10 * 2 ** (15 - map.getZoom()) &&
          (!match || candidate.distance < match.distance)) match = candidate;
    }
    clearPreview();
    if (match) {
      clickedAnchor = match.coordinates.at(-1).slice();
      // Supply points after the anchor with the normal moving cursor restored;
      // native addPath then records the entire proposal as one undo action.
      auto.coordinates = match.coordinates.slice(1);
      this.lastAdditionPoint = false;
    }
    committing = true;
    try {
      return handleClick.call(this, event);
    } finally {
      committing = false;
      clickedAnchor = undefined;
    }
  };
  const undo = manager.undo;
  manager.undo = function (...args) {
    if (auto.source !== SOURCE) return undo.apply(this, args);
    const remaining = anchors.slice(0, -1);
    clearOptions();
    const result = undo.apply(this, args);
    anchors = this.polyline ? remaining : [];
    generate();
    return result;
  };
  const doubleClick = manager.handleDblClick;
  manager.handleDblClick = function (...args) {
    if (auto.source === SOURCE) clearPreview();
    return doubleClick.apply(this, args);
  };
  for (const name of ['cancel', 'release']) {
    const original = manager[name];
    manager[name] = function (...args) {
      if (auto.source === SOURCE) {
        anchors = [];
        clearOptions();
        showStatus('');
      }
      return original.apply(this, args);
    };
  }
  const finish = manager.finish;
  manager.finish = async function (...args) {
    if (auto.source !== SOURCE) return finish.apply(this, args);
    clearOptions();
    const result = await finish.apply(this, args);
    if (this.handler && this.polyline) generate();
    return result;
  };
  if (auto.source === SOURCE) showStatus(BEGIN);
  manager.__stravaHeatmapSnap = { invalidate, get ready() { return work ?? Promise.resolve(); } };
  return manager.__stravaHeatmapSnap;
}
