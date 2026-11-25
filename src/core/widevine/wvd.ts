/**
 * Widevine Device (.wvd v2) parser and PKCS#1 -> PKCS#8 DER wrapper for WebCrypto.
 * Ported from `github.com/iyear/gowidevine@v0.1.3/device.go` (GPL-3.0, compatible with AGPL-3.0).
 */

import { concatBytes, readU16 } from "../mp4/box.ts";

export interface ParsedWvd {
  version: number;
  deviceType: number;
  securityLevel: number;
  flags: number;
  privateKeyDer: Uint8Array;
  clientIdRaw: Uint8Array;
}

export interface WidevineDevice extends ParsedWvd {
  signingKey: CryptoKey;
  decryptKey: CryptoKey;
}

function encodeDerLength(len: number): Uint8Array {
  if (len < 0x80) return new Uint8Array([len]);
  const bytes: number[] = [];
  let n = len;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>>= 8;
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function derTag(tag: number, content: Uint8Array): Uint8Array {
  return concatBytes([new Uint8Array([tag]), encodeDerLength(content.byteLength), content]);
}

// RSA AlgorithmIdentifier: SEQUENCE { OID 1.2.840.113549.1.1.1, NULL }
const RSA_ALG_ID = new Uint8Array([
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
  0x05, 0x00,
]);

function isPkcs8(der: Uint8Array): boolean {
  // Check outer SEQUENCE, skip length, expect INTEGER 0 (02 01 00), then SEQUENCE (0x30) for AlgorithmIdentifier.
  if (der.byteLength < 10 || der[0] !== 0x30) return false;
  let pos = 1;
  const lenByte = der[pos++]!;
  if (lenByte & 0x80) {
    pos += lenByte & 0x7f;
  }
  if (pos + 4 >= der.byteLength) return false;
  if (der[pos] !== 0x02 || der[pos + 1] !== 0x01 || der[pos + 2] !== 0x00) {
    return false;
  }
  return der[pos + 3] === 0x30;
}

/**
 * Wraps a PKCS#1 RSAPrivateKey DER buffer into a PKCS#8 PrivateKeyInfo DER
 * buffer suitable for `crypto.subtle.importKey("pkcs8", ...)`.
 * If the input is already PKCS#8, returns a copy untouched.
 */
export function ensurePkcs8Der(der: Uint8Array): Uint8Array {
  if (isPkcs8(der)) return der.slice();
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const privOctet = derTag(0x04, der);
  return derTag(0x30, concatBytes([version, RSA_ALG_ID, privOctet]));
}

export function decodeBase64(b64: string): Uint8Array {
  const clean = b64.replace(/\s+/g, "");
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(clean, "base64"));
  }
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function encodeBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.byteLength; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export function parseWvd(raw: Uint8Array): ParsedWvd {
  if (raw.byteLength < 11) {
    throw new Error("wvd: file too short");
  }
  if (raw[0] !== 0x57 || raw[1] !== 0x56 || raw[2] !== 0x44) {
    throw new Error("wvd: invalid signature (expected 'WVD')");
  }
  const version = raw[3]!;
  const deviceType = raw[4]!;
  const securityLevel = raw[5]!;
  const flags = raw[6]!;
  if (version !== 2) {
    throw new Error(`wvd: unsupported version ${version} (expected 2)`);
  }

  let off = 7;
  const privateKeyLen = readU16(raw, off);
  off += 2;
  if (off + privateKeyLen + 2 > raw.byteLength) {
    throw new Error("wvd: truncated private key");
  }
  const privateKeyDer = raw.slice(off, off + privateKeyLen);
  off += privateKeyLen;

  const clientIdLen = readU16(raw, off);
  off += 2;
  if (off + clientIdLen > raw.byteLength) {
    throw new Error("wvd: truncated client_id");
  }
  const clientIdRaw = raw.slice(off, off + clientIdLen);

  return {
    version,
    deviceType,
    securityLevel,
    flags,
    privateKeyDer,
    clientIdRaw,
  };
}

export async function loadWidevineDevice(
  wvdBytes: Uint8Array,
): Promise<WidevineDevice> {
  const parsed = parseWvd(wvdBytes);
  const pkcs8 = ensurePkcs8Der(parsed.privateKeyDer);
  const pkcs8Buf = new Uint8Array(pkcs8.byteLength);
  pkcs8Buf.set(pkcs8);

  const [signingKey, decryptKey] = await Promise.all([
    crypto.subtle.importKey(
      "pkcs8",
      pkcs8Buf,
      { name: "RSA-PSS", hash: "SHA-1" },
      false,
      ["sign"],
    ),
    crypto.subtle.importKey(
      "pkcs8",
      pkcs8Buf,
      { name: "RSA-OAEP", hash: "SHA-1" },
      false,
      ["decrypt"],
    ),
  ]);

  return {
    ...parsed,
    signingKey,
    decryptKey,
  };
}
