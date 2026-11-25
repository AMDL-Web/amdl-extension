import { AppleApi } from "../core/apple-api.ts";
import { runPipeline } from "../core/pipeline.ts";
import { createConsoleLogger } from "../core/types.ts";
import { createWidevineAacLcHandler } from "../core/widevine/cenc.ts";
import { WrapperClient } from "../core/wrapper-client.ts";
import type {
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

const albumCache = new Map<
  string,
  { summary: ResolvedAlbumSummary; expiresAt: number }
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

function findActiveJobForSong(songId: string): InternalJob | undefined {
  for (const j of jobs.values()) {
    if (
      j.snapshot.songId === songId &&
      j.snapshot.stage !== "done" &&
      j.snapshot.stage !== "error" &&
      j.snapshot.stage !== "cancelled"
    ) {
      return j;
    }
  }
  return undefined;
}

function enqueueSongJob(args: {
  storefront: string;
  songId: string;
  titleHint?: string;
  artistHint?: string;
}): JobSnapshot {
  const existing = findActiveJobForSong(args.songId);
  if (existing) {
    return existing.snapshot;
  }
  const now = Date.now();
  const jobId = `job-${now}-${nextJobSeq++}`;
  const snapshot: JobSnapshot = {
    jobId,
    songId: args.songId,
    storefront: args.storefront || memoryTokens.storefrontId || "cn",
    title: args.titleHint || `Track ${args.songId}`,
    artist: args.artistHint,
    stage: "queued",
    message: "Queued",
    done: 0,
    total: 0,
    notes: [],
    createdAt: now,
    updatedAt: now,
  };
  const job: InternalJob = { snapshot, controller: new AbortController() };
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

    updateJob(job, {
      title: result.song.name,
      artist: result.song.artist,
      album: result.song.album,
      codec: result.stream.codec,
      fileName: result.fileName,
      notes: result.notes,
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

async function resolveAlbumSummary(
  storefront: string,
  albumId: string,
): Promise<ResolvedAlbumSummary> {
  const sf = storefront.toLowerCase();
  const key = `${sf}:${albumId}`;
  const cached = albumCache.get(key);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.summary;
  }
  const language =
    currentSettings.language || memoryTokens.language || "zh-Hans_CN";
  const album = await appleApi.album(sf, albumId, language);
  const summary: ResolvedAlbumSummary = {
    id: album.id,
    name: album.name,
    artist: album.artist,
    tracks: album.tracks.map((t) => ({
      id: t.id,
      name: t.name,
      artistName: t.artistName,
      trackNumber: t.trackNumber,
      discNumber: t.discNumber,
    })),
  };
  albumCache.set(key, { summary, expiresAt: Date.now() + 10 * 60 * 1000 });
  return summary;
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
      const snapshot = enqueueSongJob({
        storefront: payload.storefront,
        songId: payload.songId,
        titleHint: payload.titleHint,
        artistHint: payload.artistHint,
      });
      return { ok: true, job: snapshot };
    }
    case "resolve-album": {
      mergeTokens(payload.tokens);
      const summary = await resolveAlbumSummary(
        payload.storefront,
        payload.albumId,
      );
      return { ok: true, album: summary };
    }
    case "enqueue-album": {
      mergeTokens(payload.tokens);
      const summary = await resolveAlbumSummary(
        payload.storefront,
        payload.albumId,
      );
      const queued = summary.tracks.map((t) =>
        enqueueSongJob({
          storefront: payload.storefront,
          songId: t.id,
          titleHint: t.name,
          artistHint: t.artistName,
        }),
      );
      return { ok: true, jobs: queued };
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
        notes: [],
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
