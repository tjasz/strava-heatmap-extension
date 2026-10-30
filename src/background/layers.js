import {
	normalizeGradientStops,
	parseLayerPresets,
} from '../clients/common/layers.js';

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
