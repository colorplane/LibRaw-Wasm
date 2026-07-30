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
