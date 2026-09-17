import assert from 'node:assert/strict';
import test from 'node:test';

import { WHEEL_LINE_PX, wheelDeltaToPixels } from '../src/lib/utils/wheelScroll.js';

test('line and page deltas are converted to pixels', () => {
	assert.equal(wheelDeltaToPixels(3, 1, 600), 3 * WHEEL_LINE_PX);
	assert.equal(wheelDeltaToPixels(1, 2, 600), 600);
	assert.equal(wheelDeltaToPixels(100, 0, 600), 100);
});

test('a pixel delta is passed through unchanged, in either direction', () => {
	assert.equal(wheelDeltaToPixels(-100, 0, 600), -100);
	assert.equal(wheelDeltaToPixels(0, 0, 600), 0);
});
