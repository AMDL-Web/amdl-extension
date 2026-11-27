import type { Song } from "./types.ts";

const INVALID_PATH_CHARS_RE = /[\/\\<>:"|?*]/g;
const MAX_SEGMENT_BYTES = 240;

const utf8Encoder = new TextEncoder();

function isDotOrSpace(ch: string): boolean {
  return ch === "." || /\s/.test(ch);
}

function trimDotsAndSpace(s: string): string {
  const chars = Array.from(s);
  let start = 0;
  let end = chars.length;
  while (start < end && isDotOrSpace(chars[start]!)) start++;
  while (end > start && isDotOrSpace(chars[end - 1]!)) end--;
  return chars.slice(start, end).join("");
}

function trimRightDotsAndSpace(s: string): string {
  const chars = Array.from(s);
  let end = chars.length;
  while (end > 0 && isDotOrSpace(chars[end - 1]!)) end--;
  return chars.slice(0, end).join("");
}

function trimToUtf8ByteLimit(s: string, limit: number): string {
  if (limit <= 0) return "";
  if (utf8Encoder.encode(s).length <= limit) return s;
  let out = "";
  let bytes = 0;
  for (const ch of s) {
    const chBytes = utf8Encoder.encode(ch).length;
    if (bytes + chBytes > limit) break;
    out += ch;
    bytes += chBytes;
  }
  return out;
}

export function safeName(v: string): string {
  let s = v.replace(INVALID_PATH_CHARS_RE, "_");
  s = trimDotsAndSpace(s);
  if (utf8Encoder.encode(s).length > MAX_SEGMENT_BYTES) {
    s = trimRightDotsAndSpace(trimToUtf8ByteLimit(s, MAX_SEGMENT_BYTES));
  }
  return s === "" ? "_" : s;
}

/**
 * Numbers an album's tracks as the album was released: each track's own
 * trackNumber, counting across discs by every earlier disc's track total.
 * Falls back to 1..N list positions if any track lacks a trackNumber or two
 * tracks collide. Matches Go engine/song.go#albumSongNumbers.
 */
export function albumSongNumbers(tracks: readonly Song[]): number[] {
  const totals = new Map<number, number>();
  const counts = new Map<number, number>();
  for (const track of tracks) {
    const disc = Math.max(1, track.discNumber);
    const count = (counts.get(disc) ?? 0) + 1;
    counts.set(disc, count);
    totals.set(disc, Math.max(totals.get(disc) ?? 0, track.trackNumber, count));
  }

  const numbers = new Array<number>(tracks.length);
  const seen = new Set<number>();
  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i]!;
    const disc = Math.max(1, track.discNumber);
    let number = track.trackNumber;
    for (let d = 1; d < disc; d++) {
      number += totals.get(d) ?? 0;
    }
    if (track.trackNumber < 1 || seen.has(number)) {
      for (let j = 0; j < numbers.length; j++) {
        numbers[j] = j + 1;
      }
      return numbers;
    }
    seen.add(number);
    numbers[i] = number;
  }
  return numbers;
}

export function defaultTrackFileName(songNumber: number, title: string): string {
  const num = String(songNumber).padStart(2, "0");
  return `${num}. ${safeName(title)}.m4a`;
}

export const DEFAULT_FILENAME_TEMPLATE =
  "Apple Music/{albumArtist}/{album}/{songNumber:02}. {title}.m4a";

export const DEFAULT_PLAYLIST_FILENAME_TEMPLATE =
  "Apple Music/Playlists/{playlistName}/{playlistIndex:02}. {title}.m4a";

export interface PlaylistContext {
  playlistId?: string;
  playlistName: string;
  playlistIndex: number;
}

export interface FilenameTemplateVars {
  albumArtist: string;
  artist: string;
  album: string;
  title: string;
  songNumber: number;
  trackNumber: number;
  discNumber: number;
  codec?: string;
  playlistName?: string;
  playlistIndex?: number;
}

/**
 * Formats a relative download path from a template such as:
 * `Apple Music/{albumArtist}/{album}/{songNumber:02}. {title}.m4a`
 * or for playlists:
 * `Apple Music/Playlists/{playlistName}/{playlistIndex:02}. {title}.m4a`
 * Each path segment is sanitized independently via `safeName` and never escapes
 * above the download directory.
 */
export function formatDownloadPath(
  template: string,
  vars: FilenameTemplateVars,
): string {
  const tpl =
    template.trim() ||
    (vars.playlistName !== undefined
      ? DEFAULT_PLAYLIST_FILENAME_TEMPLATE
      : DEFAULT_FILENAME_TEMPLATE);
  const values: Record<string, string | number> = {
    albumArtist: vars.albumArtist || vars.artist,
    artist: vars.artist,
    album: vars.album,
    title: vars.title,
    songNumber: vars.songNumber,
    trackNumber: vars.trackNumber,
    discNumber: vars.discNumber,
    codec: vars.codec ?? "",
    playlistName: vars.playlistName ?? "",
    playlistIndex: vars.playlistIndex ?? vars.songNumber,
  };

  const segments = tpl
    .replace(/\\/g, "/")
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s !== "" && s !== "." && s !== "..");

  const rendered = segments.map((seg) => {
    const replaced = seg.replace(
      /\{([a-zA-Z0-9_]+)(?::0(\d+))?\}/g,
      (_m, key: string, padWidth?: string) => {
        const val = values[key];
        if (val === undefined) return "";
        if (typeof val === "number" && padWidth) {
          return String(val).padStart(Number.parseInt(padWidth, 10), "0");
        }
        return String(val);
      },
    );
    return safeName(replaced);
  });

  if (rendered.length === 0) {
    return defaultTrackFileName(vars.songNumber, vars.title);
  }
  const last = rendered[rendered.length - 1]!;
  if (!last.toLowerCase().endsWith(".m4a")) {
    rendered[rendered.length - 1] = `${last}.m4a`;
  }
  return rendered.join("/");
}

/**
 * Computes a deterministic de-duplication key combining `songId` and its
 * destination path template / playlist context so the same song can be
 * downloaded both via its album and into one or more playlist folders, while
 * repeated triggers for the same song + destination stay de-duplicated.
 */
export function buildJobDedupKey(args: {
  songId: string;
  filenameTemplate?: string;
  playlistFilenameTemplate?: string;
  playlistContext?: PlaylistContext;
  codec?: string;
}): string {
  const songId = args.songId.trim();
  if (args.playlistContext) {
    const tpl =
      args.playlistFilenameTemplate?.trim() ||
      DEFAULT_PLAYLIST_FILENAME_TEMPLATE;
    const plName = safeName(args.playlistContext.playlistName || "Playlist");
    const plIdx = Math.max(1, Math.trunc(args.playlistContext.playlistIndex));
    const codecPart = tpl.includes("{codec}") ? `\0${args.codec ?? ""}` : "";
    return `${songId}\0playlist\0${tpl}\0${plName}\0${plIdx}${codecPart}`;
  }
  const tpl = args.filenameTemplate?.trim() || DEFAULT_FILENAME_TEMPLATE;
  const codecPart = tpl.includes("{codec}") ? `\0${args.codec ?? ""}` : "";
  return `${songId}\0album\0${tpl}${codecPart}`;
}

/**
 * UI-side job lookup key scoped to album/song context vs a specific playlist
 * slot, independent of the template text and resilient to DOM vs API locale
 * differences in playlist names when `playlistId` is known.
 */
export function buildUiJobKey(
  songId: string,
  playlistContext?: PlaylistContext,
): string {
  const id = songId.trim();
  if (!playlistContext) return `${id}\0album`;
  const plKey =
    playlistContext.playlistId?.trim() ||
    safeName(playlistContext.playlistName || "Playlist");
  const plIdx = Math.max(1, Math.trunc(playlistContext.playlistIndex));
  return `${id}\0playlist\0${plKey}\0${plIdx}`;
}
