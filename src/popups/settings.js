import Sortable from '../../lib/sortablejs@1.15.0.esm.min.js';

import { getExtensionName } from '../extension.js';

import {
  formatLayerPresets,
  getLayerPresets,
  setLayerPresets,
  resetLayerPresets,
  validateLayerPresets,
} from '../background/layers.js';

import {
  ACTIVITY_OPTIONS,
  COLOR_OPTIONS,
  normalizeGradientStops,
} from '../clients/common/layers.js';

const MAX_LAYERS = 8;

function createActivitySelect(selected, disabled) {
  const select = document.createElement('select');
  select.classList.add('layer-activity');
  select.classList.toggle('invalid', selected === undefined);

  const placeholder = document.createElement('option');
  placeholder.textContent = '✨ Pick an Activity';
  placeholder.disabled = true;
  placeholder.selected = selected === undefined;
  select.appendChild(placeholder);

  ACTIVITY_OPTIONS.forEach(([groupLabel, activities]) => {
    const optgroup = document.createElement('optgroup');
    optgroup.label = `📂 ${groupLabel}`;
    select.appendChild(optgroup);
    activities.forEach(([value, label]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = `📄 ${label}`;
      if (disabled.includes(value)) option.disabled = true;
      if (value === selected) option.selected = true;
      optgroup.appendChild(option);
    });
  });
  return select;
}

function createColorPicker(selected) {
  const select = document.createElement('select');
  select.classList.add('layer-color');
  select.classList.toggle('invalid', selected === undefined);

  const placeholder = document.createElement('option');
  placeholder.textContent = '✨ Pick a Color';
  placeholder.disabled = true;
  placeholder.selected = selected === undefined;
  select.appendChild(placeholder);

  COLOR_OPTIONS.forEach(([value, label]) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    if (value === selected) option.selected = true;
    select.appendChild(option);
  });
  return select;
}

function createGradientControls(layer, changeCallback) {
  const controls = document.createElement('div');
  controls.className = 'gradient-controls';
  const stops = normalizeGradientStops(layer.gradientStops);

  stops.forEach((stop, index) => {
    const row = document.createElement('div');
    row.className = 'gradient-stop';

    const dragHandle = document.createElement('span');
    dragHandle.className = 'gradient-drag-handle';
    dragHandle.textContent = '⠿';
    dragHandle.title = 'Drag to reorder gradient stop';

    const label = document.createElement('span');
    label.className = 'gradient-stop-label';
    label.textContent = `Stop ${index + 1}`;

    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.className = 'gradient-stop-color';
    colorInput.value = stop.color;
    colorInput.setAttribute('aria-label', `Stop ${index + 1} color`);
    colorInput.addEventListener('change', () => changeCallback());

    const opacityInput = document.createElement('input');
    opacityInput.type = 'range';
    opacityInput.className = 'gradient-stop-opacity';
    opacityInput.min = '0';
    opacityInput.max = '100';
    opacityInput.step = '1';
    opacityInput.value = String(Math.round(stop.opacity * 100));
    opacityInput.setAttribute('aria-label', `Stop ${index + 1} opacity`);

    const opacityOutput = document.createElement('output');
    opacityOutput.value = `${opacityInput.value}%`;
    opacityOutput.setAttribute('aria-live', 'polite');
    opacityInput.addEventListener('input', () => {
      opacityOutput.value = `${opacityInput.value}%`;
    });
    opacityInput.addEventListener('change', () => changeCallback());

    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'gradient-stop-remove';
    removeButton.textContent = '−';
    removeButton.title = `Remove stop ${index + 1}`;
    removeButton.setAttribute('aria-label', `Remove stop ${index + 1}`);
    removeButton.disabled = stops.length <= 2;
    removeButton.addEventListener('click', () => {
      changeCallback((currentLayer) => {
        currentLayer.gradientStops.splice(index, 1);
      });
    });

    row.append(
      dragHandle,
      label,
      colorInput,
      opacityInput,
      opacityOutput,
      removeButton
    );

    if (index < stops.length - 1) {
      const addButton = document.createElement('button');
      addButton.type = 'button';
      addButton.className = 'gradient-stop-add';
      addButton.textContent = '+';
      addButton.title = `Add a stop between stops ${index + 1} and ${index + 2}`;
      addButton.setAttribute(
        'aria-label',
        `Add a stop between stops ${index + 1} and ${index + 2}`
      );
      addButton.addEventListener('click', () => {
        changeCallback((currentLayer) => {
          const currentStops = currentLayer.gradientStops;
          currentStops.splice(
            index + 1,
            0,
            interpolateGradientStops(currentStops[index], currentStops[index + 1])
          );
        });
      });
      row.appendChild(addButton);
    }

    controls.appendChild(row);
  });

  Sortable.create(controls, {
    handle: '.gradient-drag-handle',
    draggable: '.gradient-stop',
    animation: 150,
    forceFallback: true,
    fallbackTolerance: 3,
    onEnd: () => changeCallback(),
  });

  return controls;
}

function interpolateGradientStops(start, end) {
  const startRgb = hexToRgb(start.color);
  const endRgb = hexToRgb(end.color);
  const color = `#${startRgb
    .map((channel, index) =>
      Math.round((channel + endRgb[index]) / 2)
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`;

  return {
    color,
    opacity: (start.opacity + end.opacity) / 2,
  };
}

function hexToRgb(color) {
  return [1, 3, 5].map((offset) =>
    Number.parseInt(color.slice(offset, offset + 2), 16)
  );
}

function createLayerItem(
  layer,
  index,
  disabledActivities,
  removeCallback,
  changeCallback
) {
  const li = document.createElement('li');
  li.className = 'layer';
  li.dataset.index = index;

  const dragHandle = document.createElement('span');
  dragHandle.className = 'drag-handle';
  dragHandle.textContent = '⠿';

  const activitySelect = createActivitySelect(layer.activity, disabledActivities);
  activitySelect.onchange = () => changeCallback();
  const colorSelect = createColorPicker(layer.color);
  colorSelect.onchange = () => changeCallback();

  const deleteButton = document.createElement('button');
  deleteButton.className = 'layer-remove';
  deleteButton.textContent = '🗑️';
  deleteButton.onclick = () => removeCallback(index);

  const main = document.createElement('div');
  main.className = 'layer-main';
  main.append(dragHandle, activitySelect, colorSelect, deleteButton);
  li.appendChild(main);
  if (layer.color === 'grayscale') {
    li.appendChild(createGradientControls(layer, changeCallback));
  }

  return li;
}

async function renderLayers(layers) {
  const list = document.getElementById('layer-list');
  list.innerHTML = '';

  layers.forEach((layer, i) => {
    const item = createLayerItem(
      layer,
      i,
      layers.map((l) => l.activity).filter((a) => a !== layer.activity),
      async (index) => {
        layers.splice(index, 1);
        await renderLayers(layers);
      },
      async (updateLayer) => {
        const current = getCurrentLayers();
        if (typeof updateLayer === 'function') updateLayer(current[i]);
        await renderLayers(current);
      }
    );
    list.appendChild(item);
  });

  const layerPresets = await getLayerPresets();
  const hasValidChanges =
    validateLayerPresets(layers) &&
    formatLayerPresets(layers) !== formatLayerPresets(layerPresets);

  document.querySelector('#layer-list .layer button').disabled = layers.length === 1;
  document.getElementById('add-layer').disabled = layers.length >= MAX_LAYERS;

  document.getElementById('apply-settings').disabled = !hasValidChanges;
}

function getCurrentLayers() {
  const items = [...document.querySelectorAll('#layer-list .layer')];
  return items.map((item) => {
    const color = item.querySelector('.layer-color').value;
    const layer = {
      activity: item.querySelector('.layer-activity').value,
      color,
    };
    if (color === 'grayscale') {
      const stopRows = [...item.querySelectorAll('.gradient-stop')];
      layer.gradientStops =
        stopRows.length >= 2
          ? stopRows.map((row) => ({
              color: row.querySelector('.gradient-stop-color').value,
              opacity:
                Number(row.querySelector('.gradient-stop-opacity').value) / 100,
            }))
          : normalizeGradientStops();
    }
    return layer;
  });
}

document.getElementById('settings-title').textContent = `⚙️ ${getExtensionName()}`;

document.addEventListener('DOMContentLoaded', async () => {
  const layerPresets = await getLayerPresets();
  await renderLayers(layerPresets);

  const list = document.getElementById('layer-list');
  Sortable.create(list, {
    handle: '.drag-handle',
    animation: 150,
    onEnd: async () => {
      const current = getCurrentLayers();
      await renderLayers(current);
    },
  });

  document.getElementById('close-settings').addEventListener('click', async () => {
    window.close();
  });

  document.getElementById('add-layer').addEventListener('click', async () => {
    const current = getCurrentLayers();
    if (current.length < MAX_LAYERS) {
      current.push({ activity: undefined, color: undefined });
      await renderLayers(current);
    }
  });

  document.getElementById('reset-settings').addEventListener('click', async () => {
    await resetLayerPresets(true);
    const layerPresets = await getLayerPresets();
    await renderLayers(layerPresets);
  });

  document.getElementById('apply-settings').addEventListener('click', async () => {
    const current = getCurrentLayers();
    if (current.length >= 1) {
      await setLayerPresets(current);
      window.close();
    }
  });
});
