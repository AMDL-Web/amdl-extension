import { TemariWasmInstance } from "../core/fairplay.ts";

interface WorkerInitMessage {
  type: "init";
  wasmUrl: string;
}

interface WorkerDecryptMessage {
  type: "decrypt";
  id: number;
  keyUri: string;
  templateJson?: string;
  data: ArrayBuffer;
  table: ArrayBuffer;
}

type WorkerIncoming = WorkerInitMessage | WorkerDecryptMessage;

let wasmPromise: Promise<TemariWasmInstance> | null = null;
const loadedKeys = new Set<string>();

async function ensureWasm(wasmUrl: string): Promise<TemariWasmInstance> {
  if (!wasmPromise) {
    wasmPromise = (async () => {
      const resp = await fetch(wasmUrl);
      if (!resp.ok) {
        throw new Error(`fetch temari.wasm failed: ${resp.status}`);
      }
      const bytes = await resp.arrayBuffer();
      return TemariWasmInstance.fromBytes(bytes);
    })();
  }
  return wasmPromise;
}

self.onmessage = async (ev: MessageEvent<WorkerIncoming>) => {
  const msg = ev.data;
  if (msg.type === "init") {
    try {
      await ensureWasm(msg.wasmUrl);
      self.postMessage({ type: "ready" });
    } catch (err) {
      self.postMessage({
        type: "init-error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  if (msg.type === "decrypt") {
    try {
      if (!wasmPromise) {
        throw new Error("fairplay worker not initialized");
      }
      const wasm = await wasmPromise;
      if (msg.templateJson && !loadedKeys.has(msg.keyUri)) {
        wasm.ensureTemplate(msg.keyUri, msg.templateJson);
        loadedKeys.add(msg.keyUri);
      }
      const dataView = new Uint8Array(msg.data);
      const tableView = new Uint32Array(msg.table);
      wasm.decryptBatchInPlace(
        msg.keyUri,
        msg.templateJson ?? "",
        dataView,
        tableView,
      );
      self.postMessage(
        { type: "result", id: msg.id, ok: true, data: msg.data },
        { transfer: [msg.data] },
      );
    } catch (err) {
      self.postMessage({
        type: "result",
        id: msg.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
};
