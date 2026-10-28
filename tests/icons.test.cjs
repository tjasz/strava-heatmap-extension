const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const sharp = require('sharp');
const { generateIcons } = require('../scripts/icons.js');

async function createFixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'heatmap icons '));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.copyFile(
    path.resolve(__dirname, '..', 'icons', 'icon.svg'),
    path.join(directory, 'icon.svg')
  );
  return directory;
}

test('replaces all four PNG icons with correctly sized color and grayscale artwork', async (t) => {
  const directory = await createFixture(t);
  const files = [48, 128].flatMap((size) => [
    `icon-${size}.png`, `icon-${size}-grayscale.png`,
  ]);
  for (const file of files) {
    await fs.writeFile(path.join(directory, file), 'stale icon');
  }
  await generateIcons(directory);
  assert.deepEqual((await fs.readdir(directory)).sort(), ['icon.svg', ...files].sort());
  for (const size of [48, 128]) {
    const pixels = [];
    for (const suffix of ['', '-grayscale']) {
      const file = path.join(directory, `icon-${size}${suffix}.png`);
      const metadata = await sharp(file).metadata();
      assert.equal(metadata.format, 'png');
      assert.equal(metadata.width, size);
      assert.equal(metadata.height, size);
      assert.equal(metadata.hasAlpha, true);
      const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
      assert.equal(info.channels, 4);
      assert.equal(data[3], 0, 'corner remains transparent');
      assert.equal(data[((size / 2) * size + size / 2) * 4 + 3], 255, 'center is opaque');
      pixels.push(data);
    }
    const [color, grayscale] = pixels;
    let hasColor = false;
    for (let i = 0; i < color.length; i += 4) {
      assert.equal(grayscale[i], grayscale[i + 1]);
      assert.equal(grayscale[i + 1], grayscale[i + 2]);
      assert.equal(grayscale[i + 3], color[i + 3], 'grayscale preserves alpha');
      if (color[i + 3] > 0 && color[i] !== color[i + 1]) hasColor = true;
    }
    assert.ok(hasColor, 'color variant retains colored pixels');
  }
});

test('invalid SVG fails without replacing existing PNGs', async (t) => {
  const directory = await createFixture(t);
  const file = path.join(directory, 'icon-48.png');
  await fs.writeFile(file, 'original icon');
  await fs.writeFile(path.join(directory, 'icon.svg'), 'not an SVG');
  await assert.rejects(generateIcons(directory), /unsupported image format/i);
  assert.equal(await fs.readFile(file, 'utf8'), 'original icon');
  assert.deepEqual((await fs.readdir(directory)).sort(), ['icon-48.png', 'icon.svg']);
});
