import {
  type RawBox,
  boxBody,
  boxBytes,
  boxesTile,
  findBox,
  parseBoxes,
  readFourCC,
  readI32,
  readI64,
  readU16,
  readU32,
  readU64,
  writeU32,
} from "./box.ts";

export interface ElstEntry {
  segDur: bigint;
  mediaTime: bigint;
  rate: number;
}

export interface TrexDefaults {
  trackId: number;
  defaultSampleDescriptionIndex: number;
  defaultSampleDuration: number;
  defaultSampleSize: number;
  defaultSampleFlags: number;
}

export interface TencInfo {
  version: number;
  defaultCryptByteBlock: number;
  defaultSkipByteBlock: number;
  defaultIsProtected: number;
  defaultPerSampleIVSize: number;
  defaultKid: Uint8Array;
  defaultConstantIv: Uint8Array;
}

export interface TrackProtection {
  originalFormat: string;
  schemeType: string;
  tenc?: TencInfo;
}

export interface ParsedInit {
  moovChildren: RawBox[];
  moovRest: Uint8Array;
  trakChildren: RawBox[];
  mdiaChildren: RawBox[];
  minfChildren: RawBox[];
  stsdBox: RawBox;
  decryptedStsd: Uint8Array;
  stsdCollapsed: boolean;
  elst: ElstEntry[] | null;
  trackId: number;
  movieTs: number;
  mediaTs: number;
  trex: TrexDefaults;
  codec: string;
  protection?: TrackProtection;
}

export interface SubSamplePattern {
  clearBytes: number;
  protectedBytes: number;
}

export interface SencInfo {
  perSampleIVSize: number;
  ivs: Uint8Array[];
  subSamples: SubSamplePattern[][] | null;
}

export interface FragmentSample {
  offset: number; // absolute byte offset in the input buffer
  size: number;
  duration: number;
  cto: number;
}

export interface FragmentTrunChunk {
  start: number; // absolute start offset in input buffer
  end: number; // absolute end offset in input buffer
  sampleCount: number;
  sampleDescriptionIndex: number;
}

export interface ParsedFragment {
  moofOffset: number;
  trackId: number;
  sampleDescriptionIndex: number;
  samples: FragmentSample[];
  chunks: FragmentTrunChunk[];
  senc: SencInfo | null;
}

const QUICKTIME_V2_MARKER = 0x7f000000;
const PIFF_SENC_UUID_HEX = "a2394f525a9b4f14a2446c427c648df4";

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.byteLength; i++) {
    s += b[i]!.toString(16).padStart(2, "0");
  }
  return s;
}

export function parseElst(body: Uint8Array): ElstEntry[] {
  if (body.byteLength < 8) throw new Error("elst: truncated");
  const version = body[0]!;
  const count = readU32(body, 4);
  const entrySize = version === 1 ? 20 : 12;
  if (body.byteLength - 8 < count * entrySize) {
    throw new Error("elst: truncated entries");
  }
  const out: ElstEntry[] = [];
  let p = 8;
  for (let i = 0; i < count; i++) {
    if (version === 1) {
      out.push({
        segDur: readU64(body, p),
        mediaTime: readI64(body, p + 8),
        rate: readU32(body, p + 16),
      });
    } else {
      out.push({
        segDur: BigInt(readU32(body, p)),
        mediaTime: BigInt(readI32(body, p + 4)),
        rate: readU32(body, p + 8),
      });
    }
    p += entrySize;
  }
  return out;
}

function parseTenc(body: Uint8Array): TencInfo {
  if (body.byteLength < 24) throw new Error("tenc: truncated");
  const version = body[0]!;
  let defaultCryptByteBlock = 0;
  let defaultSkipByteBlock = 0;
  if (version > 0) {
    const infoByte = body[5]!;
    defaultCryptByteBlock = (infoByte >>> 4) & 0x0f;
    defaultSkipByteBlock = infoByte & 0x0f;
  }
  const defaultIsProtected = body[6]!;
  const defaultPerSampleIVSize = body[7]!;
  const defaultKid = body.slice(8, 24);
  let defaultConstantIv: Uint8Array = new Uint8Array(0);
  if (defaultIsProtected === 1 && defaultPerSampleIVSize === 0) {
    if (body.byteLength < 25) throw new Error("tenc: missing constant IV size");
    const ivLen = body[24]!;
    if (body.byteLength < 25 + ivLen) {
      throw new Error("tenc: truncated constant IV");
    }
    defaultConstantIv = body.slice(25, 25 + ivLen);
  }
  return {
    version,
    defaultCryptByteBlock,
    defaultSkipByteBlock,
    defaultIsProtected,
    defaultPerSampleIVSize,
    defaultKid,
    defaultConstantIv,
  };
}

function parseSinf(sinfBody: Uint8Array): TrackProtection {
  const { boxes } = parseBoxes(sinfBody);
  const frma = findBox(boxes, "frma");
  if (!frma || boxBody(frma).byteLength < 4) {
    throw new Error("sinf missing frma box");
  }
  const originalFormat = readFourCC(boxBody(frma), 0);
  let schemeType = "";
  const schm = findBox(boxes, "schm");
  if (schm && boxBody(schm).byteLength >= 8) {
    schemeType = readFourCC(boxBody(schm), 4);
  }
  let tenc: TencInfo | undefined;
  const schi = findBox(boxes, "schi");
  if (schi) {
    const { boxes: schiBoxes } = parseBoxes(boxBody(schi));
    const tencBox = findBox(schiBoxes, "tenc");
    if (tencBox) {
      tenc = parseTenc(boxBody(tencBox));
    }
  }
  if (schemeType === "piff") {
    schemeType = "cenc";
  }
  return { originalFormat, schemeType, tenc };
}

function audioSampleEntryChildrenOffset(body: Uint8Array): number {
  const isoStart = 28;
  if (body.byteLength < 10) return isoStart;
  const qtVer = readU16(body, 8);
  let qtStart = isoStart;
  let qtFits = true;
  if (qtVer === 1) {
    qtStart = isoStart + 16;
  } else if (qtVer === 2) {
    qtStart = isoStart + 36;
    const markerPos = isoStart + 16;
    qtFits =
      body.byteLength >= markerPos + 4 &&
      readU32(body, markerPos) === QUICKTIME_V2_MARKER;
  }
  qtFits =
    qtFits && body.byteLength >= qtStart && boxesTile(body.subarray(qtStart));
  if (!qtFits && body.byteLength >= isoStart && boxesTile(body.subarray(isoStart))) {
    return isoStart;
  }
  return qtStart;
}

/**
 * Rewrites `stsd` for decrypted progressive output:
 * - Converts `enca` sample entry to its original format (`sinf/frma`) and strips `sinf`.
 * - Collapses multiple entries down to the first entry (`sampleCount = 1`).
 * Matches Go `engine/decrypt.go#prepareDecryptedInit` + `collapseSampleEntries`.
 */
export function prepareDecryptedStsd(stsdBox: RawBox): {
  decryptedStsd: Uint8Array;
  codec: string;
  collapsed: boolean;
  protection?: TrackProtection;
} {
  const body = boxBody(stsdBox);
  if (body.byteLength < 8) {
    throw new Error("stsd: truncated");
  }
  const versionAndFlags = body.subarray(0, 4);
  const entryCount = readU32(body, 4);
  const { boxes: entries } = parseBoxes(body.subarray(8));
  if (entries.length === 0) {
    throw new Error("stsd: no sample entries");
  }

  const first = entries[0]!;
  let codec = first.type;
  let protection: TrackProtection | undefined;
  let firstEntryBytes: Uint8Array = first.data;

  if (first.type === "enca") {
    const entryBody = boxBody(first);
    const childOff = audioSampleEntryChildrenOffset(entryBody);
    const preChildren = entryBody.subarray(0, childOff);
    const { boxes: children, rest } = parseBoxes(entryBody.subarray(childOff));
    const kept: Uint8Array[] = [preChildren];
    for (const c of children) {
      if (c.type === "sinf") {
        protection = parseSinf(boxBody(c));
        codec = protection.originalFormat;
      } else {
        kept.push(c.data);
      }
    }
    if (rest.byteLength > 0) kept.push(rest);
    if (!protection) {
      throw new Error("enca sample entry missing sinf box");
    }
    firstEntryBytes = boxBytes(codec, ...kept);
  }

  const collapsed = entryCount > 1 || entries.length > 1;
  const countBuf = new Uint8Array(4);
  writeU32(countBuf, 0, 1);
  const decryptedStsd = boxBytes("stsd", versionAndFlags, countBuf, firstEntryBytes);
  return { decryptedStsd, codec, collapsed, protection };
}

function readMvhdTimescale(body: Uint8Array): number {
  const ver = body[0]!;
  if (ver === 1) {
    if (body.byteLength < 24) throw new Error("mvhd v1: truncated");
    return readU32(body, 20);
  }
  if (body.byteLength < 16) throw new Error("mvhd v0: truncated");
  return readU32(body, 12);
}

function readTkhdTrackId(body: Uint8Array): number {
  const ver = body[0]!;
  if (ver === 1) {
    if (body.byteLength < 24) throw new Error("tkhd v1: truncated");
    return readU32(body, 20);
  }
  if (body.byteLength < 16) throw new Error("tkhd v0: truncated");
  return readU32(body, 12);
}

function readMdhdTimescale(body: Uint8Array): number {
  const ver = body[0]!;
  if (ver === 1) {
    if (body.byteLength < 24) throw new Error("mdhd v1: truncated");
    return readU32(body, 20);
  }
  if (body.byteLength < 16) throw new Error("mdhd v0: truncated");
  return readU32(body, 12);
}

function parseTrex(body: Uint8Array): TrexDefaults {
  if (body.byteLength < 24) throw new Error("trex: truncated");
  return {
    trackId: readU32(body, 4),
    defaultSampleDescriptionIndex: readU32(body, 8),
    defaultSampleDuration: readU32(body, 12),
    defaultSampleSize: readU32(body, 16),
    defaultSampleFlags: readU32(body, 20),
  };
}

export function parseInitSegment(moovBody: Uint8Array): ParsedInit {
  const { boxes: moovChildren, rest: moovRest } = parseBoxes(moovBody);
  let trakBox: RawBox | undefined;
  let trakCount = 0;
  let movieTs = 0;

  for (const b of moovChildren) {
    if (b.type === "trak") {
      trakBox = b;
      trakCount++;
    } else if (b.type === "mvhd") {
      movieTs = readMvhdTimescale(boxBody(b));
    }
  }
  if (trakCount !== 1 || !trakBox) {
    throw new Error(`expected exactly one trak, found ${trakCount}`);
  }

  const { boxes: trakChildren } = parseBoxes(boxBody(trakBox));
  const tkhdBox = findBox(trakChildren, "tkhd");
  if (!tkhdBox) throw new Error("no tkhd box");
  const trackId = readTkhdTrackId(boxBody(tkhdBox));

  let elst: ElstEntry[] | null = null;
  const edtsBox = findBox(trakChildren, "edts");
  if (edtsBox) {
    const { boxes: edtsChildren } = parseBoxes(boxBody(edtsBox));
    const elstBox = findBox(edtsChildren, "elst");
    if (elstBox) {
      elst = parseElst(boxBody(elstBox));
    }
  }

  const mdiaBox = findBox(trakChildren, "mdia");
  if (!mdiaBox) throw new Error("no mdia box");
  const { boxes: mdiaChildren } = parseBoxes(boxBody(mdiaBox));
  const mdhdBox = findBox(mdiaChildren, "mdhd");
  if (!mdhdBox) throw new Error("no mdhd box");
  const mediaTs = readMdhdTimescale(boxBody(mdhdBox));
  if (mediaTs === 0) throw new Error("mdhd timescale is 0");
  if (movieTs === 0) movieTs = mediaTs;

  const minfBox = findBox(mdiaChildren, "minf");
  if (!minfBox) throw new Error("no minf box");
  const { boxes: minfChildren } = parseBoxes(boxBody(minfBox));
  const stblBox = findBox(minfChildren, "stbl");
  if (!stblBox) throw new Error("no stbl box");
  const { boxes: stblChildren } = parseBoxes(boxBody(stblBox));
  const stsdBox = findBox(stblChildren, "stsd");
  if (!stsdBox) throw new Error("no stsd box");

  const { decryptedStsd, codec, collapsed, protection } =
    prepareDecryptedStsd(stsdBox);

  let trex: TrexDefaults = {
    trackId,
    defaultSampleDescriptionIndex: 1,
    defaultSampleDuration: 0,
    defaultSampleSize: 0,
    defaultSampleFlags: 0,
  };
  const mvexBox = findBox(moovChildren, "mvex");
  if (mvexBox) {
    const { boxes: mvexChildren } = parseBoxes(boxBody(mvexBox));
    for (const c of mvexChildren) {
      if (c.type !== "trex") continue;
      const parsed = parseTrex(boxBody(c));
      if (parsed.trackId === trackId) {
        trex = parsed;
      }
    }
  }

  return {
    moovChildren,
    moovRest,
    trakChildren,
    mdiaChildren,
    minfChildren,
    stsdBox,
    decryptedStsd,
    stsdCollapsed: collapsed,
    elst,
    trackId,
    movieTs,
    mediaTs,
    trex,
    codec,
    protection,
  };
}

interface ParsedSaiz {
  defaultSampleInfoSize: number;
  sampleCount: number;
  sampleInfoSizes: Uint8Array;
}

function parseSaiz(body: Uint8Array): ParsedSaiz | null {
  if (body.byteLength < 9) return null;
  const flags = (body[1]! << 16) | (body[2]! << 8) | body[3]!;
  let off = 4;
  if (flags & 0x01) {
    off += 8; // aux_info_type + aux_info_type_parameter
  }
  if (body.byteLength < off + 5) return null;
  const defaultSampleInfoSize = body[off]!;
  const sampleCount = readU32(body, off + 1);
  const sampleInfoSizes =
    defaultSampleInfoSize === 0
      ? body.subarray(off + 5, off + 5 + sampleCount)
      : new Uint8Array(0);
  return { defaultSampleInfoSize, sampleCount, sampleInfoSizes };
}

function saizMatchesIVSize(
  saiz: ParsedSaiz,
  sampleCount: number,
  ivSize: number,
): boolean {
  for (let i = 0; i < sampleCount; i++) {
    const infoSize =
      saiz.defaultSampleInfoSize !== 0
        ? saiz.defaultSampleInfoSize
        : saiz.sampleInfoSizes[i];
    if (infoSize === undefined) return false;
    if (infoSize === 0) continue;
    const rem = infoSize - ivSize;
    if (rem < 2 || (rem - 2) % 6 !== 0) return false;
  }
  return true;
}

function tryParseSencSubsamples(
  raw: Uint8Array,
  sampleCount: number,
  ivSize: number,
): { ivs: Uint8Array[]; subSamples: SubSamplePattern[][] } | null {
  const ivs: Uint8Array[] = [];
  const subSamples: SubSamplePattern[][] = [];
  let off = 0;
  for (let i = 0; i < sampleCount; i++) {
    if (ivSize > 0) {
      if (off + ivSize > raw.byteLength) return null;
      ivs.push(raw.subarray(off, off + ivSize));
      off += ivSize;
    }
    if (off + 2 > raw.byteLength) return null;
    const subCount = readU16(raw, off);
    off += 2;
    if (off + subCount * 6 > raw.byteLength) return null;
    const subs: SubSamplePattern[] = [];
    for (let j = 0; j < subCount; j++) {
      const clearBytes = readU16(raw, off);
      const protectedBytes = readU32(raw, off + 2);
      off += 6;
      subs.push({ clearBytes, protectedBytes });
    }
    subSamples.push(subs);
  }
  if (off !== raw.byteLength) return null;
  return { ivs, subSamples };
}

function parseSenc(
  body: Uint8Array,
  defaultPerSampleIVSize: number,
  saiz: ParsedSaiz | null,
): SencInfo {
  if (body.byteLength < 8) throw new Error("senc: truncated");
  const flags = (body[1]! << 16) | (body[2]! << 8) | body[3]!;
  const sampleCount = readU32(body, 4);
  const raw = body.subarray(8);
  const useSubsamples = (flags & 0x02) !== 0;

  if (sampleCount === 0 || raw.byteLength === 0) {
    return { perSampleIVSize: defaultPerSampleIVSize, ivs: [], subSamples: null };
  }

  if (!useSubsamples) {
    let ivSize = defaultPerSampleIVSize;
    if (ivSize === 0) {
      ivSize = Math.floor(raw.byteLength / sampleCount);
    }
    if (ivSize !== 0 && ivSize !== 8 && ivSize !== 16) {
      throw new Error(`senc: unexpected perSampleIVSize ${ivSize}`);
    }
    const ivs: Uint8Array[] = [];
    if (ivSize > 0) {
      if (raw.byteLength < sampleCount * ivSize) {
        throw new Error("senc: truncated IVs");
      }
      for (let i = 0; i < sampleCount; i++) {
        ivs.push(raw.subarray(i * ivSize, (i + 1) * ivSize));
      }
    }
    return { perSampleIVSize: ivSize, ivs, subSamples: null };
  }

  const candidates =
    defaultPerSampleIVSize !== 0 ? [defaultPerSampleIVSize] : [0, 8, 16];
  for (const ivSize of candidates) {
    if (
      defaultPerSampleIVSize === 0 &&
      saiz &&
      !saizMatchesIVSize(saiz, sampleCount, ivSize)
    ) {
      continue;
    }
    const parsed = tryParseSencSubsamples(raw, sampleCount, ivSize);
    if (parsed) {
      return {
        perSampleIVSize: ivSize,
        ivs: parsed.ivs,
        subSamples: parsed.subSamples,
      };
    }
  }
  throw new Error("senc: failed to parse subsample encryption entries");
}

function insideMdat(
  mdats: readonly RawBox[],
  start: number,
  end: number,
): boolean {
  let lo = 0;
  let hi = mdats.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const m = mdats[mid]!;
    if (m.off + m.data.byteLength > start) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  if (lo >= mdats.length) return false;
  const m = mdats[lo]!;
  return m.off + m.hdr <= start && end <= m.off + m.data.byteLength;
}

export interface ParsedFragmentedMp4 {
  init: ParsedInit;
  fragments: ParsedFragment[];
}

/**
 * Parses a fragmented MP4 buffer into its init segment and fragment sample
 * tables (absolute offsets into `buf`, durations, CTOs, sample description
 * indexes, and optional CENC `senc` data).
 */
export function parseFragmentedMp4(buf: Uint8Array): ParsedFragmentedMp4 {
  const { boxes: top } = parseBoxes(buf);
  let moovBox: RawBox | undefined;
  const moofs: RawBox[] = [];
  const mdats: RawBox[] = [];

  for (const b of top) {
    if (b.type === "moov") {
      if (moovBox) throw new Error("more than one moov box");
      moovBox = b;
    } else if (b.type === "moof") {
      moofs.push(b);
    } else if (b.type === "mdat") {
      mdats.push(b);
    }
  }
  if (!moovBox) throw new Error("no moov box");

  const init = parseInitSegment(boxBody(moovBox));
  const defaultPerSampleIVSize =
    init.protection?.tenc?.defaultPerSampleIVSize ?? 0;

  const fragments: ParsedFragment[] = [];

  for (const mf of moofs) {
    const { boxes: moofChildren } = parseBoxes(boxBody(mf));
    const trafs = moofChildren.filter((b) => b.type === "traf");
    let prevEnd = 0;

    for (let ti = 0; ti < trafs.length; ti++) {
      const traf = trafs[ti]!;
      const { boxes: trafChildren } = parseBoxes(boxBody(traf));
      const tfhdBox = findBox(trafChildren, "tfhd");
      if (!tfhdBox) {
        throw new Error(`moof at ${mf.off}: traf without tfhd`);
      }
      const tfhdBody = boxBody(tfhdBox);
      if (tfhdBody.byteLength < 8) {
        throw new Error(`moof at ${mf.off}: truncated tfhd`);
      }
      const tfhdFlags =
        (tfhdBody[1]! << 16) | (tfhdBody[2]! << 8) | tfhdBody[3]!;
      const trackId = readU32(tfhdBody, 4);
      if (trackId !== init.trackId) {
        throw new Error(
          `moof at ${mf.off}: traf for track ${trackId}, init has only track ${init.trackId}`,
        );
      }

      let p = 8;
      let base = 0;
      const hasBaseDataOffset = (tfhdFlags & 0x000001) !== 0;
      const hasSdi = (tfhdFlags & 0x000002) !== 0;
      const hasDefDur = (tfhdFlags & 0x000008) !== 0;
      const hasDefSize = (tfhdFlags & 0x000010) !== 0;
      const hasDefFlags = (tfhdFlags & 0x000020) !== 0;
      const defaultBaseIsMoof = (tfhdFlags & 0x020000) !== 0;

      if (hasBaseDataOffset) {
        base = Number(readU64(tfhdBody, p));
        p += 8;
      } else if (defaultBaseIsMoof || ti === 0) {
        base = mf.off;
      } else {
        base = prevEnd;
      }

      let sdi = init.trex.defaultSampleDescriptionIndex;
      if (hasSdi) {
        sdi = readU32(tfhdBody, p);
        p += 4;
      }
      if (sdi === 0) sdi = 1;

      let defDur = init.trex.defaultSampleDuration;
      if (hasDefDur) {
        defDur = readU32(tfhdBody, p);
        p += 4;
      }
      let defSize = init.trex.defaultSampleSize;
      if (hasDefSize) {
        defSize = readU32(tfhdBody, p);
        p += 4;
      }
      if (hasDefFlags) {
        p += 4;
      }

      const samples: FragmentSample[] = [];
      const chunks: FragmentTrunChunk[] = [];
      let pos = base;

      for (const child of trafChildren) {
        if (child.type !== "trun") continue;
        const tb = boxBody(child);
        if (tb.byteLength < 8) {
          throw new Error(`moof at ${mf.off}: truncated trun`);
        }
        const trunVer = tb[0]!;
        const trunFlags = (tb[1]! << 16) | (tb[2]! << 8) | tb[3]!;
        const sampleCount = readU32(tb, 4);
        let tp = 8;

        if (trunFlags & 0x000001) {
          const dataOffset = readI32(tb, tp);
          tp += 4;
          const nextPos = base + dataOffset;
          if (nextPos < 0) {
            throw new Error(`moof at ${mf.off}: negative sample data offset`);
          }
          pos = nextPos;
        }
        if (trunFlags & 0x000004) {
          tp += 4; // first_sample_flags
        }

        const hasDur = (trunFlags & 0x000100) !== 0;
        const hasSize = (trunFlags & 0x000200) !== 0;
        const hasFlags = (trunFlags & 0x000400) !== 0;
        const hasCto = (trunFlags & 0x000800) !== 0;

        const chunkStart = pos;
        for (let si = 0; si < sampleCount; si++) {
          let dur = defDur;
          let size = defSize;
          let cto = 0;
          if (hasDur) {
            dur = readU32(tb, tp);
            tp += 4;
          }
          if (hasSize) {
            size = readU32(tb, tp);
            tp += 4;
          }
          if (hasFlags) {
            tp += 4;
          }
          if (hasCto) {
            cto = trunVer === 0 ? readU32(tb, tp) : readI32(tb, tp);
            tp += 4;
          }
          samples.push({ offset: pos, size, duration: dur, cto });
          pos += size;
        }
        if (sampleCount > 0) {
          if (!insideMdat(mdats, chunkStart, pos) || pos > buf.byteLength) {
            throw new Error(
              `moof at ${mf.off}: sample data [${chunkStart}, ${pos}) is outside every mdat`,
            );
          }
          chunks.push({
            start: chunkStart,
            end: pos,
            sampleCount,
            sampleDescriptionIndex: sdi,
          });
        }
      }
      prevEnd = pos;

      // Optional CENC senc box (regular `senc` or PIFF `uuid` senc).
      let senc: SencInfo | null = null;
      const saizBox = findBox(trafChildren, "saiz");
      const saiz = saizBox ? parseSaiz(boxBody(saizBox)) : null;
      const sencBox = findBox(trafChildren, "senc");
      if (sencBox) {
        senc = parseSenc(boxBody(sencBox), defaultPerSampleIVSize, saiz);
      } else {
        for (const c of trafChildren) {
          if (c.type === "uuid") {
            const cb = boxBody(c);
            if (
              cb.byteLength >= 24 &&
              bytesToHex(cb.subarray(0, 16)) === PIFF_SENC_UUID_HEX
            ) {
              senc = parseSenc(cb.subarray(16), defaultPerSampleIVSize, saiz);
              break;
            }
          }
        }
      }

      fragments.push({
        moofOffset: mf.off,
        trackId,
        sampleDescriptionIndex: sdi,
        samples,
        chunks,
        senc,
      });
    }
  }

  return { init, fragments };
}

/**
 * Reads `moov/trak/mdia/mdhd` timescale (sample rate in Hz), or 0 if unavailable.
 */
export function readSampleRateFromMp4(data: Uint8Array): number {
  try {
    const { boxes: top } = parseBoxes(data);
    const moov = findBox(top, "moov");
    if (!moov) return 0;
    const { boxes: mc } = parseBoxes(boxBody(moov));
    const trak = findBox(mc, "trak");
    if (!trak) return 0;
    const { boxes: tc } = parseBoxes(boxBody(trak));
    const mdia = findBox(tc, "mdia");
    if (!mdia) return 0;
    const { boxes: mdc } = parseBoxes(boxBody(mdia));
    const mdhd = findBox(mdc, "mdhd");
    if (!mdhd) return 0;
    return readMdhdTimescale(boxBody(mdhd));
  } catch {
    return 0;
  }
}
