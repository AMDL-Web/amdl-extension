export type Codec =
  | "alac"
  | "aac"
  | "aac-binaural"
  | "aac-downmix"
  | "ec3"
  | "ac3"
  | "aac-lc";

export type LyricsTiming = "line" | "word";
export type LyricsExtra = "translation" | "pronunciation";
export type CoverFormat = "jpg" | "png";

export type PipelineStage =
  | "resolve"
  | "manifest"
  | "download"
  | "keys"
  | "decrypt"
  | "remux"
  | "tag"
  | "done"
  | "error";

export interface ArtworkColors {
  bgColor: string;
  textColor1: string;
  textColor2: string;
  textColor3: string;
  textColor4: string;
}

export interface Song {
  id: string;
  name: string;
  artistName: string;
  albumName: string;
  composerName: string;
  genreNames: string[];
  releaseDate: string;
  trackNumber: number;
  discNumber: number;
  trackCount: number;
  discCount: number;
  durationInMillis: number;
  isrc: string;
  contentRating: string;
  hasLyrics: boolean;
  appleDigitalMaster: boolean;
  artworkUrl: string;
  albumArtworkUrl: string;
  artistArtworkUrl: string;
  enhancedHls: string;
  albumId: string;
  albumArtist: string;
  albumArtistId: string;
  albumRelease: string;
  copyright: string;
  recordLabel: string;
  upc: string;
  artistId: string;
  artistUrl: string;
  hiResLossless: boolean;
  audioTraits: string[];
  url: string;
}

export interface Collection {
  id: string;
  type: "album" | "playlist" | "station";
  name: string;
  artist: string;
  artworkUrl: string;
  artistId: string;
  artistArtworkUrl: string;
  artistUrl: string;
  releaseDate: string;
  genreNames: string[];
  contentRating: string;
  appleDigitalMaster: boolean;
  url: string;
  trackCount: number;
  audioTraits: string[];
  tracks: Song[];
}

export interface SongInfo {
  id: string;
  name: string;
  artist: string;
  album: string;
  albumArtist: string;
  trackNumber: number;
  discNumber: number;
  songNumber: number;
  hasLyrics: boolean;
  hiRes: boolean;
}

export interface StreamInfo {
  codec: Codec;
  codecId: string;
  sampleRate: number;
  bitDepth: number;
  bandwidth: number;
  keys: number;
  manifestSource: string;
  mediaUri: string;
}

export interface TimingsMs {
  resolve: number;
  manifest: number;
  download: number;
  keys: number;
  keysFetch: number;
  decrypt: number;
  remux: number;
  lyrics: number;
  cover: number;
  total: number;
}

export interface Sizes {
  encrypted: number;
  tagged: number;
  cover: number;
  lyrics: number;
}

export interface PipelineEvent {
  stage: PipelineStage;
  message: string;
  done: number;
  total: number;
}

export interface PipelineResult {
  fileName: string;
  parts: Uint8Array[];
  totalSize: number;
  song: SongInfo;
  stream: StreamInfo;
  timingsMs: TimingsMs;
  sizes: Sizes;
  decryptMBps: number;
  notes: string[];
}

export const ITUNES_ADVISORY_NONE = 0;
export const ITUNES_ADVISORY_EXPLICIT = 1;
export const ITUNES_ADVISORY_CLEAN = 2;

export interface MP4Picture {
  format: "auto" | "jpeg" | "png";
  data: Uint8Array;
}

export interface MP4Tags {
  album?: string;
  albumSort?: string;
  albumArtist?: string;
  albumArtistSort?: string;
  artist?: string;
  artistSort?: string;
  bpm?: number;
  comment?: string;
  composer?: string;
  composerSort?: string;
  conductor?: string;
  copyright?: string;
  customGenre?: string;
  date?: string;
  description?: string;
  director?: string;
  discNumber?: number;
  discTotal?: number;
  genre?: number;
  itunesAdvisory?: number;
  itunesAlbumId?: number;
  itunesArtistId?: number;
  lyrics?: string;
  narrator?: string;
  publisher?: string;
  title?: string;
  titleSort?: string;
  trackNumber?: number;
  trackTotal?: number;
  year?: number;
  custom?: Record<string, string>;
  otherCustom?: Record<string, string[]>;
  pictures?: MP4Picture[];
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

const SECRET_KEYS = new Set([
  "authorization",
  "media-user-token",
  "mediausertoken",
  "x-apple-music-user-token",
  "developertoken",
  "musicusertoken",
  "wrappertoken",
  "token",
  "challenge",
  "license",
  "key",
]);

export function redactFields(
  fields?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!fields) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (SECRET_KEYS.has(k.toLowerCase())) {
      out[k] = "[REDACTED]";
    } else {
      out[k] = v;
    }
  }
  return out;
}

export const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export function createConsoleLogger(prefix = "[amdl]", verbose = false): Logger {
  const emit = (
    fn: (...args: unknown[]) => void,
    msg: string,
    fields?: Record<string, unknown>,
  ) => {
    const safe = redactFields(fields);
    if (safe && Object.keys(safe).length > 0) {
      fn(`${prefix} ${msg}`, safe);
    } else {
      fn(`${prefix} ${msg}`);
    }
  };
  return {
    debug(msg, fields) {
      if (verbose) emit(console.debug, msg, fields);
    },
    info(msg, fields) {
      emit(console.info, msg, fields);
    },
    warn(msg, fields) {
      emit(console.warn, msg, fields);
    },
    error(msg, fields) {
      emit(console.error, msg, fields);
    },
  };
}

export function firstNonEmpty(...values: (string | undefined | null)[]): string {
  for (const v of values) {
    if (v && v.trim() !== "") return v;
  }
  return "";
}
