const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const sharp = require('sharp');
const { generatePromo } = require('../scripts/promo.js');

test('generates a self-contained promo SVG and an opaque 440x280 24-bit PNG', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'heatmap promo '));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await generatePromo(directory);
  const png = await fs.readFile(path.join(directory, 'promo-small.png'));
  const metadata = await sharp(png).metadata();
  assert.equal(metadata.format, 'png');
  assert.equal(metadata.width, 440);
  assert.equal(metadata.height, 280);
  assert.equal(metadata.channels, 3);
  assert.equal(metadata.depth, 'uchar');
  assert.equal(metadata.hasAlpha, false);
  assert.equal(png[24], 8, 'PNG IHDR bit depth is 8 bits per channel');
  assert.equal(png[25], 2, 'PNG IHDR color type is truecolor RGB, not indexed or RGBA');
  const svg = await fs.readFile(path.join(directory, 'promo-small.svg'), 'utf8');
  assert.match(svg, /Strava Heatmap/);
  assert.match(svg, /Flaming compass/);
  assert.doesNotMatch(svg, /href="(?!#)/);
  const rendered = await sharp(Buffer.from(svg)).removeAlpha().toColourspace('srgb')
    .png({ palette: false }).toBuffer();
  assert.deepEqual(png, rendered);
});
