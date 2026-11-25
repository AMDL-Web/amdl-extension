/**
 * CENC (`cenc` / AES-128-CTR) subsample-aware in-place fMP4 decryptor on WebCrypto,
 * plus `AacLcDecryptHandler` integration for `pipeline.ts`.
 */

import { isUserTokenRejected } from "../apple-api.ts";
import type { ParsedFragmentedMp4 } from "../mp4/fragments.ts";
import type { AacLcDecryptHandler } from "../pipeline.ts";
import { createWidevineSession, extractContentKey } from "./cdm.ts";
import { getDefaultWidevineDevice } from "./device.ts";
import { type WidevineDevice, decodeBase64, encodeBase64 } from "./wvd.ts";

function buildCounter16(iv: Uint8Array): Uint8Array<ArrayBuffer> {
  const counter = new Uint8Array(new ArrayBuffer(16));
  const len = Math.min(16, iv.byteLength);
  counter.set(iv.subarray(0, len), 0);
  return counter;
}

/**
 * Decrypts CENC (`AES-128-CTR`) samples in `buf` in place.
 * Follows ISO/IEC 23001-7 and `mp4ff/mp4/crypto.go#cryptSampleCencBlock`:
 * - Fragments without `senc` and without constant IV are treated as unencrypted.
 * - Subsamples within one sample share one continuous AES-CTR keystream.
 */
export async function decryptCencInPlace(
  buf: Uint8Array,
  parsed: ParsedFragmentedMp4,
  contentKey: Uint8Array,
  signal?: AbortSignal,
): Promise<void> {
  if (contentKey.byteLength !== 16) {
    throw new Error(
      `CENC AES-128-CTR expects 16-byte key, got ${contentKey.byteLength}`,
    );
  }
  const scheme = parsed.init.protection?.schemeType;
  if (scheme && scheme !== "cenc") {
    throw new Error(`unsupported CENC scheme "${scheme}" (expected cenc)`);
  }

  const keyCopy = new Uint8Array(new ArrayBuffer(16));
  keyCopy.set(contentKey);
  const aesKey = await crypto.subtle.importKey(
    "raw",
    keyCopy,
    { name: "AES-CTR" },
    false,
    ["decrypt"],
  );

  const tenc = parsed.init.protection?.tenc;
  const constantIv =
    tenc && tenc.defaultConstantIv.byteLength > 0
      ? tenc.defaultConstantIv
      : null;

  for (const frag of parsed.fragments) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const senc = frag.senc;
    if (!senc) {
      if (!constantIv) {
        // Clear segment before/between encrypted segments (matches gowidevine).
        continue;
      }
    }
    if (
      senc &&
      senc.subSamples &&
      senc.subSamples.length !== frag.samples.length
    ) {
      throw new Error(
        `senc has ${senc.subSamples.length} subsample entries for ${frag.samples.length} samples`,
      );
    }

    for (let i = 0; i < frag.samples.length; i++) {
      const sample = frag.samples[i]!;
      if (sample.size === 0) continue;

      const sampleIv =
        senc && senc.ivs.length === frag.samples.length
          ? senc.ivs[i]!
          : constantIv;
      if (!sampleIv || sampleIv.byteLength === 0) {
        throw new Error(`CENC sample ${i} has no IV`);
      }

      const counter = buildCounter16(sampleIv);
      const subSamples = senc?.subSamples?.[i];

      if (!subSamples || subSamples.length === 0) {
        const ct = new Uint8Array(new ArrayBuffer(sample.size));
        ct.set(buf.subarray(sample.offset, sample.offset + sample.size));
        const pt = new Uint8Array(
          await crypto.subtle.decrypt(
            { name: "AES-CTR", counter, length: 64 },
            aesKey,
            ct,
          ),
        );
        buf.set(pt, sample.offset);
      } else {
        // Collect protected byte ranges; concatenate so one AES-CTR stream spans them continuously.
        const ranges: { start: number; len: number }[] = [];
        let rel = 0;
        let totalProtected = 0;
        for (const sub of subSamples) {
          const protStart = rel + sub.clearBytes;
          const protEnd = protStart + sub.protectedBytes;
          if (protEnd > sample.size) {
            throw new Error(
              `CENC subsample range ${protStart}-${protEnd} exceeds sample size ${sample.size}`,
            );
          }
          if (sub.protectedBytes > 0) {
            ranges.push({
              start: sample.offset + protStart,
              len: sub.protectedBytes,
            });
            totalProtected += sub.protectedBytes;
          }
          rel = protEnd;
        }
        if (totalProtected === 0) continue;

        const ct = new Uint8Array(new ArrayBuffer(totalProtected));
        let off = 0;
        for (const r of ranges) {
          ct.set(buf.subarray(r.start, r.start + r.len), off);
          off += r.len;
        }
        const pt = new Uint8Array(
          await crypto.subtle.decrypt(
            { name: "AES-CTR", counter, length: 64 },
            aesKey,
            ct,
          ),
        );
        off = 0;
        for (const r of ranges) {
          buf.set(pt.subarray(off, off + r.len), r.start);
          off += r.len;
        }
      }
    }
  }
}

export function createWidevineAacLcHandler(
  customDevice?: WidevineDevice,
): AacLcDecryptHandler {
  return {
    async acquireKeys({
      songId,
      media,
      mediaUserToken,
      appleApi,
      wrapper,
      logger,
      signal,
    }) {
      const device = customDevice ?? (await getDefaultWidevineDevice());
      const session = await createWidevineSession(device, media.kid);
      const challengeB64 = encodeBase64(session.challenge);

      let licenseB64 = "";
      const token = (mediaUserToken ?? "").trim();
      if (token) {
        try {
          licenseB64 = await appleApi.license(
            token,
            songId,
            challengeB64,
            media.keyUri,
            signal,
          );
        } catch (err) {
          if (isUserTokenRejected(err) && wrapper) {
            logger.warn(
              "media-user-token rejected by acquireWebPlaybackLicense; falling back to wrapper",
              { songId },
            );
          } else {
            throw err;
          }
        }
      }

      if (!licenseB64) {
        if (!wrapper) {
          throw new Error(
            "Sign in to Apple Music (or configure a wrapper) to acquire AAC-LC license.",
          );
        }
        licenseB64 = await wrapper.license(
          songId,
          challengeB64,
          media.keyUri,
          signal,
        );
      }

      const keys = await session.parseLicense(decodeBase64(licenseB64));
      return extractContentKey(keys);
    },

    async decryptInPlace(buf, parsed, contentKey, signal) {
      await decryptCencInPlace(buf, parsed, contentKey, signal);
    },
  };
}
