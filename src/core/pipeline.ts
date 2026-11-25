import {
  AppleApi,
  ERR_NO_ENHANCED_HLS,
  ERR_NO_LYRICS,
  enrichWithAlbum,
  isAppleNotFound,
  isUserTokenRejected,
} from "./apple-api.ts";
import { downloadMedia, downloadText } from "./download.ts";
import {
  type FairPlayDecryptor,
  decryptFairPlayInPlace,
} from "./fairplay.ts";
import {
  type AacLcMedia,
  CODEC_PATTERNS,
  CodecNotFoundError,
  type SelectedMediaInfo,
  parseAacLcPlaylist,
  parseMaster,
  parseMedia,
  selectVariant,
} from "./hls.ts";
import { lyricsLrc } from "./lyrics.ts";
import { flattenToParts } from "./mp4/flatten.ts";
import {
  type ParsedFragmentedMp4,
  parseFragmentedMp4,
  readSampleRateFromMp4,
} from "./mp4/fragments.ts";
import { buildTags } from "./mp4/tags.ts";
import {
  albumSongNumbers,
  defaultTrackFileName,
  formatDownloadPath,
} from "./naming.ts";
import {
  type Codec,
  type CoverFormat,
  type Logger,
  type LyricsExtra,
  type LyricsTiming,
  type PipelineEvent,
  type PipelineResult,
  type Song,
  firstNonEmpty,
  noopLogger,
} from "./types.ts";
import { parseSongRef } from "./url.ts";
import { WrapperClient, WrapperError } from "./wrapper-client.ts";

const WEB_ALAC_MAX_SAMPLE_RATE = 48000;
const AAC_LC_BANDWIDTH = 256000;

export interface AacLcDecryptHandler {
  acquireKeys(args: {
    songId: string;
    media: AacLcMedia;
    mediaUserToken?: string;
    appleApi: AppleApi;
    wrapper?: WrapperClient;
    logger: Logger;
    signal?: AbortSignal;
  }): Promise<Uint8Array>;
  decryptInPlace(
    buf: Uint8Array,
    parsed: ParsedFragmentedMp4,
    contentKey: Uint8Array,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface PipelineOptions {
  /** Song URL, album URL with `?i=`, or bare song ID. */
  url: string;
  storefront?: string;
  language?: string;
  codec?: Codec;
  maxSampleRate?: number;
  maxBitDepth?: number;
  fallbackOnCodecNotFound?: boolean;
  mediaUserToken?: string;
  embedLyrics?: boolean;
  lyricsTiming?: LyricsTiming;
  lyricsExtras?: LyricsExtra[];
  embedCover?: boolean;
  coverSize?: string;
  coverFormat?: CoverFormat;
  filenameTemplate?: string;
  downloadConcurrency?: number;
  signal?: AbortSignal;
  appleApi: AppleApi;
  wrapper?: WrapperClient;
  fairPlayDecryptor?: FairPlayDecryptor;
  aacLcDecryptor?: AacLcDecryptHandler;
  fetchImpl?: typeof globalThis.fetch;
  logger?: Logger;
  onProgress?: (event: PipelineEvent) => void;
}

function wantsDeviceManifest(
  song: Song,
  codec: Codec,
  maxSampleRate: number,
): boolean {
  if (!song.hiResLossless || codec !== "alac") return false;
  return maxSampleRate <= 0 || maxSampleRate > WEB_ALAC_MAX_SAMPLE_RATE;
}

function trackCoverUrls(song: Song): string[] {
  if (song.artworkUrl) return [song.artworkUrl];
  if (song.albumArtworkUrl) return [song.albumArtworkUrl];
  return [];
}

function isWrapperLyricsNotFound(err: unknown): boolean {
  return err instanceof WrapperError && err.code === 404;
}

async function resolveSong(
  appleApi: AppleApi,
  storefront: string,
  songId: string,
  language: string | undefined,
  signal?: AbortSignal,
): Promise<{ song: Song; songNumber: number }> {
  let song = await appleApi.songMetadata(storefront, songId, language, signal);
  let songNumber = Math.max(1, song.trackNumber);
  if (!song.albumId) {
    return { song, songNumber };
  }
  try {
    const album = await appleApi.album(
      storefront,
      song.albumId,
      language,
      signal,
    );
    if (album.tracks.length > 0) {
      song = enrichWithAlbum(song, album);
      const numbers = albumSongNumbers(album.tracks);
      for (let i = 0; i < album.tracks.length; i++) {
        if (album.tracks[i]!.id === song.id) {
          songNumber = numbers[i]!;
          break;
        }
      }
    }
  } catch {
    // Failed album fetch leaves the song as its own resource describes it.
  }
  return { song, songNumber };
}

async function extractEnhancedMedia(
  masterUrl: string,
  codec: Exclude<Codec, "aac-lc">,
  maxSampleRate: number,
  maxBitDepth: number,
  opts: { signal?: AbortSignal; fetchImpl?: typeof globalThis.fetch },
): Promise<SelectedMediaInfo> {
  const master = await downloadText(masterUrl, opts);
  const selected = selectVariant(
    parseMaster(master, masterUrl),
    codec,
    maxSampleRate,
    maxBitDepth,
  );
  const media = await downloadText(selected.uri, opts);
  const { mediaUri, keys } = parseMedia(media, selected.uri, codec);
  return {
    mediaUri,
    keys,
    codecId: selected.audio,
    bitDepth: selected.bitDepth,
    sampleRate: selected.sampleRate,
    bandwidth: selected.bandwidth,
  };
}

async function selectEnhancedStream(
  song: Song,
  codec: Exclude<Codec, "aac-lc">,
  maxSampleRate: number,
  maxBitDepth: number,
  wrapper: WrapperClient,
  logger: Logger,
  fetchOpts: { signal?: AbortSignal; fetchImpl?: typeof globalThis.fetch },
): Promise<{ info: SelectedMediaInfo; source: "device" | "catalog" }> {
  let master = song.enhancedHls;
  let source: "device" | "catalog" = "catalog";

  if (wantsDeviceManifest(song, codec, maxSampleRate)) {
    try {
      const m3u8 = await wrapper.m3u8(song.id, fetchOpts.signal);
      if (m3u8) {
        master = m3u8;
        source = "device";
      } else {
        logger.warn("device /m3u8 returned empty manifest; using web manifest", {
          songId: song.id,
        });
      }
    } catch (err) {
      if (fetchOpts.signal?.aborted) throw err;
      logger.warn(
        "device manifest unavailable; using web manifest (may lack hi-res)",
        { songId: song.id, error: String(err) },
      );
    }
  }

  if (!master) {
    throw new Error(`song ${song.id}: ${ERR_NO_ENHANCED_HLS.message}`);
  }

  try {
    const info = await extractEnhancedMedia(
      master,
      codec,
      maxSampleRate,
      maxBitDepth,
      fetchOpts,
    );
    return { info, source };
  } catch (err) {
    if (
      source === "device" &&
      !fetchOpts.signal?.aborted &&
      song.enhancedHls &&
      !(err instanceof CodecNotFoundError)
    ) {
      logger.warn("device manifest failed to load; falling back to web manifest", {
        songId: song.id,
        error: String(err),
      });
      const info = await extractEnhancedMedia(
        song.enhancedHls,
        codec,
        maxSampleRate,
        maxBitDepth,
        fetchOpts,
      );
      return { info, source: "catalog" };
    }
    throw err;
  }
}

async function resolveAacLcStream(args: {
  songId: string;
  mediaUserToken?: string;
  appleApi: AppleApi;
  wrapper?: WrapperClient;
  logger: Logger;
  signal?: AbortSignal;
  fetchImpl?: typeof globalThis.fetch;
}): Promise<{ media: AacLcMedia; source: "webplayback" | "wrapper" }> {
  let playlistUrl = "";
  let source: "webplayback" | "wrapper" = "wrapper";
  const token = (args.mediaUserToken ?? "").trim();

  if (token) {
    try {
      playlistUrl = await args.appleApi.webPlayback(
        token,
        args.songId,
        args.signal,
      );
      source = "webplayback";
    } catch (err) {
      if (isUserTokenRejected(err) && args.wrapper) {
        args.logger.warn(
          "media-user-token rejected by webPlayback; falling back to wrapper",
          { songId: args.songId },
        );
      } else {
        throw err;
      }
    }
  }

  if (!playlistUrl) {
    if (!args.wrapper) {
      throw new Error(
        "Sign in to Apple Music (or configure a wrapper) to download AAC-LC.",
      );
    }
    playlistUrl = await args.wrapper.webPlayback(args.songId, args.signal);
    source = "wrapper";
  }

  const body = await downloadText(playlistUrl, {
    signal: args.signal,
    fetchImpl: args.fetchImpl,
  });
  const media = parseAacLcPlaylist(body, playlistUrl);
  return { media, source };
}

async function fetchLyricsTask(args: {
  songId: string;
  language?: string;
  mediaUserToken?: string;
  lyricsTiming: LyricsTiming;
  lyricsExtras: LyricsExtra[];
  appleApi: AppleApi;
  wrapper?: WrapperClient;
  signal?: AbortSignal;
}): Promise<{ lrc: string; note: string }> {
  let doc = "";
  let err: unknown = null;
  const token = (args.mediaUserToken ?? "").trim();

  if (token) {
    try {
      const sf = await args.appleApi.accountStorefront(token, args.signal);
      try {
        doc = await args.appleApi.songLyrics(
          token,
          sf,
          args.songId,
          args.language,
          args.signal,
        );
      } catch (lErr) {
        if (
          !isAppleNotFound(lErr) &&
          lErr !== ERR_NO_LYRICS &&
          !isUserTokenRejected(lErr)
        ) {
          err = lErr;
        }
      }
    } catch (sfErr) {
      if (args.signal?.aborted) err = sfErr;
    }
  }

  if (!doc && !err) {
    if (!args.wrapper) {
      return {
        lrc: "",
        note: "no lyrics found via media-user-token (no wrapper configured)",
      };
    }
    try {
      doc = await args.wrapper.lyrics(
        args.songId,
        { language: args.language, syllable: true },
        args.signal,
      );
    } catch (wErr) {
      if (isWrapperLyricsNotFound(wErr)) {
        try {
          doc = await args.wrapper.lyrics(
            args.songId,
            { language: args.language, syllable: false },
            args.signal,
          );
        } catch (wErr2) {
          err = wErr2;
        }
      } else {
        err = wErr;
      }
    }
  }

  if (isWrapperLyricsNotFound(err)) {
    return { lrc: "", note: "the wrapper found no lyrics for this track" };
  }
  if (err) {
    return {
      lrc: "",
      note: `lyrics left out: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!doc) {
    return { lrc: "", note: "lyrics fetch returned an empty document" };
  }

  try {
    const lrc = lyricsLrc(doc, args.lyricsTiming === "word", args.lyricsExtras);
    if (!lrc) return { lrc: "", note: "lyrics fetch returned an empty document" };
    return { lrc, note: "" };
  } catch (convErr) {
    return {
      lrc: "",
      note: `lyrics conversion failed: ${convErr instanceof Error ? convErr.message : String(convErr)}`,
    };
  }
}

export async function runPipeline(
  opts: PipelineOptions,
): Promise<PipelineResult> {
  const totalStart = performance.now();
  const logger = opts.logger ?? noopLogger;
  const signal = opts.signal;
  const fetchOpts = { signal, fetchImpl: opts.fetchImpl };

  const defaultStorefront = opts.storefront || "cn";
  const language = opts.language || "zh-Hans_CN";
  const maxSampleRate = opts.maxSampleRate ?? 0;
  const maxBitDepth = opts.maxBitDepth ?? 0;
  const embedLyrics = opts.embedLyrics ?? true;
  const embedCover = opts.embedCover ?? true;
  const coverSize = opts.coverSize || "5000x5000";
  const coverFormat = opts.coverFormat || "jpg";
  const lyricsTiming = opts.lyricsTiming || "line";
  const lyricsExtras = opts.lyricsExtras ?? [];
  const fallbackOnCodecNotFound = opts.fallbackOnCodecNotFound ?? false;

  const emit = (
    stage: PipelineEvent["stage"],
    message: string,
    done = 0,
    total = 0,
  ) => {
    opts.onProgress?.({ stage, message, done, total });
  };

  // Mode check (DESIGN §4.2): no wrapper forces aac-lc (and requires mediaUserToken).
  let requestedCodec: Codec = opts.wrapper ? (opts.codec ?? "alac") : "aac-lc";
  if (
    requestedCodec !== "aac-lc" &&
    !Object.prototype.hasOwnProperty.call(CODEC_PATTERNS, requestedCodec)
  ) {
    throw new Error(`unknown codec "${requestedCodec}"`);
  }
  if (!opts.wrapper && !(opts.mediaUserToken ?? "").trim()) {
    throw new Error(
      "Not signed in to Apple Music and no wrapper configured. Sign in on music.apple.com or configure a wrapper in Options.",
    );
  }

  const timings = {
    resolve: 0,
    manifest: 0,
    download: 0,
    keys: 0,
    keysFetch: 0,
    decrypt: 0,
    remux: 0,
    lyrics: 0,
    cover: 0,
    total: 0,
  };
  const notes: string[] = [];

  // 1. Resolve song + album metadata.
  emit("resolve", "Resolving song");
  let t0 = performance.now();
  const { storefront, songId } = parseSongRef(opts.url, defaultStorefront);
  const { song, songNumber } = await resolveSong(
    opts.appleApi,
    storefront,
    songId,
    language,
    signal,
  );
  timings.resolve = Math.round(performance.now() - t0);

  // Start lyrics + cover in parallel with manifest & media download.
  let lyricsPromise: Promise<{ lrc: string; note: string }> = Promise.resolve({
    lrc: "",
    note: "",
  });
  if (embedLyrics) {
    if (song.hasLyrics) {
      const lt0 = performance.now();
      lyricsPromise = fetchLyricsTask({
        songId: song.id,
        language,
        mediaUserToken: opts.mediaUserToken,
        lyricsTiming,
        lyricsExtras,
        appleApi: opts.appleApi,
        wrapper: opts.wrapper,
        signal,
      }).then((r) => {
        timings.lyrics = Math.round(performance.now() - lt0);
        return r;
      });
    } else {
      notes.push("song has no lyrics");
    }
  }

  let coverPromise: Promise<{ data?: Uint8Array; note: string }> =
    Promise.resolve({ note: "" });
  if (embedCover) {
    const ct0 = performance.now();
    coverPromise = opts.appleApi
      .fetchCover(trackCoverUrls(song), coverFormat, coverSize, signal)
      .then((data) => {
        timings.cover = Math.round(performance.now() - ct0);
        return { data, note: "" };
      })
      .catch((err) => {
        timings.cover = Math.round(performance.now() - ct0);
        return {
          note: `cover left out: ${err instanceof Error ? err.message : String(err)}`,
        };
      });
  }

  // 3. Manifest selection (with optional fallback chain: requested -> aac -> aac-lc).
  emit("manifest", `Selecting ${requestedCodec.toUpperCase()} stream`);
  t0 = performance.now();
  let activeCodec: Codec = requestedCodec;
  let enhancedInfo: SelectedMediaInfo | null = null;
  let enhancedSource: "device" | "catalog" = "catalog";
  let aacLcMedia: AacLcMedia | null = null;
  let aacLcSource: "webplayback" | "wrapper" = "wrapper";

  if (activeCodec !== "aac-lc") {
    const tryOrder: Codec[] = fallbackOnCodecNotFound
      ? activeCodec === "aac"
        ? ["aac", "aac-lc"]
        : [activeCodec, "aac", "aac-lc"]
      : [activeCodec];

    let lastErr: unknown;
    for (const candidate of tryOrder) {
      if (candidate === "aac-lc") {
        notes.push(
          `codec ${requestedCodec} unavailable; fell back to aac-lc`,
        );
        activeCodec = "aac-lc";
        break;
      }
      try {
        const res = await selectEnhancedStream(
          song,
          candidate,
          maxSampleRate,
          maxBitDepth,
          opts.wrapper!,
          logger,
          fetchOpts,
        );
        enhancedInfo = res.info;
        enhancedSource = res.source;
        activeCodec = candidate;
        if (candidate !== requestedCodec) {
          notes.push(
            `codec ${requestedCodec} unavailable; fell back to ${candidate}`,
          );
        }
        break;
      } catch (err) {
        lastErr = err;
        if (!(err instanceof CodecNotFoundError) || !fallbackOnCodecNotFound) {
          throw err;
        }
      }
    }
    if (activeCodec !== "aac-lc" && !enhancedInfo) {
      throw lastErr;
    }
  }

  if (activeCodec === "aac-lc") {
    const res = await resolveAacLcStream({
      songId: song.id,
      mediaUserToken: opts.mediaUserToken,
      appleApi: opts.appleApi,
      wrapper: opts.wrapper,
      logger,
      signal,
      fetchImpl: opts.fetchImpl,
    });
    aacLcMedia = res.media;
    aacLcSource = res.source;
  }
  timings.manifest = Math.round(performance.now() - t0);

  let encryptedBuf: Uint8Array;
  let parsedMp4: ParsedFragmentedMp4;
  let streamInfo: PipelineResult["stream"];
  let decryptMBps = 0;

  if (activeCodec === "aac-lc") {
    if (!opts.aacLcDecryptor) {
      throw new Error("AAC-LC Widevine decryptor is not configured");
    }
    const media = aacLcMedia!;
    const keysStart = performance.now();
    const keyPromise = opts.aacLcDecryptor
      .acquireKeys({
        songId: song.id,
        media,
        mediaUserToken: opts.mediaUserToken,
        appleApi: opts.appleApi,
        wrapper: opts.wrapper,
        logger,
        signal,
      })
      .then((key) => {
        timings.keysFetch = Math.round(performance.now() - keysStart);
        return key;
      });

    emit("download", "Downloading encrypted AAC-LC media");
    t0 = performance.now();
    encryptedBuf = await downloadMedia(media.mediaUri, {
      signal,
      concurrency: opts.downloadConcurrency,
      fetchImpl: opts.fetchImpl,
      onProgress: (done, total) =>
        emit("download", "Downloading encrypted AAC-LC media", done, total),
    });
    timings.download = Math.round(performance.now() - t0);

    emit("keys", "Waiting for Widevine license");
    t0 = performance.now();
    const contentKey = await keyPromise;
    timings.keys = Math.round(performance.now() - t0);

    emit("decrypt", "Decrypting AAC-LC (Widevine)");
    t0 = performance.now();
    parsedMp4 = parseFragmentedMp4(encryptedBuf);
    await opts.aacLcDecryptor.decryptInPlace(
      encryptedBuf,
      parsedMp4,
      contentKey,
      signal,
    );
    const decryptSec = (performance.now() - t0) / 1000;
    timings.decrypt = Math.round(decryptSec * 1000);
    if (decryptSec > 0) {
      decryptMBps = encryptedBuf.byteLength / 1e6 / decryptSec;
    }

    const sr = readSampleRateFromMp4(encryptedBuf);
    streamInfo = {
      codec: "aac-lc",
      codecId: "28:ctrp256",
      sampleRate: sr,
      bitDepth: 0,
      bandwidth: AAC_LC_BANDWIDTH,
      keys: 1,
      manifestSource: aacLcSource,
      mediaUri: media.mediaUri,
    };
  } else {
    if (!opts.wrapper) throw new Error("wrapper client is required for FairPlay");
    if (!opts.fairPlayDecryptor) {
      throw new Error("FairPlay decryptor is not configured");
    }
    const info = enhancedInfo!;
    const wrapper = opts.wrapper;

    // 4. Overlap key template fetch with media download.
    const keysStart = performance.now();
    const keysPromise = wrapper
      .prepareKeys(song.id, info.keys, signal)
      .then((map) => {
        timings.keysFetch = Math.round(performance.now() - keysStart);
        return { map, err: null as unknown };
      })
      .catch((err) => {
        timings.keysFetch = Math.round(performance.now() - keysStart);
        return { map: new Map<string, string>(), err };
      });

    // 5. Download encrypted media.
    emit("download", "Downloading encrypted media");
    t0 = performance.now();
    encryptedBuf = await downloadMedia(info.mediaUri, {
      signal,
      concurrency: opts.downloadConcurrency,
      fetchImpl: opts.fetchImpl,
      onProgress: (done, total) =>
        emit("download", "Downloading encrypted media", done, total),
    });
    timings.download = Math.round(performance.now() - t0);

    emit("keys", "Waiting for decryption keys");
    t0 = performance.now();
    const prep = await keysPromise;
    timings.keys = Math.round(performance.now() - t0);
    if (prep.err) {
      logger.warn("key prepare failed; decrypt will fetch needed keys directly", {
        songId: song.id,
        error: String(prep.err),
      });
    }

    // 6. Parse fragments & decrypt in place via FairPlay decryptor.
    emit("decrypt", "Decrypting FairPlay samples");
    t0 = performance.now();
    parsedMp4 = parseFragmentedMp4(encryptedBuf);
    const decRes = await decryptFairPlayInPlace(
      encryptedBuf,
      parsedMp4.fragments,
      info.keys,
      async (keyUri) => {
        const cached = prep.map.get(keyUri);
        if (cached) return cached;
        return wrapper.getKeyTemplate(song.id, keyUri, signal);
      },
      opts.fairPlayDecryptor,
      {
        signal,
        logger,
        onProgress: (done, total) =>
          emit("decrypt", "Decrypting FairPlay samples", done, total),
      },
    );
    notes.push(...decRes.notes);
    const decryptSec = (performance.now() - t0) / 1000;
    timings.decrypt = Math.round(decryptSec * 1000);
    if (decryptSec > 0) {
      decryptMBps = encryptedBuf.byteLength / 1e6 / decryptSec;
    }

    streamInfo = {
      codec: activeCodec,
      codecId: info.codecId,
      sampleRate: info.sampleRate,
      bitDepth: info.bitDepth,
      bandwidth: info.bandwidth,
      keys: info.keys.length,
      manifestSource: enhancedSource,
      mediaUri: info.mediaUri,
    };
  }

  // 7. Flatten + tag in one pass into zero-copy Blob parts.
  emit("remux", "Remuxing to M4A and writing tags");
  const [lyricsRes, coverRes] = await Promise.all([
    lyricsPromise,
    coverPromise,
  ]);
  if (lyricsRes.note) notes.push(lyricsRes.note);
  if (coverRes.note) notes.push(coverRes.note);

  t0 = performance.now();
  const tags = buildTags(song, lyricsRes.lrc, coverRes.data);
  const flattened = flattenToParts(encryptedBuf, tags, parsedMp4);
  timings.remux = Math.round(performance.now() - t0);

  const albumArtist = firstNonEmpty(song.albumArtist, song.artistName);
  const fileName = opts.filenameTemplate
    ? formatDownloadPath(opts.filenameTemplate, {
        albumArtist,
        artist: song.artistName,
        album: song.albumName,
        title: song.name,
        songNumber,
        trackNumber: song.trackNumber,
        discNumber: Math.max(1, song.discNumber),
        codec: activeCodec,
      })
    : defaultTrackFileName(songNumber, song.name);

  timings.total = Math.round(performance.now() - totalStart);
  emit("done", "Done", flattened.totalSize, flattened.totalSize);

  return {
    fileName,
    parts: flattened.parts,
    totalSize: flattened.totalSize,
    song: {
      id: song.id,
      name: song.name,
      artist: song.artistName,
      album: song.albumName,
      albumArtist,
      trackNumber: song.trackNumber,
      discNumber: Math.max(1, song.discNumber),
      songNumber,
      hasLyrics: song.hasLyrics,
      hiRes: song.hiResLossless,
    },
    stream: streamInfo,
    timingsMs: timings,
    sizes: {
      encrypted: encryptedBuf.byteLength,
      tagged: flattened.totalSize,
      cover: coverRes.data?.byteLength ?? 0,
      lyrics: new TextEncoder().encode(lyricsRes.lrc).byteLength,
    },
    decryptMBps,
    notes,
  };
}
