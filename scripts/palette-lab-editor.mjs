export function createControlPoints() {
  return {
    hue: [[0, 60], [255, 0]],
    saturation: [[0, 75], [50, 100], [255, 100]],
    lightness: [[0, 50], [128, 50], [255, 25]],
    opacity: [[0, 0], [2, 25], [7, 50], [23, 75], [80, 100], [255, 100]],
  };
}

export function interpolatePoints(points, intensity) {
  const end = points.findIndex(([x]) => x >= intensity);
  if (end === 0) return points[0][1];
  if (end === -1) return points.at(-1)[1];
  const [x0, y0] = points[end - 1];
  const [x1, y1] = points[end];
  return y0 + (y1 - y0) * (intensity - x0) / (x1 - x0);
}

export function moveControlPoint(points, index, intensity, value, max) {
  const x = index === 0 ? 0 : index === points.length - 1 ? 255 :
    Math.max(points[index - 1][0] + 1, Math.min(points[index + 1][0] - 1, Math.round(intensity)));
  points[index] = [x, Math.max(0, Math.min(max, value))];
}

export function sampleCustomPalette(controls) {
  return Array.from({ length: 256 }, (_, intensity) => {
    const hue = interpolatePoints(controls.hue, intensity);
    const saturation = interpolatePoints(controls.saturation, intensity);
    const lightness = interpolatePoints(controls.lightness, intensity);
    const opacity = interpolatePoints(controls.opacity, intensity);
    const s = saturation / 100;
    const l = lightness / 100;
    const chroma = (1 - Math.abs(2 * l - 1)) * s;
    const h = (hue % 360) / 60;
    const secondary = chroma * (1 - Math.abs(h % 2 - 1));
    const sectors = [
      [chroma, secondary, 0], [secondary, chroma, 0],
      [0, chroma, secondary], [0, secondary, chroma],
      [secondary, 0, chroma], [chroma, 0, secondary],
    ];
    const rgba = sectors[Math.floor(h)].map((value) =>
      Math.round((value + l - chroma / 2) * 255)
    );
    rgba.push(Math.round(opacity / 100 * 255));
    const hex = rgba.map((byte) => byte.toString(16).padStart(2, '0')).join('');
    return { intensity, hue, saturation, lightness, opacity, hex };
  });
}

export function recolorTilePixels(source, samples) {
  const ramp = Uint8ClampedArray.from(samples.flatMap(({ hex }) =>
    hex.match(/../g).map((value) => Number.parseInt(value, 16))
  ));
  const output = new Uint8ClampedArray(source.length);
  for (let offset = 0; offset < source.length; offset += 4) {
    // Match named-palette tiles: red indexes RGBA; source alpha is not multiplied in.
    const index = source[offset] * 4;
    for (let channel = 0; channel < 4; channel++) {
      output[offset + channel] = ramp[index + channel];
    }
  }
  return output;
}

export async function createTileRenderer(image) {
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Could not create the source tile canvas context.');
  context.drawImage(image, 0, 0);
  const source = context.getImageData(0, 0, canvas.width, canvas.height);
  return (target, samples) => {
    target.width = source.width;
    target.height = source.height;
    const targetContext = target.getContext('2d');
    if (!targetContext) throw new Error('Could not create the styled tile canvas context.');
    targetContext.putImageData(
      new ImageData(recolorTilePixels(source.data, samples), source.width, source.height), 0, 0
    );
  };
}

export function mountEditor(properties, graph, renderTile) {
  const namespace = 'http://www.w3.org/2000/svg';
  let count = 0;
  function addRow() {
    const name = `Custom ${++count}`;
    const controls = createControlPoints();
    const row = document.createElement('tr');
    row.className = 'custom-row';
    const heading = document.createElement('th');
    heading.scope = 'row';
    heading.textContent = name;
    heading.insertAdjacentHTML('beforeend',
      `<svg class="preview" viewBox="0 0 256 12" role="img" aria-label="${name} palette"></svg>
      <canvas class="tile-preview" role="img" aria-label="${name} styled heatmap tile"></canvas>
      <button type="button">Copy ramp hex</button>
      <textarea class="ramp" readonly aria-label="${name} RGBA ramp hex" spellcheck="false"></textarea>
      <output class="status" aria-live="polite"></output>`);
    row.append(heading);
    const preview = heading.querySelector('.preview');
    const tile = heading.querySelector('.tile-preview');
    const ramp = heading.querySelector('.ramp');
    const status = heading.querySelector('.status');
    const charts = new Map();
    let samples = sampleCustomPalette(controls);

    function update() {
      samples = sampleCustomPalette(controls);
      ramp.value = samples.map(({ hex }) => hex).join('');
      preview.innerHTML = samples.map(({ intensity, hex }) =>
        `<rect x="${intensity}" width="1" height="12" fill="#${hex}"/>`).join('');
      renderTile(tile, samples);
      for (const { key, label, max, unit } of properties) {
        const svg = charts.get(key);
        svg.querySelector('polyline').setAttribute('points', samples.map((sample) =>
          `${46 + sample.intensity},${136 - sample[key] / max * 120}`).join(' '));
        svg.querySelectorAll('.samples circle').forEach((circle, index) => {
          circle.setAttribute('cy', 136 - samples[index][key] / max * 120);
          circle.querySelector('title').textContent =
            `Intensity ${index}: ${samples[index][key].toFixed(3)}${unit} (#${samples[index].hex})`;
        });
        const group = svg.querySelector('.controls');
        // Keep existing handles so dragging and keyboard focus survive updates.
        while (group.children.length > controls[key].length) group.lastChild.remove();
        while (group.children.length < controls[key].length) {
          const circle = document.createElementNS(namespace, 'circle');
          circle.setAttribute('r', '4');
          circle.setAttribute('tabindex', '0');
          circle.setAttribute('role', 'button');
          circle.append(document.createElementNS(namespace, 'title'));
          group.append(circle);
        }
        [...group.children].forEach((circle, index) => {
          const [x, value] = controls[key][index];
          circle.dataset.index = index;
          circle.setAttribute('cx', 46 + x);
          circle.setAttribute('cy', 136 - value / max * 120);
          const description = `${label}: intensity ${x}, ${value.toFixed(3)}${unit}`;
          circle.setAttribute('aria-label', description);
          circle.querySelector('title').textContent = description;
        });
      }
    }

    for (const property of properties) {
      const { key, label, max, unit } = property;
      const cell = document.createElement('td');
      cell.innerHTML = graph(name, samples, property);
      const svg = cell.querySelector('svg');
      svg.setAttribute('role', 'group');
      const group = document.createElementNS(namespace, 'g');
      group.setAttribute('class', 'controls');
      svg.append(group);
      charts.set(key, svg);
      row.append(cell);
      let dragging = null;
      function position(event) {
        const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(svg.getScreenCTM().inverse());
        return [point.x - 46, (136 - point.y) / 120 * max];
      }
      function edit(index, x, value) {
        moveControlPoint(controls[key], index, x, value, max);
        update();
        const [intensity, result] = controls[key][index];
        status.textContent = `${label}: intensity ${intensity}, ${result.toFixed(3)}${unit}`;
      }
      svg.addEventListener('pointerdown', (event) => {
        const handle = event.target.closest('.controls circle');
        if (!handle || event.button !== 0) return;
        event.preventDefault();
        handle.focus({ preventScroll: true });
        dragging = Number(handle.dataset.index);
        svg.setPointerCapture(event.pointerId);
      });
      svg.addEventListener('pointermove', (event) => {
        if (dragging !== null) edit(dragging, ...position(event));
      });
      svg.addEventListener('pointerup', (event) => {
        if (dragging !== null) {
          edit(dragging, ...position(event));
          dragging = null;
          svg.releasePointerCapture(event.pointerId);
        }
      });
      svg.addEventListener('lostpointercapture', () => { dragging = null; });
      svg.addEventListener('pointercancel', () => { dragging = null; });
      svg.addEventListener('dblclick', (event) => {
        if (event.target.closest('.controls')) return;
        const [x, value] = position(event);
        const intensity = Math.round(x);
        if (intensity <= 0 || intensity >= 255 || value < 0 || value > max) return;
        const points = controls[key];
        const existing = points.findIndex(([pointX]) => pointX === intensity);
        if (existing !== -1) {
          group.children[existing].focus();
          return;
        }
        points.push([intensity, value]);
        points.sort(([a], [b]) => a - b);
        update();
        group.children[points.findIndex(([pointX]) => pointX === intensity)].focus();
      });
      svg.addEventListener('keydown', (event) => {
        const handle = event.target.closest('.controls circle');
        if (!handle) return;
        const index = Number(handle.dataset.index);
        const points = controls[key];
        const [x, value] = points[index];
        const step = event.shiftKey ? 10 : 1;
        if (['Delete', 'Backspace'].includes(event.key)) {
          event.preventDefault();
          if (index === 0 || index === points.length - 1) return;
          points.splice(index, 1);
          update();
          group.children[Math.min(index, points.length - 1)].focus();
        } else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
          event.preventDefault();
          edit(index, x + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0),
            value + (event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0));
        }
      });
    }
    heading.querySelector('button').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(ramp.value);
        status.textContent = 'Copied 2048-character RGBA ramp.';
      } catch (error) {
        console.error('Could not copy palette ramp.', error);
        ramp.focus();
        ramp.select();
        status.textContent = 'Clipboard unavailable. Ramp selected: press Ctrl+C (Cmd+C on macOS) to copy.';
      }
    });
    document.querySelector('tbody').append(row);
    update();
  }
  document.querySelector('#add-custom').addEventListener('click', addRow);
  addRow();
}
