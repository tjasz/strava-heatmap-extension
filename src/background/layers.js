import {
	COLOR_OPTIONS,
	normalizeGradientStops,
	parseLayerPresets,
} from '../clients/common/layers.js';
import { PALETTES } from '../clients/common/palettes.js';

export async function resetLayerPresets(force = false) {
	const layerPresets = await getLayerPresets();
	if (layerPresets.length > 0 && !force) return false;

	const defaultLayerPresets = [
		{ activity: 'all', color: 'orange' },
		{ activity: 'ride', color: 'purple' },
		{ activity: 'run', color: 'sunset' },
		{ activity: 'water', color: 'blue' },
		{ activity: 'winter', color: 'highcontrast' },
	];
	await setLayerPresets(defaultLayerPresets);

	console.log(
		'[StravaHeatmapExt] Initializing default layer presets',
		defaultLayerPresets
	);

	return true;
}

// Colors removed from Strava in favor of new palettes (v0.14.0)
const MIGRATED_COLORS = {
	hot: 'orange',
	gray: 'highcontrast',
};

export async function migrateLayerPresets() {
	const layerPresets = await getLayerPresets();
	if (!layerPresets.some(({ color }) => color in MIGRATED_COLORS)) return false;

	const migratedLayerPresets = layerPresets.map((layer) => ({
		...layer,
		color: MIGRATED_COLORS[layer.color] ?? layer.color,
	}));
	await setLayerPresets(migratedLayerPresets);

	console.log('[StravaHeatmapExt] Migrated layer presets', migratedLayerPresets);

	return true;
}

export async function setLayerPresets(layerPresets) {
	const layers = formatLayerPresets(layerPresets);

	await browser.storage.local.set({ layers });
}

export async function getLayerPresets() {
	const { layers } = await browser.storage.local.get('layers');
	if (typeof layers !== 'string') return [];

	return parseLayerPresets(layers);
}

export function formatLayerPresets(layerPresets) {
	return layerPresets
		.map((layer) => {
			const { activity, color, gradientStops, period = 'global' } = layer;
			const fields = [activity, color];
			if (period !== 'global') fields.push(period);
			if (color === 'grayscale') {
				const serializedStops = normalizeGradientStops(gradientStops)
					.map(({ color: stopColor, opacity }) =>
						`${stopColor},${opacity}`
					)
					.join('|');
				fields.push(serializedStops);
				if (layer.gradientId !== undefined) {
					fields.push(`gradient=${encodeURIComponent(JSON.stringify({
						gradientId: layer.gradientId,
						gradientEmoji: layer.gradientEmoji,
						gradientName: layer.gradientName,
					}))}`);
				}
			}
			return fields.join(':');
		})
		.join(';');
}

export function validateLayerPresets(layerPresets) {
	for (const { activity, color, gradientStops, period = 'global' } of layerPresets) {
		if (activity === undefined || color === undefined ||
			!['global', 'weekly'].includes(period)) {
			return false;
		}
		if (
			color === 'grayscale' &&
			(!Array.isArray(gradientStops) ||
				gradientStops.length < 2 ||
				gradientStops.some(
					({ color: stopColor, opacity }) =>
						!/^#[0-9a-f]{6}$/i.test(stopColor) ||
						!isValidOpacity(opacity)
				))
		) {
			return false;
		}
	}
	return true;
}

function isValidOpacity(value) {
	const opacity = Number(value);
	return Number.isFinite(opacity) && opacity >= 0 && opacity <= 1;
}

export function validateCustomGradients(gradients) {
	return Array.isArray(gradients) &&
		new Set(gradients.map((gradient) => gradient.id)).size === gradients.length &&
		gradients.every((gradient) =>
			typeof gradient.id === 'string' && gradient.id.length > 0 &&
			typeof gradient.name === 'string' && gradient.name.trim().length > 0 &&
			typeof gradient.emoji === 'string' && gradient.emoji.trim().length > 0 &&
			validateLayerPresets([{
				activity: 'all', color: 'grayscale', gradientStops: gradient.gradientStops,
			}])
		);
}

export function resolveGradientLayers(layers, gradients) {
	return layers.map((layer) => {
		if (layer.color !== 'grayscale' || layer.gradientId === undefined) return layer;
		const gradient = gradients.find(({ id }) => id === layer.gradientId);
		if (!gradient) throw new Error(`Unknown gradient: ${layer.gradientId}`);
		return {
			...layer,
			gradientStops: normalizeGradientStops(gradient.gradientStops),
			gradientEmoji: gradient.emoji,
			gradientName: gradient.name,
		};
	});
}

export function getGradientOrder(gradients, order = []) {
	if (!Array.isArray(order) || order.some((id) => typeof id !== 'string') ||
		new Set(order).size !== order.length) {
		throw new Error('Invalid gradient order.');
	}
	const ids = [
		...COLOR_OPTIONS.filter(([id]) => id in PALETTES).map(([id]) => id),
		...gradients.map(({ id }) => id),
	];
	const known = new Set(ids);
	const ordered = new Set(order.filter((id) => known.has(id)));
	return [...ordered, ...ids.filter((id) => !ordered.has(id))];
}

export async function setGradientSettings(layers, gradients, gradientOrder = []) {
	if (!validateCustomGradients(gradients) || !validateLayerPresets(layers)) {
		throw new Error('Invalid layer or gradient settings.');
	}
	await browser.storage.local.set({
		layers: formatLayerPresets(resolveGradientLayers(layers, gradients)),
		gradients,
		gradientOrder: getGradientOrder(gradients, gradientOrder),
	});
}

export async function getGradientSettings() {
	const stored = await browser.storage.local.get(['layers', 'gradients', 'gradientOrder']);
	const layers = typeof stored.layers === 'string' ? parseLayerPresets(stored.layers) : [];
	const gradients = stored.gradients ?? [];
	if (!validateCustomGradients(gradients)) throw new Error('Invalid saved gradients.');
	let migrated = false;
	for (const layer of layers) {
		if (layer.color !== 'grayscale' || layer.gradientId !== undefined) continue;
		const gradient = {
			id: crypto.randomUUID(),
			name: `Custom Gradient ${gradients.length + 1}`,
			emoji: '⚫',
			gradientStops: normalizeGradientStops(layer.gradientStops),
		};
		gradients.push(gradient);
		layer.gradientId = gradient.id;
		layer.gradientEmoji = gradient.emoji;
		migrated = true;
	}
	const resolved = resolveGradientLayers(layers, gradients);
	const gradientOrder = getGradientOrder(gradients, stored.gradientOrder);
	if (migrated) await setGradientSettings(resolved, gradients, gradientOrder);
	return { layers: resolved, gradients, gradientOrder };
}

export async function requestLayerPresets() {
	const { layers } = await getGradientSettings();
	return formatLayerPresets(layers);
}
