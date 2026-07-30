export default class LibRaw {
	constructor() {
		this.worker = new Worker(new URL('./worker.js', import.meta.url), {type:"module"});
		this.pending = new Map();      // id -> { resolve, reject }
		this.nextId = 0;
		this.tail = Promise.resolve(); // serializes calls on this (stateful) instance
		this.disposed = false;
		this.incrementalControl = null;
		this.incrementalReader = null;
		this.worker.onmessage = ({data}) => {
			let slot = this.pending.get(data?.id);
			if(!slot) {
				return; // unknown or already-settled reply: ignore, never hang
			}
			if(data?.event) {
				slot.onEvent?.(data);
				return;
			}
			this.pending.delete(data.id);
			if(data?.error) {
				slot.reject(new Error(data.error));
			} else {
				slot.resolve(data?.out);
			}
		};
	}

	/**
	 * Dispose of the worker. Rejects any in-flight calls; the instance is unusable afterwards.
	 */
	dispose() {
		this.abortIncrementalInput();
		this.disposed = true;
		this.worker.terminate();
		for(let {reject} of this.pending.values()) {
			reject(new Error('LibRaw disposed'));
		}
		this.pending.clear();
	}

	runFnWithEvents(fn, args, onEvent) {
		let exec = () => new Promise((resolve, reject)=>{
			if(this.disposed) { // disposed while queued behind an earlier call
				reject(new Error('LibRaw disposed'));
				return;
			}
			let id = this.nextId++;
			this.pending.set(id, {resolve, reject, onEvent});
			this.worker.postMessage({id, fn, args}, args.map(a=>{
				if([ArrayBuffer, Uint8Array, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array, Float32Array, Float64Array].some(b=>a instanceof b)) { // Transfer buffer
					return a.buffer;
				}
			}).filter(a=>a));
		});
		// Only one call in flight per instance; a rejection must not break the chain.
		let result = this.tail.then(exec, exec);
		this.tail = result.then(()=>{}, ()=>{});
		return result;
	}

	runFn(fn, ...args) {
		return this.runFnWithEvents(fn, args);
	}

	static supportsIncrementalInput() {
		return typeof SharedArrayBuffer === 'function' &&
			typeof Atomics === 'object' &&
			typeof Atomics.wait === 'function';
	}

	abortIncrementalInput(state = 2) {
		const control = this.incrementalControl;
		if(control) {
			Atomics.store(control, 1, state);
			Atomics.add(control, 2, 1);
			Atomics.notify(control, 2);
		}
		try {
			this.incrementalReader?.cancel?.();
		} catch {}
	}

	/**
	 * Open/parse the RAW data with optional settings
	 */
	async open(buffer, settings) {
		return await this.runFn('open', buffer, settings);
	}

	/**
	 * Incrementally open RAW data from a ReadableStream or async iterable.
	 *
	 * Incoming chunks are copied once into the worker's shared WASM allocation.
	 * LibRaw reads that allocation through a blocking random-access datastream,
	 * so identify work can overlap the producer while preserving synchronous
	 * seek/read semantics.
	 */
	async openStream(source, settings, {
		expectedSize = 0,
		maxBytes = 512 * 1024 * 1024,
		signal,
		onProgress,
		onEvent
	} = {}) {
		if(!LibRaw.supportsIncrementalInput()) {
			throw new Error('LibRaw incremental input requires SharedArrayBuffer and Atomics');
		}
		if(this.disposed) throw new Error('LibRaw disposed');
		const normalizedExpectedSize = Math.max(0, Math.trunc(Number(expectedSize) || 0));
		const normalizedMaxBytes = Math.max(1, Math.trunc(Number(maxBytes) || 0));
		const capacity = normalizedExpectedSize || normalizedMaxBytes;
		if(capacity > normalizedMaxBytes || capacity > 0x7fffffff) {
			throw new RangeError('LibRaw incremental input exceeds its configured memory bound');
		}
		if(signal?.aborted) throw new DOMException('LibRaw incremental input aborted', 'AbortError');

		let reader;
		let iterator;
		if(source?.getReader) {
			reader = source.getReader();
		} else if(source?.[Symbol.asyncIterator]) {
			iterator = source[Symbol.asyncIterator]();
		} else {
			throw new TypeError('LibRaw openStream() expects a ReadableStream or async iterable');
		}

		const prepared = await this.runFn(
			'beginIncrementalInput',
			capacity,
			normalizedExpectedSize,
			settings
		);
		if(!(prepared?.heapBuffer instanceof SharedArrayBuffer)) {
			throw new Error('LibRaw worker did not expose shared incremental input memory');
		}
		const bytes = new Uint8Array(
			prepared.heapBuffer,
			prepared.bufferOffset,
			prepared.capacity
		);
		const control = new Int32Array(
			prepared.heapBuffer,
			prepared.controlOffset,
			4
		);
		this.incrementalControl = control;
		this.incrementalReader = reader || iterator;

		let downloaded = 0;
		let downloadCompletedAt = 0;
		let libRawStartedAt = 0;
		const startedAt = performance.now();
		let producerError;
		let aborted = false;
		const wake = (state, finalSize = downloaded) => {
			Atomics.store(control, 3, finalSize);
			Atomics.store(control, 1, state);
			Atomics.add(control, 2, 1);
			Atomics.notify(control, 2);
		};
		const abortHandler = () => {
			aborted = true;
			wake(2);
			try {
				(reader || iterator)?.cancel?.();
				iterator?.return?.();
			} catch {}
		};
		signal?.addEventListener('abort', abortHandler, {once:true});

		const openPromise = this.runFnWithEvents(
			'openIncrementalInput',
			[],
			event => {
				if(event.event !== 'incremental-open-start') return;
				// Worker and Window performance clocks are not guaranteed to
				// share a time origin. Timestamp receipt on the producer clock
				// so overlap comparisons are valid.
				libRawStartedAt = performance.now();
				onEvent?.({
					type: 'libraw-start',
					timestamp: libRawStartedAt,
					workerTimestamp: event.timestamp,
					downloadedBytes: downloaded
				});
			}
		);

		const pumpPromise = (async () => {
			try {
				for(;;) {
					if(aborted || signal?.aborted) {
						throw new DOMException('LibRaw incremental input aborted', 'AbortError');
					}
					const next = reader ? await reader.read() : await iterator.next();
					if(next.done) break;
					const chunk = next.value instanceof Uint8Array
						? next.value
						: new Uint8Array(next.value);
					if(!chunk.byteLength) continue;
					if(downloaded + chunk.byteLength > capacity) {
						throw new RangeError('LibRaw incremental input exceeds its configured memory bound');
					}
					bytes.set(chunk, downloaded);
					downloaded += chunk.byteLength;
					Atomics.store(control, 0, downloaded);
					Atomics.add(control, 2, 1);
					Atomics.notify(control, 2);
					const timestamp = performance.now();
					onProgress?.({
						bytesRead: downloaded,
						totalBytes: normalizedExpectedSize || undefined,
						elapsedMs: timestamp - startedAt,
						bytesPerSecond: downloaded * 1000 / Math.max(1, timestamp - startedAt)
					});
				}
				downloadCompletedAt = performance.now();
				wake(1);
				onEvent?.({
					type: 'download-complete',
					timestamp: downloadCompletedAt,
					downloadedBytes: downloaded
				});
			} catch(error) {
				producerError = error;
				wake(error?.name === 'AbortError' ? 2 : 3);
				throw error;
			}
		})();

		try {
			await Promise.all([openPromise, pumpPromise]);
			return {
				bytesRead: downloaded,
				totalBytes: normalizedExpectedSize || downloaded,
				timings: {
					startedAt,
					libRawStartedAt,
					downloadCompletedAt,
					overlapMs: libRawStartedAt && downloadCompletedAt
						? Math.max(0, downloadCompletedAt - libRawStartedAt)
						: 0
				}
			};
		} catch(error) {
			const userAborted = Boolean(
				signal?.aborted ||
				aborted ||
				producerError?.name === 'AbortError'
			);
			abortHandler();
			await Promise.allSettled([openPromise, pumpPromise]);
			try {
				await this.runFn('resetIncrementalInput');
			} catch {}
			if(userAborted) {
				throw new DOMException('LibRaw incremental input aborted', 'AbortError');
			}
			throw producerError || error;
		} finally {
			signal?.removeEventListener('abort', abortHandler);
			if(this.incrementalControl === control) this.incrementalControl = null;
			if(this.incrementalReader === reader || this.incrementalReader === iterator) {
				this.incrementalReader = null;
			}
			reader?.releaseLock?.();
		}
	}

	/**
	 * Retrieve metadata
	 */
	async metadata(fullOutput) {
		let metadata = await this.runFn('metadata', !!fullOutput);
		// Example: convert numeric thumb_format to a string
		if (metadata?.hasOwnProperty('thumb_format')) {
			metadata.thumb_format = [
				'unknown',
				'jpeg',
				'bitmap',
				'bitmap16',
				'layer',
				'rollei',
				'h265'
			][metadata.thumb_format] || 'unknown';
		}
		// Trim desc if present
		if (metadata?.hasOwnProperty('desc')) {
			metadata.desc = String(metadata.desc).trim();
		}
		if (metadata?.hasOwnProperty('timestamp')) {
			// LibRaw's timestamp is a time_t in epoch seconds; JS Date expects milliseconds.
			metadata.timestamp = new Date(metadata.timestamp * 1000);
		}
		return metadata;
	}

	/**
	 * Retrieve processed image data (synchronously from the perspective of C++,
	 * but we've already awaited the module & instance.)
	 */
	async imageData() {
		return await this.runFn('imageData');
	}

	/**
	 * Reprocess the opened RAW image with new output settings. The source is
	 * unpacked only once and remains in the worker between renders.
	 */
	async render(settings) {
		return await this.runFn('render', settings);
	}

	/**
	 * Retrieve the raw, undebayered sensor data (16-bit mosaic, no demosaicing).
	 */
	async rawImageData() {
		return await this.runFn('rawImageData');
	}

	/**
	 * Retrieve a compact 16-bit RGB/mono overview of the raw sensor plane.
	 * The full unpacked mosaic stays in the worker for a later rawImageData().
	 */
	async rawImagePreview(maxDimension = 1024) {
		return await this.runFn('rawImagePreview', Math.max(1, Math.round(maxDimension)));
	}

	/**
     * Retrieve the embedded JPEG preview (Fast extraction)
     */
    async thumbnailData() {
        return await this.runFn('thumbnailData');
    }
}
