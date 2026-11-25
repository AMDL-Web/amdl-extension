// M0 spike FairPlay worker skeleton.

interface TemariExports {
  memory: WebAssembly.Memory;
  wasm_alloc(len: number): number;
  wasm_dealloc(ptr: number, len: number): void;
  template_new(ptr: number, len: number): number;
  template_free(handle: number): void;
  decrypt_samples(handle: number, bufPtr: number, bufLen: number, tablePtr: number, count: number): number;
}

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

self.onmessage = async (ev: MessageEvent<{
  wasmUrl: string;
  goldenJson: string;
  goldenCtBase64: string;
  goldenPtBase64: string;
}>) => {
  try {
    const { wasmUrl, goldenJson, goldenCtBase64, goldenPtBase64 } = ev.data;
    const resp = await fetch(wasmUrl);
    const bytes = await resp.arrayBuffer();
    const { instance } = await WebAssembly.instantiate(bytes, {});
    const exp = instance.exports as unknown as TemariExports;

    const jsonBytes = new TextEncoder().encode(goldenJson);
    const jsonPtr = exp.wasm_alloc(jsonBytes.length);
    new Uint8Array(exp.memory.buffer, jsonPtr, jsonBytes.length).set(jsonBytes);
    const handle = exp.template_new(jsonPtr, jsonBytes.length);
    exp.wasm_dealloc(jsonPtr, jsonBytes.length);
    if (handle === 0) {
      throw new Error("template_new returned 0");
    }

    const ct = decodeBase64(goldenCtBase64);
    const pt = decodeBase64(goldenPtBase64);
    const bufPtr = exp.wasm_alloc(ct.length);
    const tablePtr = exp.wasm_alloc(8);
    new Uint8Array(exp.memory.buffer, bufPtr, ct.length).set(ct);
    const tableView = new DataView(exp.memory.buffer, tablePtr, 8);
    tableView.setUint32(0, 0, true);
    tableView.setUint32(4, ct.length, true);

    const status = exp.decrypt_samples(handle, bufPtr, ct.length, tablePtr, 1);
    const decrypted = new Uint8Array(exp.memory.buffer, bufPtr, ct.length).slice();

    exp.wasm_dealloc(tablePtr, 8);
    exp.wasm_dealloc(bufPtr, ct.length);
    exp.template_free(handle);

    let match = status === 0 && decrypted.length === pt.length;
    if (match) {
      for (let i = 0; i < pt.length; i++) {
        if (decrypted[i] !== pt[i]) {
          match = false;
          break;
        }
      }
    }
    self.postMessage({ ok: match, status, byteLength: decrypted.length, wasmSize: bytes.byteLength });
  } catch (err) {
    self.postMessage({ ok: false, error: String(err) });
  }
};
