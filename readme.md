<sub>*Follow me on X [@ybouane](https://x.com/ybouane) — I'm building in public.*</sub>
# LibRaw-Wasm
A WebAssembly build of LibRaw, powered by Emscripten and leveraging Web Workers. This lets you decode and process RAW image files directly in the browser or in a Node.js environment supporting WebAssembly. With LibRaw-Wasm, you can extract metadata and obtain decoded image data from formats such as CR2, NEF, ARW, DNG, and more.

This package provides an asynchronous API for opening RAW images and processing them using the same robust codebase behind LibRaw.

LibRaw-Wasm's processing is done in a Web Worker to avoid blocking the main UI thread.


# Install
```bash
npm install libraw-wasm
```

# Basic usage
```javascript
import LibRaw from 'libraw-wasm';

const output = document.getElementById('output');
// Instantiate LibRaw
const raw = new LibRaw();
// Open (decode) the RAW file
await raw.open(new Uint8Array(fileBuffer), { /* settings */ });

// Fetch metadata
const meta = await raw.metadata(/* fullOutput=false */);
console.log('Metadata:', meta);
output.innerText = JSON.stringify(meta, null, 4);

// Fetch the decoded image data (RGB pixels).
// imageData() rejects if decoding fails (e.g. a compression format this build
// can't decode), so wrap it in try/catch when handling untrusted files.
try {
	const imageData = await raw.imageData();
	console.log('Image data:', imageData);
	console.log('Image data length:', imageData.data.length);
} catch (err) {
	console.error('Failed to decode image:', err);
}

// Fetch the raw, undebayered sensor data (16-bit mosaic, no demosaicing)
const rawImageData = await raw.rawImageData();
console.log('Raw sensor data:', rawImageData); // { raw_width, raw_height, width, height, top_margin, left_margin, data: Uint16Array }

```

## Incremental input

`openStream()` accepts a standard `ReadableStream<Uint8Array>` or async
iterable. It places chunks directly into a bounded allocation in the worker's
shared WebAssembly memory. LibRaw reads that allocation through a synchronous,
random-access datastream, so format identification can overlap the producer
without transferring a completed file to the worker or copying it into a
second native vector.

```javascript
const response = await fetch(rawUrl, {signal});
if (!response.ok) throw new Error(`RAW request failed (${response.status})`);

const expectedSize = Number(response.headers.get('content-length')) || 0;
const raw = new LibRaw();
const input = await raw.openStream(
	response.body,
	{useCameraWb: true},
	{
		expectedSize,
		// Unknown-length inputs cannot grow beyond this application policy.
		maxBytes: 512 * 1024 * 1024,
		signal,
		onProgress({bytesRead, totalBytes, bytesPerSecond}) {
			console.log({bytesRead, totalBytes, bytesPerSecond});
		},
		onEvent(event) {
			if (event.type === 'libraw-start') {
				console.log('LibRaw started with', event.downloadedBytes, 'bytes available');
			}
		}
	}
);
console.log('producer/LibRaw overlap:', input.timings.overlapMs, 'ms');
const image = await raw.imageData();
```

Pass the exact size when it is available. LibRaw's public input contract is
synchronous and random-access; a known size lets it seek and parse while later
ranges are still arriving. When the size is unknown, decoder construction
starts immediately and parsing resumes at EOF once the stream publishes its
actual size.

Incremental input requires `SharedArrayBuffer` and `Atomics`, which usually
means serving the page with cross-origin isolation headers. Check
`LibRaw.supportsIncrementalInput()` and retain a complete-buffer fallback for
other environments. `maxBytes` is a hard bound: the stream rejects rather than
allocating beyond it.

### Progressive regions

Applications can opt into stable region callbacks while `openStream()` is
still receiving bytes:

```javascript
await raw.openStream(response.body, settings, {
	expectedSize: Number(response.headers.get('content-length')) || 0,
	progressive: true,
	progressiveBatchRows: 32,
	onEvent(event) {
		if (event.type === 'progressive-image-info') {
			createBlackSurface(event.width, event.height);
		}
		if (event.type === 'progressive-image-fallback') {
			console.log('Use the normal full render:', event.reason);
		}
	},
	onRegion({x, y, width, height, data, bitmap}) {
		if (bitmap) {
			uploadEmbeddedPreview(bitmap);
		} else {
			uploadRgbaRegion(x, y, width, height, data);
		}
	}
});
```

Baseline uncompressed, chunky RGB or LinearRaw TIFF/DNG strips with uniform
8- or 16-bit samples expose deterministic completed scanlines. Every emitted
RGBA region is orientation-correct, final-positioned, and emitted once.

For TIFF-derived compressed or CFA RAW formats such as Sony ARW, the decoder
walks the standard IFD/SubIFD chain and selects the largest bounded embedded
JPEG. It publishes its final orientation-corrected dimensions as soon as the
IFD chain is available and emits an `ImageBitmap` once only that JPEG byte
range has arrived. The RAW sensor payload continues downloading and opening in
LibRaw concurrently. Consumers own emitted bitmaps and should close them after
upload when their rendering API does not consume the transfer.

Layouts without safe scanlines or a standard embedded JPEG emit
`progressive-image-fallback` and continue through the ordinary LibRaw path.
Scanline memory is bounded by `progressiveBatchRows`; embedded previews are
bounded by `progressiveMaxPreviewBytes` (hard-capped at 64 MiB) and
`progressiveMaxPreviewPixels` (hard-capped at 64 megapixels). The decoder reads
from the existing shared incremental allocation and never creates another
complete-RAW buffer.

# Settings
```javascript
{
	bright: 1.0,			// -b <float> : brightness
	threshold: 0.0,			// -n <float> : wavelet denoise threshold
	autoBrightThr: 0.01,	// portion of clipped pixels for auto-brightening
	adjustMaximumThr: 0.75,	// auto-adjust max if channel overflow above threshold
	expShift: 1.0,			// exposure shift in linear scale (requires expCorrec=1)
	expPreser: 0.0,			// preserve highlights when expShift>1 (0..1)

	halfSize: false,		// -h  : output at 1/2 size
	fourColorRgb: false,	// -f  : separate interpolation for two green channels
	highlight: 0,			// -H  : highlight mode (0..9)
	useAutoWb: false,		// -a  : auto white balance
	useCameraWb: false,		// -w  : camera's recorded WB
	useCameraMatrix: 1,		// +M/-M : color profile usage (0=off,1=on if WB,3=always)
	outputColor: 1,			// -o  : output colorspace (0..8) (0=raw,1=sRGB,2=Adobe, etc.)
	outputBps: 8,			// -4  : 8 or 16 bits per sample
	outputTiff: false,		// -T  : output TIFF if true, else PPM
	outputFlags: 0,			// bitfield for custom output flags
	userFlip: -1,			// -t  : flip/rotate (0..7, default=-1 means use RAW value)
	userQual: 3,			// -q  : interpolation quality (0..12)
	userBlack: -1,			// -k  : user black level
	userCblack: [-1, -1, -1, -1], // per-channel black offsets
	userSat: 0,				// -S  : saturation level
	medPasses: 0,			// -m  : median filter passes
	noAutoBright: false,	// -W  : don't apply auto brightness
	useFujiRotate: -1,		// -j  : -1=use, 0=off, 1=on, for Fuji sensor rotation
	greenMatching: false,	// fix green channel imbalance (not a dcraw key)
	dcbIterations: -1,		// additional DCB passes (-1=off)
	dcbEnhanceFl: false,	// enhance color fidelity in DCB
	fbddNoiserd: 0,			// 0=off,1=light,2=full FBDD denoise
	expCorrec: false,		// enable exposure correction (then expShift, expPreser apply)
	noAutoScale: false,		// skip scale_colors (affects WB)
	noInterpolation: false,	// skip demosaic entirely (outputs raw mosaic)

	greybox: null,			// -A x y w h : rectangle (x,y,width,height) for WB calc
	cropbox: null,			// Cropping rectangle (left, top, w, h) applied before rotation
	aber: null,				// -C (red multiplier = aber[0], blue multiplier = aber[2])
	gamm: null,				// -g power toe_slope (1/power -> gamm[0], gamm[1] -> slope)
	userMul: null,			// -r mul0 mul1 mul2 mul3 : user WB multipliers (r, g, b, g2)

	outputProfile: null,	// -o <filename> : output ICC profile (if compiled w/ LCMS)
	cameraProfile: null,	// -p <filename> or 'embed' : camera ICC profile
	badPixels: null,		// -P <file> : file with bad pixels map
	darkFrame: null,		// -K <file> : file with dark frame (16-bit PGM)
}
```


# Additional Notes
- **Performance:** Decoding large RAW files in the browser can be CPU-intensive.
- **Memory:** WebAssembly modules can allocate a significant amount of memory. Check your environment’s limits if you work with very large files.

## Local development
 - If you're making changes in the CPP wrapper, launch `compileLibraw.sh` (or `npm run compile`). It builds the LCMS + LibRaw static libs once into `libs/`/`includes/` and reuses them on subsequent runs; set `FORCE_LIBS=1` to rebuild them (e.g. after changing pinned versions).
 - If you're launching it on MacOS, make sure that emscripten is installed (e.g. `brew install emscripten`) + build dependencies are insalled (e.g. `brew install autoconf automake libtool`). The pinned toolchain is Emscripten 5.0.7.
 - Tests: `npm test` runs the fast worker reply-routing unit test; `npm run test:integration` decodes `example-sony.ARW` in headless Chromium (run `npx playwright install chromium` first).

## CI/CD
 - **PRs** (`ci.yml`): the wasm is built from source and the full test suite runs on every pull request — so you do **not** need to build or commit any binaries (`dist/`, `libraw.wasm`, …). CI regenerates them.
 - **main** (`build-artifacts.yml`): when a build-affecting file changes on `main`, CI rebuilds the wasm and commits the regenerated artifacts back, keeping the checked-in binaries authoritative.
 - **Releases** (`release.yml`): pushing a `v*` tag builds from source, tests, and publishes to npm (with provenance, via OIDC trusted publishing) plus a GitHub Release. Cut one with `npm version <patch|minor|major> && git push --follow-tags`.
