const TIFF_TYPES = new Map([
	[1, 1], // BYTE
	[2, 1], // ASCII
	[3, 2], // SHORT
	[4, 4], // LONG
	[5, 8], // RATIONAL
	[6, 1], // SBYTE
	[7, 1], // UNDEFINED
	[8, 2], // SSHORT
	[9, 4], // SLONG
	[10, 8], // SRATIONAL
	[11, 4], // FLOAT
	[12, 8] // DOUBLE
]);

const TAG_IMAGE_WIDTH = 256;
const TAG_IMAGE_HEIGHT = 257;
const TAG_BITS_PER_SAMPLE = 258;
const TAG_COMPRESSION = 259;
const TAG_PHOTOMETRIC = 262;
const TAG_STRIP_OFFSETS = 273;
const TAG_ORIENTATION = 274;
const TAG_SAMPLES_PER_PIXEL = 277;
const TAG_ROWS_PER_STRIP = 278;
const TAG_STRIP_BYTE_COUNTS = 279;
const TAG_PLANAR_CONFIGURATION = 284;
const PHOTOMETRIC_RGB = 2;
const PHOTOMETRIC_LINEAR_RAW = 34892;

function orientedSize(width, height, orientation) {
	return orientation >= 5 && orientation <= 8
		? {width: height, height: width}
		: {width, height};
}

function orientPoint(x, y, width, height, orientation) {
	switch(orientation) {
		case 2: return {x: width - 1 - x, y};
		case 3: return {x: width - 1 - x, y: height - 1 - y};
		case 4: return {x, y: height - 1 - y};
		case 5: return {x: y, y: x};
		case 6: return {x: height - 1 - y, y: x};
		case 7: return {x: height - 1 - y, y: width - 1 - x};
		case 8: return {x: y, y: width - 1 - x};
		default: return {x, y};
	}
}

function orientedBounds(x, y, width, height, sourceWidth, sourceHeight, orientation) {
	const corners = [
		orientPoint(x, y, sourceWidth, sourceHeight, orientation),
		orientPoint(x + width - 1, y, sourceWidth, sourceHeight, orientation),
		orientPoint(x, y + height - 1, sourceWidth, sourceHeight, orientation),
		orientPoint(x + width - 1, y + height - 1, sourceWidth, sourceHeight, orientation)
	];
	const xs = corners.map(point => point.x);
	const ys = corners.map(point => point.y);
	const left = Math.min(...xs);
	const top = Math.min(...ys);
	return {
		x: left,
		y: top,
		width: Math.max(...xs) - left + 1,
		height: Math.max(...ys) - top + 1
	};
}

function normalizedOrientation(value) {
	const orientation = Number(value) || 1;
	return orientation >= 1 && orientation <= 8 ? orientation : 1;
}

/**
 * Incrementally decodes completed scanlines from baseline uncompressed,
 * chunky RGB or LinearRaw TIFF/DNG strips.
 *
 * The decoder reads directly from the shared incremental input allocation. It
 * never owns a complete-file copy and emits each source scanline exactly once.
 */
export class ProgressiveTiffDecoder {
	constructor(bytes, {
		batchRows = 32,
		onEvent,
		onRegion
	} = {}) {
		this.bytes = bytes;
		this.batchRows = Math.max(1, Math.min(256, Math.trunc(batchRows) || 32));
		this.onEvent = onEvent;
		this.onRegion = onRegion;
		this.available = 0;
		this.layout = null;
		this.nextRows = [];
		this.decodedPixels = 0;
		this.fallbackPublished = false;
		this.completed = false;
		this.started = false;
	}

	push(available) {
		if(this.completed || this.fallbackPublished) return;
		this.available = Math.max(this.available, Math.min(this.bytes.byteLength, available));
		if(!this.layout) {
			const parsed = this.parseLayout();
			if(parsed?.pending) return;
			if(parsed?.reason) {
				this.publishFallback(parsed.reason, parsed.info);
				return;
			}
			this.layout = parsed;
			this.nextRows = new Array(parsed.stripOffsets.length).fill(0);
			this.started = true;
			this.onEvent?.({
				type: 'progressive-image-info',
				timestamp: performance.now(),
				format: parsed.photometric === PHOTOMETRIC_LINEAR_RAW
					? 'linear-raw-tiff'
					: 'rgb-tiff',
				width: parsed.outputWidth,
				height: parsed.outputHeight,
				sourceWidth: parsed.width,
				sourceHeight: parsed.height,
				orientation: parsed.orientation,
				totalPixels: parsed.width * parsed.height
			});
		}
		this.decodeAvailableRows();
	}

	finish(available) {
		if(this.completed) return;
		this.push(available);
		this.completed = true;
		if(this.fallbackPublished) return;
		if(!this.layout) {
			this.publishFallback('truncated-or-unsupported-tiff');
			return;
		}
		this.decodeAvailableRows();
		const totalPixels = this.layout.width * this.layout.height;
		if(this.decodedPixels !== totalPixels) {
			this.onEvent?.({
				type: 'progressive-image-interrupted',
				timestamp: performance.now(),
				decodedPixels: this.decodedPixels,
				totalPixels,
				reason: 'truncated-pixel-data'
			});
			return;
		}
		this.onEvent?.({
			type: 'progressive-image-complete',
			timestamp: performance.now(),
			decodedPixels: this.decodedPixels,
			totalPixels
		});
	}

	fail(error, cancelled = false) {
		if(this.completed) return;
		this.completed = true;
		if(!this.started) return;
		this.onEvent?.({
			type: cancelled
				? 'progressive-image-cancelled'
				: 'progressive-image-interrupted',
			timestamp: performance.now(),
			decodedPixels: this.decodedPixels,
			totalPixels: this.layout.width * this.layout.height,
			reason: error?.message || String(error || 'input-failed')
		});
	}

	publishFallback(reason, info = {}) {
		if(this.fallbackPublished) return;
		this.fallbackPublished = true;
		this.onEvent?.({
			type: 'progressive-image-fallback',
			timestamp: performance.now(),
			reason,
			...info
		});
	}

	parseLayout() {
		if(this.available < 8) return {pending: true};
		const first = this.bytes[0];
		const second = this.bytes[1];
		const littleEndian = first === 0x49 && second === 0x49;
		const bigEndian = first === 0x4d && second === 0x4d;
		if(!littleEndian && !bigEndian) return {reason: 'not-a-tiff'};
		const view = new DataView(
			this.bytes.buffer,
			this.bytes.byteOffset,
			this.bytes.byteLength
		);
		const u16 = offset => view.getUint16(offset, littleEndian);
		const u32 = offset => view.getUint32(offset, littleEndian);
		if(u16(2) !== 42) return {reason: 'unsupported-tiff-version'};
		const ifdOffset = u32(4);
		if(ifdOffset > this.bytes.byteLength - 2) return {reason: 'invalid-ifd-offset'};
		if(this.available < ifdOffset + 2) return {pending: true};
		const entryCount = u16(ifdOffset);
		if(entryCount > 4096) return {reason: 'invalid-ifd-entry-count'};
		const entriesEnd = ifdOffset + 2 + entryCount * 12;
		if(entriesEnd > this.bytes.byteLength) return {reason: 'invalid-ifd-size'};
		if(this.available < entriesEnd) return {pending: true};

		const entries = new Map();
		for(let index = 0; index < entryCount; index++) {
			const offset = ifdOffset + 2 + index * 12;
			const tag = u16(offset);
			const type = u16(offset + 2);
			const count = u32(offset + 4);
			const typeSize = TIFF_TYPES.get(type);
			if(!typeSize || count > 0x7fffffff / typeSize) continue;
			const size = count * typeSize;
			const valueOffset = size <= 4 ? offset + 8 : u32(offset + 8);
			entries.set(tag, {tag, type, count, size, valueOffset});
		}

		const readValues = tag => {
			const entry = entries.get(tag);
			if(!entry) return undefined;
			if(entry.valueOffset + entry.size > this.bytes.byteLength) return null;
			if(entry.valueOffset + entry.size > this.available) return null;
			const values = [];
			for(let index = 0; index < entry.count; index++) {
				const offset = entry.valueOffset + index * (TIFF_TYPES.get(entry.type) || 1);
				switch(entry.type) {
					case 1:
					case 7:
						values.push(this.bytes[offset]);
						break;
					case 3:
						values.push(u16(offset));
						break;
					case 4:
						values.push(u32(offset));
						break;
					default:
						return undefined;
				}
			}
			return values;
		};
		const scalar = (tag, fallback) => {
			const values = readValues(tag);
			return values?.length ? values[0] : fallback;
		};

		const width = scalar(TAG_IMAGE_WIDTH, 0);
		const height = scalar(TAG_IMAGE_HEIGHT, 0);
		const orientation = normalizedOrientation(scalar(TAG_ORIENTATION, 1));
		const output = width && height ? orientedSize(width, height, orientation) : {};
		const info = {
			width: output.width,
			height: output.height,
			sourceWidth: width,
			sourceHeight: height,
			orientation
		};
		if(!width || !height || width > 100000 || height > 100000) {
			return {reason: 'invalid-image-dimensions', info};
		}
		const compression = scalar(TAG_COMPRESSION, 1);
		if(compression !== 1) return {reason: 'compressed-pixel-data', info};
		const photometric = scalar(TAG_PHOTOMETRIC, 0);
		if(photometric !== PHOTOMETRIC_RGB &&
			photometric !== PHOTOMETRIC_LINEAR_RAW) {
			return {reason: 'unsupported-photometric-interpretation', info};
		}
		const samples = scalar(TAG_SAMPLES_PER_PIXEL, 1);
		if(samples !== 3 && samples !== 4) {
			return {reason: 'unsupported-sample-count', info};
		}
		if(scalar(TAG_PLANAR_CONFIGURATION, 1) !== 1) {
			return {reason: 'planar-pixel-data', info};
		}
		const bits = readValues(TAG_BITS_PER_SAMPLE);
		if(bits === null) return {pending: true};
		const normalizedBits = bits?.length === 1
			? new Array(samples).fill(bits[0])
			: bits;
		if(!normalizedBits ||
			normalizedBits.length < samples ||
			!normalizedBits.slice(0, samples).every(value => value === 8 || value === 16) ||
			!normalizedBits.slice(0, samples).every(value => value === normalizedBits[0])) {
			return {reason: 'unsupported-bits-per-sample', info};
		}
		const stripOffsets = readValues(TAG_STRIP_OFFSETS);
		const stripByteCounts = readValues(TAG_STRIP_BYTE_COUNTS);
		if(stripOffsets === null || stripByteCounts === null) return {pending: true};
		if(!stripOffsets?.length ||
			stripOffsets.length !== stripByteCounts?.length) {
			return {reason: 'missing-strip-layout', info};
		}
		const rowsPerStrip = Math.max(1, scalar(TAG_ROWS_PER_STRIP, height));
		const expectedStrips = Math.ceil(height / rowsPerStrip);
		if(stripOffsets.length < expectedStrips) {
			return {reason: 'incomplete-strip-layout', info};
		}
		const bytesPerSample = normalizedBits[0] / 8;
		const rowBytes = width * samples * bytesPerSample;
		for(let index = 0; index < expectedStrips; index++) {
			const rows = Math.min(rowsPerStrip, height - index * rowsPerStrip);
			const offset = stripOffsets[index];
			const byteCount = stripByteCounts[index];
			if(offset > this.bytes.byteLength ||
				byteCount < rows * rowBytes ||
				offset + byteCount > this.bytes.byteLength) {
				return {reason: 'invalid-strip-layout', info};
			}
		}

		return {
			littleEndian,
			width,
			height,
			outputWidth: output.width,
			outputHeight: output.height,
			orientation,
			photometric,
			samples,
			bitsPerSample: normalizedBits[0],
			bytesPerSample,
			rowBytes,
			rowsPerStrip,
			stripOffsets: stripOffsets.slice(0, expectedStrips),
			stripByteCounts: stripByteCounts.slice(0, expectedStrips)
		};
	}

	decodeAvailableRows() {
		const layout = this.layout;
		if(!layout) return;
		for(let strip = 0; strip < layout.stripOffsets.length; strip++) {
			const y = strip * layout.rowsPerStrip;
			const rows = Math.min(layout.rowsPerStrip, layout.height - y);
			const offset = layout.stripOffsets[strip];
			const byteCount = layout.stripByteCounts[strip];
			const availableBytes = Math.max(
				0,
				Math.min(byteCount, this.available - offset)
			);
			const availableRows = Math.min(
				rows,
				Math.floor(availableBytes / layout.rowBytes)
			);
			while(this.nextRows[strip] < availableRows) {
				const firstRow = this.nextRows[strip];
				const rowCount = Math.min(
					this.batchRows,
					availableRows - firstRow
				);
				this.emitRows(strip, firstRow, rowCount);
				this.nextRows[strip] += rowCount;
			}
		}
	}

	emitRows(strip, firstRow, rowCount) {
		const layout = this.layout;
		const sourceY = strip * layout.rowsPerStrip + firstRow;
		const bounds = orientedBounds(
			0,
			sourceY,
			layout.width,
			rowCount,
			layout.width,
			layout.height,
			layout.orientation
		);
		const rgba = new Uint8Array(bounds.width * bounds.height * 4);
		const view = new DataView(
			this.bytes.buffer,
			this.bytes.byteOffset,
			this.bytes.byteLength
		);
		const stripOffset = layout.stripOffsets[strip] +
			firstRow * layout.rowBytes;
		for(let row = 0; row < rowCount; row++) {
			for(let x = 0; x < layout.width; x++) {
				const source = stripOffset + row * layout.rowBytes +
					x * layout.samples * layout.bytesPerSample;
				const readSample = sample => {
					const offset = source + sample * layout.bytesPerSample;
					if(layout.bitsPerSample === 8) return this.bytes[offset];
					return Math.round(
						view.getUint16(offset, layout.littleEndian) * 255 / 65535
					);
				};
				const oriented = orientPoint(
					x,
					sourceY + row,
					layout.width,
					layout.height,
					layout.orientation
				);
				const target = (
					(oriented.y - bounds.y) * bounds.width +
					(oriented.x - bounds.x)
				) * 4;
				rgba[target] = readSample(0);
				rgba[target + 1] = readSample(1);
				rgba[target + 2] = readSample(2);
				rgba[target + 3] = layout.samples === 4
					? readSample(3)
					: 255;
			}
		}
		this.decodedPixels += layout.width * rowCount;
		this.onRegion?.({
			x: bounds.x,
			y: bounds.y,
			width: bounds.width,
			height: bounds.height,
			data: rgba,
			decodedPixels: this.decodedPixels,
			totalPixels: layout.width * layout.height
		});
	}
}
