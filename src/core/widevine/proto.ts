/**
 * Minimal protobuf wire encoder/decoder for Widevine L3 license messages.
 * Field numbers follow `widevinepb/license.proto` from `github.com/iyear/gowidevine@v0.1.3`
 * (GPL-3.0, compatible with AGPL-3.0).
 */

import { concatBytes } from "../mp4/box.ts";

export const LICENSE_TYPE_STREAMING = 1;
export const LICENSE_TYPE_OFFLINE = 2;
export const LICENSE_TYPE_AUTOMATIC = 3;

export const PROTOCOL_VERSION_2_1 = 21;
export const LICENSE_REQUEST_TYPE_NEW = 1;

export const SIGNED_MESSAGE_LICENSE_REQUEST = 1;
export const SIGNED_MESSAGE_LICENSE = 2;

export const KEY_TYPE_SIGNING = 1;
export const KEY_TYPE_CONTENT = 2;

export function encodeVarint(value: number | bigint): Uint8Array {
  let v = typeof value === "bigint" ? BigInt.asUintN(64, value) : BigInt(value >>> 0);
  const out: number[] = [];
  while (v >= 0x80n) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
  return new Uint8Array(out);
}

export function encodeFieldVarint(
  fieldNumber: number,
  value: number | bigint,
): Uint8Array {
  const tag = encodeVarint((fieldNumber << 3) | 0);
  const val = encodeVarint(value);
  return concatBytes([tag, val]);
}

export function encodeFieldBytes(
  fieldNumber: number,
  bytes: Uint8Array,
): Uint8Array {
  const tag = encodeVarint((fieldNumber << 3) | 2);
  const len = encodeVarint(bytes.byteLength);
  return concatBytes([tag, len, bytes]);
}

export interface ProtoField {
  fieldNumber: number;
  wireType: number;
  varint?: bigint;
  bytes?: Uint8Array;
}

export function readVarint(
  buf: Uint8Array,
  offset: number,
): { value: bigint; nextOffset: number } {
  let result = 0n;
  let shift = 0n;
  let pos = offset;
  while (pos < buf.byteLength) {
    const byte = buf[pos++]!;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value: result, nextOffset: pos };
    }
    shift += 7n;
    if (shift > 63n) {
      throw new Error("protobuf varint overflow");
    }
  }
  throw new Error("truncated protobuf varint");
}

export function decodeFields(buf: Uint8Array): ProtoField[] {
  const fields: ProtoField[] = [];
  let pos = 0;
  while (pos < buf.byteLength) {
    const tag = readVarint(buf, pos);
    pos = tag.nextOffset;
    const fieldNumber = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 0x07n);
    if (wireType === 0) {
      const v = readVarint(buf, pos);
      pos = v.nextOffset;
      fields.push({ fieldNumber, wireType, varint: v.value });
    } else if (wireType === 1) {
      if (pos + 8 > buf.byteLength) throw new Error("truncated 64-bit field");
      fields.push({
        fieldNumber,
        wireType,
        bytes: buf.subarray(pos, pos + 8),
      });
      pos += 8;
    } else if (wireType === 2) {
      const len = readVarint(buf, pos);
      pos = len.nextOffset;
      const n = Number(len.value);
      if (pos + n > buf.byteLength) {
        throw new Error("truncated length-delimited protobuf field");
      }
      fields.push({
        fieldNumber,
        wireType,
        bytes: buf.subarray(pos, pos + n),
      });
      pos += n;
    } else if (wireType === 5) {
      if (pos + 4 > buf.byteLength) throw new Error("truncated 32-bit field");
      fields.push({
        fieldNumber,
        wireType,
        bytes: buf.subarray(pos, pos + 4),
      });
      pos += 4;
    } else {
      throw new Error(`unsupported protobuf wire type ${wireType}`);
    }
  }
  return fields;
}

export function encodeWidevinePsshData(kid: Uint8Array): Uint8Array {
  // WidevinePsshData.key_ids = field 2 (repeated bytes)
  return encodeFieldBytes(2, kid);
}

export function encodeLicenseRequest(args: {
  clientIdRaw: Uint8Array;
  psshDataRaw: Uint8Array;
  licenseType: number;
  requestId: Uint8Array;
  requestTimeSec: bigint;
  protocolVersion: number;
  keyControlNonce: number;
}): Uint8Array {
  const innerPssh = concatBytes([
    encodeFieldBytes(1, args.psshDataRaw),
    encodeFieldVarint(2, args.licenseType),
    encodeFieldBytes(3, args.requestId),
  ]);
  const contentId = encodeFieldBytes(1, innerPssh);

  return concatBytes([
    encodeFieldBytes(1, args.clientIdRaw),
    encodeFieldBytes(2, contentId),
    encodeFieldVarint(3, LICENSE_REQUEST_TYPE_NEW),
    encodeFieldVarint(4, args.requestTimeSec),
    encodeFieldVarint(6, args.protocolVersion),
    encodeFieldVarint(7, args.keyControlNonce >>> 0),
  ]);
}

export function encodeSignedMessage(args: {
  type: number;
  msg: Uint8Array;
  signature: Uint8Array;
}): Uint8Array {
  return concatBytes([
    encodeFieldVarint(1, args.type),
    encodeFieldBytes(2, args.msg),
    encodeFieldBytes(3, args.signature),
  ]);
}

export interface DecodedSignedMessage {
  type: number;
  msg: Uint8Array;
  signature: Uint8Array;
  sessionKey: Uint8Array;
}

export function decodeSignedMessage(buf: Uint8Array): DecodedSignedMessage {
  let type = 0;
  let msg: Uint8Array = new Uint8Array(0);
  let signature: Uint8Array = new Uint8Array(0);
  let sessionKey: Uint8Array = new Uint8Array(0);

  for (const f of decodeFields(buf)) {
    if (f.fieldNumber === 1 && f.varint !== undefined) type = Number(f.varint);
    else if (f.fieldNumber === 2 && f.bytes) msg = f.bytes;
    else if (f.fieldNumber === 3 && f.bytes) signature = f.bytes;
    else if (f.fieldNumber === 4 && f.bytes) sessionKey = f.bytes;
  }
  return { type, msg, signature, sessionKey };
}

export interface RawKeyContainer {
  id: Uint8Array;
  iv: Uint8Array;
  key: Uint8Array;
  type: number;
}

export function decodeLicenseKeys(licenseMsg: Uint8Array): RawKeyContainer[] {
  const keys: RawKeyContainer[] = [];
  for (const f of decodeFields(licenseMsg)) {
    if (f.fieldNumber !== 3 || !f.bytes) continue;
    let id: Uint8Array = new Uint8Array(0);
    let iv: Uint8Array = new Uint8Array(0);
    let key: Uint8Array = new Uint8Array(0);
    let type = 0;
    for (const kf of decodeFields(f.bytes)) {
      if (kf.fieldNumber === 1 && kf.bytes) id = kf.bytes;
      else if (kf.fieldNumber === 2 && kf.bytes) iv = kf.bytes;
      else if (kf.fieldNumber === 3 && kf.bytes) key = kf.bytes;
      else if (kf.fieldNumber === 4 && kf.varint !== undefined) {
        type = Number(kf.varint);
      }
    }
    keys.push({ id, iv, key, type });
  }
  return keys;
}
