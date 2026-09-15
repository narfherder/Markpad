/** Pixels per line for a wheel that reports in lines (`DOM_DELTA_LINE`). */
export const WHEEL_LINE_PX = 40;

/** How long after the last notch a gesture is considered over. */
export const WHEEL_GESTURE_IDLE_MS = 300;

/**
 * A wheel delta in pixels, whatever unit the device reported it in.
 *
 * Chromium on Windows reports pixels, but Firefox-style line deltas and the
 * page deltas some mice send in "one screen at a time" mode would otherwise
 * move the strip by 3px or by 1px a notch.
 */
export function wheelDeltaToPixels(delta: number, deltaMode: number, pageSize: number): number {
	if (deltaMode === 1) return delta * WHEEL_LINE_PX;
	if (deltaMode === 2) return delta * pageSize;
	return delta;
}

export interface WheelScrollInput {
	/** The strip's scroll offset right now — mid-animation, possibly. */
	current: number;
	/** Where the previous notch of this gesture was already taking it, if any. */
	pending: number | null;
	delta: number;
	deltaMode: number;
	/** The strip's visible width, the size of one page. */
	pageSize: number;
	/** `scrollWidth - clientWidth`. */
	max: number;
}

/**
 * Where a wheel notch should take a horizontally scrolling strip.
 *
 * Measured from the destination the gesture is already heading for, not from
 * `current`. Under smooth scrolling `current` is wherever the animation has
 * got to, and a fast flick sends its next notch long before that is anywhere
 * near the last target — so re-basing on it discards most of every notch but
 * the first. A flick of the wheel barely moved the tab strip for exactly that
 * reason. Accumulating makes eight notches travel eight notches' distance,
 * however far the animation has or has not got.
 */
export function nextWheelScrollTarget(input: WheelScrollInput): number {
	const base = input.pending ?? input.current;
	const next = base + wheelDeltaToPixels(input.delta, input.deltaMode, input.pageSize);
	return Math.max(0, Math.min(input.max, next));
}
