import type { FairPlayDecryptor } from "../core/fairplay.ts";

interface WorkerSlot {
  worker: Worker;
  busy: boolean;
  loadedKeys: Set<string>;
}

interface PendingJob {
  id: number;
  keyUri: string;
  templateJson: string;
  data: Uint8Array;
  table: Uint32Array;
  signal?: AbortSignal;
  resolve: (data: Uint8Array) => void;
  reject: (err: Error) => void;
}

const IDLE_TERMINATE_MS = 60_000;

/**
 * Multi-worker FairPlay decryption pool running `temari.wasm` inside classic
 * Web Workers (spawned from the MV3 offscreen document). Uses Transferable
 * ArrayBuffers (no SharedArrayBuffer/COOP/COEP) and terminates idle workers
 * after 60 s to release wasm linear memory.
 */
export class FairPlayWorkerPool implements FairPlayDecryptor {
  private readonly workerUrl: string;
  private readonly wasmUrl: string;
  private readonly maxWorkers: number;
  private readonly slots: WorkerSlot[] = [];
  private readonly queue: PendingJob[] = [];
  private readonly inFlight = new Map<
    number,
    { slot: WorkerSlot; job: PendingJob }
  >();
  private nextJobId = 1;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: {
    workerUrl: string;
    wasmUrl: string;
    maxWorkers?: number;
  }) {
    this.workerUrl = opts.workerUrl;
    this.wasmUrl = opts.wasmUrl;
    const hw =
      typeof navigator !== "undefined" && navigator.hardwareConcurrency
        ? navigator.hardwareConcurrency
        : 4;
    this.maxWorkers = Math.max(1, Math.min(opts.maxWorkers ?? hw, 8));
  }

  concurrency(): number {
    return this.maxWorkers;
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private scheduleIdleTimer(): void {
    if (this.inFlight.size > 0 || this.queue.length > 0) return;
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      if (this.inFlight.size === 0 && this.queue.length === 0) {
        this.dispose();
      }
    }, IDLE_TERMINATE_MS);
  }

  private createSlot(): WorkerSlot {
    const worker = new Worker(this.workerUrl);
    const slot: WorkerSlot = {
      worker,
      busy: false,
      loadedKeys: new Set(),
    };
    worker.onmessage = (
      ev: MessageEvent<{
        type: string;
        id?: number;
        ok?: boolean;
        data?: ArrayBuffer;
        error?: string;
      }>,
    ) => {
      const msg = ev.data;
      if (msg.type !== "result" || msg.id === undefined) return;
      const entry = this.inFlight.get(msg.id);
      if (!entry) return;
      this.inFlight.delete(msg.id);
      entry.slot.busy = false;
      if (msg.ok && msg.data) {
        entry.job.resolve(new Uint8Array(msg.data));
      } else {
        entry.job.reject(new Error(msg.error || "fairplay worker failed"));
      }
      this.pump();
      this.scheduleIdleTimer();
    };
    worker.onerror = (ev) => {
      const err = new Error(ev.message || "fairplay worker crashed");
      // Fail any job currently assigned to this slot and drop the crashed worker.
      for (const [id, entry] of this.inFlight.entries()) {
        if (entry.slot === slot) {
          this.inFlight.delete(id);
          entry.job.reject(err);
        }
      }
      const idx = this.slots.indexOf(slot);
      if (idx >= 0) this.slots.splice(idx, 1);
      worker.terminate();
      this.pump();
      this.scheduleIdleTimer();
    };
    worker.postMessage({ type: "init", wasmUrl: this.wasmUrl });
    this.slots.push(slot);
    return slot;
  }

  private acquireIdleSlot(): WorkerSlot | null {
    for (const s of this.slots) {
      if (!s.busy) return s;
    }
    if (this.slots.length < this.maxWorkers) {
      return this.createSlot();
    }
    return null;
  }

  private pump(): void {
    while (this.queue.length > 0) {
      const job = this.queue[0]!;
      if (job.signal?.aborted) {
        this.queue.shift();
        job.reject(new DOMException("Aborted", "AbortError"));
        continue;
      }
      const slot = this.acquireIdleSlot();
      if (!slot) return;
      this.queue.shift();
      slot.busy = true;
      this.clearIdleTimer();
      this.inFlight.set(job.id, { slot, job });

      // Ensure owned ArrayBuffers so transfer never detaches a caller's shared buffer.
      const dataBuf =
        job.data.byteOffset === 0 &&
        job.data.byteLength === job.data.buffer.byteLength &&
        job.data.buffer instanceof ArrayBuffer
          ? job.data.buffer
          : job.data.slice().buffer;
      const tableBuf =
        job.table.byteOffset === 0 &&
        job.table.byteLength === job.table.buffer.byteLength &&
        job.table.buffer instanceof ArrayBuffer
          ? job.table.buffer
          : job.table.slice().buffer;

      const sendTemplate = !slot.loadedKeys.has(job.keyUri);
      if (sendTemplate) {
        slot.loadedKeys.add(job.keyUri);
      }

      slot.worker.postMessage(
        {
          type: "decrypt",
          id: job.id,
          keyUri: job.keyUri,
          ...(sendTemplate ? { templateJson: job.templateJson } : {}),
          data: dataBuf,
          table: tableBuf,
        },
        [dataBuf, tableBuf],
      );
    }
  }

  decryptBatch(
    keyUri: string,
    templateJson: string,
    data: Uint8Array,
    table: Uint32Array,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    if (signal?.aborted) {
      return Promise.reject(new DOMException("Aborted", "AbortError"));
    }
    return new Promise<Uint8Array>((resolve, reject) => {
      const job: PendingJob = {
        id: this.nextJobId++,
        keyUri,
        templateJson,
        data,
        table,
        signal,
        resolve,
        reject,
      };
      if (signal) {
        const onAbort = () => {
          const qIdx = this.queue.indexOf(job);
          if (qIdx >= 0) {
            this.queue.splice(qIdx, 1);
            reject(new DOMException("Aborted", "AbortError"));
          }
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.queue.push(job);
      this.pump();
    });
  }

  dispose(): void {
    this.clearIdleTimer();
    for (const slot of this.slots) {
      slot.worker.terminate();
    }
    this.slots.length = 0;
  }
}
