/**
 * RFC 4493 AES-128-CMAC built on WebCrypto AES-CBC.
 *
 * Single-block AES-ECB(K, X) is computed via AES-CBC with an all-zero IV
 * (taking the first 16 bytes before WebCrypto's PKCS#7 padding block).
 * Multi-block CBC-MAC is computed in one AES-CBC call over the prepared blocks.
 */

const ZERO_IV = new Uint8Array(16);

function leftShiftOneBitAndXorRb(input: Uint8Array): Uint8Array {
  const out = new Uint8Array(16);
  let carry = 0;
  for (let i = 15; i >= 0; i--) {
    const b = input[i]!;
    out[i] = ((b << 1) | carry) & 0xff;
    carry = (b & 0x80) !== 0 ? 1 : 0;
  }
  if ((input[0]! & 0x80) !== 0) {
    out[15] = out[15]! ^ 0x87;
  }
  return out;
}

async function aesCbcEncrypt(
  key: CryptoKey,
  data: Uint8Array,
): Promise<Uint8Array> {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-CBC", iv: ZERO_IV },
    key,
    copy,
  );
  return new Uint8Array(ct);
}

/**
 * Computes 16-byte AES-128-CMAC (RFC 4493) for `message` under `keyBytes`.
 */
export async function aesCmac(
  keyBytes: Uint8Array,
  message: Uint8Array,
): Promise<Uint8Array> {
  if (keyBytes.byteLength !== 16) {
    throw new Error(`aesCmac expects 16-byte key, got ${keyBytes.byteLength}`);
  }
  const keyCopy = new Uint8Array(16);
  keyCopy.set(keyBytes);
  const key = await crypto.subtle.importKey(
    "raw",
    keyCopy,
    { name: "AES-CBC" },
    false,
    ["encrypt"],
  );

  // Step 1: Generate subkeys K1, K2 from L = AES_K(0^128).
  const encZero = await aesCbcEncrypt(key, ZERO_IV);
  const L = encZero.subarray(0, 16);
  const K1 = leftShiftOneBitAndXorRb(L);
  const K2 = leftShiftOneBitAndXorRb(K1);

  // Step 2: Prepare blocks (M_1 || ... || M_last).
  const len = message.byteLength;
  const numBlocks = len === 0 ? 1 : Math.ceil(len / 16);
  const completeLastBlock = len > 0 && len % 16 === 0;

  const prepared = new Uint8Array(numBlocks * 16);
  if (len > 0) {
    prepared.set(message, 0);
  }
  const lastStart = (numBlocks - 1) * 16;
  if (completeLastBlock) {
    for (let i = 0; i < 16; i++) {
      prepared[lastStart + i] = prepared[lastStart + i]! ^ K1[i]!;
    }
  } else {
    prepared[len] = 0x80;
    for (let i = 0; i < 16; i++) {
      prepared[lastStart + i] = prepared[lastStart + i]! ^ K2[i]!;
    }
  }

  // Step 3: CBC-MAC over `prepared` using zero IV; take the n-th ciphertext block.
  const cbcOut = await aesCbcEncrypt(key, prepared);
  return cbcOut.slice(lastStart, lastStart + 16);
}
