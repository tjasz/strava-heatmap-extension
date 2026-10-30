import { createHeatmapRaster, metersPerPixel, project, slidePaths, smoothSlidePath, unproject } from '../www.openstreetmap.org/slide/algorithm.js';
import { loadSlideTiles, SLIDE_ZOOM } from '../www.openstreetmap.org/slide/tiles.js';

export function sampleSlideTargets(anchor) {
  const start = project(anchor, SLIDE_ZOOM);
  const step = (1000 / 6) / metersPerPixel(anchor[1], SLIDE_ZOOM);
  const targets = [];
  for (let row = -3; row <= 3; row++) for (let col = -3; col <= 3; col++) {
    if (row || col) targets.push(unproject([start[0] + col * step, start[1] + row * step], SLIDE_ZOOM));
  }
  return targets;
}

function sharedLength(a, b) {
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
  return shared;
}

const pathScore = (path) => path.costs.at(-1) / (path.lengths.at(-1) * path.scale);

function removeContained(paths) {
  const kept = [];
  for (const path of paths.slice().sort((a, b) => b.lengths.at(-1) - a.lengths.at(-1) || pathScore(a) - pathScore(b))) {
    if (!kept.some((other) => sharedLength(path, other) >= path.lengths.at(-1))) kept.push(path);
  }
  return kept;
}

export function selectSlideOptions(paths, raster) {
  let candidates = paths.filter((path) => path.points.length >= 2 && path.lengths.at(-1) > 0);
  let count;
  do {
    count = candidates.length;
    const groups = [];
    for (const path of removeContained(candidates).sort((a, b) => pathScore(a) - pathScore(b))) {
      const group = groups.find((candidate) => candidate.members.every((member) =>
        sharedLength(path, member) >= Math.max(path.lengths.at(-1), member.lengths.at(-1)) * 0.9));
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
    candidates = removeContained(groups.filter(({ end }) => end > 0).map(({ base, end }) => ({
      points: base.points.slice(0, end + 1), costs: base.costs.slice(0, end + 1),
      lengths: base.lengths.slice(0, end + 1), scale: base.scale,
    })));
  } while (candidates.length < count);
  const options = candidates.map((path) => {
    const cost = path.costs.at(-1), length = path.lengths.at(-1) * path.scale;
    return {
      coordinates: path.points.map((point) => unproject(point, SLIDE_ZOOM)),
      cost, length, score: cost / length,
    };
  }).sort((a, b) => a.score - b.score);
  if (raster) {
    // Keep deduplication on the pixel tree; smoothing must not move its forks.
    const exits = new Map();
    for (const { coordinates } of options) coordinates.forEach((point, i) => {
      const key = point.join(',');
      if (!exits.has(key)) exits.set(key, new Set());
      exits.get(key).add(coordinates[i + 1]?.join(','));
    });
    for (const option of options) {
      const fixed = option.coordinates.flatMap((point, i) => exits.get(point.join(',')).size > 1 ? [i] : []);
      option.coordinates = smoothSlidePath(option.coordinates, raster, fixed);
    }
  }
  return options;
}

export async function loadSlideOptions(anchor, layer, signal, onProgress = () => {}) {
  const targets = sampleSlideTargets(anchor);
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
  const options = selectSlideOptions(paths, raster);
  // Keep the user's anchor exact through projection and unprojection.
  for (const option of options) option.coordinates[0] = anchor.slice();
  return options;
}
