export function makeRgbDng({
	width = 6,
	height = 5,
	orientation = 1,
	rowsPerStrip = 2,
	compression = 1
} = {}) {
	const strips = Math.ceil(height / rowsPerStrip);
	const entries = 12;
	const ifdOffset = 8;
	const ifdSize = 2 + entries * 12 + 4;
	const bitsOffset = ifdOffset + ifdSize;
	const stripOffsetsOffset = bitsOffset + 6;
	const stripByteCountsOffset = stripOffsetsOffset + strips * 4;
	const pixelOffset = stripByteCountsOffset + strips * 4;
	const rowBytes = width * 3;
	const totalBytes = pixelOffset + width * height * 3;
	const bytes = new Uint8Array(totalBytes);
	const view = new DataView(bytes.buffer);
	const u16 = (offset, value) => view.setUint16(offset, value, true);
	const u32 = (offset, value) => view.setUint32(offset, value, true);

	bytes.set([0x49, 0x49]);
	u16(2, 42);
	u32(4, ifdOffset);
	u16(ifdOffset, entries);
	let entryOffset = ifdOffset + 2;
	const entry = (tag, type, count, value) => {
		u16(entryOffset, tag);
		u16(entryOffset + 2, type);
		u32(entryOffset + 4, count);
		if(type === 3 && count === 1) u16(entryOffset + 8, value);
		else u32(entryOffset + 8, value);
		entryOffset += 12;
	};
	entry(256, 4, 1, width);
	entry(257, 4, 1, height);
	entry(258, 3, 3, bitsOffset);
	entry(259, 3, 1, compression);
	entry(262, 3, 1, 34892);
	entry(273, 4, strips, strips === 1 ? pixelOffset : stripOffsetsOffset);
	entry(274, 3, 1, orientation);
	entry(277, 3, 1, 3);
	entry(278, 4, 1, rowsPerStrip);
	entry(279, 4, strips, strips === 1 ? width * height * 3 : stripByteCountsOffset);
	entry(284, 3, 1, 1);
	entry(50706, 1, 4, 0x00000401);
	u32(entryOffset, 0);
	u16(bitsOffset, 8);
	u16(bitsOffset + 2, 8);
	u16(bitsOffset + 4, 8);
	let nextPixel = pixelOffset;
	for(let strip = 0; strip < strips; strip++) {
		const rows = Math.min(rowsPerStrip, height - strip * rowsPerStrip);
		u32(stripOffsetsOffset + strip * 4, nextPixel);
		u32(stripByteCountsOffset + strip * 4, rows * rowBytes);
		nextPixel += rows * rowBytes;
	}
	for(let y = 0; y < height; y++) {
		for(let x = 0; x < width; x++) {
			const target = pixelOffset + (y * width + x) * 3;
			bytes[target] = Math.round((x + 1) * 255 / (width + 1));
			bytes[target + 1] = Math.round((y + 1) * 255 / (height + 1));
			bytes[target + 2] = Math.round((x + y + 2) * 255 / (width + height + 2));
		}
	}
	return {bytes, pixelOffset, rowBytes};
}

export function makeEmbeddedJpegRaw({
	width = 8,
	height = 6,
	orientation = 1,
	jpegLength = 128,
	trailingBytes = 1024
} = {}) {
	const firstIfdOffset = 8;
	const firstEntries = 2;
	const firstIfdSize = 2 + firstEntries * 12 + 4;
	const previewIfdOffset = firstIfdOffset + firstIfdSize;
	const previewEntries = 6;
	const previewIfdSize = 2 + previewEntries * 12 + 4;
	const jpegOffset = previewIfdOffset + previewIfdSize + 64;
	const totalBytes = jpegOffset + jpegLength + trailingBytes;
	const bytes = new Uint8Array(totalBytes);
	const view = new DataView(bytes.buffer);
	const u16 = (offset, value) => view.setUint16(offset, value, true);
	const u32 = (offset, value) => view.setUint32(offset, value, true);
	const writeIfd = (offset, entries, nextOffset) => {
		u16(offset, entries.length);
		let entryOffset = offset + 2;
		for(const [tag, type, value] of entries) {
			u16(entryOffset, tag);
			u16(entryOffset + 2, type);
			u32(entryOffset + 4, 1);
			if(type === 3) u16(entryOffset + 8, value);
			else u32(entryOffset + 8, value);
			entryOffset += 12;
		}
		u32(entryOffset, nextOffset);
	};

	bytes.set([0x49, 0x49]);
	u16(2, 42);
	u32(4, firstIfdOffset);
	writeIfd(firstIfdOffset, [
		[259, 3, 6],
		[274, 3, orientation]
	], previewIfdOffset);
	writeIfd(previewIfdOffset, [
		[256, 4, width],
		[257, 4, height],
		[259, 3, 7],
		[274, 3, orientation],
		[513, 4, jpegOffset],
		[514, 4, jpegLength]
	], 0);
	bytes[jpegOffset] = 0xff;
	bytes[jpegOffset + 1] = 0xd8;
	bytes.fill(0x5a, jpegOffset + 2, jpegOffset + jpegLength - 2);
	bytes[jpegOffset + jpegLength - 2] = 0xff;
	bytes[jpegOffset + jpegLength - 1] = 0xd9;
	return {
		bytes,
		jpegOffset,
		jpegLength,
		metadataBytes: previewIfdOffset + previewIfdSize
	};
}
