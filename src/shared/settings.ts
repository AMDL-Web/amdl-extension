import {
  DEFAULT_FILENAME_TEMPLATE,
  DEFAULT_PLAYLIST_FILENAME_TEMPLATE,
} from "../core/naming.ts";
import type {
  Codec,
  CoverFormat,
  LyricsExtra,
  LyricsTiming,
} from "../core/types.ts";

export const SETTINGS_SCHEMA_VERSION = 1;
export const SETTINGS_STORAGE_KEY = "settings";

export interface ExtensionSettings {
  schemaVersion: number;
  wrapperUrl: string;
  wrapperToken: string;
  codec: Codec;
  maxSampleRate: number;
  maxBitDepth: number;
  fallbackOnCodecNotFound: boolean;
  embedLyrics: boolean;
  lyricsTiming: LyricsTiming;
  lyricsExtras: LyricsExtra[];
  embedCover: boolean;
  coverSize: string;
  coverFormat: CoverFormat;
  filenameTemplate: string;
  playlistFilenameTemplate: string;
  concurrency: number;
  saveAs: boolean;
  language: string;
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  wrapperUrl: "",
  wrapperToken: "",
  codec: "alac",
  maxSampleRate: 192000,
  maxBitDepth: 24,
  fallbackOnCodecNotFound: true,
  embedLyrics: true,
  lyricsTiming: "word",
  lyricsExtras: ["translation"],
  embedCover: true,
  coverSize: "5000x5000",
  coverFormat: "jpg",
  filenameTemplate: DEFAULT_FILENAME_TEMPLATE,
  playlistFilenameTemplate: DEFAULT_PLAYLIST_FILENAME_TEMPLATE,
  concurrency: 4,
  saveAs: false,
  language: "",
};

const VALID_CODECS = new Set<Codec>([
  "alac",
  "aac",
  "aac-binaural",
  "aac-downmix",
  "ec3",
  "ac3",
  "aac-lc",
]);

export function sanitizeSettings(raw: unknown): ExtensionSettings {
  const s =
    raw && typeof raw === "object" ? (raw as Partial<ExtensionSettings>) : {};
  const codec =
    typeof s.codec === "string" && VALID_CODECS.has(s.codec as Codec)
      ? (s.codec as Codec)
      : DEFAULT_SETTINGS.codec;
  const maxSampleRate =
    typeof s.maxSampleRate === "number" &&
    [44100, 48000, 96000, 192000].includes(s.maxSampleRate)
      ? s.maxSampleRate
      : DEFAULT_SETTINGS.maxSampleRate;
  const maxBitDepth =
    s.maxBitDepth === 16 || s.maxBitDepth === 24
      ? s.maxBitDepth
      : DEFAULT_SETTINGS.maxBitDepth;
  const lyricsTiming: LyricsTiming =
    s.lyricsTiming === "word" || s.lyricsTiming === "line"
      ? s.lyricsTiming
      : DEFAULT_SETTINGS.lyricsTiming;
  const lyricsExtras: LyricsExtra[] = Array.isArray(s.lyricsExtras)
    ? s.lyricsExtras.filter(
        (x): x is LyricsExtra => x === "translation" || x === "pronunciation",
      )
    : [...DEFAULT_SETTINGS.lyricsExtras];
  const coverFormat: CoverFormat = s.coverFormat === "png" ? "png" : "jpg";
  const concurrency =
    typeof s.concurrency === "number" && Number.isFinite(s.concurrency)
      ? Math.max(1, Math.min(4, Math.round(s.concurrency)))
      : DEFAULT_SETTINGS.concurrency;

  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    wrapperUrl: typeof s.wrapperUrl === "string" ? s.wrapperUrl.trim() : "",
    wrapperToken:
      typeof s.wrapperToken === "string" ? s.wrapperToken.trim() : "",
    codec,
    maxSampleRate,
    maxBitDepth,
    fallbackOnCodecNotFound:
      typeof s.fallbackOnCodecNotFound === "boolean"
        ? s.fallbackOnCodecNotFound
        : DEFAULT_SETTINGS.fallbackOnCodecNotFound,
    embedLyrics:
      typeof s.embedLyrics === "boolean"
        ? s.embedLyrics
        : DEFAULT_SETTINGS.embedLyrics,
    lyricsTiming,
    lyricsExtras,
    embedCover:
      typeof s.embedCover === "boolean"
        ? s.embedCover
        : DEFAULT_SETTINGS.embedCover,
    coverSize:
      typeof s.coverSize === "string" && s.coverSize.trim()
        ? s.coverSize.trim()
        : DEFAULT_SETTINGS.coverSize,
    coverFormat,
    filenameTemplate:
      typeof s.filenameTemplate === "string" && s.filenameTemplate.trim()
        ? s.filenameTemplate.trim()
        : DEFAULT_FILENAME_TEMPLATE,
    playlistFilenameTemplate:
      typeof s.playlistFilenameTemplate === "string" &&
      s.playlistFilenameTemplate.trim()
        ? s.playlistFilenameTemplate.trim()
        : DEFAULT_PLAYLIST_FILENAME_TEMPLATE,
    concurrency,
    saveAs: Boolean(s.saveAs),
    language: typeof s.language === "string" ? s.language.trim() : "",
  };
}

export async function loadSettings(): Promise<ExtensionSettings> {
  const result = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
  return sanitizeSettings(result[SETTINGS_STORAGE_KEY]);
}

export async function saveSettings(
  settings: ExtensionSettings,
): Promise<ExtensionSettings> {
  const clean = sanitizeSettings(settings);
  await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: clean });
  return clean;
}

export function wrapperOriginPattern(address: string): string | null {
  const trimmed = address.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  const withScheme = trimmed.includes("://") ? trimmed : `http://${trimmed}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.host) return null;
    return `${u.origin}/*`;
  } catch {
    return null;
  }
}
