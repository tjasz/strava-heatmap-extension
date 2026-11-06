const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');

test('palette capture extracts light and dark textures while preserving saved light IDs', async () => {
  const names = ['blue', 'purple', 'orange', 'sunset', 'pink', 'highcontrast', 'bluered'];
  const textures = [...names.flatMap((name) => [`${name}_light`, `${name}_dark`]), 'weekly_rainbow'];
  const chunk = (type, data) => {
    const buffer = Buffer.alloc(data.length + 12);
    buffer.writeUInt32BE(data.length);
    buffer.write(type, 4);
    data.copy(buffer, 8);
    return buffer;
  };
  const expected = new Map();
  let offset = 0;
  const loader = [];
  const files = textures.map((texture, index) => {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(256);
    header.writeUInt32BE(1, 4);
    header[8] = 8;
    header[9] = 6;
    const ramp = Buffer.from(Array.from({ length: 256 }, (_, intensity) =>
      [intensity, index, 255 - intensity, intensity]).flat());
    expected.set(texture, ramp);
    const file = Buffer.concat([
      Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
      chunk('IDAT', zlib.deflateSync(Buffer.concat([Buffer.from([0]), ramp]))),
    ]);
    loader.push(`filename: "/assets/Shared/Textures/Heatmap/${texture}.png", start: ${offset}, end: ${offset + file.length}`);
    offset += file.length;
    return file;
  });
  let output;
  const source = await fs.readFile(path.join(__dirname, '..', 'scripts', 'palettes.js'), 'utf8');
  await vm.runInNewContext(source, {
    Buffer,
    require(name) {
      if (name === 'fs') return { writeFileSync(file, value) { output = value; } };
      return require(name);
    },
    process: { argv: [], cwd: () => process.cwd(), exit() { assert.fail('capture failed'); } },
    console: { log() {}, error(error) { throw error; } },
    async fetch(url) {
      return {
        ok: true,
        arrayBuffer: async () => url.endsWith('.mjs')
          ? Buffer.from(loader.join('\n')) : Buffer.concat(files),
      };
    },
  });
  const palettes = vm.runInNewContext(output.replace('export const PALETTES =', 'PALETTES ='));
  assert.equal(Object.keys(palettes).length, 15);
  for (const name of names) {
    const light = Buffer.from(expected.get(`${name}_light`));
    if (name === 'bluered') {
      for (let intensity = 0; intensity < 128; intensity++) {
        light.copy(light, intensity * 4, 128 * 4, 128 * 4 + 3);
      }
    }
    assert.equal(palettes[name], light.toString('hex'));
    assert.equal(palettes[`${name}_dark`], expected.get(`${name}_dark`).toString('hex'));
  }
  assert.equal(palettes.rainbow, expected.get('weekly_rainbow').toString('hex'));
});
