import test from 'node:test';
import assert from 'node:assert/strict';
import { PALETTES } from '../src/clients/common/palettes.js';
import { renderPage, samplePalette } from '../scripts/palette-lab.mjs';

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
  assert.doesNotMatch(html, /<script|https?:\/\//);
});
