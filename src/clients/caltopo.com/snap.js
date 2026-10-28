import {
  createHeatmapRaster,
  slideLineTwice,
} from '../www.openstreetmap.org/slide/algorithm.js';
import { loadSlideTiles } from '../www.openstreetmap.org/slide/tiles.js';

const SOURCE = 'strava';

export async function traceHeatmap(locations, layer, signal, onProgress) {
  const source = {
    url: ([x, y, z]) => layer.template
      .replace('{z}', z).replace('{x}', x).replace('{y}', y),
  };
  const loaded = await loadSlideTiles(locations, source, signal, () =>
    onProgress('Loading Strava heatmap...'));
  onProgress('Following Strava heat centerline...');
  const raster = createHeatmapRaster(loaded.tiles, loaded.zoom, loaded.bounds);
  const result = await slideLineTwice(locations, raster, {
    fixedIndices: [0, locations.length - 1],
    signal,
  });
  return result.map(({ loc }) => loc);
}

export function installCalTopoSnap(manager, getLayer, trace = traceHeatmap) {
  const auto = manager.autoDrawOverlay;
  const select = auto?.dropMenu?.container?.[0];
  if (!select || typeof manager.handleClick !== 'function' ||
      typeof manager.addPath !== 'function' || typeof auto.fetch !== 'function') {
    return null;
  }
  if (manager.__stravaHeatmapSnap) return manager.__stravaHeatmapSnap;

  auto.data[SOURCE] = { tiles: {}, features: {}, nodes: {} };
  auto.dropMenu.addItem('Strava', SOURCE);
  select.style.width = 'auto';
  const status = document.createElement('span');
  status.className = 'strava-heatmap-snap-status';
  status.setAttribute('role', 'status');
  select.after(status);

  let pending;
  const showStatus = (message, error = false) => {
    status.setAttribute('role', error ? 'alert' : 'status');
    status.textContent = message;
  };
  const invalidate = () => {
    pending?.abort();
    pending = undefined;
    showStatus('');
  };
  select.addEventListener('change', invalidate);

  const fetch = auto.fetch;
  auto.fetch = function (...args) {
    if (this.source !== SOURCE) return fetch.apply(this, args);
  };

  // CalTopo binds handlers through these methods. Keep its commit/undo logic,
  // supplying only the traced path in place of its OSM network route.
  const click = manager.handleClick;
  manager.handleClick = async function (event) {
    if (auto.source !== SOURCE || this.handler?.mode !== 'polyline') {
      return click.call(this, event);
    }
    if (pending) return;
    if (this.ignoreNextClick || !this.polyline ||
        event.target?.closest('form, button, .leaflet-control')) {
      return click.call(this, event);
    }

    const coordinates = this.map.getCoordinates(this.polyline);
    if (coordinates.length < 2) return click.call(this, event);
    const offset = this.$div.offset();
    if (!offset) {
      showStatus('Could not locate the CalTopo drawing canvas.', true);
      return;
    }
    const end = this.map.fromContainerPixel([
      event.pageX - offset.left, event.pageY - offset.top,
    ]);
    const start = coordinates[coordinates.length - 2].slice();
    if (start[0] === end[0] && start[1] === end[1]) return;

    const controller = new AbortController();
    pending = controller;
    const polyline = this.polyline;
    const handler = this.handler;
    const before = JSON.stringify(coordinates);
    const layer = getLayer();
    try {
      if (!layer) throw new Error('Choose a Strava heatmap layer first.');
      showStatus('Loading Strava heatmap...');
      const path = await trace([start, end], layer, controller.signal, showStatus);
      if (controller.signal.aborted || this.polyline !== polyline ||
          this.handler !== handler || auto.source !== SOURCE ||
          getLayer()?.template !== layer.template) {
        if (pending === controller) showStatus('');
        return;
      }
      if (JSON.stringify(this.map.getCoordinates(polyline)) !== before) {
        throw new Error('The line changed while snapping. Click again to retry.');
      }
      // CalTopo replaces its moving cursor with the first supplied point.
      // The start is already committed; exclude it to avoid duplicate vertices
      // and retain the extra cursor coordinate needed by native undo.
      this.setOverride(false);
      this.lastAdditionPoint = false;
      auto.coordinates = path.slice(1);
      click.call(this, event);
      showStatus('');
    } catch (error) {
      if (!controller.signal.aborted) {
        console.warn('[StravaHeatmapExt] CalTopo snapping failed.', error);
        showStatus(`Strava: ${error.message}`, true);
      }
    } finally {
      if (pending === controller) pending = undefined;
    }
  };

  const move = manager.handleMouseMove;
  manager.handleMouseMove = function (...args) {
    if (!pending) return move.apply(this, args);
  };
  const doubleClick = manager.handleDblClick;
  manager.handleDblClick = function (...args) {
    if (!pending) return doubleClick.apply(this, args);
  };
  for (const name of ['undo', 'cancel', 'release', 'finish']) {
    const original = manager[name];
    manager[name] = function (...args) {
      invalidate();
      return original.apply(this, args);
    };
  }

  manager.__stravaHeatmapSnap = { invalidate };
  return manager.__stravaHeatmapSnap;
}
