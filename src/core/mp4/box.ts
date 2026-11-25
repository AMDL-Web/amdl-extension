export interface RawBox {
  type: string;
  hdr: number; // 8 or 16
  off: number; // byte offset within the parsed buffer
  data: Uint8Array; // full box including header (subarray alias)
}

const latin1Decoder = new TextDecoder("latin1");

export function readFourCC(buf: Uint8Array, off: number): string {
  return latin1Decoder.decode(buf.subarray(off, off + 4));
}

export function writeFourCC(buf: Uint8Array, off: number, fourcc: string): void {
  for (let i = 0; i < 4; i++) {
    buf[off + i] = fourcc.charCodeAt(i) & 0xff;
  }
}

export function readU16(buf: Uint8Array, off: number): number {
  return ((buf[off]! << 8) | buf[off + 1]!) >>> 0;
}

export function readI16(buf: Uint8Array, off: number): number {
  const v = readU16(buf, off);
  return v >= 0x8000 ? v - 0x10000 : v;
}

export function readU32(buf: Uint8Array, off: number): number {
  return (
    ((buf[off]! << 24) |
      (buf[off + 1]! << 16) |
      (buf[off + 2]! << 8) |
      buf[off + 3]!) >>>
    0
  );
}

export function readI32(buf: Uint8Array, off: number): number {
  return (
    (buf[off]! << 24) |
    (buf[off + 1]! << 16) |
    (buf[off + 2]! << 8) |
    buf[off + 3]!
  );
}

export function readU64(buf: Uint8Array, off: number): bigint {
  const hi = BigInt(readU32(buf, off));
  const lo = BigInt(readU32(buf, off + 4));
  return (hi << 32n) | lo;
}

export function readI64(buf: Uint8Array, off: number): bigint {
  const u = readU64(buf, off);
  return u >= 1n << 63n ? u - (1n << 64n) : u;
}

export function writeU16(buf: Uint8Array, off: number, val: number): void {
  buf[off] = (val >>> 8) & 0xff;
  buf[off + 1] = val & 0xff;
}

export function writeU32(buf: Uint8Array, off: number, val: number): void {
  buf[off] = (val >>> 24) & 0xff;
  buf[off + 1] = (val >>> 16) & 0xff;
  buf[off + 2] = (val >>> 8) & 0xff;
  buf[off + 3] = val & 0xff;
}

export function writeU64(buf: Uint8Array, off: number, val: bigint): void {
  const u = BigInt.asUintN(64, val);
  writeU32(buf, off, Number((u >> 32n) & 0xffffffffn));
  writeU32(buf, off + 4, Number(u & 0xffffffffn));
}

export function be16(v: number): Uint8Array {
  const out = new Uint8Array(2);
  writeU16(out, 0, v);
  return out;
}

export function be32(v: number): Uint8Array {
  const out = new Uint8Array(4);
  writeU32(out, 0, v);
  return out;
}

export function be64(v: bigint): Uint8Array {
  const out = new Uint8Array(8);
  writeU64(out, 0, v);
  return out;
}

export function boxBody(b: RawBox): Uint8Array {
  return b.data.subarray(b.hdr);
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

/**
 * Splits `buf` into consecutive ISO BMFF boxes. A size of 0 means "to end of
 * buf". A trailing fragment < 8 bytes is returned in `rest` (matching Go
 * `m4a/box.go#parseBoxes`).
 */
export function parseBoxes(
  buf: Uint8Array,
): { boxes: RawBox[]; rest: Uint8Array } {
  const boxes: RawBox[] = [];
  let off = 0;
  while (off < buf.byteLength) {
    if (buf.byteLength - off < 8) {
      return { boxes, rest: buf.subarray(off) };
    }
    let size = BigInt(readU32(buf, off));
    const type = readFourCC(buf, off + 4);
    let hdr = 8;
    if (size === 0n) {
      size = BigInt(buf.byteLength - off);
    } else if (size === 1n) {
      if (buf.byteLength - off < 16) {
        throw new Error(`box "${type}" at ${off}: truncated 64-bit size`);
      }
      size = readU64(buf, off + 8);
      hdr = 16;
    }
    if (size < BigInt(hdr) || size > BigInt(buf.byteLength - off)) {
      throw new Error(
        `box "${type}" at ${off}: size ${size} does not fit in ${buf.byteLength - off} bytes`,
      );
    }
    const sizeNum = Number(size);
    boxes.push({
      type,
      hdr,
      off,
      data: buf.subarray(off, off + sizeNum),
    });
    off += sizeNum;
  }
  return { boxes, rest: new Uint8Array(0) };
}

export function boxesTile(buf: Uint8Array): boolean {
  let off = 0;
  while (off < buf.byteLength) {
    if (buf.byteLength - off < 8) return false;
    let size = BigInt(readU32(buf, off));
    let hdr = 8;
    if (size === 0n) {
      size = BigInt(buf.byteLength - off);
    } else if (size === 1n) {
      if (buf.byteLength - off < 16) return false;
      size = readU64(buf, off + 8);
      hdr = 16;
    }
    if (size < BigInt(hdr) || size > BigInt(buf.byteLength - off)) {
      return false;
    }
    off += Number(size);
  }
  return off === buf.byteLength;
}

export function findBox(
  boxes: readonly RawBox[],
  type: string,
): RawBox | undefined {
  return boxes.find((b) => b.type === type);
}

export function boxBytes(type: string, ...parts: Uint8Array[]): Uint8Array {
  let payloadLen = 0;
  for (const p of parts) payloadLen += p.byteLength;
  const n32 = 8 + payloadLen;
  if (n32 > 0xffffffff) {
    const total = BigInt(16) + BigInt(payloadLen);
    const out = new Uint8Array(16 + payloadLen);
    writeU32(out, 0, 1);
    writeFourCC(out, 4, type);
    writeU64(out, 8, total);
    let off = 16;
    for (const p of parts) {
      out.set(p, off);
      off += p.byteLength;
    }
    return out;
  }
  const out = new Uint8Array(n32);
  writeU32(out, 0, n32);
  writeFourCC(out, 4, type);
  let off = 8;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

export function fullBoxBytes(
  type: string,
  version: number,
  flags: number,
  ...parts: Uint8Array[]
): Uint8Array {
  const vf = new Uint8Array([
    version & 0xff,
    (flags >>> 16) & 0xff,
    (flags >>> 8) & 0xff,
    flags & 0xff,
  ]);
  return boxBytes(type, vf, ...parts);
}

export function metaPrefixLen(body: Uint8Array): number {
  if (body.byteLength >= 8 && readFourCC(body, 4) === "hdlr") {
    return 0;
  }
  return 4;
}
