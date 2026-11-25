import { describe, expect, it } from "vitest";
import {
  be16,
  be32,
  be64,
  boxBody,
  boxBytes,
  concatBytes,
  findBox,
  fullBoxBytes,
  metaPrefixLen,
  parseBoxes,
  readFourCC,
  readU32,
  writeU32,
} from "../src/core/mp4/box.ts";
import { flatten } from "../src/core/mp4/flatten.ts";
import { parseFragmentedMp4 } from "../src/core/mp4/fragments.ts";
import {
  readIlst,
  shiftChunkOffsets,
  writeTagsBytes,
} from "../src/core/mp4/tags.ts";
import { ITUNES_ADVISORY_CLEAN, type MP4Tags } from "../src/core/types.ts";

function buildAudioSampleEntry(
  type: string,
  extraChildren: Uint8Array[],
): Uint8Array {
  const pre = new Uint8Array(28);
  pre[7] = 1; // dataRefIndex = 1
  pre[17] = 2; // channelCount = 2
  pre[19] = 16; // sampleSize = 16
  writeU32(pre, 24, 44100 << 16);
  return boxBytes(type, pre, ...extraChildren);
}

function buildSinf(origFormat: string, scheme: string): Uint8Array {
  const frma = boxBytes("frma", new TextEncoder().encode(origFormat));
  const schm = fullBoxBytes(
    "schm",
    0,
    0,
    new TextEncoder().encode(scheme),
    be32(0x00010000),
  );
  const tencBody = new Uint8Array(20);
  tencBody[2] = 1; // defaultIsProtected = 1
  tencBody[3] = 8; // defaultPerSampleIVSize = 8
  const tenc = fullBoxBytes("tenc", 0, 0, tencBody);
  const schi = boxBytes("schi", tenc);
  return boxBytes("sinf", frma, schm, schi);
}

function buildSynthFmp4(opts: {
  codec: string;
  encrypted?: boolean;
  twoStsdEntries?: boolean;
  elstMediaTime?: number;
  withCto?: boolean;
  lastSampleDur?: number;
}): { raw: Uint8Array; samples: Uint8Array[] } {
  const ftyp = boxBytes(
    "ftyp",
    new TextEncoder().encode("iso5"),
    be32(0),
    new TextEncoder().encode("iso5mp41"),
  );

  // mvhd v0 (timescale 90000)
  const mvhdBody = new Uint8Array(96);
  writeU32(mvhdBody, 8, 90000);
  writeU32(mvhdBody, 92, 2);
  const mvhd = fullBoxBytes("mvhd", 0, 0, mvhdBody);

  // tkhd v0 (trackId 1)
  const tkhdBody = new Uint8Array(80);
  writeU32(tkhdBody, 8, 1);
  const tkhd = fullBoxBytes("tkhd", 0, 3, tkhdBody);

  // mdhd v0 (timescale 44100)
  const mdhdBody = new Uint8Array(20);
  writeU32(mdhdBody, 8, 44100);
  const mdhd = fullBoxBytes("mdhd", 0, 0, mdhdBody);

  const esds = fullBoxBytes("esds", 0, 0, new Uint8Array([3, 4, 0, 1, 0, 0]));
  const sinf = buildSinf(opts.codec, "cbcs");
  const entryType = opts.encrypted ? "enca" : opts.codec;
  const entryChildren = opts.encrypted ? [esds, sinf] : [esds];
  const entry1 = buildAudioSampleEntry(entryType, entryChildren);
  const stsdEntries = opts.twoStsdEntries ? [entry1, entry1] : [entry1];
  const stsd = fullBoxBytes(
    "stsd",
    0,
    0,
    be32(stsdEntries.length),
    ...stsdEntries,
  );
  const stbl = boxBytes(
    "stbl",
    stsd,
    fullBoxBytes("stts", 0, 0, be32(0)),
    fullBoxBytes("stsc", 0, 0, be32(0)),
    fullBoxBytes("stsz", 0, 0, be32(0), be32(0)),
    fullBoxBytes("stco", 0, 0, be32(0)),
  );
  const minf = boxBytes("minf", stbl);
  const mdia = boxBytes("mdia", mdhd, minf);

  const trakChildren: Uint8Array[] = [tkhd];
  if (opts.elstMediaTime !== undefined) {
    const elstBody = concatBytes([
      be32(1),
      be32(0),
      be32(opts.elstMediaTime >>> 0),
      be32(1 << 16),
    ]);
    trakChildren.push(boxBytes("edts", fullBoxBytes("elst", 0, 0, elstBody)));
  }
  trakChildren.push(mdia);
  const trak = boxBytes("trak", ...trakChildren);

  const trex = fullBoxBytes(
    "trex",
    0,
    0,
    be32(1), // trackId
    be32(1), // default sdi
    be32(1024), // default dur
    be32(0),
    be32(0),
  );
  const mvex = boxBytes("mvex", trex);
  const pssh = fullBoxBytes("pssh", 0, 0, new Uint8Array(20));
  const moov = boxBytes(
    "moov",
    mvhd,
    trak,
    mvex,
    ...(opts.encrypted ? [pssh] : []),
  );

  // Build 2 fragments (second using sdi=2 when twoStsdEntries is set)
  const samples: Uint8Array[] = [];
  let file = concatBytes([ftyp, moov]);
  for (let fragIdx = 0; fragIdx < 2; fragIdx++) {
    const fragSamples: Uint8Array[] = [];
    for (let i = 0; i < 4; i++) {
      const s = new Uint8Array(64 + i * 16);
      s.fill((fragIdx * 10 + i + 1) & 0xff);
      fragSamples.push(s);
      samples.push(s);
    }
    const payload = concatBytes(fragSamples);

    const buildMoof = (dataOffset: number): Uint8Array => {
      const tfhdFlags =
        0x020000 | (opts.twoStsdEntries && fragIdx === 1 ? 0x000002 : 0);
      const tfhdParts: Uint8Array[] = [be32(1)];
      if (opts.twoStsdEntries && fragIdx === 1) tfhdParts.push(be32(2));
      const tfhd = fullBoxBytes("tfhd", 0, tfhdFlags, ...tfhdParts);

      const hasDur = fragIdx === 1 && opts.lastSampleDur !== undefined;
      const trunFlags =
        0x000001 | 0x000200 | (hasDur ? 0x000100 : 0) | (opts.withCto ? 0x000800 : 0);
      const trunParts: Uint8Array[] = [
        be32(fragSamples.length),
        be32(dataOffset >>> 0),
      ];
      for (let i = 0; i < fragSamples.length; i++) {
        if (hasDur) {
          trunParts.push(
            be32(i === fragSamples.length - 1 ? opts.lastSampleDur! : 1024),
          );
        }
        trunParts.push(be32(fragSamples[i]!.byteLength));
        if (opts.withCto) trunParts.push(be32(i % 2));
      }
      const trun = fullBoxBytes("trun", 0, trunFlags, ...trunParts);
      const mfhd = fullBoxBytes("mfhd", 0, 0, be32(fragIdx + 1));
      const traf = boxBytes("traf", tfhd, trun);
      return boxBytes("moof", mfhd, traf);
    };

    const dummyMoof = buildMoof(0);
    const moof = buildMoof(dummyMoof.byteLength + 8);
    const mdat = boxBytes("mdat", payload);
    file = concatBytes([file, moof, mdat]);
  }
  return { raw: file, samples };
}

function extractIlst(file: Uint8Array): Uint8Array {
  const { boxes: top } = parseBoxes(file);
  let cur = findBox(top, "moov")!;
  for (const name of ["udta", "meta", "ilst"]) {
    let body = boxBody(cur);
    if (cur.type === "meta") body = body.subarray(metaPrefixLen(body));
    cur = findBox(parseBoxes(body).boxes, name)!;
  }
  return cur.data;
}

describe("MP4 fragment parser, flattener, and tagger", () => {
  it("rewrites enca->mp4a, drops sinf/pssh/mvex, collapses stsd, preserves elst & adds roll", () => {
    const { raw, samples } = buildSynthFmp4({
      codec: "mp4a",
      encrypted: true,
      twoStsdEntries: true,
      elstMediaTime: 2112,
      withCto: true,
    });

    const parsed = parseFragmentedMp4(raw);
    expect(parsed.init.codec).toBe("mp4a");
    expect(parsed.init.stsdCollapsed).toBe(true);
    expect(parsed.init.protection?.schemeType).toBe("cbcs");
    expect(parsed.fragments).toHaveLength(2);
    expect(parsed.fragments[0]!.sampleDescriptionIndex).toBe(1);
    expect(parsed.fragments[1]!.sampleDescriptionIndex).toBe(2);

    const flat = flatten(raw);
    const { boxes: top } = parseBoxes(flat);
    expect(top.map((b) => b.type)).toEqual(["ftyp", "free", "mdat", "moov"]);
    expect(readFourCC(boxBody(top[0]!), 0)).toBe("M4A ");

    const moovChildren = parseBoxes(boxBody(top[3]!)).boxes;
    expect(findBox(moovChildren, "mvex")).toBeUndefined();
    expect(findBox(moovChildren, "pssh")).toBeUndefined();

    // Verify stsd has 1 entry of type mp4a with no sinf
    const trak = findBox(moovChildren, "trak")!;
    const trakChildren = parseBoxes(boxBody(trak)).boxes;
    const elstBox = findBox(
      parseBoxes(boxBody(findBox(trakChildren, "edts")!)).boxes,
      "elst",
    )!;
    // elst entry 0 mediaTime should be 2112
    expect(readU32(boxBody(elstBox), 12)).toBe(2112);

    const mdia = findBox(trakChildren, "mdia")!;
    const minf = findBox(parseBoxes(boxBody(mdia)).boxes, "minf")!;
    const stbl = parseBoxes(
      boxBody(findBox(parseBoxes(boxBody(minf)).boxes, "stbl")!),
    ).boxes;
    const stsdBody = boxBody(findBox(stbl, "stsd")!);
    expect(readU32(stsdBody, 4)).toBe(1); // collapsed to 1 entry
    const entry = parseBoxes(stsdBody.subarray(8)).boxes[0]!;
    expect(entry.type).toBe("mp4a");

    // Verify stsc sdi normalized to 1 and ctts + roll sgpd/sbgp exist
    const stscBody = boxBody(findBox(stbl, "stsc")!);
    expect(readU32(stscBody, 16)).toBe(1);
    expect(findBox(stbl, "ctts")).toBeDefined();
    expect(findBox(stbl, "sgpd")).toBeDefined();
    expect(findBox(stbl, "sbgp")).toBeDefined();

    // Verify mdat payload matches all samples concatenated
    const mdatBody = boxBody(top[2]!);
    expect(Buffer.from(mdatBody).equals(Buffer.from(concatBytes(samples)))).toBe(
      true,
    );
  });

  it("pads shortened final sample duration for ec-3 and drops input elst", () => {
    const { raw } = buildSynthFmp4({
      codec: "ec-3",
      elstMediaTime: 512,
      lastSampleDur: 300,
    });
    const flat = flatten(raw);
    const moov = findBox(parseBoxes(flat).boxes, "moov")!;
    const trak = findBox(parseBoxes(boxBody(moov)).boxes, "trak")!;
    const trakChildren = parseBoxes(boxBody(trak)).boxes;
    const elstBox = findBox(
      parseBoxes(boxBody(findBox(trakChildren, "edts")!)).boxes,
      "elst",
    )!;
    // For ec-3, mediaTime is reset to 0
    expect(readU32(boxBody(elstBox), 12)).toBe(0);

    const mdia = findBox(trakChildren, "mdia")!;
    const mdhd = findBox(parseBoxes(boxBody(mdia)).boxes, "mdhd")!;
    // 8 samples * 1024 = 8192 (shortened last sample 300 padded to 1024)
    expect(readU32(boxBody(mdhd), 16)).toBe(8 * 1024);
  });

  it("round-trips full iTunes tags and preserves offsets on moov-first layout", () => {
    const { raw } = buildSynthFmp4({ codec: "alac" });
    const jpeg = concatBytes([
      new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
      new Uint8Array(64).fill(7),
    ]);
    const tags: MP4Tags = {
      title: "One Last Kiss",
      artist: "宇多田ヒカル",
      album: "One Last Kiss",
      albumArtist: "宇多田ヒカル",
      composer: "Hikaru Utada",
      customGenre: "J-Pop",
      lyrics: "[00:01.00]line 1\n[00:02.00]line 2",
      trackNumber: 1,
      trackTotal: 7,
      discNumber: 1,
      discTotal: 1,
      date: "2021-03-09",
      copyright: "℗ 2021 Sony Music Labels Inc.",
      publisher: "Epic Records Japan",
      itunesAdvisory: ITUNES_ADVISORY_CLEAN,
      itunesAlbumId: 1553280539,
      itunesArtistId: 262836961,
      custom: {
        PERFORMER: "宇多田ヒカル",
        ISRC: "JPU902100181",
        UPC: "",
      },
      pictures: [{ format: "auto", data: jpeg }],
    };

    const fused = flatten(raw, tags);
    const twoStep = writeTagsBytes(flatten(raw), tags);
    expect(Buffer.from(fused).equals(Buffer.from(twoStep))).toBe(true);

    const read = readIlst(extractIlst(fused));
    expect(read.title).toBe(tags.title);
    expect(read.artist).toBe(tags.artist);
    expect(read.lyrics).toBe(tags.lyrics);
    expect(read.trackNumber).toBe(1);
    expect(read.trackTotal).toBe(7);
    expect(read.itunesAlbumId).toBe(1553280539);
    expect(read.itunesArtistId).toBe(262836961);
    expect(read.itunesAdvisory).toBe(ITUNES_ADVISORY_CLEAN);
    expect(read.custom).toEqual({
      ISRC: "JPU902100181",
      PERFORMER: "宇多田ヒカル",
    });
    expect(read.pictures?.[0]?.format).toBe("jpeg");

    // Test moov-before-mdat chunk offset shifting
    const flat = flatten(raw);
    const top = parseBoxes(flat).boxes;
    const moovCopy = findBox(top, "moov")!.data.slice();
    shiftChunkOffsets(moovCopy, 0n, BigInt(moovCopy.byteLength));
    const moovFirst = concatBytes([
      flat.subarray(0, 28),
      moovCopy,
      flat.subarray(28, findBox(top, "moov")!.off),
    ]);
    const retagged = writeTagsBytes(moovFirst, tags);
    const retaggedTop = parseBoxes(retagged).boxes;
    const mdat = findBox(retaggedTop, "mdat")!;
    const retaggedMoov = findBox(retaggedTop, "moov")!;
    const trak = findBox(parseBoxes(boxBody(retaggedMoov)).boxes, "trak")!;
    const mdia = findBox(parseBoxes(boxBody(trak)).boxes, "mdia")!;
    const minf = findBox(parseBoxes(boxBody(mdia)).boxes, "minf")!;
    const stbl = findBox(parseBoxes(boxBody(minf)).boxes, "stbl")!;
    const stco = findBox(parseBoxes(boxBody(stbl)).boxes, "stco")!;
    expect(readU32(boxBody(stco), 8)).toBe(mdat.off + mdat.hdr);
  });

  it("parses senc box with 8-byte IVs and subsamples", () => {
    const { raw } = buildSynthFmp4({ codec: "mp4a", encrypted: true });
    // Quick check that be16/be64 helpers encode big-endian cleanly
    expect(Array.from(be16(0x1234))).toEqual([0x12, 0x34]);
    expect(Array.from(be64(0x0102030405060708n))).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect(parseFragmentedMp4(raw).fragments[0]!.senc).toBeNull();
  });
});
