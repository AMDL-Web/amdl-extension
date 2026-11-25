import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

interface TemariExports {
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

describe("temari-wasm golden vector", () => {
  it("decrypts track_1720704575_s1 byte-for-byte identically and preserves unaligned tail", async () => {
    const wasmBytes = readFileSync(path.resolve("src/wasm/temari.wasm"));
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    const exp = instance.exports as unknown as TemariExports;

    const jsonBytes = readFileSync(
      path.resolve("tests/fixtures/fairplay/track_1720704575_s1.json"),
    );
    const ct = readFileSync(
      path.resolve("tests/fixtures/fairplay/track_1720704575_s1.ct"),
    );
    const pt = readFileSync(
      path.resolve("tests/fixtures/fairplay/track_1720704575_s1.pt"),
    );

    const jsonPtr = exp.wasm_alloc(jsonBytes.length);
    new Uint8Array(exp.memory.buffer, jsonPtr, jsonBytes.length).set(jsonBytes);
    const handle = exp.template_new(jsonPtr, jsonBytes.length);
    exp.wasm_dealloc(jsonPtr, jsonBytes.length);
    expect(handle).toBeGreaterThan(0);

    // Pack two copies of the sample back-to-back to exercise batching + non-zero offset + unaligned tail (9354 % 16 === 10).
    const totalLen = ct.length * 2;
    const bufPtr = exp.wasm_alloc(totalLen);
    const tablePtr = exp.wasm_alloc(16);
    new Uint8Array(exp.memory.buffer, bufPtr, ct.length).set(ct);
    new Uint8Array(exp.memory.buffer, bufPtr + ct.length, ct.length).set(ct);

    const tv = new DataView(exp.memory.buffer, tablePtr, 16);
    tv.setUint32(0, 0, true);
    tv.setUint32(4, ct.length, true);
    tv.setUint32(8, ct.length, true);
    tv.setUint32(12, ct.length, true);

    const status = exp.decrypt_samples(handle, bufPtr, totalLen, tablePtr, 2);
    expect(status).toBe(0);

    const out1 = Buffer.from(new Uint8Array(exp.memory.buffer, bufPtr, ct.length));
    const out2 = Buffer.from(
      new Uint8Array(exp.memory.buffer, bufPtr + ct.length, ct.length),
    );
    expect(out1.equals(pt)).toBe(true);
    expect(out2.equals(pt)).toBe(true);

    // Bounds check rejection
    tv.setUint32(0, totalLen - 4, true);
    tv.setUint32(4, 16, true);
    expect(exp.decrypt_samples(handle, bufPtr, totalLen, tablePtr, 1)).toBe(-3);

    exp.template_free(handle);
    // Invalid handle after free
    expect(exp.decrypt_samples(handle, bufPtr, totalLen, tablePtr, 1)).toBe(-1);

    exp.wasm_dealloc(tablePtr, 16);
    exp.wasm_dealloc(bufPtr, totalLen);
  });
});
