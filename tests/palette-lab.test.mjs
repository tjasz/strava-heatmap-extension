import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PALETTES } from '../src/clients/common/palettes.js';
import { renderPage, samplePalette } from '../scripts/palette-lab.mjs';
import {
  createControlPoints, interpolatePoints, moveControlPoint, recolorTilePixels, sampleCustomPalette,
} from '../scripts/palette-lab-editor.mjs';

const close = (actual, expected) => assert.ok(
  Math.abs(actual - expected) < 1e-10, `${actual} should equal ${expected}`
);

test('palette samples convert sRGB to HSL independently of alpha', () => {
  for (const [hex, hue, saturation, lightness, opacity] of [
    ['ff0000ff', 0, 100, 50, 100],
    ['00ff0080', 120, 100, 50, 128 / 255 * 100],
    ['0000ff00', 240, 100, 50, 0],
    ['ffff00ff', 60, 100, 50, 100],
    ['00ffffff', 180, 100, 50, 100],
    ['ff00ffff', 300, 100, 50, 100],
    ['ff0080ff', 360 - 128 / 255 * 60, 100, 50, 100],
    ['00000000', 0, 0, 0, 0],
    ['ffffffff', 0, 0, 100, 100],
    ['808080ff', 0, 0, 128 / 255 * 100, 100],
    ['804020ff', 20, 60, 80 / 255 * 100, 100],
  ]) {
    const samples = samplePalette(hex.repeat(256));
    assert.equal(samples.length, 256);
    for (const sample of samples) {
      close(sample.hue, hue);
      close(sample.saturation, saturation);
      close(sample.lightness, lightness);
      close(sample.opacity, opacity);
    }
  }
  for (const invalid of ['', 'ff0000ff', 'zz'.repeat(1024)]) {
    assert.throws(() => samplePalette(invalid), /256-entry hex RGBA/);
  }
});

test('every built-in palette retains all 256 exact RGBA entries', () => {
  for (const ramp of Object.values(PALETTES)) {
    const samples = samplePalette(ramp);
    assert.equal(samples.length, 256);
    for (const [intensity, sample] of samples.entries()) {
      assert.equal(sample.intensity, intensity);
      assert.equal(sample.hex, ramp.slice(intensity * 8, (intensity + 1) * 8));
      close(sample.opacity, parseInt(sample.hex.slice(6), 16) / 255 * 100);
      assert.ok(sample.hue >= 0 && sample.hue < 360);
      for (const key of ['saturation', 'lightness', 'opacity']) {
        assert.ok(sample[key] >= 0 && sample[key] <= 100);
      }
    }
  }
});

test('page graphs all samples in a palette-by-property table with fixed axes', () => {
  const html = renderPage();
  const rows = [...html.matchAll(/<tr><th scope="row">([\s\S]*?)<\/tr>/g)];
  assert.equal(rows.length, Object.keys(PALETTES).length);
  for (const [index, [name, ramp]] of Object.entries(PALETTES).entries()) {
    const row = rows[index][1];
    assert.ok(row.startsWith(name));
    assert.match(row, /class="preview"[\s\S]*?<\/svg>\s*<canvas class="tile-preview"/);
    assert.ok(row.includes(`data-ramp="${ramp}"`));
    assert.equal([...row.matchAll(/<td>/g)].length, 4);
    const graphs = [...row.matchAll(/<svg class="graph"[\s\S]*?<\/svg>/g)];
    assert.equal(graphs.length, 4);
    const samples = samplePalette(ramp);
    for (const [column, key] of ['hue', 'saturation', 'lightness', 'opacity'].entries()) {
      const graph = graphs[column][0];
      const max = column === 0 ? 360 : 100;
      const unit = column === 0 ? 'deg' : '%';
      for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
        assert.ok(graph.includes(`text-anchor="end">${fraction * max}${unit}</text>`));
      }
      const points = graph.match(/<polyline points="([^"]+)"/)[1].split(' ');
      assert.equal(points.length, 256);
      assert.equal([...graph.matchAll(/<circle /g)].length, 256);
      for (const [intensity, point] of points.entries()) {
        const [x, y] = point.split(',').map(Number);
        assert.equal(x, 46 + intensity);
        close(y, 136 - samples[intensity][key] / max * 120);
        assert.ok(graph.includes(`Intensity ${intensity}: ${samples[intensity][key].toFixed(3)}${unit}`));
      }
    }
  }
  assert.match(html, /<script type="module">/);
  assert.doesNotMatch(html, /<script[^>]+src=/);
  assert.match(html, /\.tile-preview\s*\{[^}]*background:\s*repeating-conic-gradient/);
  const tile = readFileSync(new URL('../images/foot-15-5304-11549.png', import.meta.url));
  assert.ok(html.includes(`src="data:image/png;base64,${tile.toString('base64')}"`));
});

test('tile styling maps all 256 red intensities to exact palette RGBA, ignoring source alpha', () => {
  const source = Uint8ClampedArray.from(Array.from({ length: 256 }, (_, intensity) =>
    [intensity, 255 - intensity, 37, intensity % 3 === 0 ? 0 : 128]).flat());
  const original = source.slice();
  const ramps = [
    ...Object.values(PALETTES),
    sampleCustomPalette(createControlPoints()).map(({ hex }) => hex).join(''),
  ];
  for (const ramp of ramps) {
    const output = recolorTilePixels(source, samplePalette(ramp));
    assert.deepEqual(output, new Uint8ClampedArray(Buffer.from(ramp, 'hex')));
    assert.deepEqual(source, original, 'styling must not modify the source tile');
  }
});

test('custom defaults use the exact requested piecewise linear curves', () => {
  const controls = createControlPoints();
  const samples = sampleCustomPalette(controls);
  assert.equal(samples.length, 256);
  for (const sample of samples) {
    const x = sample.intensity;
    close(sample.hue, 180 + 90 * x / 255);
    close(sample.saturation, x < 50 ? 75 + x / 2 : 100);
    close(sample.lightness, 50 + 50 * x / 255);
    const knots = [[0, 0], [2, 25], [7, 50], [23, 75], [80, 100], [255, 100]];
    const segment = knots.findIndex(([end]) => end >= x);
    const [x1, y1] = knots[segment];
    const [x0, y0] = knots[Math.max(0, segment - 1)];
    close(sample.opacity, x === 0 ? 0 : y0 + (y1 - y0) * (x - x0) / (x1 - x0));
  }
  assert.equal(samples[0].hex, '20dfdf00');
  assert.equal(samples.at(-1).hex, 'ffffffff');
  for (const [intensity, opacity] of controls.opacity) close(samples[intensity].opacity, opacity);
  const ramp = samples.map(({ hex }) => hex).join('');
  assert.match(ramp, /^[0-9a-f]{2048}$/);
  samplePalette(ramp).forEach((sample, index) =>
    close(sample.opacity, Math.round(samples[index].opacity / 100 * 255) / 255 * 100));
});

test('custom HSL conversion covers all sectors, achromatic colors, and hue 360', () => {
  for (const [hue, saturation, lightness, hex] of [
    [0, 100, 50, 'ff000080'], [60, 100, 50, 'ffff0080'],
    [120, 100, 50, '00ff0080'], [180, 100, 50, '00ffff80'],
    [240, 100, 50, '0000ff80'], [300, 100, 50, 'ff00ff80'],
    [360, 100, 50, 'ff000080'], [270, 0, 50, '80808080'],
    [270, 100, 100, 'ffffff80'], [270, 100, 0, '00000080'],
  ]) {
    const controls = {
      hue: [[0, hue], [255, hue]],
      saturation: [[0, saturation], [255, saturation]],
      lightness: [[0, lightness], [255, lightness]],
      opacity: [[0, 50], [255, 50]],
    };
    assert.ok(sampleCustomPalette(controls).every((sample) => sample.hex === hex));
  }
});

test('control movement clamps axes, pins endpoints, and prevents crossing neighbors', () => {
  const controls = createControlPoints();
  const other = createControlPoints();
  moveControlPoint(controls.opacity, 0, 90, -20, 100);
  moveControlPoint(controls.opacity, 5, 90, 150, 100);
  assert.deepEqual(controls.opacity[0], [0, 0]);
  assert.deepEqual(controls.opacity[5], [255, 100]);
  moveControlPoint(controls.opacity, 2, 100, 70, 100);
  assert.deepEqual(controls.opacity[2], [22, 70]);
  moveControlPoint(controls.opacity, 2, -100, 20, 100);
  assert.deepEqual(controls.opacity[2], [3, 20]);
  assert.deepEqual(other.opacity[2], [7, 50]);
  close(interpolatePoints([[0, 20], [255, 40]], 127.5), 30);
  assert.match(sampleCustomPalette(controls).map(({ hex }) => hex).join(''), /^[0-9a-f]{2048}$/);
});
