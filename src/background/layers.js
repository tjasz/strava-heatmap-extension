import {
	DEFAULT_GRADIENT_END,
	DEFAULT_GRADIENT_START,
	normalizeGradientColor,
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
		.map(({ activity, color, gradientStart, gradientEnd }) => {
			const fields = [activity, color];
			if (color === 'grayscale') {
				fields.push(
					normalizeGradientColor(gradientStart, DEFAULT_GRADIENT_START),
					normalizeGradientColor(gradientEnd, DEFAULT_GRADIENT_END)
				);
			}
			return fields.join(':');
		})
		.join(';');
}

export function validateLayerPresets(layerPresets) {
	for (const { activity, color, gradientStart, gradientEnd } of layerPresets) {
		if (activity === undefined || color === undefined) {
			return false;
		}
		if (
			color === 'grayscale' &&
			(!/^#[0-9a-f]{6}$/i.test(gradientStart) ||
				!/^#[0-9a-f]{6}$/i.test(gradientEnd))
		) {
			return false;
		}
	}
	return true;
}
