// Integration test: drive the real built module (dist/) in a headless browser
// against the example Sony RAW, asserting decode output and the concurrency /
// instance-reuse / dispose invariants.
//
// The module is built for `web,worker` and uses pthreads + SharedArrayBuffer, so
// it cannot run in Node — we serve dist/ over HTTP with the COOP/COEP headers
// cross-origin isolation requires, and drive it with Playwright's Chromium.
//
//   npm run test:integration
//
// CI installs the browser with `npx playwright install --with-deps chromium`.
// Set PW_CHANNEL=chrome to use a locally installed Google Chrome instead.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import {makeRgbDng} from '../progressive-fixture.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE = 'example-sony.ARW';
const PROGRESSIVE_FIXTURE = makeRgbDng({
	width: 96,
	height: 64,
	orientation: 6,
	rowsPerStrip: 4
}).bytes;
const MIME = {
	'.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm',
	'.html': 'text/html', '.json': 'application/json', '.map': 'application/json',
	'.arw': 'application/octet-stream', '.dng': 'application/octet-stream',
};

const PAGE = `<!doctype html><meta charset=utf-8><title>decode</title>
<script type="module">
import LibRaw from './dist/index.js';
const withTimeout = (p, ms, label) => Promise.race([
	p, new Promise((_, r) => setTimeout(() => r(new Error('TIMEOUT ' + label)), ms)),
]);
(async () => {
	try {
		const buf = await (await fetch('./${FIXTURE}')).arrayBuffer();
		// open() transfers (detaches) the input, so make independent copies up front.
		const bytes = () => new Uint8Array(buf.slice(0));

		const raw = new LibRaw();
		await raw.open(bytes(), { useCameraWb: true });
		const meta = await raw.metadata(true);
		const img = await raw.imageData();
		const rerendered = await raw.render({ useCameraWb: true, bright: 1.5 });
		const rawPreview = await raw.rawImagePreview(1024);
		const rawImg = await raw.rawImageData();
		const thumb = await raw.thumbnailData();

		// Concurrency: the exact Promise.all scenario that used to hang.
		const reuse = new LibRaw();
		await reuse.open(bytes(), { useCameraWb: true, halfSize: true });
		const [cMeta, cImg] = await withTimeout(
			Promise.all([reuse.metadata(), reuse.imageData()]), 20000, 'Promise.all');

		// Instance reuse: a 2nd open() on the same instance must reflect new settings.
		await reuse.open(bytes(), { useCameraWb: true, halfSize: false });
		const reImg = await reuse.imageData();

		// dispose() must reject in-flight calls instead of hanging.
		const d = new LibRaw();
		await d.open(bytes(), {});
		const inflight = d.metadata();
		d.dispose();
		let disposedRejected = false;
		await inflight.catch(() => { disposedRejected = true; });

		// Lossy DNG (Adobe lossy / baseline-JPEG, compression 34892, LinearRaw) — issue #27.
		// This path needs libjpeg linked in: with the old USE_JPEG-off build lossy_dng_load_raw()
		// was an empty stub and imageData() resolved with nothing. The fixture encodes R ramping
		// left->right and G ramping top->bottom, so we assert the gradient survived the JPEG
		// round-trip — proving libjpeg actually decoded the tile, not just "non-empty".
		const dngBuf = await (await fetch('./test/integration/lossy.dng')).arrayBuffer();
		const dngRaw = new LibRaw();
		await dngRaw.open(new Uint8Array(dngBuf.slice(0)), { useCameraWb: true, outputBps: 8 });
		let dngImg = null, dngErr = null;
		try { dngImg = await dngRaw.imageData(); } catch (e) { dngErr = String(e && e.message || e); }
		let dngStats = null;
		if (dngImg && dngImg.data && dngImg.width && dngImg.height) {
			const W = dngImg.width, H = dngImg.height, C = dngImg.colors || 3, d = dngImg.data;
			const tx = Math.floor(W / 3), ty = Math.floor(H / 3);
			let rL = 0, rR = 0, gT = 0, gB = 0, nz = 0;
			for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
				const i = (y * W + x) * C;
				if (d[i] || d[i + 1] || d[i + 2]) nz++;
				if (x < tx) rL += d[i]; else if (x >= W - tx) rR += d[i];
				if (y < ty) gT += d[i + 1]; else if (y >= H - ty) gB += d[i + 1];
			}
			const nx = tx * H, ny = ty * W;
			dngStats = { rLeft: rL / nx, rRight: rR / nx, gTop: gT / ny, gBottom: gB / ny, nonzero: nz };
		}

		// Delayed chunked input: the worker must enter the real LibRaw
		// open_datastream() call before the final network chunk arrives, while
		// producing byte-for-byte identical output to open(BufferSource).
		const streamedResponse = await fetch('/delayed-known.dng');
		const streamedEvents = [];
		const streamedRaw = new LibRaw();
		const streamedOpen = await streamedRaw.openStream(
			streamedResponse.body,
			{ useCameraWb: true, outputBps: 8 },
			{
				expectedSize: Number(streamedResponse.headers.get('content-length')),
				maxBytes: 2 * 1024 * 1024,
				progressive: true,
				onEvent: event => streamedEvents.push(event)
			}
		);
		const streamedImg = await streamedRaw.imageData();
		let streamedEquivalent = Boolean(
			streamedImg &&
			dngImg &&
			streamedImg.width === dngImg.width &&
			streamedImg.height === dngImg.height &&
			streamedImg.data.length === dngImg.data.length
		);
		if (streamedEquivalent) {
			for (let i = 0; i < dngImg.data.length; i++) {
				if (streamedImg.data[i] !== dngImg.data[i]) {
					streamedEquivalent = false;
					break;
				}
			}
		}
		streamedRaw.dispose();

		// Unknown-length streams are bounded by maxBytes. LibRaw construction
		// starts immediately and parsing resumes once EOF publishes the true size.
		const unknownResponse = await fetch('/delayed-unknown.dng');
		const unknownRaw = new LibRaw();
		const unknownOpen = await unknownRaw.openStream(
			unknownResponse.body,
			{ useCameraWb: true, outputBps: 8 },
			{ maxBytes: 2 * 1024 * 1024 }
		);
		const unknownImg = await unknownRaw.imageData();
		unknownRaw.dispose();

		// A baseline uncompressed LinearRaw DNG exposes deterministic completed
		// scanlines. The first oriented region must arrive while the response is
		// still open, without stretching it into the unavailable black area.
		const progressiveResponse = await fetch('/delayed-progressive.dng');
		const progressiveRaw = new LibRaw();
		const progressiveEvents = [];
		const progressiveRegions = [];
		let progressiveFirstRegionAt = 0;
		const progressiveOpen = await progressiveRaw.openStream(
			progressiveResponse.body,
			{useCameraWb: true, outputBps: 8},
			{
				expectedSize: Number(progressiveResponse.headers.get('content-length')),
				maxBytes: 2 * 1024 * 1024,
				progressive: true,
				progressiveBatchRows: 2,
				onEvent: event => progressiveEvents.push(event),
				onRegion: region => {
					if (!progressiveFirstRegionAt) progressiveFirstRegionAt = performance.now();
					progressiveRegions.push({
						x: region.x,
						y: region.y,
						width: region.width,
						height: region.height,
						bytes: region.data.byteLength,
						decodedPixels: region.decodedPixels,
						totalPixels: region.totalPixels
					});
				}
			}
		);
		const progressiveInfo = progressiveEvents.find(
			event => event.type === 'progressive-image-info'
		);
		const progressiveComplete = progressiveEvents.find(
			event => event.type === 'progressive-image-complete'
		);
		const progressiveDownloadComplete = progressiveEvents.find(
			event => event.type === 'download-complete'
		);
		let progressiveDecoded = null;
		let progressiveDecodeError = null;
		try {
			progressiveDecoded = await progressiveRaw.imageData();
		} catch (error) {
			progressiveDecodeError = String(error?.message || error);
		}
		progressiveRaw.dispose();

		// Sony ARW stores a full-resolution JPEG before its much larger sensor
		// payload. Discover its final geometry from the IFD chain, decode only
		// that bounded range, and emit an ImageBitmap while the ARW response is
		// still streaming.
		const arwResponse = await fetch('/delayed-arw');
		const arwRaw = new LibRaw();
		const arwEvents = [];
		let arwDownloadedBytes = 0;
		let resolveArwRegion;
		const arwRegionPromise = new Promise(resolve => {
			resolveArwRegion = resolve;
		});
		const arwOpen = await arwRaw.openStream(
			arwResponse.body,
			{useCameraWb: true, outputBps: 8},
			{
				expectedSize: Number(arwResponse.headers.get('content-length')),
				maxBytes: 64 * 1024 * 1024,
				progressive: true,
				onProgress: progress => {
					arwDownloadedBytes = progress.bytesRead;
				},
				onEvent: event => arwEvents.push(event),
				onRegion: region => {
					const result = {
						x: region.x,
						y: region.y,
						width: region.width,
						height: region.height,
						source: region.source,
						hasBitmap: region.bitmap instanceof ImageBitmap,
						downloadedBytes: arwDownloadedBytes,
						timestamp: performance.now()
					};
					region.bitmap?.close();
					resolveArwRegion(result);
				}
			}
		);
		const arwRegion = await withTimeout(arwRegionPromise, 10000, 'ARW progressive preview');
		const arwInfo = arwEvents.find(
			event => event.type === 'progressive-image-info'
		);
		const arwDownloadComplete = arwEvents.find(
			event => event.type === 'download-complete'
		);
		const arwMeta = await arwRaw.metadata();
		arwRaw.dispose();

		// Abort must wake a datastream blocked in synchronous LibRaw code and
		// cancel the browser stream rather than waiting for the server to finish.
		const cancelController = new AbortController();
		const cancelResponse = await fetch('/slow-cancel.dng', {signal: cancelController.signal});
		const cancelRaw = new LibRaw();
		let cancelRejected = false;
		try {
			await cancelRaw.openStream(
				cancelResponse.body,
				{},
				{
					expectedSize: Number(cancelResponse.headers.get('content-length')),
					signal: cancelController.signal,
					onProgress: progress => {
						if (progress.bytesRead > 0) cancelController.abort();
					}
				}
			);
		} catch (error) {
			cancelRejected = error?.name === 'AbortError';
		}
		cancelRaw.dispose();

		// Producer failures and invalid RAW bytes must both reject cleanly.
		const networkFailureRaw = new LibRaw();
		let networkFailureRejected = false;
		try {
			await networkFailureRaw.openStream((async function * () {
				yield new Uint8Array([1, 2, 3, 4]);
				throw new Error('synthetic network failure');
			})(), {}, {expectedSize: 128, maxBytes: 1024});
		} catch (error) {
			networkFailureRejected = /network failure/.test(String(error?.message));
		}
		networkFailureRaw.dispose();

		const decoderFailureRaw = new LibRaw();
		let decoderFailureRejected = false;
		try {
			await decoderFailureRaw.openStream(
				(async function * () { yield new Uint8Array([0x4e, 0x4f, 0x54, 0x52, 0x41, 0x57]); })(),
				{},
				{expectedSize: 6, maxBytes: 6}
			);
			decoderFailureRejected = !(await decoderFailureRaw.imageData());
		} catch {
			decoderFailureRejected = true;
		}
		decoderFailureRaw.dispose();

		const boundedRaw = new LibRaw();
		let memoryBoundRejected = false;
		try {
			await boundedRaw.openStream(
				(async function * () {
					yield new Uint8Array(768);
					yield new Uint8Array(768);
				})(),
				{},
				{maxBytes: 1024}
			);
		} catch (error) {
			memoryBoundRejected = error instanceof RangeError;
		}
		boundedRaw.dispose();
		dngRaw.dispose();

		window.__RESULT = {
			ok: true,
			model: meta?.camera_model,
			dngW: dngImg?.width, dngH: dngImg?.height, dngColors: dngImg?.colors,
			dngLen: dngImg?.data?.length, dngCtor: dngImg?.data?.constructor?.name,
			dngErr, dngStats,
			streamedEquivalent,
			streamedBytes: streamedOpen?.bytesRead,
			streamedOverlapMs: streamedOpen?.timings?.overlapMs,
			streamedStartedBeforeComplete:
				streamedOpen?.timings?.libRawStartedAt > 0 &&
				streamedOpen.timings.libRawStartedAt < streamedOpen.timings.downloadCompletedAt,
			streamedBytesAtStart:
				streamedEvents.find(event => event.type === 'libraw-start')?.downloadedBytes,
			streamedProgressiveFallback:
				streamedEvents.find(event => event.type === 'progressive-image-fallback')?.reason,
			unknownBytes: unknownOpen?.bytesRead,
			unknownW: unknownImg?.width,
			progressiveBytes: progressiveOpen?.bytesRead,
			progressiveInfo,
			progressiveRegions,
			progressiveComplete: Boolean(progressiveComplete),
			progressiveBeforeDownloadComplete:
				progressiveFirstRegionAt > 0 &&
				progressiveFirstRegionAt < progressiveDownloadComplete?.timestamp,
			progressiveDecodedWidth: progressiveDecoded?.width,
			progressiveDecodeError,
			arwBytes: arwOpen?.bytesRead,
			arwInfo,
			arwRegion,
			arwPreviewBeforeDownloadComplete:
				arwRegion?.timestamp > 0 &&
				arwRegion.timestamp < arwDownloadComplete?.timestamp,
			arwModel: arwMeta?.camera_model,
			cancelRejected,
			networkFailureRejected,
			decoderFailureRejected,
			memoryBoundRejected,
			tsYear: meta?.timestamp instanceof Date ? meta.timestamp.getUTCFullYear() : null,
			tsIso: meta?.timestamp instanceof Date ? meta.timestamp.toISOString() : null,
			lens: meta?.lens?.Lens,
			imgW: img?.width, imgH: img?.height, imgLen: img?.data?.length, imgCtor: img?.data?.constructor?.name,
			rerenderW: rerendered?.width, rerenderH: rerendered?.height, rerenderLen: rerendered?.data?.length,
			rawLen: rawImg?.data?.length, rawCtor: rawImg?.data?.constructor?.name,
			previewW: rawPreview?.preview_width, previewH: rawPreview?.preview_height,
			previewLen: rawPreview?.data?.length, previewCtor: rawPreview?.data?.constructor?.name,
			thumbW: thumb?.width, thumbH: thumb?.height, thumbFmt: thumb?.format,
			concMeta: cMeta?.camera_model, concImgW: cImg?.width,
			reHalfW: cImg?.width, reFullW: reImg?.width,
			disposedRejected,
		};
	} catch (e) { window.__RESULT = { ok: false, error: String(e && e.message || e), stack: e && e.stack }; }
})();
</script>`;

const server = http.createServer(async (req, res) => {
	res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
	res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
	res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
	const url = decodeURIComponent(req.url.split('?')[0]);
	if (url === '/' || url === '/index.html') {
		res.setHeader('Content-Type', 'text/html');
		return res.end(PAGE);
	}
	if (
		url === '/delayed-known.dng' ||
		url === '/delayed-unknown.dng' ||
		url === '/slow-cancel.dng' ||
		url === '/delayed-progressive.dng' ||
		url === '/delayed-arw'
	) {
		const data = url === '/delayed-progressive.dng'
			? PROGRESSIVE_FIXTURE
			: url === '/delayed-arw'
				? await readFile(join(ROOT, FIXTURE))
				: await readFile(join(ROOT, 'test/integration/lossy.dng'));
		res.setHeader('Content-Type', 'application/octet-stream');
		if (url !== '/delayed-unknown.dng') {
			res.setHeader('Content-Length', data.byteLength);
		}
		const chunkSize = url === '/delayed-known.dng'
			? 256
			: url === '/delayed-progressive.dng'
				? 192
				: url === '/delayed-arw'
					? 256 * 1024
				: 2048;
		const delayMs = url === '/slow-cancel.dng'
			? 60
			: url === '/delayed-known.dng'
				? 30
				: url === '/delayed-progressive.dng'
					? 18
					: url === '/delayed-arw'
						? 15
					: 12;
		let offset = 0;
		let closed = false;
		req.on('close', () => { closed = true; });
		const writeNext = () => {
			if (closed) return;
			if (offset >= data.byteLength) {
				res.end();
				return;
			}
			const end = Math.min(data.byteLength, offset + chunkSize);
			res.write(data.subarray(offset, end));
			offset = end;
			setTimeout(writeNext, delayMs);
		};
		writeNext();
		return;
	}
	try {
		const p = normalize(join(ROOT, url));
		if (!p.startsWith(ROOT)) { res.statusCode = 403; return res.end('forbidden'); }
		const data = await readFile(p);
		res.setHeader('Content-Type', MIME[extname(p).toLowerCase()] || 'application/octet-stream');
		res.end(data);
	} catch { res.statusCode = 404; res.end('not found'); }
});

await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const launchOpts = { headless: true };
if (process.env.PW_CHANNEL) launchOpts.channel = process.env.PW_CHANNEL;
const browser = await chromium.launch(launchOpts);
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => { if (m.type() === 'error') logs.push('[console.error] ' + m.text()); });
page.on('pageerror', (e) => logs.push('[pageerror] ' + e.message));

let r;
try {
	await page.goto(`http://localhost:${port}/`);
	await page.waitForFunction('window.__RESULT !== undefined', { timeout: 120000 });
	r = await page.evaluate('window.__RESULT');
} catch (e) {
	r = { ok: false, error: 'driver: ' + e.message };
} finally {
	await browser.close();
	server.close();
}

if (logs.length) console.log(logs.join('\n'));
console.log(JSON.stringify(r, null, 2));

// Assertions
const checks = [];
const check = (cond, msg) => checks.push({ ok: !!cond, msg });
check(r && r.ok, 'page ran without error');
if (r && r.ok) {
	check(r.model === 'ILME-FX30', `model is ILME-FX30 (got ${r.model})`);
	check(r.tsYear && r.tsYear >= 2020, `timestamp scaled to a real year (got ${r.tsIso})`);
	check(r.imgW === 6240 && r.imgH === 4168, `imageData full dims 6240x4168 (got ${r.imgW}x${r.imgH})`);
	check(r.imgCtor === 'Uint8Array', `imageData is Uint8Array (got ${r.imgCtor})`);
	check(r.rerenderW === 6240 && r.rerenderH === 4168 && r.rerenderLen === r.imgLen, 'render() reuses the opened RAW at full resolution');
	check(r.rawLen === 6272 * 4168, `rawImageData full mosaic length (got ${r.rawLen})`);
	check(r.rawCtor === 'Uint16Array', `rawImageData is Uint16Array (got ${r.rawCtor})`);
	check(r.previewW === 1024 && r.previewH === 681, `rawImagePreview fits 1024px (got ${r.previewW}x${r.previewH})`);
	check(r.previewLen === r.previewW * r.previewH * 4, `rawImagePreview has RGBA16 samples (got ${r.previewLen})`);
	check(r.previewCtor === 'Uint16Array', `rawImagePreview is Uint16Array (got ${r.previewCtor})`);
	check(r.thumbW === 6192 && r.thumbH === 4128, `thumbnail dims 6192x4128 (got ${r.thumbW}x${r.thumbH})`);
	check(r.thumbFmt === 'jpeg', `thumbnail format jpeg (got ${r.thumbFmt})`);
	check(r.concMeta === 'ILME-FX30' && r.concImgW === 3120, 'concurrent Promise.all resolved with correct payloads');
	check(r.reHalfW === 3120 && r.reFullW === 6240, `instance reuse reflects new settings (half=${r.reHalfW}, full=${r.reFullW})`);
	check(r.disposedRejected, 'dispose() rejected the in-flight call');

	// Lossy DNG decode (issue #27) — fails (empty/throws) on a build without libjpeg.
	const s = r.dngStats;
	check(r.dngErr == null, `lossy DNG imageData did not throw (err=${r.dngErr})`);
	check(r.dngW === 256 && r.dngH === 168, `lossy DNG dims 256x168 (got ${r.dngW}x${r.dngH})`);
	check(r.dngLen === 256 * 168 * 3, `lossy DNG data length 129024 (got ${r.dngLen})`);
	check(r.dngCtor === 'Uint8Array', `lossy DNG data is Uint8Array (got ${r.dngCtor})`);
	check(s && s.nonzero > 0, `lossy DNG decoded non-empty pixels (nonzero=${s?.nonzero})`);
	check(s && s.rRight > s.rLeft + 20, `lossy DNG red gradient L->R (L=${s?.rLeft?.toFixed(1)} R=${s?.rRight?.toFixed(1)})`);
	check(s && s.gBottom > s.gTop + 20, `lossy DNG green gradient T->B (T=${s?.gTop?.toFixed(1)} B=${s?.gBottom?.toFixed(1)})`);
	check(r.streamedEquivalent, 'incremental decode is byte-for-byte equivalent to complete-buffer decode');
	check(r.streamedStartedBeforeComplete, `LibRaw started before download completion (overlap=${r.streamedOverlapMs}ms)`);
	check(r.streamedOverlapMs > 20, `incremental pipeline recorded meaningful overlap (${r.streamedOverlapMs}ms)`);
	check(r.streamedBytesAtStart < r.streamedBytes, `LibRaw started with a partial input (${r.streamedBytesAtStart}/${r.streamedBytes} bytes)`);
	check(
		r.streamedProgressiveFallback === 'compressed-pixel-data',
		`compressed DNG keeps the complete-render fallback (${r.streamedProgressiveFallback})`
	);
	check(r.unknownBytes > 0 && r.unknownW === 256, `unknown-length stream decoded (${r.unknownBytes} bytes, width=${r.unknownW})`);
	check(
		r.progressiveInfo?.width === 64 &&
			r.progressiveInfo?.height === 96 &&
			r.progressiveInfo?.orientation === 6,
		`progressive metadata preserves orientation (${r.progressiveInfo?.width}x${r.progressiveInfo?.height}, orientation=${r.progressiveInfo?.orientation})`
	);
	check(
		r.progressiveRegions?.length > 1 &&
			r.progressiveRegions.every(region =>
				region.width >= 1 &&
				region.width <= 2 &&
				region.height === 96
			) &&
			new Set(r.progressiveRegions.flatMap(region =>
				Array.from({length: region.width}, (_, offset) => region.x + offset)
			)).size === 64,
		`rotated scanline batches land in final positions (${r.progressiveRegions?.length} regions)`
	);
	check(r.progressiveBeforeDownloadComplete, 'first progressive region arrived before download completion');
	check(r.progressiveComplete, 'progressive input replaced every black source region exactly once');
	check(
		r.progressiveRegions?.at(-1)?.decodedPixels ===
			r.progressiveRegions?.at(-1)?.totalPixels,
		'progressive region coverage is complete and monotonic'
	);
	check(
		r.progressiveDecodedWidth > 0 && r.progressiveDecodeError == null,
		`progressive LinearRaw DNG remains decodable by LibRaw (width=${r.progressiveDecodedWidth}, error=${r.progressiveDecodeError})`
	);
	check(
		r.arwInfo?.format === 'embedded-jpeg' &&
			r.arwInfo?.width === 6192 &&
			r.arwInfo?.height === 4128 &&
			r.arwInfo?.orientation === 1,
		`ARW publishes early final preview geometry (${r.arwInfo?.width}x${r.arwInfo?.height}, ${r.arwInfo?.format})`
	);
	check(
		r.arwRegion?.hasBitmap &&
			r.arwRegion?.source === 'embedded-jpeg' &&
			r.arwRegion?.width === 6192 &&
			r.arwRegion?.height === 4128,
		`ARW emits its embedded preview ImageBitmap (${r.arwRegion?.width}x${r.arwRegion?.height})`
	);
	check(
		r.arwPreviewBeforeDownloadComplete &&
			r.arwRegion?.downloadedBytes < r.arwBytes,
		`ARW preview arrives before download completion (${r.arwRegion?.downloadedBytes}/${r.arwBytes} bytes)`
	);
	check(r.arwModel === 'ILME-FX30', `streamed ARW remains open in LibRaw (${r.arwModel})`);
	check(r.cancelRejected, 'incremental input rejects immediately with AbortError on cancellation');
	check(r.networkFailureRejected, 'incremental input propagates producer/network failure');
	check(r.decoderFailureRejected, 'incremental input propagates decoder failure');
	check(r.memoryBoundRejected, 'unknown-length input enforces maxBytes without unbounded growth');
}

const failed = checks.filter((c) => !c.ok);
for (const c of checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.msg}`);
console.log(failed.length === 0 ? '\nAll integration checks passed.' : `\n${failed.length} integration check(s) failed.`);
process.exit(failed.length === 0 ? 0 : 1);
