import {
  AppleApi,
  type LibraryLockupRecord,
} from "../core/apple-api.ts";
import {
  type PlaylistContext,
  buildJobDedupKey,
} from "../core/naming.ts";
import { runPipeline } from "../core/pipeline.ts";
import { createConsoleLogger } from "../core/types.ts";
import { createWidevineAacLcHandler } from "../core/widevine/cenc.ts";
import { WrapperClient } from "../core/wrapper-client.ts";
import type {
  AlbumTrackSummary,
  CollectionKind,
  EnqueueCollectionResponse,
  JobSnapshot,
  OffscreenForwardEnvelope,
  PageTokens,
  ResolvedAlbumSummary,
  RuntimeRequest,
  TestWrapperResponse,
} from "../shared/messages.ts";
import {
  DEFAULT_SETTINGS,
  type ExtensionSettings,
  sanitizeSettings,
} from "../shared/settings.ts";
import { FairPlayWorkerPool } from "./fairplay-pool.ts";

const logger = createConsoleLogger("[amdl-offscreen]");

// Runtime state kept strictly in offscreen memory (tokens are NEVER persisted).
let currentSettings: ExtensionSettings = { ...DEFAULT_SETTINGS };
const memoryTokens: PageTokens = {};
let wrapperClient: WrapperClient | null = null;
let wrapperClientKey = "";

const collectionCache = new Map<
  string,
  { summary: ResolvedAlbumSummary; expiresAt: number }
>();
const libraryLockupCache = new Map<
  string,
  { items: LibraryLockupRecord[]; expiresAt: number }
>();

const fairPlayPool = new FairPlayWorkerPool({
  workerUrl: chrome.runtime.getURL("offscreen/fairplay-worker.js"),
  wasmUrl: chrome.runtime.getURL("temari.wasm"),
});

const aacLcHandler = createWidevineAacLcHandler();

function mergeTokens(incoming?: PageTokens): void {
  if (!incoming) return;
  if (incoming.developerToken?.trim()) {
    memoryTokens.developerToken = incoming.developerToken.trim();
    appleApi.setDeveloperToken(memoryTokens.developerToken);
  }
  if (incoming.musicUserToken?.trim()) {
    memoryTokens.musicUserToken = incoming.musicUserToken.trim();
  }
  if (incoming.storefrontId?.trim()) {
    memoryTokens.storefrontId = incoming.storefrontId.trim().toLowerCase();
  }
  if (incoming.language?.trim()) {
    memoryTokens.language = incoming.language.trim();
  }
}

async function requestFreshTokensFromSw(): Promise<PageTokens | null> {
  try {
    const resp = (await chrome.runtime.sendMessage({
      type: "offscreen-refresh-tokens",
    })) as PageTokens | null;
    if (resp) mergeTokens(resp);
    return resp;
  } catch {
    return null;
  }
}

const appleApi = new AppleApi({
  logger,
  getDeveloperToken: async (forceRefresh) => {
    if (!forceRefresh && memoryTokens.developerToken) {
      return memoryTokens.developerToken;
    }
    const refreshed = await requestFreshTokensFromSw();
    return refreshed?.developerToken?.trim() || null;
  },
});

function getWrapperClient(settings: ExtensionSettings): WrapperClient | undefined {
  const addr = settings.wrapperUrl.trim();
  if (!addr) {
    wrapperClient = null;
    wrapperClientKey = "";
    return undefined;
  }
  const key = `${addr}\0${settings.wrapperToken}`;
  if (wrapperClient && wrapperClientKey === key) {
    return wrapperClient;
  }
  wrapperClient = new WrapperClient({
    address: addr,
    token: settings.wrapperToken || undefined,
  });
  wrapperClientKey = key;
  return wrapperClient;
}

interface InternalJob {
  snapshot: JobSnapshot;
  controller: AbortController;
  initialNotes: string[];
}

const jobs = new Map<string, InternalJob>();
const pendingQueue: string[] = [];
let activeCount = 0;
let nextJobSeq = 1;

const activeBlobUrls = new Map<string, ReturnType<typeof setTimeout>>();

function revokeBlobUrl(url: string): void {
  const timer = activeBlobUrls.get(url);
  if (timer !== undefined) {
    clearTimeout(timer);
    activeBlobUrls.delete(url);
  }
  try {
    URL.revokeObjectURL(url);
  } catch {
    // ignore
  }
}

function broadcastJob(snapshot: JobSnapshot): void {
  void chrome.runtime
    .sendMessage({
      type: "offscreen-job-update",
      job: snapshot,
    })
    .catch(() => {});
}

function updateJob(
  job: InternalJob,
  patch: Partial<JobSnapshot>,
): JobSnapshot {
  job.snapshot = {
    ...job.snapshot,
    ...patch,
    updatedAt: Date.now(),
  };
  broadcastJob(job.snapshot);
  return job.snapshot;
}

function effectiveCodec(): string {
  const wrapper = getWrapperClient(currentSettings);
  return wrapper ? currentSettings.codec : "aac-lc";
}

function findDuplicateJob(dedupKey: string): InternalJob | undefined {
  for (const j of jobs.values()) {
    if (
      j.snapshot.dedupKey === dedupKey &&
      j.snapshot.stage !== "error" &&
      j.snapshot.stage !== "cancelled"
    ) {
      return j;
    }
  }
  return undefined;
}

async function resolveAccountStorefront(): Promise<string> {
  const mut = memoryTokens.musicUserToken?.trim();
  if (mut) {
    try {
      const sf = await appleApi.accountStorefront(mut);
      if (sf) return sf.toLowerCase();
    } catch (err) {
      logger.warn("accountStorefront lookup failed; falling back", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return memoryTokens.storefrontId?.trim().toLowerCase() || "cn";
}

function enqueueSongJob(args: {
  storefront: string;
  songId: string;
  titleHint?: string;
  artistHint?: string;
  playlistContext?: PlaylistContext;
  initialNotes?: string[];
}): JobSnapshot {
  const dedupKey = buildJobDedupKey({
    songId: args.songId,
    filenameTemplate: currentSettings.filenameTemplate,
    playlistFilenameTemplate: currentSettings.playlistFilenameTemplate,
    playlistContext: args.playlistContext,
    codec: effectiveCodec(),
  });
  const existing = findDuplicateJob(dedupKey);
  if (existing) {
    return existing.snapshot;
  }
  const now = Date.now();
  const jobId = `job-${now}-${nextJobSeq++}`;
  const initialNotes = args.initialNotes ? [...args.initialNotes] : [];
  const snapshot: JobSnapshot = {
    jobId,
    songId: args.songId,
    dedupKey,
    storefront: args.storefront || memoryTokens.storefrontId || "cn",
    title: args.titleHint || `Track ${args.songId}`,
    artist: args.artistHint,
    ...(args.playlistContext ? { playlistContext: args.playlistContext } : {}),
    stage: "queued",
    message: "Queued",
    done: 0,
    total: 0,
    notes: [...initialNotes],
    createdAt: now,
    updatedAt: now,
  };
  const job: InternalJob = {
    snapshot,
    controller: new AbortController(),
    initialNotes,
  };
  jobs.set(jobId, job);
  pendingQueue.push(jobId);
  broadcastJob(snapshot);
  pumpQueue();
  return snapshot;
}

function pumpQueue(): void {
  const maxConcurrent = Math.max(1, Math.min(4, currentSettings.concurrency));
  while (activeCount < maxConcurrent && pendingQueue.length > 0) {
    const jobId = pendingQueue.shift()!;
    const job = jobs.get(jobId);
    if (!job || job.snapshot.stage === "cancelled") continue;
    activeCount++;
    void runJob(job).finally(() => {
      activeCount--;
      pumpQueue();
    });
  }
}

async function runJob(job: InternalJob): Promise<void> {
  const settings = currentSettings;
  const wrapper = getWrapperClient(settings);
  const language = settings.language || memoryTokens.language || "zh-Hans_CN";

  try {
    const result = await runPipeline({
      url: job.snapshot.songId,
      storefront: job.snapshot.storefront,
      language,
      codec: wrapper ? settings.codec : "aac-lc",
      maxSampleRate: settings.maxSampleRate,
      maxBitDepth: settings.maxBitDepth,
      fallbackOnCodecNotFound: settings.fallbackOnCodecNotFound,
      mediaUserToken: memoryTokens.musicUserToken,
      embedLyrics: settings.embedLyrics,
      lyricsTiming: settings.lyricsTiming,
      lyricsExtras: settings.lyricsExtras,
      embedCover: settings.embedCover,
      coverSize: settings.coverSize,
      coverFormat: settings.coverFormat,
      filenameTemplate: settings.filenameTemplate,
      playlistFilenameTemplate: settings.playlistFilenameTemplate,
      playlistContext: job.snapshot.playlistContext,
      appleApi,
      wrapper,
      fairPlayDecryptor: fairPlayPool,
      aacLcDecryptor: aacLcHandler,
      logger,
      signal: job.controller.signal,
      onProgress(ev) {
        if (job.controller.signal.aborted) return;
        updateJob(job, {
          stage: ev.stage === "done" ? "saving" : ev.stage,
          message: ev.stage === "done" ? "Saving file" : ev.message,
          done: ev.done,
          total: ev.total,
        });
      },
    });

    if (job.controller.signal.aborted) {
      updateJob(job, { stage: "cancelled", message: "Cancelled" });
      return;
    }

    const mergedNotes = [...job.initialNotes, ...result.notes];
    updateJob(job, {
      title: result.song.name,
      artist: result.song.artist,
      album: result.song.album,
      codec: result.stream.codec,
      fileName: result.fileName,
      notes: mergedNotes,
      stage: "saving",
      message: "Saving file",
      done: result.totalSize,
      total: result.totalSize,
    });

    const blob = new Blob(result.parts as BlobPart[], { type: "audio/mp4" });
    const blobUrl = URL.createObjectURL(blob);
    // Fallback safety cleanup after 10 minutes if download event is never seen.
    const safetyTimer = setTimeout(() => revokeBlobUrl(blobUrl), 10 * 60 * 1000);
    activeBlobUrls.set(blobUrl, safetyTimer);

    const saveResp = (await chrome.runtime.sendMessage({
      type: "offscreen-save-blob",
      jobId: job.snapshot.jobId,
      blobUrl,
      filename: result.fileName,
      saveAs: settings.saveAs,
    })) as { ok?: boolean; error?: string };

    if (!saveResp?.ok) {
      revokeBlobUrl(blobUrl);
      throw new Error(saveResp?.error || "chrome.downloads failed");
    }

    updateJob(job, {
      stage: "done",
      message: `Saved (${result.stream.codec.toUpperCase()})`,
    });
  } catch (err) {
    if (job.controller.signal.aborted) {
      updateJob(job, { stage: "cancelled", message: "Cancelled" });
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("job failed", { songId: job.snapshot.songId, error: msg });
    updateJob(job, {
      stage: "error",
      message: "Failed",
      error: msg,
    });
  }
}

async function resolveCollectionSummary(
  kind: CollectionKind,
  storefront: string,
  id: string,
): Promise<ResolvedAlbumSummary> {
  const isLibrary = kind === "library-album" || kind === "library-playlist";
  const sf = isLibrary
    ? await resolveAccountStorefront()
    : storefront.toLowerCase();
  const key = `${kind}:${sf}:${id}`;
  const cached = collectionCache.get(key);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.summary;
  }
  const language =
    currentSettings.language || memoryTokens.language || "zh-Hans_CN";

  let summary: ResolvedAlbumSummary;

  if (kind === "album") {
    const album = await appleApi.album(sf, id, language);
    summary = {
      id: album.id,
      kind: "album",
      storefront: sf,
      name: album.name,
      artist: album.artist,
      tracks: album.tracks.map((t, idx) => ({
        id: t.id,
        name: t.name,
        artistName: t.artistName,
        trackNumber: t.trackNumber,
        discNumber: t.discNumber,
        playlistIndex: idx + 1,
      })),
      skippedUnavailableCount: 0,
      skippedNonSongCount: 0,
    };
  } else if (kind === "library-album") {
    const mut = memoryTokens.musicUserToken?.trim() || "";
    const libAlbum = await appleApi.libraryAlbum(mut, id, language);
    let tracks: AlbumTrackSummary[] = libAlbum.tracks.map((t) => ({
      id: t.catalogId ?? "",
      libraryId: t.libraryId,
      name: t.name,
      artistName: t.artistName,
      trackNumber: t.trackNumber,
      discNumber: t.discNumber,
      playlistIndex: t.playlistIndex,
      unavailableInCatalog: t.unavailableInCatalog,
      nonSong: t.kind !== "song",
    }));
    let skippedUnavailableCount = tracks.filter(
      (t) => t.unavailableInCatalog,
    ).length;
    let skippedNonSongCount = tracks.filter((t) => t.nonSong).length;

    if (libAlbum.catalogAlbumId) {
      try {
        const catAlbum = await appleApi.album(
          sf,
          libAlbum.catalogAlbumId,
          language,
        );
        if (catAlbum.tracks.length > 0) {
          tracks = catAlbum.tracks.map((t, idx) => ({
            id: t.id,
            name: t.name,
            artistName: t.artistName,
            trackNumber: t.trackNumber,
            discNumber: t.discNumber,
            playlistIndex: idx + 1,
          }));
          skippedUnavailableCount = 0;
          skippedNonSongCount = 0;
        }
      } catch (err) {
        logger.warn(
          "catalog album lookup for library album failed; falling back to library track catalogIds",
          {
            libraryAlbumId: id,
            catalogAlbumId: libAlbum.catalogAlbumId,
            error: err instanceof Error ? err.message : String(err),
          },
        );
      }
    }

    summary = {
      id: libAlbum.id,
      kind: "library-album",
      storefront: sf,
      name: libAlbum.name,
      artist: libAlbum.artist,
      catalogAlbumId: libAlbum.catalogAlbumId,
      tracks,
      skippedUnavailableCount,
      skippedNonSongCount,
    };
  } else if (kind === "playlist") {
    const pl = await appleApi.playlist(sf, id, language);
    const tracks = pl.tracks.map((t) => ({
      id: t.catalogId ?? "",
      name: t.name,
      artistName: t.artistName,
      trackNumber: t.trackNumber,
      discNumber: t.discNumber,
      playlistIndex: t.playlistIndex,
      unavailableInCatalog: false,
      nonSong: t.kind !== "song",
    }));
    summary = {
      id: pl.id,
      kind: "playlist",
      storefront: sf,
      name: pl.name,
      artist: pl.artist,
      tracks,
      skippedUnavailableCount: 0,
      skippedNonSongCount: tracks.filter((t) => t.nonSong).length,
    };
  } else {
    const mut = memoryTokens.musicUserToken?.trim() || "";
    const pl = await appleApi.libraryPlaylist(mut, id, language);
    const tracks = pl.tracks.map((t) => ({
      id: t.catalogId ?? "",
      libraryId: t.libraryId,
      name: t.name,
      artistName: t.artistName,
      trackNumber: t.trackNumber,
      discNumber: t.discNumber,
      playlistIndex: t.playlistIndex,
      unavailableInCatalog: t.unavailableInCatalog,
      nonSong: t.kind !== "song",
    }));
    summary = {
      id: pl.id,
      kind: "library-playlist",
      storefront: sf,
      name: pl.name,
      artist: pl.artist,
      tracks,
      skippedUnavailableCount: tracks.filter((t) => t.unavailableInCatalog)
        .length,
      skippedNonSongCount: tracks.filter((t) => t.nonSong).length,
    };
  }

  collectionCache.set(key, { summary, expiresAt: Date.now() + 10 * 60 * 1000 });
  return summary;
}

function normalizeArtworkStem(url: string): string {
  if (!url) return "";
  const m = url.match(/\/image\/thumb\/([^?]+?)(?:\/\d+x\d+[^/?]*|\/\{w\}x\{h\}[^/?]*)?$/i);
  if (m?.[1]) return m[1].toLowerCase();
  const m2 = url.match(/\/([^/]+\.(?:jpg|jpeg|png|webp))(?=\/|$|\?)/i);
  return m2?.[1]?.toLowerCase() ?? "";
}

async function resolveLibraryLockup(args: {
  source: "albums" | "recently-added";
  title: string;
  subtitle?: string;
  artworkStem?: string;
}): Promise<{ kind: "library-album" | "library-playlist"; id: string; name: string } | null> {
  const mut = memoryTokens.musicUserToken?.trim() || "";
  if (!mut) return null;
  const language =
    currentSettings.language || memoryTokens.language || "zh-Hans_CN";
  const cacheKey = `${args.source}:${language}`;
  let entry = libraryLockupCache.get(cacheKey);
  if (!entry || Date.now() >= entry.expiresAt) {
    const items = await appleApi.libraryLockupItems(mut, args.source, language);
    entry = { items, expiresAt: Date.now() + 2 * 60 * 1000 };
    libraryLockupCache.set(cacheKey, entry);
  }

  const wantedStem = (args.artworkStem || "").toLowerCase();
  const wantedTitle = args.title.trim().toLowerCase();
  const wantedSub = (args.subtitle || "").trim().toLowerCase();

  if (wantedStem) {
    const byArt = entry.items.find(
      (it) => normalizeArtworkStem(it.artworkUrl) === wantedStem,
    );
    if (byArt) return { kind: byArt.kind, id: byArt.id, name: byArt.name };
  }
  if (wantedTitle && wantedSub) {
    const exact = entry.items.find(
      (it) =>
        it.name.trim().toLowerCase() === wantedTitle &&
        it.artistName.trim().toLowerCase() === wantedSub,
    );
    if (exact) return { kind: exact.kind, id: exact.id, name: exact.name };
  }
  if (wantedTitle) {
    const byTitle = entry.items.find(
      (it) => it.name.trim().toLowerCase() === wantedTitle,
    );
    if (byTitle) return { kind: byTitle.kind, id: byTitle.id, name: byTitle.name };
  }
  return null;
}

function enqueueSummaryTracks(
  summary: ResolvedAlbumSummary,
  isPlaylist: boolean,
): EnqueueCollectionResponse {
  const sf = summary.storefront || "cn";
  const downloadable = summary.tracks.filter((t) => Boolean(t.id) && !t.nonSong);
  const skippedCount = summary.skippedUnavailableCount ?? 0;
  const skippedNonSongCount = summary.skippedNonSongCount ?? 0;
  const skippedNote =
    skippedCount > 0
      ? `Skipped ${skippedCount} track${skippedCount === 1 ? "" : "s"} not available in the Apple Music catalog`
      : "";

  if (downloadable.length === 0) {
    const message =
      skippedCount > 0
        ? `No downloadable tracks (${skippedCount} not available in the Apple Music catalog)`
        : "No downloadable tracks found";
    return {
      ok: true,
      jobs: [],
      collection: summary,
      skippedCount,
      skippedNonSongCount,
      totalCount: summary.tracks.length,
      message,
    };
  }

  const queued = downloadable.map((t, i) =>
    enqueueSongJob({
      storefront: sf,
      songId: t.id,
      titleHint: t.name,
      artistHint: t.artistName,
      ...(isPlaylist
        ? {
            playlistContext: {
              playlistId: summary.id,
              playlistName: summary.name || "Playlist",
              playlistIndex: t.playlistIndex ?? i + 1,
            },
          }
        : {}),
      ...(i === 0 && skippedNote ? { initialNotes: [skippedNote] } : {}),
    }),
  );

  return {
    ok: true,
    jobs: queued,
    collection: summary,
    skippedCount,
    skippedNonSongCount,
    totalCount: summary.tracks.length,
    ...(skippedNote ? { message: skippedNote } : {}),
  };
}

async function handlePayload(
  payload: RuntimeRequest,
): Promise<unknown> {
  switch (payload.type) {
    case "settings-updated": {
      currentSettings = sanitizeSettings(payload.settings);
      getWrapperClient(currentSettings);
      pumpQueue();
      return { ok: true };
    }
    case "enqueue-song": {
      mergeTokens(payload.tokens);
      const storefront =
        payload.useAccountStorefront || !payload.storefront
          ? await resolveAccountStorefront()
          : payload.storefront.toLowerCase();
      let playlistContext = payload.playlistContext;
      // Canonicalize playlist name via the cached collection summary so row clicks
      // and header clicks always share the same destination folder & dedupKey
      // even when the DOM renders a different locale title than the Apple API.
      if (playlistContext?.playlistId) {
        const plKind: CollectionKind = payload.useAccountStorefront
          ? "library-playlist"
          : "playlist";
        try {
          const summary = await resolveCollectionSummary(
            plKind,
            storefront,
            playlistContext.playlistId,
          );
          if (summary.name) {
            playlistContext = {
              ...playlistContext,
              playlistName: summary.name,
            };
          }
        } catch {
          // Keep DOM-provided playlistName fallback on lookup error.
        }
      }
      const snapshot = enqueueSongJob({
        storefront,
        songId: payload.songId,
        titleHint: payload.titleHint,
        artistHint: payload.artistHint,
        playlistContext,
      });
      return { ok: true, job: snapshot };
    }
    case "resolve-album": {
      mergeTokens(payload.tokens);
      const summary = await resolveCollectionSummary(
        "album",
        payload.storefront,
        payload.albumId,
      );
      return { ok: true, album: summary };
    }
    case "resolve-collection": {
      mergeTokens(payload.tokens);
      const summary = await resolveCollectionSummary(
        payload.kind,
        payload.storefront,
        payload.id,
      );
      return { ok: true, collection: summary };
    }
    case "resolve-library-lockup": {
      mergeTokens(payload.tokens);
      const match = await resolveLibraryLockup({
        source: payload.source,
        title: payload.title,
        subtitle: payload.subtitle,
        artworkStem: payload.artworkStem,
      });
      return { ok: true, match };
    }
    case "enqueue-album": {
      mergeTokens(payload.tokens);
      const summary = await resolveCollectionSummary(
        "album",
        payload.storefront,
        payload.albumId,
      );
      return enqueueSummaryTracks(summary, false);
    }
    case "enqueue-library-album": {
      mergeTokens(payload.tokens);
      const summary = await resolveCollectionSummary(
        "library-album",
        "",
        payload.libraryAlbumId,
      );
      return enqueueSummaryTracks(summary, false);
    }
    case "enqueue-playlist": {
      mergeTokens(payload.tokens);
      const summary = await resolveCollectionSummary(
        "playlist",
        payload.storefront,
        payload.playlistId,
      );
      return enqueueSummaryTracks(summary, true);
    }
    case "enqueue-library-playlist": {
      mergeTokens(payload.tokens);
      const summary = await resolveCollectionSummary(
        "library-playlist",
        "",
        payload.libraryPlaylistId,
      );
      return enqueueSummaryTracks(summary, true);
    }
    case "get-jobs": {
      const list = Array.from(jobs.values())
        .map((j) => j.snapshot)
        .sort((a, b) => b.createdAt - a.createdAt);
      return { ok: true, jobs: list };
    }
    case "cancel-job": {
      const job = jobs.get(payload.jobId);
      if (!job) return { ok: false, error: "job not found" };
      const qIdx = pendingQueue.indexOf(payload.jobId);
      if (qIdx >= 0) pendingQueue.splice(qIdx, 1);
      job.controller.abort();
      updateJob(job, { stage: "cancelled", message: "Cancelled" });
      return { ok: true };
    }
    case "retry-job": {
      const job = jobs.get(payload.jobId);
      if (!job) return { ok: false, error: "job not found" };
      if (
        job.snapshot.stage !== "error" &&
        job.snapshot.stage !== "cancelled"
      ) {
        return { ok: true, job: job.snapshot };
      }
      job.controller = new AbortController();
      updateJob(job, {
        stage: "queued",
        message: "Queued",
        done: 0,
        total: 0,
        error: undefined,
        notes: [...job.initialNotes],
      });
      pendingQueue.push(payload.jobId);
      pumpQueue();
      return { ok: true, job: job.snapshot };
    }
    case "clear-finished": {
      for (const [id, j] of jobs.entries()) {
        if (
          j.snapshot.stage === "done" ||
          j.snapshot.stage === "error" ||
          j.snapshot.stage === "cancelled"
        ) {
          jobs.delete(id);
        }
      }
      return { ok: true };
    }
    case "test-wrapper": {
      try {
        const client = new WrapperClient({
          address: payload.address,
          token: payload.token || undefined,
          timeoutMs: 10_000,
        });
        const status = await client.status();
        return { ok: true, status } satisfies TestWrapperResponse;
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        } satisfies TestWrapperResponse;
      }
    }
    case "offscreen-revoke-blob": {
      revokeBlobUrl(payload.blobUrl);
      return { ok: true };
    }
    default:
      return { ok: false, error: `unhandled message ${(payload as { type?: string }).type}` };
  }
}

chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
  const env = msg as Partial<OffscreenForwardEnvelope> | null;
  if (!env || env.target !== "offscreen" || !env.payload) {
    return false;
  }
  if (env.settings) {
    currentSettings = sanitizeSettings(env.settings);
  }
  if (env.tokens) {
    mergeTokens(env.tokens);
  }
  void handlePayload(env.payload)
    .then(sendResponse)
    .catch((err) => {
      sendResponse({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  return true;
});
