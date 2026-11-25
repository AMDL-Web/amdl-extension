import type { ParsedFragment } from "./mp4/fragments.ts";
import type { Logger } from "./types.ts";

export interface TemariWasmExports {
  memory: WebAssembly.Memory;
  wasm_alloc(len: number): number;
  wasm_dealloc(ptr: number, len: number): void;
  template_new(ptr: number, len: number): number;
  template_free(handle: number): void;
  decrypt_samples(
    handle: number,
    bufPtr: number,
    bufLen: number,
    tablePtr: number,
    count: number,
  ): number;
}

/**
 * Reusable single-instance wrapper over `temari.wasm`.
 * Keeps parsed template handles cached by keyUri and reuses grow-only wasm
 * scratch buffers for sample data and sample tables (zero per-batch leaks).
 */
export class TemariWasmInstance {
  private readonly exp: TemariWasmExports;
  private readonly handles = new Map<string, number>();
  private dataPtr = 0;
  private dataCap = 0;
  private tablePtr = 0;
  private tableCap = 0;

  private constructor(exp: TemariWasmExports) {
    this.exp = exp;
  }

  static async fromBytes(wasmBytes: BufferSource): Promise<TemariWasmInstance> {
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    return new TemariWasmInstance(
      instance.exports as unknown as TemariWasmExports,
    );
  }

  static async fromModule(
    module: WebAssembly.Module,
  ): Promise<TemariWasmInstance> {
    const instance = await WebAssembly.instantiate(module, {});
    return new TemariWasmInstance(
      instance.exports as unknown as TemariWasmExports,
    );
  }

  private ensureDataBuf(len: number): number {
    if (len > this.dataCap) {
      if (this.dataPtr !== 0) {
        this.exp.wasm_dealloc(this.dataPtr, this.dataCap);
        this.dataPtr = 0;
        this.dataCap = 0;
      }
      const nextCap = Math.max(len, 256 * 1024);
      const ptr = this.exp.wasm_alloc(nextCap);
      if (ptr === 0) throw new Error(`temari-wasm: wasm_alloc(${nextCap}) failed`);
      this.dataPtr = ptr;
      this.dataCap = nextCap;
    }
    return this.dataPtr;
  }

  private ensureTableBuf(byteLen: number): number {
    if (byteLen > this.tableCap) {
      if (this.tablePtr !== 0) {
        this.exp.wasm_dealloc(this.tablePtr, this.tableCap);
        this.tablePtr = 0;
        this.tableCap = 0;
      }
      const nextCap = Math.max(byteLen, 4096);
      const ptr = this.exp.wasm_alloc(nextCap);
      if (ptr === 0) throw new Error(`temari-wasm: wasm_alloc(${nextCap}) failed`);
      this.tablePtr = ptr;
      this.tableCap = nextCap;
    }
    return this.tablePtr;
  }

  ensureTemplate(keyUri: string, templateJson: string): number {
    const existing = this.handles.get(keyUri);
    if (existing !== undefined) return existing;
    const jsonBytes = new TextEncoder().encode(templateJson);
    const ptr = this.exp.wasm_alloc(jsonBytes.byteLength);
    if (ptr === 0) {
      throw new Error("temari-wasm: wasm_alloc for template JSON failed");
    }
    new Uint8Array(this.exp.memory.buffer, ptr, jsonBytes.byteLength).set(
      jsonBytes,
    );
    const handle = this.exp.template_new(ptr, jsonBytes.byteLength);
    this.exp.wasm_dealloc(ptr, jsonBytes.byteLength);
    if (handle === 0) {
      throw new Error(`temari-wasm: invalid template JSON for ${keyUri}`);
    }
    this.handles.set(keyUri, handle);
    return handle;
  }

  /**
   * Decrypts `data` in place using `(offset, size)` pairs in `table`
   * (`table.length === count * 2`).
   */
  decryptBatchInPlace(
    keyUri: string,
    templateJson: string,
    data: Uint8Array,
    table: Uint32Array,
  ): void {
    const count = table.length >>> 1;
    if (count === 0 || data.byteLength === 0) return;
    const handle = this.ensureTemplate(keyUri, templateJson);
    const dPtr = this.ensureDataBuf(data.byteLength);
    const tPtr = this.ensureTableBuf(table.byteLength);

    // Re-read memory.buffer after any alloc in case memory grew.
    new Uint8Array(this.exp.memory.buffer, dPtr, data.byteLength).set(data);
    new Uint32Array(this.exp.memory.buffer, tPtr, table.length).set(table);

    const status = this.exp.decrypt_samples(
      handle,
      dPtr,
      data.byteLength,
      tPtr,
      count,
    );
    if (status !== 0) {
      throw new Error(`temari-wasm: decrypt_samples failed with status ${status}`);
    }
    data.set(new Uint8Array(this.exp.memory.buffer, dPtr, data.byteLength));
  }

  dispose(): void {
    for (const handle of this.handles.values()) {
      this.exp.template_free(handle);
    }
    this.handles.clear();
    if (this.dataPtr !== 0) {
      this.exp.wasm_dealloc(this.dataPtr, this.dataCap);
      this.dataPtr = 0;
      this.dataCap = 0;
    }
    if (this.tablePtr !== 0) {
      this.exp.wasm_dealloc(this.tablePtr, this.tableCap);
      this.tablePtr = 0;
      this.tableCap = 0;
    }
  }
}

export interface FairPlayDecryptor {
  decryptBatch(
    keyUri: string,
    templateJson: string,
    data: Uint8Array,
    table: Uint32Array,
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
  concurrency(): number;
  dispose?(): void;
}

export class SingleThreadFairPlayDecryptor implements FairPlayDecryptor {
  private readonly wasm: TemariWasmInstance;

  constructor(wasm: TemariWasmInstance) {
    this.wasm = wasm;
  }

  concurrency(): number {
    return 1;
  }

  async decryptBatch(
    keyUri: string,
    templateJson: string,
    data: Uint8Array,
    table: Uint32Array,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    this.wasm.decryptBatchInPlace(keyUri, templateJson, data, table);
    return data;
  }

  dispose(): void {
    this.wasm.dispose();
  }
}

interface BatchPlan {
  keyUri: string;
  fragments: ParsedFragment[];
  totalBytes: number;
  sampleCount: number;
}

const MIN_BATCH_BYTES = 256 * 1024;

/**
 * Decrypts all FairPlay-encrypted fragments in `buf` in place.
 * Batches consecutive same-key fragments to >= 256 KiB and dispatches across
 * `decryptor` up to `decryptor.concurrency()` in flight at once.
 */
export async function decryptFairPlayInPlace(
  buf: Uint8Array,
  fragments: readonly ParsedFragment[],
  keys: readonly string[],
  getTemplateJson: (keyUri: string) => Promise<string>,
  decryptor: FairPlayDecryptor,
  opts: {
    signal?: AbortSignal;
    logger?: Logger;
    onProgress?: (doneBytes: number, totalBytes: number) => void;
  } = {},
): Promise<{ notes: string[] }> {
  if (fragments.length === 0) {
    throw new Error("no fragments extracted from media");
  }
  if (keys.length === 0) {
    throw new Error("fairplay decrypt: no keys available");
  }

  const notes: string[] = [];
  let keyFallbacks = 0;
  let unkeyedDesc = 0;

  // Group consecutive fragments with the same keyUri into >= 256 KiB batches.
  const batches: BatchPlan[] = [];
  let current: BatchPlan | null = null;
  let totalSampleBytes = 0;

  for (const frag of fragments) {
    const descIndex = frag.sampleDescriptionIndex;
    let keyIndex = Math.max(0, descIndex - 1);
    if (keyIndex >= keys.length) {
      keyIndex = 0;
      keyFallbacks++;
      unkeyedDesc = descIndex;
    }
    const keyUri = keys[keyIndex]!;
    let fragBytes = 0;
    for (const c of frag.chunks) fragBytes += c.end - c.start;
    totalSampleBytes += fragBytes;

    if (
      current &&
      current.keyUri === keyUri &&
      current.totalBytes < MIN_BATCH_BYTES
    ) {
      current.fragments.push(frag);
      current.totalBytes += fragBytes;
      current.sampleCount += frag.samples.length;
    } else {
      current = {
        keyUri,
        fragments: [frag],
        totalBytes: fragBytes,
        sampleCount: frag.samples.length,
      };
      batches.push(current);
    }
  }

  if (keyFallbacks > 0) {
    const msg = `${keyFallbacks}/${fragments.length} fragments referenced unkeyed sample description ${unkeyedDesc}; fell back to keys[0]`;
    opts.logger?.warn(msg);
    notes.push(msg);
  }

  // Ensure all required templates are resolved before launching worker batches.
  const neededKeys = Array.from(new Set(batches.map((b) => b.keyUri)));
  const templateByKey = new Map<string, string>();
  await Promise.all(
    neededKeys.map(async (k) => {
      templateByKey.set(k, await getTemplateJson(k));
    }),
  );

  let nextIdx = 0;
  let doneBytes = 0;
  let lastProgressAt = 0;
  const maxInFlight = Math.max(1, decryptor.concurrency());

  const runBatch = async (batch: BatchPlan): Promise<void> => {
    if (opts.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    if (batch.totalBytes === 0 || batch.sampleCount === 0) return;

    // Pack all chunks of this batch tightly into a single contiguous buffer so
    // only sample payload bytes cross worker boundaries.
    const packed = new Uint8Array(new ArrayBuffer(batch.totalBytes));
    const table = new Uint32Array(new ArrayBuffer(batch.sampleCount * 8));
    const chunkCopyMap: { dstOff: number; srcOff: number; len: number }[] = [];

    let packedOff = 0;
    let tableIdx = 0;
    for (const frag of batch.fragments) {
      // Build sample-to-packed offset map using chunk starts.
      let fragSampleCursor = 0;
      for (const c of frag.chunks) {
        const len = c.end - c.start;
        packed.set(buf.subarray(c.start, c.end), packedOff);
        chunkCopyMap.push({ dstOff: c.start, srcOff: packedOff, len });

        // Samples inside this chunk are laid out starting at c.start.
        const delta = packedOff - c.start;
        for (let k = 0; k < c.sampleCount; k++) {
          const s = frag.samples[fragSampleCursor++]!;
          table[tableIdx++] = s.offset + delta;
          table[tableIdx++] = s.size;
        }
        packedOff += len;
      }
    }

    const templateJson = templateByKey.get(batch.keyUri)!;
    const decrypted = await decryptor.decryptBatch(
      batch.keyUri,
      templateJson,
      packed,
      table,
      opts.signal,
    );

    // Write decrypted chunks back into `buf` in place.
    for (const m of chunkCopyMap) {
      buf.set(decrypted.subarray(m.srcOff, m.srcOff + m.len), m.dstOff);
    }

    doneBytes += batch.totalBytes;
    if (opts.onProgress) {
      const now = Date.now();
      if (now - lastProgressAt >= 100 || doneBytes >= totalSampleBytes) {
        lastProgressAt = now;
        opts.onProgress(doneBytes, totalSampleBytes);
      }
    }
  };

  const workerLoop = async () => {
    for (;;) {
      const idx = nextIdx++;
      if (idx >= batches.length) return;
      await runBatch(batches[idx]!);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(maxInFlight, batches.length) }, () =>
      workerLoop(),
    ),
  );

  return { notes };
}
