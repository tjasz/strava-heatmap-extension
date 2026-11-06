const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const sharp = require('sharp');

test('fallback PNG has centered white text, a mid-gray outline and a blurred dark-gray shadow on black', async () => {
  const asset = path.resolve(__dirname, '..', 'assets', 'heatmap-fallback-grayscale');
  const svg = await fs.readFile(`${asset}.svg`, 'utf8');
  const message = [...svg.matchAll(/<text[^>]*>([^<]+)<\/text>/g)]
    .map((match) => match[1]).join(' ');
  assert.equal(message,
    'Click the Strava Heatmap extension icon to log into Strava and enable the heatmap.');
  assert.match(svg, /font-weight="700"/);
  assert.match(svg, /<feGaussianBlur stdDeviation="2"/);
  assert.match(svg, /<feOffset dx="0" dy="2"/);
  assert.match(svg, /<use href="#message" fill="#404040" stroke="#404040"[^>]+filter="url\(#shadow\)"/);
  assert.ok(svg.indexOf('filter="url(#shadow)"') < svg.indexOf('stroke="#808080"'));
  assert.match(svg, /<use href="#message" fill="none" stroke="#808080" stroke-width="3"/);
  assert.match(svg, /<use href="#message" fill="#fff"/);
  const image = sharp(`${asset}.png`);
  const metadata = await image.metadata();
  assert.equal(metadata.width, 256);
  assert.equal(metadata.height, 256);
  assert.equal(metadata.hasAlpha, false);
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.channels, 3);
  let minX = 256, minY = 256, maxX = -1, maxY = -1;
  let white = 0;
  let midGray = 0;
  let antialiased = 0;
  for (let y = 0; y < 256; y++) {
    for (let x = 0; x < 256; x++) {
      const offset = (y * 256 + x) * 3;
      const intensity = data[offset];
      assert.equal(data[offset + 1], intensity);
      assert.equal(data[offset + 2], intensity);
      if (intensity >= 128) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
      if (intensity > 0) {
        if (intensity === 255) white++;
        else antialiased++;
        if (intensity === 128) midGray++;
      }
    }
  }
  assert.ok(white > 0);
  assert.ok(midGray >= 300, 'the outline must include a substantial solid mid-intensity region');
  assert.ok(antialiased > 0);
  assert.ok(minX >= 12 && maxX < 244, 'text must not touch the tile edges');
  assert.ok(Math.abs((minX + maxX) / 2 - 127.5) <= 2, 'horizontally centered');
  assert.ok(Math.abs((minY + maxY) / 2 - 127.5) <= 2, 'vertically centered');
  let shadowPixels = 0;
  for (let y = maxY + 3; y < 256; y++) {
    for (let x = 0; x < 256; x++) {
      const intensity = data[(y * 256 + x) * 3];
      if (intensity > 0 && intensity <= 64) shadowPixels++;
    }
  }
  assert.ok(shadowPixels >= 20, 'a blurred dark shadow must extend below the text outline');
  assert.equal(data[0], 0);
});
