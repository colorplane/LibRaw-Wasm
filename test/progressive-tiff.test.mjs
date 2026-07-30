import assert from 'node:assert/strict';

import {ProgressiveTiffDecoder} from '../progressive-tiff.js';
import {makeRgbDng} from './progressive-fixture.mjs';

async function test(name, fn) {
	try {
		await fn();
		console.log(`  ok   ${name}`);
	} catch(error) {
		console.error(`  FAIL ${name}`);
		throw error;
	}
}

await test('emits dimensions before pixel data and only completed rows', () => {
	const fixture = makeRgbDng({width: 6, height: 5, rowsPerStrip: 2});
	const events = [];
	const regions = [];
	const decoder = new ProgressiveTiffDecoder(fixture.bytes, {
		batchRows: 1,
		onEvent: event => events.push(event),
		onRegion: region => regions.push(region)
	});
	decoder.push(fixture.pixelOffset);
	const info = events.find(event => event.type === 'progressive-image-info');
	assert.deepEqual(
		{width: info.width, height: info.height, orientation: info.orientation},
		{width: 6, height: 5, orientation: 1}
	);
	assert.equal(regions.length, 0);
	decoder.push(fixture.pixelOffset + fixture.rowBytes - 1);
	assert.equal(regions.length, 0);
	decoder.push(fixture.pixelOffset + fixture.rowBytes);
	assert.equal(regions.length, 1);
	assert.deepEqual(
		{y: regions[0].y, height: regions[0].height, decoded: regions[0].decodedPixels},
		{y: 0, height: 1, decoded: 6}
	);
});

await test('maps rotated strips into their final orientation', () => {
	const fixture = makeRgbDng({
		width: 3,
		height: 2,
		orientation: 6,
		rowsPerStrip: 1
	});
	const events = [];
	const regions = [];
	const decoder = new ProgressiveTiffDecoder(fixture.bytes, {
		onEvent: event => events.push(event),
		onRegion: region => regions.push(region)
	});
	decoder.finish(fixture.bytes.byteLength);
	const info = events.find(event => event.type === 'progressive-image-info');
	assert.deepEqual(
		{width: info.width, height: info.height},
		{width: 2, height: 3}
	);
	assert.equal(regions.length, 2);
	assert.deepEqual(
		regions.map(region => ({x: region.x, y: region.y, width: region.width, height: region.height})),
		[
			{x: 1, y: 0, width: 1, height: 3},
			{x: 0, y: 0, width: 1, height: 3}
		]
	);
	assert.equal(events.at(-1).type, 'progressive-image-complete');
});

await test('falls back without emitting regions for compressed TIFF data', () => {
	const fixture = makeRgbDng({compression: 7});
	const events = [];
	const regions = [];
	const decoder = new ProgressiveTiffDecoder(fixture.bytes, {
		onEvent: event => events.push(event),
		onRegion: region => regions.push(region)
	});
	decoder.finish(fixture.bytes.byteLength);
	assert.equal(regions.length, 0);
	assert.equal(events.at(-1).type, 'progressive-image-fallback');
	assert.equal(events.at(-1).reason, 'compressed-pixel-data');
});

await test('keeps emitted regions when an incremental producer fails', () => {
	const fixture = makeRgbDng({width: 8, height: 6, rowsPerStrip: 2});
	const events = [];
	const regions = [];
	const decoder = new ProgressiveTiffDecoder(fixture.bytes, {
		onEvent: event => events.push(event),
		onRegion: region => regions.push(region)
	});
	decoder.push(fixture.pixelOffset + fixture.rowBytes * 2);
	assert.equal(regions.length, 1);
	decoder.fail(new Error('connection lost'));
	assert.equal(regions.length, 1);
	assert.equal(events.at(-1).type, 'progressive-image-interrupted');
	assert.equal(events.at(-1).decodedPixels, 16);
});

await test('bounds temporary region memory by the configured row batch', () => {
	const fixture = makeRgbDng({width: 1024, height: 65, rowsPerStrip: 65});
	const regions = [];
	const decoder = new ProgressiveTiffDecoder(fixture.bytes, {
		batchRows: 4,
		onRegion: region => regions.push(region)
	});
	decoder.finish(fixture.bytes.byteLength);
	assert.ok(regions.length > 1);
	assert.ok(Math.max(...regions.map(region => region.data.byteLength)) <= 1024 * 4 * 4);
});

console.log('\nAll progressive TIFF tests passed.');
