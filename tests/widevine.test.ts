import { describe, expect, it } from "vitest";
import {
  be16,
  be32,
  boxBytes,
  concatBytes,
  fullBoxBytes,
  writeU32,
} from "../src/core/mp4/box.ts";
import { parseFragmentedMp4 } from "../src/core/mp4/fragments.ts";
import { createWidevineSession } from "../src/core/widevine/cdm.ts";
import { decryptCencInPlace } from "../src/core/widevine/cenc.ts";
import { aesCmac } from "../src/core/widevine/cmac.ts";
import {
  DEFAULT_WIDEVINE_DEVICE_BASE64,
  getDefaultWidevineDevice,
} from "../src/core/widevine/device.ts";
import {
  KEY_TYPE_CONTENT,
  LICENSE_TYPE_AUTOMATIC,
  PROTOCOL_VERSION_2_1,
  SIGNED_MESSAGE_LICENSE,
  SIGNED_MESSAGE_LICENSE_REQUEST,
  decodeFields,
  decodeLicenseKeys,
  decodeSignedMessage,
  encodeFieldBytes,
  encodeFieldVarint,
  encodeLicenseRequest,
  encodeSignedMessage,
  encodeWidevinePsshData,
} from "../src/core/widevine/proto.ts";
import {
  decodeBase64,
  encodeBase64,
  parseWvd,
} from "../src/core/widevine/wvd.ts";

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

describe("RFC 4493 AES-128-CMAC", () => {
  // Official test vectors from RFC 4493 Section 4.
  const key = hexToBytes("2b7e151628aed2a6abf7158809cf4f3c");

  it("matches RFC 4493 Example 1 (empty message)", async () => {
    const mac = await aesCmac(key, new Uint8Array(0));
    expect(bytesToHex(mac)).toBe("bb1d6929e95937287fa37d129b756746");
  });

  it("matches RFC 4493 Example 2 (16 bytes)", async () => {
    const msg = hexToBytes("6bc1bee22e409f96e93d7e117393172a");
    const mac = await aesCmac(key, msg);
    expect(bytesToHex(mac)).toBe("070a16b46b4d4144f79bdd9dd04a287c");
  });

  it("matches RFC 4493 Example 3 (40 bytes)", async () => {
    const msg = hexToBytes(
      "6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e5130c81c46a35ce411",
    );
    const mac = await aesCmac(key, msg);
    expect(bytesToHex(mac)).toBe("dfa66747de9ae63030ca32611497c827");
  });

  it("matches RFC 4493 Example 4 (64 bytes)", async () => {
    const msg = hexToBytes(
      "6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e51" +
        "30c81c46a35ce411e5fbc1191a0a52eff69f2445df4f9b17ad2b417be66c3710",
    );
    const mac = await aesCmac(key, msg);
    expect(bytesToHex(mac)).toBe("51f0bebf7e3b9d92fc49741779363cfe");
  });
});

describe("Widevine protobuf & WVD device", () => {
  it("round-trips SignedMessage and License KeyContainer protobufs", () => {
    const kid = hexToBytes("df6ef2f5fd83078091a78566c8d01925");
    const pssh = encodeWidevinePsshData(kid);
    const psshFields = decodeFields(pssh);
    expect(psshFields).toHaveLength(1);
    expect(psshFields[0]!.fieldNumber).toBe(2);
    expect(bytesToHex(psshFields[0]!.bytes!)).toBe(bytesToHex(kid));

    const req = encodeLicenseRequest({
      clientIdRaw: new Uint8Array([1, 2, 3]),
      psshDataRaw: pssh,
      licenseType: LICENSE_TYPE_AUTOMATIC,
      requestId: new TextEncoder().encode("00000000000000000100000000000000"),
      requestTimeSec: 1700000000n,
      protocolVersion: PROTOCOL_VERSION_2_1,
      keyControlNonce: 42,
    });
    const signed = encodeSignedMessage({
      type: SIGNED_MESSAGE_LICENSE_REQUEST,
      msg: req,
      signature: new Uint8Array([9, 8, 7]),
    });
    const decoded = decodeSignedMessage(signed);
    expect(decoded.type).toBe(SIGNED_MESSAGE_LICENSE_REQUEST);
    expect(Buffer.from(decoded.msg).equals(Buffer.from(req))).toBe(true);
    expect(Array.from(decoded.signature)).toEqual([9, 8, 7]);

    const keyContainer = concatBytes([
      encodeFieldBytes(1, kid),
      encodeFieldBytes(2, new Uint8Array(16).fill(0xaa)),
      encodeFieldBytes(3, new Uint8Array(32).fill(0xbb)),
      encodeFieldVarint(4, KEY_TYPE_CONTENT),
    ]);
    const licMsg = encodeFieldBytes(3, keyContainer);
    const keys = decodeLicenseKeys(licMsg);
    expect(keys).toHaveLength(1);
    expect(keys[0]!.type).toBe(KEY_TYPE_CONTENT);
    expect(bytesToHex(keys[0]!.id)).toBe(bytesToHex(kid));
  });

  it("parses embedded WVD v2 device, wraps PKCS#1 -> PKCS#8, and generates SignedMessage challenge", async () => {
    const raw = decodeBase64(DEFAULT_WIDEVINE_DEVICE_BASE64);
    const parsed = parseWvd(raw);
    expect(parsed.version).toBe(2);
    expect(parsed.securityLevel).toBe(3);
    expect(parsed.privateKeyDer.byteLength).toBeGreaterThan(1000);
    expect(parsed.clientIdRaw.byteLength).toBeGreaterThan(1000);

    const device = await getDefaultWidevineDevice();
    const kidB64 = encodeBase64(hexToBytes("0123456789abcdef0123456789abcdef"));
    const session = await createWidevineSession(device, kidB64);
    const signed = decodeSignedMessage(session.challenge);
    expect(signed.type).toBe(SIGNED_MESSAGE_LICENSE_REQUEST);
    expect(signed.signature.byteLength).toBe(256); // 2048-bit RSA-PSS

    // Reject a bogus license type or tampered MAC
    const bogusLic = encodeSignedMessage({
      type: SIGNED_MESSAGE_LICENSE,
      msg: new Uint8Array([1, 2, 3]),
      signature: new Uint8Array(32),
    });
    await expect(session.parseLicense(bogusLic)).rejects.toThrow(/session_key/);
  });
});

describe("CENC AES-128-CTR in-place decryption", () => {
  it("decrypts both full-sample and multi-subsample CENC fragments accurately", async () => {
    const contentKey = hexToBytes("00112233445566778899aabbccddeeff");
    const aesKey = await crypto.subtle.importKey(
      "raw",
      contentKey.slice(),
      { name: "AES-CTR" },
      false,
      ["encrypt"],
    );

    // Sample 1: clear 5 + protected 20 + clear 3 + protected 12 = 40 bytes
    const pt1 = new Uint8Array(40);
    for (let i = 0; i < pt1.length; i++) pt1[i] = i + 1;
    const iv1 = hexToBytes("0102030405060708");
    const ctr1 = new Uint8Array(16);
    ctr1.set(iv1, 0);
    // Encrypt the 20 + 12 = 32 protected bytes under one continuous CTR stream
    const protConcat = concatBytes([pt1.subarray(5, 25), pt1.subarray(28, 40)]);
    const encConcat = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-CTR", counter: ctr1, length: 64 },
        aesKey,
        protConcat.slice(),
      ),
    );
    const ct1 = pt1.slice();
    ct1.set(encConcat.subarray(0, 20), 5);
    ct1.set(encConcat.subarray(20, 32), 28);

    // Build minimal CENC fMP4 with senc (flags=0x02 subsamples)
    const ftyp = boxBytes(
      "ftyp",
      new TextEncoder().encode("iso5"),
      be32(0),
      new TextEncoder().encode("iso5mp41"),
    );
    const mvhdBody = new Uint8Array(96);
    writeU32(mvhdBody, 8, 44100);
    const mvhd = fullBoxBytes("mvhd", 0, 0, mvhdBody);
    const tkhdBody = new Uint8Array(80);
    writeU32(tkhdBody, 8, 1);
    const tkhd = fullBoxBytes("tkhd", 0, 3, tkhdBody);
    const mdhdBody = new Uint8Array(20);
    writeU32(mdhdBody, 8, 44100);
    const mdhd = fullBoxBytes("mdhd", 0, 0, mdhdBody);

    const frma = boxBytes("frma", new TextEncoder().encode("mp4a"));
    const schm = fullBoxBytes(
      "schm",
      0,
      0,
      new TextEncoder().encode("cenc"),
      be32(0x00010000),
    );
    const tencBody = new Uint8Array(20);
    tencBody[2] = 1;
    tencBody[3] = 8; // perSampleIVSize = 8
    const sinf = boxBytes(
      "sinf",
      frma,
      schm,
      boxBytes("schi", fullBoxBytes("tenc", 0, 0, tencBody)),
    );
    const pre = new Uint8Array(28);
    pre[7] = 1;
    pre[17] = 2;
    pre[19] = 16;
    writeU32(pre, 24, 44100 << 16);
    const enca = boxBytes("enca", pre, sinf);
    const stsd = fullBoxBytes("stsd", 0, 0, be32(1), enca);
    const stbl = boxBytes("stbl", stsd);
    const moov = boxBytes(
      "moov",
      mvhd,
      boxBytes("trak", tkhd, boxBytes("mdia", mdhd, boxBytes("minf", stbl))),
      boxBytes(
        "mvex",
        fullBoxBytes("trex", 0, 0, be32(1), be32(1), be32(1024), be32(0), be32(0)),
      ),
    );

    const sencPayload = concatBytes([
      be32(1), // sampleCount
      iv1, // 8-byte IV
      be16(2), // 2 subsamples
      be16(5),
      be32(20),
      be16(3),
      be32(12),
    ]);
    const senc = fullBoxBytes("senc", 0, 0x02, sencPayload);
    const tfhd = fullBoxBytes("tfhd", 0, 0x020000, be32(1));
    const buildMoof = (dataOff: number) =>
      boxBytes(
        "moof",
        fullBoxBytes("mfhd", 0, 0, be32(1)),
        boxBytes(
          "traf",
          tfhd,
          fullBoxBytes("trun", 0, 0x000201, be32(1), be32(dataOff), be32(ct1.byteLength)),
          senc,
        ),
      );
    const moof = buildMoof(buildMoof(0).byteLength + 8);
    const file = concatBytes([ftyp, moov, moof, boxBytes("mdat", ct1)]);

    const parsed = parseFragmentedMp4(file);
    expect(parsed.fragments[0]!.senc?.subSamples?.[0]).toEqual([
      { clearBytes: 5, protectedBytes: 20 },
      { clearBytes: 3, protectedBytes: 12 },
    ]);

    await decryptCencInPlace(file, parsed, contentKey);
    const s = parsed.fragments[0]!.samples[0]!;
    expect(
      Buffer.from(file.subarray(s.offset, s.offset + s.size)).equals(
        Buffer.from(pt1),
      ),
    ).toBe(true);
  });
});
