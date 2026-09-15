import assert from 'node:assert/strict';
import test from 'node:test';

import { WHEEL_LINE_PX, nextWheelScrollTarget, wheelDeltaToPixels } from '../src/lib/utils/wheelScroll.js';

const strip = { pageSize: 600, max: 5000, deltaMode: 0 };

test('a fast flick travels the full distance of every notch', () => {
	// The animation has not moved at all between notches — the worst case, and
	// the one a real flick produces. Re-basing on `current` would land at 100.
	let pending: number | null = null;
	for (let i = 0; i < 8; i++) {
		pending = nextWheelScrollTarget({ ...strip, current: 0, pending, delta: 100 });
	}
	assert.equal(pending, 800);
});

test('a new gesture starts from where the strip actually is', () => {
	assert.equal(nextWheelScrollTarget({ ...strip, current: 1234, pending: null, delta: 100 }), 1334);
});

test('the target never leaves the scrollable range, and reversing works from the edge', () => {
	const atEnd = nextWheelScrollTarget({ ...strip, current: 4950, pending: null, delta: 100 });
	assert.equal(atEnd, 5000);
	assert.equal(nextWheelScrollTarget({ ...strip, current: 4990, pending: atEnd, delta: -100 }), 4900);
	assert.equal(nextWheelScrollTarget({ ...strip, current: 30, pending: null, delta: -100 }), 0);
});

test('line and page deltas are converted to pixels', () => {
	assert.equal(wheelDeltaToPixels(3, 1, 600), 3 * WHEEL_LINE_PX);
	assert.equal(wheelDeltaToPixels(1, 2, 600), 600);
	assert.equal(wheelDeltaToPixels(100, 0, 600), 100);
});
