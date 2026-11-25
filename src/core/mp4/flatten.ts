import type { MP4Tags } from "../types.ts";
import {
  type RawBox,
  be32,
  boxBody,
  boxBytes,
  concatBytes,
  findBox,
  fullBoxBytes,
  readU32,
  writeU32,
  writeU64,
} from "./box.ts";
import {
  type ElstEntry,
  type ParsedFragmentedMp4,
  type ParsedInit,
  parseFragmentedMp4,
} from "./fragments.ts";
import { retagMoov, rewriteIlst } from "./tags.ts";

// ftypM4A is the ftyp ffmpeg writes for `-f mp4 -brand "M4A "`.
const FTYP_M4A = new Uint8Array([
  0, 0, 0, 28, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20, 0, 0, 2, 0, 0x4d,
  0x34, 0x41, 0x20, 0x69, 0x73, 0x6f, 0x32, 0x6d, 0x70, 0x34, 0x31,
]);

// 28 (ftyp) + 16 (free+mdat32 or mdat64) = 44.
const MDAT_PAYLOAD_START = 44n;

interface SttsEntry {
  count: number;
  delta: number;
}

interface CttsEntry {
  count: number;
  offset: number;
}

interface ChunkRef {
  data: Uint8Array;
  n: number;
  sdi: number;
}

interface SampleTable {
  sizes: number[];
  stts: SttsEntry[];
  ctts: CttsEntry[];
  hasCtts: boolean;
  chunks: ChunkRef[];
  payload: bigint;
  mediaDur: bigint;
}

function createSampleTable(): SampleTable {
  return {
    sizes: [],
    stts: [],
    ctts: [],
    hasCtts: false,
    chunks: [],
    payload: 0n,
    mediaDur: 0n,
  };
}

function addSample(st: SampleTable, size: number, dur: number, cto: number): void {
  st.sizes.push(size);
  const lastStts = st.stts[st.stts.length - 1];
  if (lastStts && lastStts.delta === dur) {
    lastStts.count++;
  } else {
    st.stts.push({ count: 1, delta: dur });
  }
  const lastCtts = st.ctts[st.ctts.length - 1];
  if (lastCtts && lastCtts.offset === cto) {
    lastCtts.count++;
  } else {
    st.ctts.push({ count: 1, offset: cto });
  }
  if (cto !== 0) st.hasCtts = true;
  st.mediaDur += BigInt(dur);
}

/**
 * Gives a shortened final (E-)AC-3 sample the duration of the samples before it
 * (matching Go `m4a/flatten.go#padLastDuration` and ffmpeg).
 */
function padLastDuration(st: SampleTable): void {
  const n = st.stts.length;
  if (n < 2) return;
  const last = st.stts[n - 1]!;
  const prev = st.stts[n - 2]!;
  if (last.count !== 1 || last.delta >= prev.delta) return;
  st.mediaDur += BigInt(prev.delta - last.delta);
  prev.count++;
  st.stts.pop();
}

function scaleUp(d: bigint, to: number, from: number): bigint {
  if (to === from) return d;
  const toB = BigInt(to);
  const fromB = BigInt(from);
  return (d * toB + fromB - 1n) / fromB;
}

function buildEditList(
  init: ParsedInit,
  mediaDur: bigint,
): { entries: ElstEntry[]; trackDur: bigint } {
  let mediaTime = 0n;
  if (init.codec === "mp4a" && init.elst) {
    for (const e of init.elst) {
      if (e.mediaTime >= 0n) {
        if (e.mediaTime < mediaDur) {
          mediaTime = e.mediaTime;
        }
        break;
      }
    }
  }
  const d = scaleUp(mediaDur - mediaTime, init.movieTs, init.mediaTs);
  return {
    entries: [{ segDur: d, mediaTime, rate: 1 << 16 }],
    trackDur: d,
  };
}

function encodeElst(entries: readonly ElstEntry[]): Uint8Array {
  let version = 0;
  for (const e of entries) {
    if (
      e.segDur > 0xffffffffn ||
      e.mediaTime > 0x7fffffffn ||
      e.mediaTime < -0x80000000n
    ) {
      version = 1;
    }
  }
  const entrySize = version === 1 ? 20 : 12;
  const body = new Uint8Array(4 + entries.length * entrySize);
  writeU32(body, 0, entries.length);
  let off = 4;
  for (const e of entries) {
    if (version === 1) {
      writeU64(body, off, e.segDur);
      writeU64(body, off + 8, e.mediaTime);
      writeU32(body, off + 16, e.rate);
    } else {
      writeU32(body, off, Number(e.segDur));
      writeU32(body, off + 4, Number(BigInt.asUintN(32, e.mediaTime)));
      writeU32(body, off + 8, e.rate);
    }
    off += entrySize;
  }
  return fullBoxBytes("elst", version, 0, body);
}

/**
 * Re-encodes `mvhd`, `tkhd`, or `mdhd` with a new duration, upgrading version
 * 0 -> 1 only if `dur > 0xFFFFFFFF`, while preserving all other fields verbatim.
 */
function withDuration(box: RawBox, dur: bigint): Uint8Array {
  const body = boxBody(box);
  const ver = body[0]!;
  const flags = (body[1]! << 16) | (body[2]! << 8) | body[3]!;
  const needV1 = ver === 1 || dur > 0xffffffffn;

  if (box.type === "mvhd") {
    if (!needV1) {
      const out = box.data.slice();
      writeU32(out, box.hdr + 16, Number(dur));
      return out;
    }
    if (ver === 1) {
      const out = box.data.slice();
      writeU64(out, box.hdr + 24, dur);
      return out;
    }
    // Upgrade v0 -> v1
    const creation = BigInt(readU32(body, 4));
    const mod = BigInt(readU32(body, 8));
    const timescale = readU32(body, 12);
    const tail = body.subarray(20);
    const next = new Uint8Array(28 + tail.byteLength);
    writeU64(next, 0, creation);
    writeU64(next, 8, mod);
    writeU32(next, 16, timescale);
    writeU64(next, 20, dur);
    next.set(tail, 28);
    return fullBoxBytes("mvhd", 1, flags, next);
  }

  if (box.type === "tkhd") {
    if (!needV1) {
      const out = box.data.slice();
      writeU32(out, box.hdr + 20, Number(dur));
      return out;
    }
    if (ver === 1) {
      const out = box.data.slice();
      writeU64(out, box.hdr + 28, dur);
      return out;
    }
    const creation = BigInt(readU32(body, 4));
    const mod = BigInt(readU32(body, 8));
    const trackId = readU32(body, 12);
    const reserved = readU32(body, 16);
    const tail = body.subarray(24);
    const next = new Uint8Array(32 + tail.byteLength);
    writeU64(next, 0, creation);
    writeU64(next, 8, mod);
    writeU32(next, 16, trackId);
    writeU32(next, 20, reserved);
    writeU64(next, 24, dur);
    next.set(tail, 32);
    return fullBoxBytes("tkhd", 1, flags, next);
  }

  if (box.type === "mdhd") {
    if (!needV1) {
      const out = box.data.slice();
      writeU32(out, box.hdr + 16, Number(dur));
      return out;
    }
    if (ver === 1) {
      const out = box.data.slice();
      writeU64(out, box.hdr + 24, dur);
      return out;
    }
    const creation = BigInt(readU32(body, 4));
    const mod = BigInt(readU32(body, 8));
    const timescale = readU32(body, 12);
    const tail = body.subarray(20);
    const next = new Uint8Array(28 + tail.byteLength);
    writeU64(next, 0, creation);
    writeU64(next, 8, mod);
    writeU32(next, 16, timescale);
    writeU64(next, 20, dur);
    next.set(tail, 28);
    return fullBoxBytes("mdhd", 1, flags, next);
  }

  throw new Error(`withDuration: unexpected box type "${box.type}"`);
}

function buildStbl(
  init: ParsedInit,
  st: SampleTable,
  payloadStart: bigint,
): Uint8Array {
  const parts: Uint8Array[] = [init.decryptedStsd];

  // stts
  const sttsBody = new Uint8Array(4 + st.stts.length * 8);
  writeU32(sttsBody, 0, st.stts.length);
  for (let i = 0; i < st.stts.length; i++) {
    writeU32(sttsBody, 4 + i * 8, st.stts[i]!.count);
    writeU32(sttsBody, 8 + i * 8, st.stts[i]!.delta);
  }
  parts.push(fullBoxBytes("stts", 0, 0, sttsBody));

  // ctts (only if non-zero offsets exist)
  if (st.hasCtts) {
    let version = 0;
    for (const e of st.ctts) {
      if (e.offset < 0) version = 1;
    }
    const cttsBody = new Uint8Array(4 + st.ctts.length * 8);
    writeU32(cttsBody, 0, st.ctts.length);
    for (let i = 0; i < st.ctts.length; i++) {
      writeU32(cttsBody, 4 + i * 8, st.ctts[i]!.count);
      writeU32(cttsBody, 8 + i * 8, st.ctts[i]!.offset >>> 0);
    }
    parts.push(fullBoxBytes("ctts", version, 0, cttsBody));
  }

  // stsc
  const stscRuns: [number, number, number][] = [];
  let lastN = -1;
  let lastSdi = -1;
  for (let i = 0; i < st.chunks.length; i++) {
    const c = st.chunks[i]!;
    if (i > 0 && c.n === lastN && c.sdi === lastSdi) continue;
    stscRuns.push([i + 1, c.n, c.sdi]);
    lastN = c.n;
    lastSdi = c.sdi;
  }
  const stscBody = new Uint8Array(4 + stscRuns.length * 12);
  writeU32(stscBody, 0, stscRuns.length);
  for (let i = 0; i < stscRuns.length; i++) {
    const [firstChunk, samplesPerChunk, sdi] = stscRuns[i]!;
    writeU32(stscBody, 4 + i * 12, firstChunk);
    writeU32(stscBody, 8 + i * 12, samplesPerChunk);
    writeU32(stscBody, 12 + i * 12, sdi);
  }
  parts.push(fullBoxBytes("stsc", 0, 0, stscBody));

  // stsz
  let uniform = st.sizes[0] ?? 0;
  for (let i = 1; i < st.sizes.length; i++) {
    if (st.sizes[i] !== uniform) {
      uniform = 0;
      break;
    }
  }
  let stszBody: Uint8Array;
  if (uniform !== 0) {
    stszBody = new Uint8Array(8);
    writeU32(stszBody, 0, uniform);
    writeU32(stszBody, 4, st.sizes.length);
  } else {
    stszBody = new Uint8Array(8 + st.sizes.length * 4);
    writeU32(stszBody, 0, 0);
    writeU32(stszBody, 4, st.sizes.length);
    for (let i = 0; i < st.sizes.length; i++) {
      writeU32(stszBody, 8 + i * 4, st.sizes[i]!);
    }
  }
  parts.push(fullBoxBytes("stsz", 0, 0, stszBody));

  // stco / co64
  const lastChunkLen = BigInt(
    st.chunks[st.chunks.length - 1]!.data.byteLength,
  );
  const lastOffset = payloadStart + st.payload - lastChunkLen;
  let off = payloadStart;
  if (lastOffset > 0xffffffffn) {
    const co = new Uint8Array(4 + st.chunks.length * 8);
    writeU32(co, 0, st.chunks.length);
    for (let i = 0; i < st.chunks.length; i++) {
      writeU64(co, 4 + i * 8, off);
      off += BigInt(st.chunks[i]!.data.byteLength);
    }
    parts.push(fullBoxBytes("co64", 0, 0, co));
  } else {
    const co = new Uint8Array(4 + st.chunks.length * 4);
    writeU32(co, 0, st.chunks.length);
    for (let i = 0; i < st.chunks.length; i++) {
      writeU32(co, 4 + i * 4, Number(off));
      off += BigInt(st.chunks[i]!.data.byteLength);
    }
    parts.push(fullBoxBytes("stco", 0, 0, co));
  }

  // AAC audio pre-roll sample group (matching ffmpeg & Go m4a/flatten.go)
  if (init.codec === "mp4a") {
    const sgpd = new Uint8Array([
      0x72, 0x6f, 0x6c, 0x6c, 0, 0, 0, 2, 0, 0, 0, 1, 0xff, 0xff,
    ]);
    parts.push(fullBoxBytes("sgpd", 1, 0, sgpd));
    const sbgp = new Uint8Array(16);
    sbgp.set([0x72, 0x6f, 0x6c, 0x6c, 0, 0, 0, 1], 0);
    writeU32(sbgp, 8, st.sizes.length);
    writeU32(sbgp, 12, 1);
    parts.push(fullBoxBytes("sbgp", 0, 0, sbgp));
  }

  return boxBytes("stbl", ...parts);
}

function buildMoov(
  init: ParsedInit,
  st: SampleTable,
  payloadStart: bigint,
): Uint8Array {
  const { entries: elst, trackDur } = buildEditList(init, st.mediaDur);
  const stbl = buildStbl(init, st, payloadStart);

  const minfParts = init.minfChildren.map((b) =>
    b.type === "stbl" ? stbl : b.data,
  );
  const mdiaParts = init.mdiaChildren.map((b) => {
    if (b.type === "mdhd") return withDuration(b, st.mediaDur);
    if (b.type === "minf") return boxBytes("minf", ...minfParts);
    return b.data;
  });

  const edts = boxBytes("edts", encodeElst(elst));
  const hadEdts = Boolean(findBox(init.trakChildren, "edts"));
  const trakParts: Uint8Array[] = [];
  for (const b of init.trakChildren) {
    if (b.type === "tkhd") {
      trakParts.push(withDuration(b, trackDur));
      if (!hadEdts) trakParts.push(edts);
    } else if (b.type === "edts") {
      trakParts.push(edts);
    } else if (b.type === "mdia") {
      trakParts.push(boxBytes("mdia", ...mdiaParts));
    } else {
      trakParts.push(b.data);
    }
  }

  const moovParts: Uint8Array[] = [];
  for (const b of init.moovChildren) {
    if (b.type === "mvhd") {
      moovParts.push(withDuration(b, trackDur));
    } else if (b.type === "trak") {
      moovParts.push(boxBytes("trak", ...trakParts));
    } else if (b.type === "mvex" || b.type === "pssh") {
      // Drop mvex (progressive) and pssh (decrypted).
    } else {
      moovParts.push(b.data);
    }
  }
  if (init.moovRest.byteLength > 0) {
    moovParts.push(init.moovRest);
  }
  return boxBytes("moov", ...moovParts);
}

export interface FlattenedPlan {
  parts: Uint8Array[];
  totalSize: number;
}

/**
 * Flattens an in-place-decrypted fragmented MP4 into progressive M4A parts
 * (`ftyp`, `free`+`mdat` header, chunk `subarray` slices referencing `buf`,
 * trailing `moov` with tags). No full-track copy is allocated.
 */
export function flattenToParts(
  buf: Uint8Array,
  tags?: MP4Tags | null,
  preparsed?: ParsedFragmentedMp4,
): FlattenedPlan {
  const parsed = preparsed ?? parseFragmentedMp4(buf);
  const { init, fragments } = parsed;
  const st = createSampleTable();

  for (const frag of fragments) {
    for (const s of frag.samples) {
      addSample(st, s.size, s.duration, s.cto);
    }
    for (const c of frag.chunks) {
      // Because `prepareDecryptedStsd` collapses `stsd` to 1 entry, every
      // chunk's `sampleDescriptionIndex` must point at entry 1 (matching Go
      // `encodeDecryptedFragment` + `collapseSampleEntries`).
      const sdi = init.stsdCollapsed ? 1 : c.sampleDescriptionIndex;
      const slice = buf.subarray(c.start, c.end);
      st.chunks.push({ data: slice, n: c.sampleCount, sdi });
      st.payload += BigInt(slice.byteLength);
    }
  }
  if (st.sizes.length === 0) {
    throw new Error("no samples in the fragments");
  }
  if (init.codec === "ac-3" || init.codec === "ec-3") {
    padLastDuration(st);
  }

  let head: Uint8Array;
  if (st.payload + 8n > 0xffffffffn) {
    const mdatHdr = new Uint8Array(16);
    writeU32(mdatHdr, 0, 1);
    mdatHdr.set([0x6d, 0x64, 0x61, 0x74], 4);
    writeU64(mdatHdr, 8, st.payload + 16n);
    head = concatBytes([FTYP_M4A, mdatHdr]);
  } else {
    const freeAndMdat = new Uint8Array(16);
    freeAndMdat.set([0, 0, 0, 8, 0x66, 0x72, 0x65, 0x65], 0);
    writeU32(freeAndMdat, 8, Number(st.payload + 8n));
    freeAndMdat.set([0x6d, 0x64, 0x61, 0x74], 12);
    head = concatBytes([FTYP_M4A, freeAndMdat]);
  }

  let moov = buildMoov(init, st, MDAT_PAYLOAD_START);
  // Leave an empty ilst shell when untagged (matching Go m4a/flatten.go),
  // or merge and write tags directly in one pass.
  if (tags) {
    moov = retagMoov(moov, tags);
  } else {
    moov = rewriteIlst(moov, (old) => old ?? boxBytes("ilst"));
  }

  const parts: Uint8Array[] = [head];
  let totalSize = head.byteLength;
  for (const c of st.chunks) {
    parts.push(c.data);
    totalSize += c.data.byteLength;
  }
  parts.push(moov);
  totalSize += moov.byteLength;

  return { parts, totalSize };
}

export function flatten(buf: Uint8Array, tags?: MP4Tags | null): Uint8Array {
  return concatBytes(flattenToParts(buf, tags).parts);
}

// Re-export be32 so consumers don't get unused import warnings if needed
export { be32 };
