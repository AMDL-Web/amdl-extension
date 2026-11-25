import {
  ITUNES_ADVISORY_CLEAN,
  ITUNES_ADVISORY_EXPLICIT,
  ITUNES_ADVISORY_NONE,
  type MP4Picture,
  type MP4Tags,
  type Song,
  firstNonEmpty,
} from "../types.ts";
import {
  type RawBox,
  boxBody,
  boxBytes,
  concatBytes,
  fullBoxBytes,
  metaPrefixLen,
  parseBoxes,
  readI16,
  readI32,
  readU32,
  readU64,
  writeU16,
  writeU32,
  writeU64,
} from "./box.ts";

const utf8Enc = new TextEncoder();
const utf8Dec = new TextDecoder();

// hdlrMdir is the metadata handler box ffmpeg and iTunes write in meta.
const HDLR_MDIR = new Uint8Array([
  0, 0, 0, 33, 0x68, 0x64, 0x6c, 0x72, 0, 0, 0, 0, 0, 0, 0, 0, 0x6d, 0x64,
  0x69, 0x72, 0x61, 0x70, 0x70, 0x6c, 0, 0, 0, 0, 0, 0, 0, 0, 0,
]);

function itunesTagId(value: string): number {
  if (!value || !/^-?\d+$/.test(value)) return 0;
  const n = BigInt(value);
  if (n < -2147483648n || n > 2147483647n) return 0;
  return Number(n);
}

/**
 * Builds the tag set matching Go `experiments/browser/engine/song.go#buildTags`.
 */
export function buildTags(
  song: Song,
  lyrics: string,
  cover?: Uint8Array,
): MP4Tags {
  const albumArtist = firstNonEmpty(song.albumArtist, song.artistName);
  let advisory = ITUNES_ADVISORY_NONE;
  if (song.contentRating === "explicit") advisory = ITUNES_ADVISORY_EXPLICIT;
  else if (song.contentRating === "clean") advisory = ITUNES_ADVISORY_CLEAN;

  const tags: MP4Tags = {
    title: song.name,
    artist: song.artistName,
    album: song.albumName,
    albumArtist,
    composer: song.composerName,
    customGenre: song.genreNames[0] ?? "",
    lyrics,
    trackNumber: song.trackNumber,
    trackTotal: song.trackCount,
    discNumber: song.discNumber,
    discTotal: song.discCount,
    date: firstNonEmpty(song.albumRelease, song.releaseDate),
    copyright: song.copyright,
    publisher: song.recordLabel,
    titleSort: song.name,
    artistSort: song.artistName,
    albumSort: song.albumName,
    albumArtistSort: albumArtist,
    composerSort: song.composerName,
    itunesAdvisory: advisory,
    itunesAlbumId: itunesTagId(song.albumId),
    itunesArtistId: itunesTagId(song.artistId),
    custom: {
      PERFORMER: song.artistName,
      RELEASETIME: song.releaseDate,
      ISRC: song.isrc,
      LABEL: song.recordLabel,
      UPC: song.upc,
    },
  };
  if (cover && cover.byteLength > 0) {
    tags.pictures = [{ format: "auto", data: cover }];
  }
  return tags;
}

interface IlstItem {
  name: string;
  children: RawBox[];
}

export function readIlst(ilst: Uint8Array): MP4Tags {
  const { boxes: top } = parseBoxes(ilst);
  if (top.length !== 1) throw new Error("ilst: not a single box");
  const { boxes: itemBoxes } = parseBoxes(boxBody(top[0]!));

  const items: IlstItem[] = [];
  for (const b of itemBoxes) {
    let name = b.type;
    if (name.charCodeAt(0) === 0xa9) {
      name = `(c)${name.slice(1).toLowerCase()}`;
    }
    let children: RawBox[] = [];
    try {
      children = parseBoxes(boxBody(b)).boxes;
    } catch {
      children = [];
    }
    items.push({ name, children });
  }

  const firstData = (name: string): Uint8Array | undefined => {
    for (const it of items) {
      if (it.name !== name) continue;
      for (const c of it.children) {
        if (c.type === "data") return c.data;
      }
    }
    return undefined;
  };
  const text = (name: string): string => {
    const d = firstData(name);
    return d && d.byteLength >= 16 ? utf8Dec.decode(d.subarray(16)) : "";
  };
  const i16 = (d: Uint8Array | undefined, at: number): number =>
    d && d.byteLength >= at + 2 ? readI16(d, at) : 0;
  const i32 = (d: Uint8Array | undefined, at: number): number =>
    d && d.byteLength >= at + 4 ? readI32(d, at) : 0;

  const t: MP4Tags = {
    album: text("(c)alb"),
    albumArtist: text("aART"),
    artist: text("(c)art"),
    comment: text("(c)cmt"),
    composer: text("(c)wrt"),
    conductor: text("(c)con"),
    copyright: text("cprt"),
    customGenre: text("(c)gen"),
    description: text("desc"),
    lyrics: text("(c)lyr"),
    narrator: text("(c)nrt"),
    publisher: text("(c)pub"),
    title: text("(c)nam"),
    bpm: i16(firstData("tmpo"), 16),
    itunesAlbumId: i32(firstData("plID"), 20),
    itunesArtistId: i32(firstData("atID"), 16),
  };

  const trkn = firstData("trkn");
  if (trkn && trkn.byteLength >= 22) {
    t.trackNumber = i16(trkn, 18);
    t.trackTotal = i16(trkn, 20);
  }
  const disk = firstData("disk");
  if (disk && disk.byteLength >= 22) {
    t.discNumber = i16(disk, 18);
    t.discTotal = i16(disk, 20);
  }
  const rtng = firstData("rtng");
  if (rtng && rtng.byteLength > 16 && (rtng[16] === 1 || rtng[16] === 2)) {
    t.itunesAdvisory = rtng[16];
  }
  const gnre = firstData("gnre");
  if (gnre && gnre.byteLength > 17 && gnre[17]! >= 1 && gnre[17]! <= 79) {
    t.genre = gnre[17];
  }

  const pictures: MP4Picture[] = [];
  for (const it of items) {
    if (it.name !== "covr") continue;
    for (const c of it.children) {
      if (c.type !== "data" || c.data.byteLength < 16) continue;
      const fmtCode = c.data[11];
      pictures.push({
        format: fmtCode === 14 ? "png" : fmtCode === 13 ? "jpeg" : "auto",
        data: c.data.subarray(16),
      });
    }
  }
  if (pictures.length > 0) t.pictures = pictures;

  const names: string[] = [];
  const values: string[] = [];
  const others: Record<string, string[]> = {};
  for (const it of items) {
    if (it.name !== "----") continue;
    let name = "";
    let hasName = false;
    const datas: string[] = [];
    for (const c of it.children) {
      if (c.type === "name" && !hasName && c.data.byteLength >= 12) {
        name = utf8Dec.decode(c.data.subarray(12)).toUpperCase();
        hasName = true;
      } else if (c.type === "data" && c.data.byteLength >= 16) {
        datas.push(utf8Dec.decode(c.data.subarray(16)));
      }
    }
    if (!hasName || datas.length === 0) continue;
    names.push(name);
    values.push(datas[0]!);
    if (datas.length > 1) {
      others[name] = [...(others[name] ?? []), ...datas.slice(1)];
    }
  }
  if (names.length > 0) {
    const custom: Record<string, string> = {};
    for (let i = 0; i < names.length; i++) {
      const name = names[i]!;
      const value = values[i]!;
      if (Object.prototype.hasOwnProperty.call(custom, name)) {
        others[name] = [...(others[name] ?? []), value];
      } else {
        custom[name] = value;
      }
    }
    t.custom = custom;
    if (Object.keys(others).length > 0) t.otherCustom = others;
  }

  const year = text("(c)day");
  if (year) {
    if (/^\d+$/.test(year)) {
      const y = Number.parseInt(year, 10);
      if (Number.isSafeInteger(y) && y <= 0x7fffffff) {
        t.year = y;
      } else {
        throw new Error(`©day "${year}": out of int32 range`);
      }
    } else {
      t.date = year;
    }
  }
  return t;
}

export function mergeTags(existing: MP4Tags, next: MP4Tags): MP4Tags {
  const m: MP4Tags = {
    ...existing,
    custom: { ...(existing.custom ?? {}) },
    otherCustom: Object.fromEntries(
      Object.entries(existing.otherCustom ?? {}).map(([k, v]) => [k, [...v]]),
    ),
    pictures: [...(existing.pictures ?? [])],
  };

  const str = (key: keyof MP4Tags, v: string | undefined) => {
    if (v) (m as Record<string, unknown>)[key] = v;
  };
  str("album", next.album);
  str("albumSort", next.albumSort);
  str("albumArtist", next.albumArtist);
  str("albumArtistSort", next.albumArtistSort);
  str("artist", next.artist);
  str("artistSort", next.artistSort);
  if (next.bpm && next.bpm > 0) m.bpm = next.bpm;
  str("comment", next.comment);
  str("composer", next.composer);
  str("composerSort", next.composerSort);
  str("conductor", next.conductor);
  str("copyright", next.copyright);
  str("customGenre", next.customGenre);
  str("date", next.date);
  str("description", next.description);
  str("director", next.director);
  if (next.discNumber && next.discNumber > 0) m.discNumber = next.discNumber;
  if (next.discTotal && next.discTotal > 0) m.discTotal = next.discTotal;
  if (next.itunesAdvisory && next.itunesAdvisory !== ITUNES_ADVISORY_NONE) {
    m.itunesAdvisory = next.itunesAdvisory;
  }
  if (next.itunesAlbumId && next.itunesAlbumId > 0) {
    m.itunesAlbumId = next.itunesAlbumId;
  }
  if (next.itunesArtistId && next.itunesArtistId > 0) {
    m.itunesArtistId = next.itunesArtistId;
  }
  str("lyrics", next.lyrics);
  str("narrator", next.narrator);
  str("publisher", next.publisher);
  str("title", next.title);
  str("titleSort", next.titleSort);
  if (next.trackNumber && next.trackNumber > 0) m.trackNumber = next.trackNumber;
  if (next.trackTotal && next.trackTotal > 0) m.trackTotal = next.trackTotal;
  if (next.year && next.year > 0) m.year = next.year;
  if (next.genre && next.genre > 0) m.genre = next.genre;

  for (const [k, v] of Object.entries(next.custom ?? {})) {
    if (v) m.custom![k] = v;
  }
  for (const [k, v] of Object.entries(next.otherCustom ?? {})) {
    if (v.length > 0) {
      m.otherCustom![k] = [...(m.otherCustom![k] ?? []), ...v];
    }
  }
  if (next.pictures && next.pictures.length > 0) {
    m.pictures!.push(...next.pictures);
  }
  return m;
}

function pictureFormatByte(p: MP4Picture): number {
  if (p.format === "png") return 14;
  if (
    p.format === "auto" &&
    p.data.byteLength >= 4 &&
    p.data[0] === 0x89 &&
    p.data[1] === 0x50 &&
    p.data[2] === 0x4e &&
    p.data[3] === 0x47
  ) {
    return 14;
  }
  return 13;
}

/**
 * Encodes an `ilst` box with go-mp4tag's exact atom order and layout (and
 * sorted freeform keys, matching Go `experiments/browser/m4a/tags.go#encodeIlst`).
 */
export function encodeIlst(t: MP4Tags): Uint8Array {
  const chunks: Uint8Array[] = [];

  const pushRegular = (name: string, val: string | undefined, copyrightSign: boolean) => {
    if (!val) return;
    const valBytes = utf8Enc.encode(val);
    const size = valBytes.byteLength + 24;
    const buf = new Uint8Array(size);
    writeU32(buf, 0, size);
    if (copyrightSign) {
      buf[4] = 0xa9;
      for (let i = 0; i < 3; i++) buf[5 + i] = name.charCodeAt(i);
    } else {
      for (let i = 0; i < 4; i++) buf[4 + i] = name.charCodeAt(i);
    }
    writeU32(buf, 8, size - 8);
    buf.set([0x64, 0x61, 0x74, 0x61, 0, 0, 0, 1, 0, 0, 0, 0], 12);
    buf.set(valBytes, 24);
    chunks.push(buf);
  };

  const pushAtomWithData = (name: string, typeCode: number, payload: Uint8Array) => {
    const size = payload.byteLength + 24;
    const buf = new Uint8Array(size);
    writeU32(buf, 0, size);
    for (let i = 0; i < 4; i++) buf[4 + i] = name.charCodeAt(i);
    writeU32(buf, 8, payload.byteLength + 16);
    buf.set([0x64, 0x61, 0x74, 0x61, 0, 0, 0, typeCode, 0, 0, 0, 0], 12);
    buf.set(payload, 24);
    chunks.push(buf);
  };

  pushRegular("nam", t.title, true);
  pushRegular("sonm", t.titleSort, false);
  pushRegular("alb", t.album, true);
  pushRegular("soal", t.albumSort, false);
  pushRegular("aART", t.albumArtist, false);
  pushRegular("soaa", t.albumArtistSort, false);
  pushRegular("ART", t.artist, true);
  pushRegular("soar", t.artistSort, false);
  pushRegular("cmt", t.comment, true);
  pushRegular("wrt", t.composer, true);
  pushRegular("soco", t.composerSort, false);
  pushRegular("cprt", t.copyright, false);
  pushRegular("lyr", t.lyrics, true);
  pushRegular("gen", t.customGenre, true);
  pushRegular("desc", t.description, false);
  pushRegular("pub", t.publisher, true);
  pushRegular("con", t.conductor, true);

  if (t.itunesAdvisory && t.itunesAdvisory !== ITUNES_ADVISORY_NONE) {
    pushAtomWithData("rtng", 0x15, new Uint8Array([t.itunesAdvisory & 0xff]));
  }
  if (t.itunesAlbumId && t.itunesAlbumId > 0) {
    const p = new Uint8Array(8);
    writeU64(p, 0, BigInt(t.itunesAlbumId));
    pushAtomWithData("plID", 0x15, p);
  }
  if (t.itunesArtistId && t.itunesArtistId > 0) {
    const p = new Uint8Array(4);
    writeU32(p, 0, t.itunesArtistId >>> 0);
    pushAtomWithData("atID", 0x15, p);
  }

  const pushTrknDisk = (name: string, n: number, total: number, pad: boolean) => {
    const nn = Math.max(0, n);
    const tt = Math.max(0, total);
    const p = new Uint8Array(pad ? 8 : 6);
    writeU16(p, 2, nn);
    writeU16(p, 4, tt);
    pushAtomWithData(name, 0, p);
  };
  if ((t.trackNumber ?? 0) > 0 || (t.trackTotal ?? 0) > 0) {
    pushTrknDisk("trkn", t.trackNumber ?? 0, t.trackTotal ?? 0, true);
  }
  if ((t.discNumber ?? 0) > 0 || (t.discTotal ?? 0) > 0) {
    pushTrknDisk("disk", t.discNumber ?? 0, t.discTotal ?? 0, false);
  }
  if (t.bpm && t.bpm > 0) {
    const p = new Uint8Array(2);
    writeU16(p, 0, t.bpm);
    pushAtomWithData("tmpo", 0x15, p);
  }
  if (t.year && t.year > 0) {
    pushRegular("day", String(t.year), true);
  } else {
    pushRegular("day", t.date, true);
  }
  if (t.genre && t.genre > 0) {
    pushAtomWithData("gnre", 0, new Uint8Array([0, t.genre & 0xff]));
  }

  // Freeform atoms sorted by raw key (ASCII/UTF-16 code unit order matching Go sort.Strings for ASCII keys).
  const custom = t.custom ?? {};
  const otherCustom = t.otherCustom ?? {};
  const keys = Object.keys(custom).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const k of keys) {
    const nameStr = k.toUpperCase();
    const nameBytes = utf8Enc.encode(nameStr);
    const vals = [custom[k]!, ...(otherCustom[nameStr] ?? [])].map((s) =>
      utf8Enc.encode(s),
    );
    let total = nameBytes.byteLength + 48; // 8 ---- + 28 mean + 12 name
    for (const vb of vals) total += vb.byteLength + 16;

    const buf = new Uint8Array(total);
    let off = 0;
    writeU32(buf, off, total);
    off += 4;
    buf.set([0x2d, 0x2d, 0x2d, 0x2d], off); // ----
    off += 4;
    // mean box: size 0x1c, "mean", version+flags 0, "com.apple.iTunes"
    buf.set(
      [
        0, 0, 0, 0x1c, 0x6d, 0x65, 0x61, 0x6e, 0, 0, 0, 0, 0x63, 0x6f, 0x6d,
        0x2e, 0x61, 0x70, 0x70, 0x6c, 0x65, 0x2e, 0x69, 0x54, 0x75, 0x6e, 0x65,
        0x73,
      ],
      off,
    );
    off += 28;
    // name box
    writeU32(buf, off, nameBytes.byteLength + 12);
    off += 4;
    buf.set([0x6e, 0x61, 0x6d, 0x65, 0, 0, 0, 0], off);
    off += 8;
    buf.set(nameBytes, off);
    off += nameBytes.byteLength;
    // data boxes
    for (const vb of vals) {
      writeU32(buf, off, vb.byteLength + 16);
      off += 4;
      buf.set([0x64, 0x61, 0x74, 0x61, 0, 0, 0, 1, 0, 0, 0, 0], off);
      off += 12;
      buf.set(vb, off);
      off += vb.byteLength;
    }
    chunks.push(buf);
  }

  const pics = (t.pictures ?? []).filter((p) => p && p.data.byteLength > 0);
  if (pics.length > 0) {
    let covrSize = 8;
    for (const p of pics) covrSize += p.data.byteLength + 16;
    const buf = new Uint8Array(covrSize);
    let off = 0;
    writeU32(buf, off, covrSize);
    off += 4;
    buf.set([0x63, 0x6f, 0x76, 0x72], off);
    off += 4;
    for (const p of pics) {
      writeU32(buf, off, p.data.byteLength + 16);
      off += 4;
      buf.set(
        [0x64, 0x61, 0x74, 0x61, 0, 0, 0, pictureFormatByte(p), 0, 0, 0, 0],
        off,
      );
      off += 12;
      buf.set(p.data, off);
      off += p.data.byteLength;
    }
    chunks.push(buf);
  }

  return boxBytes("ilst", ...chunks);
}

export function rewriteIlst(
  moov: Uint8Array,
  newIlst: (old: Uint8Array | null) => Uint8Array,
): Uint8Array {
  const { boxes: top } = parseBoxes(moov);
  if (top.length !== 1 || top[0]!.type !== "moov") {
    throw new Error("rewriteIlst: not a single moov box");
  }
  const { boxes: children, rest } = parseBoxes(boxBody(top[0]!));
  const parts = children.map((b) => b.data);

  const makeMeta = () => fullBoxBytes("meta", 0, 0, HDLR_MDIR, newIlst(null));

  const udtaIdx = children.findIndex((b) => b.type === "udta");
  if (udtaIdx < 0) {
    parts.push(boxBytes("udta", makeMeta()));
  } else {
    const { boxes: udta, rest: urest } = parseBoxes(boxBody(children[udtaIdx]!));
    const uparts = udta.map((b) => b.data);
    const metaIdx = udta.findIndex((b) => b.type === "meta");
    if (metaIdx < 0) {
      uparts.push(makeMeta());
    } else {
      const mbody = boxBody(udta[metaIdx]!);
      const prefix = metaPrefixLen(mbody);
      if (mbody.byteLength < prefix) throw new Error("meta: truncated");
      const { boxes: meta, rest: mrest } = parseBoxes(mbody.subarray(prefix));
      const mparts = meta.map((b) => b.data);
      const ilstIdx = meta.findIndex((b) => b.type === "ilst");
      const old = ilstIdx >= 0 ? meta[ilstIdx]!.data : null;
      const ilst = newIlst(old);
      if (ilstIdx >= 0) mparts[ilstIdx] = ilst;
      else mparts.push(ilst);
      const rebuilt = [mbody.subarray(0, prefix), ...mparts];
      if (mrest.byteLength > 0) rebuilt.push(mrest);
      uparts[metaIdx] = boxBytes("meta", ...rebuilt);
    }
    if (urest.byteLength > 0) uparts.push(urest);
    parts[udtaIdx] = boxBytes("udta", ...uparts);
  }
  if (rest.byteLength > 0) parts.push(rest);
  return boxBytes("moov", ...parts);
}

export function retagMoov(moov: Uint8Array, tags: MP4Tags | null): Uint8Array {
  const next = tags ?? {};
  return rewriteIlst(moov, (old) => {
    const existing = old ? readIlst(old) : {};
    return encodeIlst(mergeTags(existing, next));
  });
}

export function shiftChunkOffsets(
  moov: Uint8Array,
  threshold: bigint,
  delta: bigint,
): void {
  const { boxes: top } = parseBoxes(moov);
  if (top.length !== 1) throw new Error("shiftChunkOffsets: not a single box");
  const pathOrder = ["trak", "mdia", "minf", "stbl"];
  const walk = (buf: Uint8Array, depth: number) => {
    const { boxes } = parseBoxes(buf);
    for (const c of boxes) {
      if (depth < 4 && c.type === pathOrder[depth]) {
        walk(boxBody(c), depth + 1);
      } else if (depth === 4 && (c.type === "stco" || c.type === "co64")) {
        const body = boxBody(c);
        if (body.byteLength < 8) throw new Error(`${c.type}: truncated`);
        const count = readU32(body, 4);
        const w = c.type === "co64" ? 8 : 4;
        if (body.byteLength - 8 < count * w) {
          throw new Error(`${c.type}: truncated`);
        }
        for (let i = 0; i < count; i++) {
          const pos = 8 + i * w;
          if (w === 4) {
            const v = BigInt(readU32(body, pos));
            if (v >= threshold) {
              const nv = v + delta;
              if (nv < 0n || nv > 0xffffffffn) {
                throw new Error(
                  "stco: shifted chunk offset does not fit 32 bits",
                );
              }
              writeU32(body, pos, Number(nv));
            }
          } else {
            const v = readU64(body, pos);
            if (v >= threshold) {
              writeU64(body, pos, v + delta);
            }
          }
        }
      }
    }
  };
  walk(boxBody(top[0]!), 0);
}

export function writeTagsBytes(
  input: Uint8Array,
  tags: MP4Tags | null,
): Uint8Array {
  const { boxes: top } = parseBoxes(input);
  let moovIdx = -1;
  for (let i = 0; i < top.length; i++) {
    if (top[i]!.type === "moov") {
      if (moovIdx >= 0) throw new Error("more than one moov box");
      moovIdx = i;
    }
  }
  if (moovIdx < 0) throw new Error("no moov box");
  const moov = top[moovIdx]!;
  const newMoov = retagMoov(moov.data, tags);
  const delta = BigInt(newMoov.byteLength - moov.data.byteLength);
  const moovEnd = moov.off + moov.data.byteLength;
  if (delta !== 0n && moovIdx < top.length - 1) {
    shiftChunkOffsets(newMoov, BigInt(moovEnd), delta);
  }
  return concatBytes([
    input.subarray(0, moov.off),
    newMoov,
    input.subarray(moovEnd),
  ]);
}
