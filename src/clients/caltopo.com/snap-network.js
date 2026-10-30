import { createHeatmapRaster, project, slidePaths, unproject } from '../www.openstreetmap.org/slide/algorithm.js';
import { loadSlideTiles, SLIDE_ZOOM } from '../www.openstreetmap.org/slide/tiles.js';

export function sampleSlideTargets(anchor, previous, zoom) {
  const start = project(anchor, SLIDE_ZOOM);
  const radius = 512 * 2 ** (SLIDE_ZOOM - zoom);
  let bearing = 0;
  if (previous) {
    const radians = (value) => value * Math.PI / 180;
    const lat1 = radians(previous[1]), lat2 = radians(anchor[1]);
    const delta = radians(anchor[0] - previous[0]);
    bearing = Math.atan2(Math.sin(delta) * Math.cos(lat2),
      Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(delta)) * 180 / Math.PI;
  }
  const angles = previous
    ? [...Array.from({ length: 30 }, (_, i) => bearing - 87 + i * 6),
      ...Array.from({ length: 20 }, (_, i) => bearing + 94.5 + i * 9)]
    : Array.from({ length: 50 }, (_, i) => i * 7.2);
  return angles.map((angle) => {
    const radians = angle * Math.PI / 180;
    return unproject([start[0] + radius * Math.sin(radians), start[1] - radius * Math.cos(radians)], SLIDE_ZOOM);
  });
}

function sharedTrajectory(a, b) {
  let ia = 0, ib = 0, shared = 0;
  const at = (path, distance, index) => {
    const span = path.lengths[index + 1] - path.lengths[index];
    const fraction = span ? (distance - path.lengths[index]) / span : 0;
    return path.points[index].map((value, k) =>
      value + fraction * (path.points[index + 1][k] - value));
  };
  const limit = Math.min(a.lengths.at(-1), b.lengths.at(-1));
  for (let distance = 0; distance <= limit; distance = Math.min(limit, distance + 0.5)) {
    while (ia + 2 < a.points.length && a.lengths[ia + 1] < distance) ia++;
    while (ib + 2 < b.points.length && b.lengths[ib + 1] < distance) ib++;
    const pa = at(a, distance, ia), pb = at(b, distance, ib);
    if (Math.hypot(pa[0] - pb[0], pa[1] - pb[1]) > 1) break;
    shared = distance;
    if (distance === limit) break;
  }
  return shared >= a.lengths.at(-1) * 0.9 && shared >= b.lengths.at(-1) * 0.9;
}

export function selectSlideOptions(paths) {
  const score = (path) => path.costs.at(-1) / (path.lengths.at(-1) * path.scale);
  const groups = [];
  for (const path of paths.slice().sort((a, b) => score(a) - score(b))) {
    if (path.points.length < 2 || !(path.lengths.at(-1) > 0)) continue;
    const group = groups.find((candidate) => candidate.members.every((member) => sharedTrajectory(path, member)));
    if (!group) {
      groups.push({ base: path, members: [path], end: path.points.length - 1 });
      continue;
    }
    group.members.push(path);
    let end = 0;
    while (end + 1 <= group.end && end + 1 < path.points.length &&
        group.base.points[end + 1].every((value, k) => value === path.points[end + 1][k])) end++;
    group.end = end;
  }
  return groups.filter(({ end }) => end > 0).map(({ base, end }) => {
    const cost = base.costs[end], length = base.lengths[end] * base.scale;
    return {
      coordinates: base.points.slice(0, end + 1).map((point) => unproject(point, SLIDE_ZOOM)),
      cost, length, score: cost / length,
    };
  }).sort((a, b) => a.score - b.score).slice(0, 5);
}

export async function loadSlideOptions(anchor, previous, zoom, layer, signal, onProgress = () => {}) {
  const targets = sampleSlideTargets(anchor, previous, zoom);
  const source = {
    url: ([x, y, z]) => layer.template.replace('{z}', z).replace('{x}', x).replace('{y}', y),
  };
  onProgress('Loading Strava heatmap...');
  const loaded = await loadSlideTiles([anchor, ...targets], source, signal);
  const raster = createHeatmapRaster(loaded.tiles, loaded.zoom, loaded.bounds);
  onProgress('Finding Slide options...');
  let lastYield = performance.now();
  const paths = await slidePaths(anchor, targets, raster, {
    signal,
    yield: async () => {
      if (performance.now() - lastYield < 16) return;
      await new Promise((resolve) => setTimeout(resolve, 0));
      lastYield = performance.now();
    },
    onProgress: (progress) => onProgress(`Finding Slide options... ${Math.round(progress * 100)}%`),
  });
  const options = selectSlideOptions(paths);
  // Keep the user's anchor exact through projection and unprojection.
  for (const option of options) option.coordinates[0] = anchor.slice();
  return options;
}
