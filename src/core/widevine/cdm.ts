/**
 * Widevine L3 CDM challenge generation & license parsing on WebCrypto.
 * Ported from `github.com/iyear/gowidevine@v0.1.3/cdm.go` (GPL-3.0, compatible with AGPL-3.0).
 */

import { be32, concatBytes } from "../mp4/box.ts";
import { aesCmac } from "./cmac.ts";
import {
  KEY_TYPE_CONTENT,
  LICENSE_TYPE_AUTOMATIC,
  PROTOCOL_VERSION_2_1,
  SIGNED_MESSAGE_LICENSE,
  SIGNED_MESSAGE_LICENSE_REQUEST,
  decodeLicenseKeys,
  decodeSignedMessage,
  encodeLicenseRequest,
  encodeSignedMessage,
  encodeWidevinePsshData,
} from "./proto.ts";
import { type WidevineDevice, decodeBase64 } from "./wvd.ts";

export interface WidevineKey {
  type: number;
  iv: Uint8Array;
  id: Uint8Array;
  key: Uint8Array;
}

export interface WidevineSession {
  challenge: Uint8Array;
  parseLicense(licenseBytes: Uint8Array): Promise<WidevineKey[]>;
}

const encAscii = (s: string) => new TextEncoder().encode(s);

function randomUint32(): number {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return arr[0]!;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}

async function deriveEncKey(
  licenseRequest: Uint8Array,
  sessionKey: Uint8Array,
): Promise<Uint8Array> {
  const input = concatBytes([
    new Uint8Array([0x01]),
    encAscii("ENCRYPTION"),
    new Uint8Array([0x00]),
    licenseRequest,
    be32(128),
  ]);
  return aesCmac(sessionKey, input);
}

async function deriveAuthKey(
  licenseRequest: Uint8Array,
  sessionKey: Uint8Array,
): Promise<Uint8Array> {
  const input = concatBytes([
    new Uint8Array([0x01]),
    encAscii("AUTHENTICATION"),
    new Uint8Array([0x00]),
    licenseRequest,
    be32(512),
  ]);
  const key1 = await aesCmac(sessionKey, input);
  input[0] = 0x02;
  const key2 = await aesCmac(sessionKey, input);
  return concatBytes([key1, key2]);
}

async function hmacSha256(
  keyBytes: Uint8Array,
  data: Uint8Array,
): Promise<Uint8Array> {
  const kBuf = new Uint8Array(keyBytes.byteLength);
  kBuf.set(keyBytes);
  const dBuf = new Uint8Array(data.byteLength);
  dBuf.set(data);
  const key = await crypto.subtle.importKey(
    "raw",
    kBuf,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, dBuf);
  return new Uint8Array(sig);
}

async function decryptKeyAesCbc(
  encKey: CryptoKey,
  iv: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  const ivCopy = new Uint8Array(16);
  ivCopy.set(iv.subarray(0, 16));
  const ctCopy = new Uint8Array(ciphertext.byteLength);
  ctCopy.set(ciphertext);
  // WebCrypto AES-CBC decrypt strips PKCS#7 padding automatically.
  const pt = await crypto.subtle.decrypt(
    { name: "AES-CBC", iv: ivCopy },
    encKey,
    ctCopy,
  );
  return new Uint8Array(pt);
}

/**
 * Generates a Widevine L3 license challenge for `kidBase64` and returns a
 * `parseLicense` closure bound to that request (for session key derivation and
 * HMAC-SHA256 verification).
 */
export async function createWidevineSession(
  device: WidevineDevice,
  kidBase64: string,
  opts: { nowMs?: number } = {},
): Promise<WidevineSession> {
  const kid = decodeBase64(kidBase64);
  if (kid.byteLength === 0) {
    throw new Error("empty Widevine KID");
  }
  const psshDataRaw = encodeWidevinePsshData(kid);
  const r1 = randomUint32().toString(16).toUpperCase().padStart(8, "0");
  const r2 = randomUint32().toString(16).toUpperCase().padStart(8, "0");
  const requestId = encAscii(`${r1}${r2}0100000000000000`);
  const requestTimeSec = BigInt(Math.floor((opts.nowMs ?? Date.now()) / 1000));

  const reqData = encodeLicenseRequest({
    clientIdRaw: device.clientIdRaw,
    psshDataRaw,
    licenseType: LICENSE_TYPE_AUTOMATIC,
    requestId,
    requestTimeSec,
    protocolVersion: PROTOCOL_VERSION_2_1,
    keyControlNonce: randomUint32(),
  });

  const reqCopy = new Uint8Array(reqData.byteLength);
  reqCopy.set(reqData);
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "RSA-PSS", saltLength: 20 },
      device.signingKey,
      reqCopy,
    ),
  );

  const challenge = encodeSignedMessage({
    type: SIGNED_MESSAGE_LICENSE_REQUEST,
    msg: reqData,
    signature,
  });

  return {
    challenge,
    async parseLicense(licenseBytes: Uint8Array): Promise<WidevineKey[]> {
      const signedMsg = decodeSignedMessage(licenseBytes);
      if (signedMsg.type !== SIGNED_MESSAGE_LICENSE) {
        throw new Error(`unexpected Widevine SignedMessage type ${signedMsg.type}`);
      }
      if (signedMsg.sessionKey.byteLength === 0) {
        throw new Error("Widevine license missing session_key");
      }

      const skCopy = new Uint8Array(signedMsg.sessionKey.byteLength);
      skCopy.set(signedMsg.sessionKey);
      const sessionKey = new Uint8Array(
        await crypto.subtle.decrypt(
          { name: "RSA-OAEP" },
          device.decryptKey,
          skCopy,
        ),
      );
      if (sessionKey.byteLength !== 16) {
        throw new Error(
          `invalid Widevine session key length ${sessionKey.byteLength}`,
        );
      }

      const [derivedEncKey, derivedAuthKey] = await Promise.all([
        deriveEncKey(reqData, sessionKey),
        deriveAuthKey(reqData, sessionKey),
      ]);

      // Verify license MAC before decrypting any keys.
      const expectedMac = await hmacSha256(derivedAuthKey, signedMsg.msg);
      if (!timingSafeEqual(signedMsg.signature, expectedMac)) {
        throw new Error("Widevine license HMAC-SHA256 verification failed");
      }

      const encKeyBuf = new Uint8Array(16);
      encKeyBuf.set(derivedEncKey);
      const aesCbcKey = await crypto.subtle.importKey(
        "raw",
        encKeyBuf,
        { name: "AES-CBC" },
        false,
        ["decrypt"],
      );

      const rawKeys = decodeLicenseKeys(signedMsg.msg);
      const out: WidevineKey[] = [];
      for (const rk of rawKeys) {
        let decrypted: Uint8Array = new Uint8Array(0);
        if (rk.key.byteLength > 0 && rk.iv.byteLength === 16) {
          decrypted = await decryptKeyAesCbc(aesCbcKey, rk.iv, rk.key);
        }
        out.push({
          type: rk.type,
          iv: rk.iv,
          id: rk.id,
          key: decrypted,
        });
      }
      return out;
    },
  };
}

export function extractContentKey(keys: readonly WidevineKey[]): Uint8Array {
  const found = keys.find(
    (k) => k.type === KEY_TYPE_CONTENT && k.key.byteLength === 16,
  );
  if (!found) {
    throw new Error("Widevine license contained no 16-byte CONTENT key");
  }
  return found.key;
}
