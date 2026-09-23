import {
	normalizeGradientStops,
	parseLayerPresets,
} from '../clients/common/layers.js';

export async function resetLayerPresets(force = false) {
	const layerPresets = await getLayerPresets();
	if (layerPresets.length > 0 && !force) return false;

	const defaultLayerPresets = [
		{ activity: 'all', color: 'hot' },
		{ activity: 'ride', color: 'purple' },
		{ activity: 'run', color: 'orange' },
		{ activity: 'water', color: 'blue' },
		{ activity: 'winter', color: 'gray' },
	];
	await setLayerPresets(defaultLayerPresets);

	console.log(
		'[StravaHeatmapExt] Initializing default layer presets',
		defaultLayerPresets
	);

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
			const { activity, color, gradientStops } = layer;
			const fields = [activity, color];
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
	for (const { activity, color, gradientStops } of layerPresets) {
		if (activity === undefined || color === undefined) {
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
