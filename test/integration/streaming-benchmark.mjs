import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {dirname, extname, join, normalize, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixturePath = join(root, 'test/integration/lossy.dng');
const fixture = await readFile(fixturePath);
const pageSource = `<!doctype html><script type="module">
import LibRaw from './dist/index.js';

async function sequential() {
  const startedAt = performance.now();
  const response = await fetch('/delayed.dng');
  const bytes = new Uint8Array(await response.arrayBuffer());
  const downloadCompletedAt = performance.now();
  const raw = new LibRaw();
  await raw.open(bytes, {useCameraWb: true, outputBps: 8});
  const openedAt = performance.now();
  await raw.imageData();
  const completedAt = performance.now();
  raw.dispose();
  return {
    totalMs: completedAt - startedAt,
    downloadMs: downloadCompletedAt - startedAt,
    openMs: openedAt - downloadCompletedAt
  };
}

async function overlapping() {
  const startedAt = performance.now();
  const response = await fetch('/delayed.dng');
  const raw = new LibRaw();
  const input = await raw.openStream(
    response.body,
    {useCameraWb: true, outputBps: 8},
    {
      expectedSize: Number(response.headers.get('content-length')),
      maxBytes: 1024 * 1024
    }
  );
  await raw.imageData();
  const completedAt = performance.now();
  raw.dispose();
  return {
    totalMs: completedAt - startedAt,
    overlapMs: input.timings.overlapMs,
    libRawStartedAt: input.timings.libRawStartedAt,
    downloadCompletedAt: input.timings.downloadCompletedAt
  };
}

(async () => {
  try {
    const sequentialResult = await sequential();
    const overlappingResult = await overlapping();
    window.__RESULT = {
      sequential: sequentialResult,
      overlapping: overlappingResult,
      savedMs: sequentialResult.totalMs - overlappingResult.totalMs,
      speedup: sequentialResult.totalMs / overlappingResult.totalMs
    };
  } catch (error) {
    window.__RESULT = {error: String(error?.stack || error)};
  }
})();
</script>`;

const server = http.createServer(async (request, response) => {
	response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
	response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
	response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
	const url = decodeURIComponent(request.url.split('?')[0]);
	if (url === '/' || url === '/index.html') {
		response.setHeader('Content-Type', 'text/html');
		response.end(pageSource);
		return;
	}
	if (url === '/delayed.dng') {
		response.setHeader('Content-Type', 'application/octet-stream');
		response.setHeader('Content-Length', fixture.byteLength);
		let offset = 0;
		const writeNext = () => {
			if (offset >= fixture.byteLength) {
				response.end();
				return;
			}
			const end = Math.min(fixture.byteLength, offset + 256);
			response.write(fixture.subarray(offset, end));
			offset = end;
			setTimeout(writeNext, 30);
		};
		writeNext();
		return;
	}
	try {
		const path = normalize(join(root, url));
		if (!path.startsWith(root)) {
			response.statusCode = 403;
			response.end('forbidden');
			return;
		}
		const data = await readFile(path);
		response.setHeader('Content-Type', extname(path) === '.wasm' ? 'application/wasm' : 'text/javascript');
		response.end(data);
	} catch {
		response.statusCode = 404;
		response.end('not found');
	}
});

await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
const browser = await chromium.launch({
	headless: true,
	...(process.env.PW_CHANNEL ? {channel: process.env.PW_CHANNEL} : {})
});
const page = await browser.newPage();
let result;
try {
	await page.goto(`http://127.0.0.1:${server.address().port}/`);
	await page.waitForFunction('window.__RESULT !== undefined', {timeout: 120000});
	result = await page.evaluate('window.__RESULT');
} finally {
	await browser.close();
	server.close();
}

if (result?.error) throw new Error(result.error);
console.log(JSON.stringify(result, null, 2));
if (!(result.overlapping.libRawStartedAt < result.overlapping.downloadCompletedAt)) {
	throw new Error('Benchmark did not observe LibRaw/download overlap');
}
