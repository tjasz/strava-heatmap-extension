import { loadHeatmapNetwork } from './snap-network.js';

const SOURCE = 'strava';
const NORMAL = { stroke: '#F0F000', 'stroke-opacity': 0.4, 'stroke-width': 7 };
const HOVER = { stroke: '#FFFF00', 'stroke-opacity': 0.8, 'stroke-width': 10 };

export function installCalTopoSnap(manager, getLayer, loadNetwork = loadHeatmapNetwork) {
  const auto = manager.autoDrawOverlay;
  const select = auto?.dropMenu?.container?.[0];
  if (!select || !['fetch', 'postFetch', 'add', 'select', 'unselect'].every(
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
    status.textContent = message;
  };
  let controller = new AbortController();
  let template;
  let queue = [];
  let running = 0;
  let hovered;
  let failed = false;
  const invalidate = (reload = true) => {
    controller.abort();
    controller = new AbortController();
    queue = [];
    template = undefined;
    hovered = undefined;
    failed = false;
    showStatus('');
    if (auto.source !== SOURCE) return;
    auto.unselect();
    auto.coordinates = undefined;
    auto.clear(true);
    auto.data[SOURCE] = { tiles: {}, features: {}, nodes: {} };
    Object.assign(auto, auto.data[SOURCE]);
    auto.rebuildGlobalNodeGrid();
    if (reload && auto.map) auto.fetch();
  };
  select.addEventListener('change', () => invalidate());

  const fetch = auto.fetch;
  const pump = () => {
    while (running < 2 && queue.length) {
      const job = queue.shift();
      running++;
      const { signal, layer, x, y, key } = job;
      Promise.resolve().then(() => {
        if (signal.aborted) return;
        return loadNetwork(x, y, auto.targetZoom, layer, signal);
      }).then((features) => {
        if (signal.aborted || auto.source !== SOURCE ||
            getLayer()?.template !== layer.template || !auto.map) return;
        auto.postFetch(key, features);
        if (!failed && !queue.length && running === 1) showStatus('');
      }).catch((error) => {
        if (signal.aborted) return;
        failed = true;
        delete auto.data[SOURCE].tiles[key];
        console.warn('[StravaHeatmapExt] CalTopo snap network failed.', error);
        showStatus(`Strava: ${error.message}`, true);
      }).finally(() => {
        running--;
        pump();
      });
    }
  };
  auto.fetch = function (...args) {
    if (this.source !== SOURCE) return fetch.apply(this, args);
    if (!this.map) return;
    const layer = getLayer();
    if (template && template !== layer?.template) return invalidate();
    if (!layer) return showStatus('Choose a Strava heatmap layer first.', true);
    template = layer.template;
    if (this.map.getZoom() < this.zoomThreshold) {
      showStatus('Zoom in to see Strava snap lines.');
      return;
    }
    const bounds = this.getTileBounds(this.getMapBounds());
    const count = (bounds[1][0] - bounds[0][0] + 1) * (bounds[0][1] - bounds[1][1] + 1);
    if (count > 16) return showStatus('Zoom in to load Strava snap lines.', true);
    for (let x = bounds[0][0]; x <= bounds[1][0]; x++) {
      for (let y = bounds[1][1]; y <= bounds[0][1]; y++) {
        const key = `${x}-${y}`;
        if (this.tiles[key]) continue;
        this.tiles[key] = true;
        queue.push({ x, y, key, layer, signal: controller.signal });
      }
    }
    if (queue.length && running === 0) {
      failed = false;
      showStatus('Loading Strava snap lines...');
    }
    this.draw();
    pump();
  };

  const add = auto.add;
  auto.add = function (id) {
    const result = add.call(this, id);
    if (this.source === SOURCE && this.mapObjs[id]) this.map.setStyle(this.mapObjs[id], NORMAL);
    return result;
  };
  const selectLine = auto.select;
  const unselectLine = auto.unselect;
  const restoreHover = () => {
    if (hovered && auto.mapObjs[hovered]) auto.map?.setStyle(auto.mapObjs[hovered], NORMAL);
    hovered = undefined;
  };
  auto.select = function (point, id) {
    if (this.source !== SOURCE) return selectLine.call(this, point, id);
    restoreHover();
    const feature = this.features[id];
    if (this.reference && (!this.routing ||
        !this.routing.solution[feature?.startNodeId] || !this.routing.solution[feature?.endNodeId])) {
      if (this.selected) this.map.removeOverlay(this.selected);
      this.selected = undefined;
      this.coordinates = undefined;
      manager.setOverride(false);
    }
    const result = selectLine.call(this, point, id);
    hovered = id;
    if (id && this.mapObjs[id]) this.map.setStyle(this.mapObjs[id], HOVER);
    return result;
  };
  auto.unselect = function (...args) {
    const result = unselectLine.apply(this, args);
    if (this.source === SOURCE) restoreHover();
    return result;
  };
  for (const name of ['cancel', 'release', 'finish']) {
    const original = manager[name];
    manager[name] = function (...args) {
      const result = original.apply(this, args);
      if (auto.source === SOURCE) invalidate(false);
      return result;
    };
  }
  manager.__stravaHeatmapSnap = { invalidate };
  return manager.__stravaHeatmapSnap;
}
