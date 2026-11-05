import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { PALETTES } from '../src/clients/common/palettes.js';

const PROPERTIES = [
  { key: 'hue', label: 'Hue', max: 360, unit: 'deg' },
  { key: 'saturation', label: 'Saturation', max: 100, unit: '%' },
  { key: 'lightness', label: 'Lightness', max: 100, unit: '%' },
  { key: 'opacity', label: 'Opacity', max: 100, unit: '%' },
];

export function samplePalette(ramp) {
  if (!/^[0-9a-f]{2048}$/i.test(ramp)) {
    throw new Error('Expected a 256-entry hex RGBA palette.');
  }
  return ramp.match(/.{8}/g).map((hex, intensity) => {
    const [red, green, blue, alpha] = hex.match(/../g).map((value) =>
      Number.parseInt(value, 16)
    );
    const max = Math.max(red, green, blue);
    const min = Math.min(red, green, blue);
    const delta = max - min;
    const lightness = (max + min) / 510;
    let hue = 0;
    if (delta) {
      if (max === red) hue = ((green - blue) / delta) % 6;
      else if (max === green) hue = (blue - red) / delta + 2;
      else hue = (red - green) / delta + 4;
      hue = (hue * 60 + 360) % 360;
    }
    return {
      intensity,
      hex,
      hue,
      saturation: delta ? delta / (255 - Math.abs(max + min - 255)) * 100 : 0,
      lightness: lightness * 100,
      opacity: alpha / 255 * 100,
    };
  });
}

function graph(name, samples, { key, label, max, unit }) {
  const x = (sample) => 46 + sample.intensity;
  const y = (sample) => 136 - sample[key] / max * 120;
  const points = samples.map((sample) => `${x(sample)},${y(sample)}`).join(' ');
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((fraction) => {
    const height = 136 - fraction * 120;
    return `<path class="grid" d="M46 ${height}H301"/>
      <text x="40" y="${height + 4}" text-anchor="end">${fraction * max}${unit}</text>`;
  }).join('');
  const markers = samples.map((sample) => `<circle cx="${x(sample)}" cy="${y(sample)}" r="3">
    <title>Intensity ${sample.intensity}: ${sample[key].toFixed(3)}${unit} (#${sample.hex})</title>
  </circle>`).join('');
  return `<svg class="graph" viewBox="0 0 316 166" role="img" aria-label="${name}: ${label}, 256 samples, 0 to ${max}${unit}">
    <title>${name}: ${label}</title>
    ${ticks}
    <path class="axis" d="M46 16V136H301"/>
    <text x="46" y="153">0</text>
    <text x="173.5" y="163" text-anchor="middle">Intensity</text>
    <text x="301" y="153" text-anchor="end">255</text>
    <polyline points="${points}"/>
    <g class="samples">${markers}</g>
  </svg>`;
}

export function renderPage() {
  const editor = readFileSync(new URL('./palette-lab-editor.mjs', import.meta.url), 'utf8')
    .replace(/^export /gm, '');
  const rows = Object.entries(PALETTES).map(([name, ramp]) => {
    const samples = samplePalette(ramp);
    const preview = samples.map((sample) =>
      `<rect x="${sample.intensity}" width="1" height="12" fill="#${sample.hex}"/>`
    ).join('');
    return `<tr><th scope="row">${name}
      <svg class="preview" viewBox="0 0 256 12" role="img" aria-label="${name} palette">${preview}</svg>
    </th>${PROPERTIES.map((property) => `<td>${graph(name, samples, property)}</td>`).join('')}</tr>`;
  }).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Built-in gradient properties</title>
  <style>
    body { font: 14px system-ui, sans-serif; margin: 24px; color: #20252b; background: #fff; }
    h1 { font-size: 24px; }
    .table-scroll { overflow-x: auto; }
    table { border-collapse: collapse; width: 100%; }
    caption { text-align: left; padding: 8px 0; }
    th, td { border: 1px solid #cbd0d5; padding: 8px; vertical-align: top; }
    thead th { background: #edf0f3; }
    tbody th { min-width: 128px; text-align: left; }
    .preview { display: block; width: 128px; height: 12px; margin-top: 12px;
      background: repeating-conic-gradient(#ddd 0% 25%, #fff 0% 50%) 0 0 / 8px 8px; }
    .graph { display: block; width: 100%; min-width: 260px; }
    .graph text { font-size: 10px; fill: #47515c; }
    .grid { stroke: #e1e5e9; stroke-width: 1; }
    .axis { fill: none; stroke: #78838e; }
    polyline { fill: none; stroke: #1468ac; stroke-width: 1.5; stroke-linejoin: round; }
    .samples circle { fill: transparent; }
    .samples circle:hover { fill: #1468ac; }
    button { margin: 8px 4px 8px 0; cursor: pointer; }
    .custom-row { background: #f5faff; }
    .custom-row .graph { touch-action: none; user-select: none; }
    .controls circle { fill: #fff; stroke: #b04400; stroke-width: 2; cursor: grab; }
    .controls circle:focus { fill: #ffcd8b; outline: none; stroke-width: 3; }
    .ramp { display: block; width: 128px; height: 48px; font: 11px monospace; }
    .status { display: block; min-height: 4em; max-width: 160px; font-weight: normal; font-size: 12px; }
  </style>
</head>
<body>
  <h1>Built-in gradient properties</h1>
  <p>All 256 RGBA samples from each built-in palette, indexed by intensity (0-255).
    Hover over a line to inspect each sample.</p>
  <p>Fixed Y axes: hue 0-360 degrees; saturation, lightness, and opacity 0-100%.
    HSL uses the stored sRGB values without opacity compositing.
    Achromatic hue is shown as 0 degrees. Hue is not unwrapped at 360 degrees.</p>
  <p>Custom rows: drag the outlined control points; double-click a chart to add one.
    Focus a point and use arrow keys to edit (Shift for steps of 10), or Delete to
    remove an interior point. Endpoints stay at intensities 0 and 255.
    Custom graphs show the intended HSL curves before RGBA byte rounding,
    retaining hue and saturation even at white or fully transparent samples.
    Copy exports 256 RGBA entries as one 2048-character hex string.
    Edits last until the page is reloaded.</p>
  <button id="add-custom" type="button">Add custom palette</button>
  <div class="table-scroll">
    <table>
      <caption>${Object.keys(PALETTES).length} palettes; 256 points per graph</caption>
      <thead><tr><th scope="col">Palette</th>${PROPERTIES.map(({ label }) =>
        `<th scope="col">${label}</th>`).join('')}</tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
</body>
<script type="module">
${editor}
mountEditor(${JSON.stringify(PROPERTIES)}, ${graph.toString()});
</script>
</html>
`;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const directory = new URL('../.palette-lab/', import.meta.url);
  const output = new URL('index.html', directory);
  await mkdir(directory, { recursive: true });
  await writeFile(output, renderPage());
  console.log(`Generated ${fileURLToPath(output)}\nOpen in a browser: ${output.href}`);
}
