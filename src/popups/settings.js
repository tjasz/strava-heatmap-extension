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
  DEFAULT_GRADIENT_END,
  DEFAULT_GRADIENT_OPACITY,
  DEFAULT_GRADIENT_START,
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

  [
    [
      'Start',
      'gradient-start',
      layer.gradientStart ?? DEFAULT_GRADIENT_START,
      'gradient-start-opacity',
      layer.gradientStartOpacity ?? DEFAULT_GRADIENT_OPACITY,
    ],
    [
      'End',
      'gradient-end',
      layer.gradientEnd ?? DEFAULT_GRADIENT_END,
      'gradient-end-opacity',
      layer.gradientEndOpacity ?? DEFAULT_GRADIENT_OPACITY,
    ],
  ].forEach(([labelText, colorClass, color, opacityClass, opacity]) => {
    const label = document.createElement('label');
    label.className = 'gradient-endpoint';
    label.textContent = labelText;
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.className = colorClass;
    colorInput.value = color;
    colorInput.setAttribute('aria-label', `${labelText} color`);
    colorInput.addEventListener('change', changeCallback);

    const opacityInput = document.createElement('input');
    opacityInput.type = 'range';
    opacityInput.className = opacityClass;
    opacityInput.min = '0';
    opacityInput.max = '100';
    opacityInput.step = '1';
    opacityInput.value = String(Math.round(opacity * 100));
    opacityInput.setAttribute('aria-label', `${labelText} opacity`);

    const opacityOutput = document.createElement('output');
    opacityOutput.value = `${opacityInput.value}%`;
    opacityOutput.setAttribute('aria-live', 'polite');
    opacityInput.addEventListener('input', () => {
      opacityOutput.value = `${opacityInput.value}%`;
    });
    opacityInput.addEventListener('change', changeCallback);

    label.append(colorInput, opacityInput, opacityOutput);
    controls.appendChild(label);
  });

  return controls;
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
      async () => {
        const current = getCurrentLayers();
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
      layer.gradientStart =
        item.querySelector('.gradient-start')?.value ?? DEFAULT_GRADIENT_START;
      layer.gradientEnd =
        item.querySelector('.gradient-end')?.value ?? DEFAULT_GRADIENT_END;
      layer.gradientStartOpacity =
        Number(
          item.querySelector('.gradient-start-opacity')?.value ??
            DEFAULT_GRADIENT_OPACITY * 100
        ) / 100;
      layer.gradientEndOpacity =
        Number(
          item.querySelector('.gradient-end-opacity')?.value ??
            DEFAULT_GRADIENT_OPACITY * 100
        ) / 100;
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
