import { createHeatmapRaster, unproject } from '../www.openstreetmap.org/slide/algorithm.js';
import { loadSlideTiles, SLIDE_ZOOM } from '../www.openstreetmap.org/slide/tiles.js';

// Thin the heat into a connected, one-pixel network before splitting it at
// junctions. Unlike tracing a clicked chord, this preserves forks and loops.
export async function heatmapNetwork(raster, bounds, signal) {
  const { width, height, density, coverage, x, y, zoom } = raster;
  const mask = Uint8Array.from(density, (value, i) => coverage[i] && value >= 0.08 ? 1 : 0);
  const offsets = [-width, 1 - width, 1, width + 1, width, width - 1, -1, -width - 1];
  let active = [];
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const i = row * width + col;
      if (!row || !col || row === height - 1 || col === width - 1) mask[i] = 0;
      else if (mask[i]) active.push(i);
    }
  }
  let changed = true;
  let iteration = 0;
  while (changed) {
    if (signal.aborted) throw new DOMException('Strava snap cancelled.', 'AbortError');
    changed = false;
    for (let phase = 0; phase < 2; phase++) {
      const remove = [];
      for (const i of active) {
        const n = offsets.map((offset) => mask[i + offset]);
        const count = n.reduce((sum, value) => sum + value, 0);
        if (count < 2 || count > 6) continue;
        const transitions = n.reduce((sum, value, j) =>
          sum + (!value && n[(j + 1) % 8] ? 1 : 0), 0);
        if (transitions !== 1) continue;
        if (phase === 0
          ? !(n[0] * n[2] * n[4]) && !(n[2] * n[4] * n[6])
          : !(n[0] * n[2] * n[6]) && !(n[0] * n[4] * n[6])) remove.push(i);
      }
      for (const i of remove) mask[i] = 0;
      changed ||= remove.length > 0;
      active = active.filter((i) => mask[i]);
    }
    if (++iteration % 8 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  // Crop only after thinning, so adjoining tiles share the same centerline.
  for (const i of active) {
    const px = x + i % width, py = y + Math.floor(i / width);
    if (px < bounds.minX || px > bounds.maxX || py < bounds.minY || py > bounds.maxY) {
      mask[i] = 0;
    }
  }
  active = active.filter((i) => mask[i]);
  const neighbors = (i) => offsets.flatMap((offset, j) => {
    if (!mask[i + offset]) return [];
    // A diagonal beside an orthogonal edge is not another junction.
    if (j % 2 && (mask[i + offsets[(j + 7) % 8]] || mask[i + offsets[(j + 1) % 8]])) return [];
    return [i + offset];
  });
  const graph = new Map(active.map((i) => [i, neighbors(i)]));
  const visited = new Set();
  const features = [];
  const edge = (a, b) => a < b ? `${a}:${b}` : `${b}:${a}`;
  const walk = (start, next) => {
    const path = [start];
    let previous = start, current = next;
    while (!visited.has(edge(previous, current))) {
      visited.add(edge(previous, current));
      path.push(current);
      const links = graph.get(current);
      if (links.length !== 2 || current === start) break;
      const following = links.find((i) => i !== previous);
      previous = current;
      current = following;
    }
    if (path.length > 1) features.push({
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'LineString',
        coordinates: path.map((i) => unproject([x + i % width, y + Math.floor(i / width)], zoom)),
      },
    });
  };
  for (const [i, links] of graph) {
    if (links.length !== 2) for (const next of links) {
      if (!visited.has(edge(i, next))) walk(i, next);
    }
  }
  // Components without endpoints are closed loops.
  for (const [i, links] of graph) for (const next of links) {
    if (!visited.has(edge(i, next))) walk(i, next);
  }
  if (signal.aborted) throw new DOMException('Strava snap cancelled.', 'AbortError');
  return features;
}

export async function loadHeatmapNetwork(tileX, tileY, tileZoom, layer, signal) {
  const size = 512 * 2 ** (SLIDE_ZOOM - tileZoom);
  const x = tileX * size, y = tileY * size;
  const bounds = { minX: x, minY: y, maxX: x + size, maxY: y + size };
  const source = {
    url: ([tx, ty, z]) => layer.template
      .replace('{z}', z).replace('{x}', tx).replace('{y}', ty),
  };
  const loaded = await loadSlideTiles([
    unproject([x + 1, y + 1]), unproject([x + size - 1, y + size - 1]),
  ], source, signal);
  if (signal.aborted) throw new DOMException('Strava snap cancelled.', 'AbortError');
  const raster = createHeatmapRaster(loaded.tiles, loaded.zoom, loaded.bounds);
  return heatmapNetwork(raster, bounds, signal);
}
