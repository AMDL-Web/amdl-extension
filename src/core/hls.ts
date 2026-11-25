import { type Codec, firstNonEmpty } from "./types.ts";

export const PREFETCH_KEY = "skd://itunes.apple.com/P000000000/s1/e1";

export interface HlsVariant {
  uri: string;
  audio: string;
  bandwidth: number;
  bitDepth: number;
  sampleRate: number;
}

export interface SelectedMediaInfo {
  mediaUri: string;
  keys: string[];
  codecId: string;
  bitDepth: number;
  sampleRate: number;
  bandwidth: number;
}

export interface AacLcMedia {
  mediaUri: string;
  keyUri: string;
  kid: string;
}

export class CodecNotFoundError extends Error {
  readonly codec: string;
  readonly nonRetryable = true;

  constructor(codec: string) {
    super(`codec ${codec} not found in manifest`);
    this.name = "CodecNotFoundError";
    this.codec = codec;
  }
}

export const CODEC_PATTERNS: Record<Exclude<Codec, "aac-lc">, RegExp> = {
  alac: /audio-alac-stereo-\d{5,6}-\d{2}$/,
  aac: /audio-stereo-\d{3}$/,
  "aac-binaural": /audio-stereo-\d{3}-binaural$/,
  "aac-downmix": /audio-stereo-\d{3}-downmix$/,
  ec3: /audio-(atmos|ec3)-\d{4}$/,
  ac3: /audio-ac3-\d{3}$/,
};

const KEY_SUFFIX_BY_CODEC: Record<string, string> = {
  alac: "c23",
  aac: "c22",
  "aac-downmix": "c24",
  "aac-binaural": "c24",
  ec3: "c24",
  ac3: "c24",
};

export function parseAttrs(v: string): Record<string, string> {
  const out: Record<string, string> = {};
  let key = "";
  let val = "";
  let inKey = true;
  let inQuote = false;

  const flush = () => {
    const k = key.trim();
    const trimmed = val.trim();
    const unquoted =
      trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2
        ? trimmed.slice(1, -1)
        : trimmed.replace(/^"+|"+$/g, "");
    if (k !== "") {
      out[k] = unquoted;
    }
    key = "";
    val = "";
    inKey = true;
  };

  for (let i = 0; i < v.length; i++) {
    const ch = v[i]!;
    if (inKey && ch === "=") {
      inKey = false;
    } else if (!inKey && ch === '"') {
      inQuote = !inQuote;
      val += ch;
    } else if (!inKey && ch === "," && !inQuote) {
      flush();
    } else if (inKey) {
      key += ch;
    } else {
      val += ch;
    }
  }
  flush();
  return out;
}

export function absUrl(base: string, ref: string): string {
  try {
    return new URL(ref, base).toString();
  } catch {
    return ref;
  }
}

function atoi(v: string): number {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

export function parseMaster(body: string, base: string): HlsVariant[] {
  const lines = body.split(/\r?\n/);
  const out: HlsVariant[] = [];
  let pending: Record<string, string> | null = null;
  const mediaExtras = new Map<string, Record<string, string>>();

  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("#EXT-X-MEDIA:")) {
      const attrs = parseAttrs(line.slice("#EXT-X-MEDIA:".length));
      if (attrs["GROUP-ID"]) {
        mediaExtras.set(attrs["GROUP-ID"], attrs);
      }
      continue;
    }
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      pending = parseAttrs(line.slice("#EXT-X-STREAM-INF:".length));
      continue;
    }
    if (pending !== null && line !== "" && !line.startsWith("#")) {
      const audio = pending["AUDIO"] ?? "";
      const extras = mediaExtras.get(audio) ?? {};
      out.push({
        uri: absUrl(base, line),
        audio,
        bandwidth: atoi(
          firstNonEmpty(pending["AVERAGE-BANDWIDTH"], pending["BANDWIDTH"]),
        ),
        bitDepth: atoi(firstNonEmpty(extras["BIT-DEPTH"], extras["bit_depth"])),
        sampleRate: atoi(
          firstNonEmpty(extras["SAMPLE-RATE"], extras["sample_rate"]),
        ),
      });
      pending = null;
    }
  }
  return out;
}

export function selectVariant(
  variants: readonly HlsVariant[],
  codec: Exclude<Codec, "aac-lc">,
  maxSampleRate = 0,
  maxBitDepth = 0,
): HlsVariant {
  const pat = CODEC_PATTERNS[codec];
  const filtered: HlsVariant[] = [];
  for (const v of variants) {
    if (pat && !pat.test(v.audio)) continue;
    if (codec === "alac") {
      if (maxSampleRate > 0 && v.sampleRate > maxSampleRate) continue;
      if (maxBitDepth > 0 && v.bitDepth > maxBitDepth) continue;
    }
    filtered.push(v);
  }
  if (filtered.length === 0) {
    throw new CodecNotFoundError(codec);
  }
  filtered.sort((a, b) => b.bandwidth - a.bandwidth);
  return filtered[0]!;
}

export function parseMedia(
  body: string,
  base: string,
  codec: string,
): { mediaUri: string; keys: string[] } {
  const lines = body.split(/\r?\n/);
  const keys: string[] = [PREFETCH_KEY];
  const keySuffix = KEY_SUFFIX_BY_CODEC[codec] ?? "c6";
  let mediaUri = "";

  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("#EXT-X-KEY:")) {
      const attrs = parseAttrs(line.slice("#EXT-X-KEY:".length));
      const key = attrs["URI"] ?? "";
      if (
        key.startsWith("skd://") &&
        (key.endsWith(keySuffix) || key.endsWith("c6"))
      ) {
        keys.push(key);
      }
    }
    if (line.startsWith("#EXT-X-MAP:")) {
      const attrs = parseAttrs(line.slice("#EXT-X-MAP:".length));
      if (attrs["URI"]) {
        mediaUri = absUrl(base, attrs["URI"]);
      }
    }
  }
  if (!mediaUri) {
    throw new Error("manifest has no EXT-X-MAP media URI");
  }
  return { mediaUri, keys };
}

export function parseAacLcPlaylist(body: string, playlistUrl: string): AacLcMedia {
  let mediaUri = "";
  let keyUri = "";
  let kid = "";
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("#EXT-X-KEY:")) {
      const uri = parseAttrs(line.slice("#EXT-X-KEY:".length))["URI"] ?? "";
      if (uri) {
        keyUri = uri;
        const comma = uri.indexOf(",");
        if (comma >= 0) {
          kid = uri.slice(comma + 1);
        }
      }
    }
    if (line.startsWith("#EXT-X-MAP:")) {
      const mapUri = parseAttrs(line.slice("#EXT-X-MAP:".length))["URI"] ?? "";
      if (mapUri) {
        mediaUri = absUrl(playlistUrl, mapUri);
      }
    }
  }
  if (!mediaUri) {
    throw new Error("aac-lc playlist has no EXT-X-MAP media URI");
  }
  if (!keyUri || !kid) {
    throw new Error("aac-lc playlist has no Widevine key URI");
  }
  return { mediaUri, keyUri, kid };
}
