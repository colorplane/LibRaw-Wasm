import LibRawModule from './libraw.js';

let ready;
let LibRawClass;
let raw;
let module;

async function initLibRaw() {
	ready = (async () => {
		module = await LibRawModule();
		LibRawClass = module.LibRaw;
		raw = new LibRawClass();
	})();
}

initLibRaw();

function isTypedArray(obj) {
	return ArrayBuffer.isView(obj) && !(obj instanceof DataView);
}

self.onmessage = async (event) => {
	const {id, fn, args} = event.data;
	try {
		await ready;
		if (fn === 'openIncrementalInput') {
			self.postMessage({
				id,
				event: 'incremental-open-start',
				timestamp: performance.now()
			});
		}
		let out;
		if (fn === 'warmup') {
			out = true;
		} else if (fn === 'openBlob') {
			const readStart = performance.now();
			const bytes = new Uint8Array(await args[0].arrayBuffer());
			const fileReadMs = performance.now() - readStart;
			const openStart = performance.now();
			raw.open(bytes, args[1]);
			out = {fileReadMs, openMs: performance.now() - openStart};
		} else {
			out = raw[fn](...args);
		}
		if (fn === 'beginIncrementalInput') {
			out.heapBuffer = out.sharedView.buffer;
			delete out.sharedView;
		}
		const transferList = [];
		for (const key in out) {
			const value = out[key];
			if (isTypedArray(value))
				transferList.push(value.buffer);
		}
		self.postMessage({id, out}, transferList);
	} catch (err) {
		self.postMessage({id, error: err.message});
	}
};
