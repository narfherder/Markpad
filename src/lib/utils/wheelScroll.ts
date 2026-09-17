/** Pixels per line for a wheel that reports in lines (`DOM_DELTA_LINE`). */
export const WHEEL_LINE_PX = 40;

/**
 * A wheel delta in pixels, whatever unit the device reported it in.
 *
 * Chromium on Windows reports pixels, but Firefox-style line deltas and the
 * page deltas some mice send in "one screen at a time" mode would otherwise
 * move a strip by 3px or by 1px a notch.
 */
export function wheelDeltaToPixels(delta: number, deltaMode: number, pageSize: number): number {
	if (deltaMode === 1) return delta * WHEEL_LINE_PX;
	if (deltaMode === 2) return delta * pageSize;
	return delta;
}
