import Sortable from '../../lib/sortablejs@1.15.0.esm.min.js';

import { getExtensionName } from '../extension.js';

import {
  formatLayerPresets,
  getGradientSettings,
  setGradientSettings,
  resetLayerPresets,
  validateLayerPresets,
  validateCustomGradients,
} from '../background/layers.js';

import {
  ACTIVITY_OPTIONS,
  COLOR_OPTIONS,
  normalizeGradientStops,
} from '../clients/common/layers.js';
import { PALETTES } from '../clients/common/palettes.js';

const MAX_LAYERS = 8;
let gradients = [];
let savedSettings;
const editingGradients = new Set();

function gradientOptions() {
  return [
    ...COLOR_OPTIONS.filter(([value]) => value in PALETTES),
    ...gradients.map(({ id, name, emoji }) => [id, `${emoji} ${name}`]),
  ];
}

function createActivitySelect(selected) {
  const select = document.createElement('select');
  select.classList.add('layer-activity');
  select.classList.toggle('invalid', selected === undefined);

  const placeholder = document.createElement('option');
  placeholder.value = '';
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
  placeholder.value = '';
  placeholder.textContent = '✨ Pick a Color';
  placeholder.disabled = true;
  placeholder.selected = selected === undefined;
  select.appendChild(placeholder);

  gradientOptions().forEach(([value, label]) => {
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

function createPeriodSelect(selected = 'global') {
  const select = document.createElement('select');
  select.className = 'layer-period';
  select.setAttribute('aria-label', 'Heatmap type');
  for (const [value, label] of [['global', 'Global'], ['weekly', 'Weekly (Premium)']]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    option.selected = value === selected;
    select.appendChild(option);
  }
  return select;
}

function createLayerItem(
  layer,
  index,
  removeCallback,
  changeCallback
) {
  const li = document.createElement('li');
  li.className = 'layer';
  li.dataset.index = index;

  const dragHandle = document.createElement('span');
  dragHandle.className = 'drag-handle';
  dragHandle.textContent = '⠿';

  const activitySelect = createActivitySelect(layer.activity);
  activitySelect.className = `${activitySelect.className} layer-activity`.trim();
  activitySelect.setAttribute('aria-label', 'Sport');
  activitySelect.onchange = () => changeCallback();
  const colorSelect = createColorPicker(layer.gradientId ?? layer.color);
  colorSelect.className = `${colorSelect.className} layer-color`.trim();
  colorSelect.setAttribute('aria-label', 'Color');
  colorSelect.onchange = () => changeCallback();
  const periodSelect = createPeriodSelect(layer.period);
  periodSelect.onchange = () => changeCallback();

  const deleteButton = document.createElement('button');
  deleteButton.className = 'layer-remove';
  deleteButton.textContent = '🗑️';
  deleteButton.onclick = () => removeCallback(index);

  const main = document.createElement('div');
  main.className = 'layer-main';
  main.append(dragHandle, periodSelect, activitySelect, colorSelect, deleteButton);
  li.appendChild(main);
  return li;
}

async function renderLayers(layers) {
  const list = document.getElementById('layer-list');
  list.innerHTML = '';

  layers.forEach((layer, i) => {
    const item = createLayerItem(
      layer,
      i,
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

  list.querySelectorAll('.layer-remove').forEach((button) => {
    button.disabled = layers.length === 1;
  });
  document.getElementById('add-layer').disabled = layers.length >= MAX_LAYERS;
  updateApplyButton();
}

function getCurrentLayers() {
  const items = [...document.querySelectorAll('#layer-list .layer')];
  return items.map((item) => {
    const selected = item.querySelector('.layer-color').value || undefined;
    const gradient = gradients.find(({ id }) => id === selected);
    const color = gradient ? 'grayscale' : selected;
    const layer = {
      activity: item.querySelector('.layer-activity').value || undefined,
      color,
      period: item.querySelector('.layer-period').value,
    };
    if (gradient) {
      layer.gradientId = gradient.id;
      layer.gradientStops = gradient.gradientStops;
      layer.gradientEmoji = gradient.emoji;
    }
    return layer;
  });
}

function settingsSignature(layers, customGradients) {
  return JSON.stringify([formatLayerPresets(layers), customGradients]);
}

function updateApplyButton() {
  const layers = getCurrentLayers();
  document.getElementById('apply-settings').disabled =
    layers.length === 0 ||
    !validateLayerPresets(layers) ||
    !validateCustomGradients(gradients) ||
    settingsSignature(layers, gradients) === savedSettings;
}

function createGradientPreview(gradient) {
  const canvas = document.createElement('canvas');
  canvas.className = 'gradient-preview';
  canvas.width = 256;
  canvas.height = 10;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', `${gradient.name} gradient`);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not create gradient preview.');
  const image = context.createImageData(256, 10);
  const ramp = PALETTES[gradient.id];
  const stops = ramp ? undefined : normalizeGradientStops(gradient.gradientStops);
  for (let x = 0; x < 256; x++) {
    let rgba;
    if (ramp) {
      rgba = [0, 2, 4, 6].map((offset) =>
        Number.parseInt(ramp.slice(x * 8 + offset, x * 8 + offset + 2), 16)
      );
    } else {
      const position = x / 255 * (stops.length - 1);
      const index = Math.min(Math.floor(position), stops.length - 2);
      const start = [...hexToRgb(stops[index].color), stops[index].opacity * 255];
      const end = [...hexToRgb(stops[index + 1].color), stops[index + 1].opacity * 255];
      rgba = start.map((channel, i) =>
        Math.round(channel + (end[i] - channel) * (position - index))
      );
    }
    for (let y = 0; y < 10; y++) image.data.set(rgba, (y * 256 + x) * 4);
  }
  context.putImageData(image, 0, 0);
  return canvas;
}

function readGradientEditor(item, gradient) {
  gradient.name = item.querySelector('.gradient-name').value;
  gradient.emoji = item.querySelector('.gradient-emoji').value;
  gradient.gradientStops = [...item.querySelectorAll('.gradient-stop')].map((row) => ({
    color: row.querySelector('.gradient-stop-color').value,
    opacity: Number(row.querySelector('.gradient-stop-opacity').value) / 100,
  }));
}

function renderGradients() {
  const list = document.getElementById('gradient-list');
  list.innerHTML = '';
  const builtins = COLOR_OPTIONS.filter(([id]) => id in PALETTES).map(([id, label]) => ({
    id, name: label.slice(label.indexOf(' ') + 1), emoji: label.slice(0, label.indexOf(' ')),
  }));
  for (const gradient of [...builtins, ...gradients]) {
    const item = document.createElement('li');
    item.className = 'gradient';
    item.dataset.id = gradient.id;
    if (editingGradients.has(gradient.id)) {
      const fields = document.createElement('div');
      fields.className = 'gradient-fields';
      for (const [key, label] of [['name', 'Name'], ['emoji', 'Emoji']]) {
        const field = document.createElement('label');
        field.textContent = label;
        const input = document.createElement('input');
        input.type = 'text';
        input.className = `gradient-${key}`;
        input.value = gradient[key];
        input.required = true;
        input.addEventListener('input', () => {
          readGradientEditor(item, gradient);
          void renderLayers(getCurrentLayers());
        });
        field.appendChild(input);
        fields.appendChild(field);
      }
      item.appendChild(fields);
      item.appendChild(createGradientControls(gradient, async (update) => {
        readGradientEditor(item, gradient);
        if (typeof update === 'function') update(gradient);
        renderGradients();
        await renderLayers(getCurrentLayers());
      }));
      const done = document.createElement('button');
      done.className = 'gradient-done';
      done.textContent = 'Done';
      done.addEventListener('click', async () => {
        readGradientEditor(item, gradient);
        if (!validateCustomGradients([gradient])) {
          showError(new Error('Enter a name and emoji for this gradient.'));
          return;
        }
        document.getElementById('settings-error').hidden = true;
        editingGradients.delete(gradient.id);
        renderGradients();
        await renderLayers(getCurrentLayers());
      });
      item.appendChild(done);
    } else {
      const label = document.createElement('div');
      label.className = 'gradient-label';
      label.textContent = `${gradient.emoji} ${gradient.name}`;
      item.append(label, createGradientPreview(gradient));
      if (!(gradient.id in PALETTES)) {
        const edit = document.createElement('button');
        edit.className = 'gradient-edit';
        edit.textContent = 'Edit';
        edit.setAttribute('aria-label', `Edit ${gradient.name}`);
        edit.addEventListener('click', () => {
          editingGradients.add(gradient.id);
          renderGradients();
        });
        item.appendChild(edit);
      }
    }
    list.appendChild(item);
  }
  updateApplyButton();
}

function showError(error) {
  console.error('[StravaHeatmapExt] Settings error.', error);
  const message = document.getElementById('settings-error');
  message.textContent = error.message;
  message.hidden = false;
}

document.getElementById('settings-title').textContent = `⚙️ ${getExtensionName()}`;

document.addEventListener('DOMContentLoaded', async () => {
  let settings;
  try {
    settings = await getGradientSettings();
  } catch (error) {
    showError(error);
    return;
  }
  const { layers: layerPresets } = settings;
  gradients = settings.gradients;
  savedSettings = settingsSignature(layerPresets, gradients);
  await renderLayers(layerPresets);
  renderGradients();
  document.getElementById('add-gradient').disabled = false;

  const tabs = ['layers', 'gradients'];
  function selectTab(selected) {
    for (const tab of tabs) {
      const button = document.getElementById(`${tab}-tab`);
      button.setAttribute('aria-selected', String(tab === selected));
      button.tabIndex = tab === selected ? 0 : -1;
      document.getElementById(`${tab}-panel`).hidden = tab !== selected;
    }
  }
  for (const tab of tabs) {
    const button = document.getElementById(`${tab}-tab`);
    button.addEventListener('click', () => selectTab(tab));
    button.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const selected = event.key === 'Home' ? 'layers' :
        event.key === 'End' ? 'gradients' : tabs.find((value) => value !== tab);
      selectTab(selected);
      document.getElementById(`${selected}-tab`).focus();
    });
  }
  document.getElementById('add-gradient').addEventListener('click', () => {
    const gradient = {
      id: crypto.randomUUID(),
      name: `Custom Gradient ${gradients.length + 1}`,
      emoji: '⚫',
      gradientStops: normalizeGradientStops(),
    };
    gradients.push(gradient);
    editingGradients.add(gradient.id);
    renderGradients();
    void renderLayers(getCurrentLayers());
  });

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
    try {
      await resetLayerPresets(true);
      const settings = await getGradientSettings();
      savedSettings = settingsSignature(settings.layers, settings.gradients);
      await renderLayers(settings.layers);
    } catch (error) {
      showError(error);
    }
  });

  document.getElementById('apply-settings').addEventListener('click', async () => {
    const current = getCurrentLayers();
    if (current.length >= 1 && validateLayerPresets(current) && validateCustomGradients(gradients)) {
      try {
        await setGradientSettings(current, gradients);
        window.close();
      } catch (error) {
        showError(error);
      }
    }
  });
});
