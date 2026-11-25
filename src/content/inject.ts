import { parseAppleMusicUrl } from "../core/url.ts";
import type {
  JobSnapshot,
  PageTokens,
  ResolvedAlbumSummary,
} from "../shared/messages.ts";

const HEADER_BTN_ATTR = "data-amdl-header";
const ROW_BTN_ATTR = "data-amdl-row";

const jobsBySongId = new Map<string, JobSnapshot>();
const albumTrackCache = new Map<string, ResolvedAlbumSummary>();
const albumTrackInFlight = new Map<
  string,
  Promise<ResolvedAlbumSummary | null>
>();

interface RouteInfo {
  type: "album" | "song";
  storefront: string;
  id: string;
  trackId?: string;
}

function currentRoute(): RouteInfo | null {
  try {
    const parsed = parseAppleMusicUrl(location.href, "album");
    if (parsed.type === "album" || parsed.type === "song") {
      return {
        type: parsed.type,
        storefront: parsed.storefront,
        id: parsed.id,
        trackId: parsed.trackId,
      };
    }
  } catch {
    // Non-album/song page (home, browse, search, etc.)
  }
  return null;
}

function requestPageTokens(timeoutMs = 1500): Promise<PageTokens> {
  return new Promise((resolve) => {
    const nonce =
      typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      channel.port1.close();
      resolve({});
    }, timeoutMs);
    channel.port1.onmessage = (ev: MessageEvent) => {
      const data = ev.data as {
        type?: string;
        nonce?: string;
        tokens?: PageTokens;
      } | null;
      if (data?.type === "amdl:token-res" && data.nonce === nonce) {
        clearTimeout(timer);
        channel.port1.close();
        resolve(data.tokens ?? {});
      }
    };
    window.postMessage({ type: "amdl:token-req", nonce }, location.origin, [
      channel.port2,
    ]);
  });
}

async function sendRuntime<T = unknown>(msg: Record<string, unknown>): Promise<T | null> {
  try {
    return (await chrome.runtime.sendMessage(msg)) as T;
  } catch {
    return null;
  }
}

async function resolveAlbumTracks(
  storefront: string,
  albumId: string,
): Promise<ResolvedAlbumSummary | null> {
  const key = `${storefront}:${albumId}`;
  const cached = albumTrackCache.get(key);
  if (cached) return cached;
  const inflight = albumTrackInFlight.get(key);
  if (inflight) return inflight;

  const p = (async () => {
    const tokens = await requestPageTokens();
    const resp = await sendRuntime<{
      ok?: boolean;
      album?: ResolvedAlbumSummary;
    }>({
      type: "resolve-album",
      storefront,
      albumId,
      tokens,
    });
    if (resp?.ok && resp.album) {
      albumTrackCache.set(key, resp.album);
      return resp.album;
    }
    return null;
  })().finally(() => {
    albumTrackInFlight.delete(key);
  });

  albumTrackInFlight.set(key, p);
  return p;
}

function extractSongIdFromRow(
  rowEl: Element,
  albumSummary?: ResolvedAlbumSummary | null,
): { songId: string; titleHint: string } | null {
  const titleHint = rowEl.getAttribute("aria-label")?.trim() || "";

  // 1. Direct `/song/.../<id>` anchor inside row (verified on live music.apple.com).
  const songLink = rowEl.querySelector<HTMLAnchorElement>('a[href*="/song/"]');
  if (songLink?.href) {
    try {
      const parsed = parseAppleMusicUrl(songLink.href, "song");
      if (parsed.type === "song" && /^\d+$/.test(parsed.id)) {
        return { songId: parsed.id, titleHint };
      }
    } catch {
      // fall through
    }
  }

  // 2. Fallback: `a[href*="i="]` query param.
  const iLink = rowEl.querySelector<HTMLAnchorElement>('a[href*="i="]');
  if (iLink?.href) {
    try {
      const u = new URL(iLink.href, location.origin);
      const id = u.searchParams.get("i");
      if (id && /^\d+$/.test(id)) {
        return { songId: id, titleHint };
      }
    } catch {
      // fall through
    }
  }

  // 3. Fallback: `data-row` 0-based index against resolved album tracks.
  const rowIdxAttr = rowEl.getAttribute("data-row");
  if (rowIdxAttr !== null && albumSummary) {
    const idx = Number.parseInt(rowIdxAttr, 10);
    const track = Number.isFinite(idx) ? albumSummary.tracks[idx] : undefined;
    if (track?.id) {
      return { songId: track.id, titleHint: titleHint || track.name };
    }
  }

  return null;
}

const HEADER_CSS = `
  :host {
    display: inline-flex;
    align-items: center;
    margin-inline-start: 8px;
    vertical-align: middle;
  }
  button {
    all: unset;
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 36px;
    padding: 0 16px;
    border-radius: 999px;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
    font-size: 13px;
    font-weight: 600;
    line-height: 1;
    cursor: pointer;
    color: #fff;
    background: #fa233b;
    transition: opacity 0.15s ease, transform 0.1s ease, background-color 0.15s ease;
    user-select: none;
    white-space: nowrap;
  }
  button:hover { opacity: 0.9; }
  button:active { transform: scale(0.98); }
  button[data-state="done"] { background: #28a745; }
  button[data-state="error"] { background: #d93025; }
  button[data-state="working"] { background: #fa233b; opacity: 0.92; }
  svg { width: 15px; height: 15px; flex: none; }
  .spin { animation: amdl-spin 1s linear infinite; }
  @keyframes amdl-spin { to { transform: rotate(360deg); } }
`;

const ROW_CSS = `
  :host {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    margin-inline: 4px;
    vertical-align: middle;
    flex: none;
  }
  button {
    all: unset;
    box-sizing: border-box;
    position: relative;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    color: rgba(0, 0, 0, 0.65);
    background: transparent;
    transition: background-color 0.15s ease, color 0.15s ease;
  }
  @media (prefers-color-scheme: dark) {
    button { color: rgba(255, 255, 255, 0.72); }
  }
  button:hover {
    background: rgba(250, 35, 59, 0.14);
    color: #fa233b;
  }
  button[data-state="working"] { color: #fa233b; }
  button[data-state="done"] { color: #28a745; }
  button[data-state="error"] { color: #d93025; }
  svg { width: 16px; height: 16px; display: block; }
  .ring-bg { stroke: currentColor; opacity: 0.22; }
  .ring-fg {
    stroke: #fa233b;
    transform: rotate(-90deg);
    transform-origin: center;
    transition: stroke-dashoffset 0.15s linear;
  }
  .spin { animation: amdl-spin 1s linear infinite; }
  @keyframes amdl-spin { to { transform: rotate(360deg); } }
`;

const ICON_DOWNLOAD = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/></svg>`;
const ICON_CHECK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`;
const ICON_ERROR = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v5"/><path d="M12 16h.01"/></svg>`;
const ICON_SPINNER = `<svg class="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>`;

function renderProgressRing(ratio: number): string {
  const r = 9;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0.05, Math.min(1, ratio));
  const offset = c * (1 - clamped);
  return `<svg viewBox="0 0 24 24" fill="none"><circle class="ring-bg" cx="12" cy="12" r="${r}" stroke-width="2.4"/><circle class="ring-fg" cx="12" cy="12" r="${r}" stroke-width="2.4" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}" stroke-linecap="round"/></svg>`;
}

interface ButtonRef {
  host: HTMLElement;
  btn: HTMLButtonElement;
  kind: "header-album" | "header-song" | "row";
  songId?: string;
  albumId?: string;
  storefront: string;
}

const mountedButtons = new Set<ButtonRef>();

function updateRowButtonVisual(ref: ButtonRef): void {
  if (!ref.songId) return;
  const job = jobsBySongId.get(ref.songId);
  if (!job || job.stage === "cancelled") {
    ref.btn.dataset.state = "idle";
    ref.btn.innerHTML = ICON_DOWNLOAD;
    ref.btn.title = "Download track";
    ref.btn.setAttribute("aria-label", "Download track");
    return;
  }
  if (job.stage === "done") {
    ref.btn.dataset.state = "done";
    ref.btn.innerHTML = ICON_CHECK;
    ref.btn.title = job.notes.length
      ? `${job.message} (${job.notes.join("; ")})`
      : job.message;
    ref.btn.setAttribute("aria-label", "Downloaded");
    return;
  }
  if (job.stage === "error") {
    ref.btn.dataset.state = "error";
    ref.btn.innerHTML = ICON_ERROR;
    ref.btn.title = `Error: ${job.error || job.message} (click to retry)`;
    ref.btn.setAttribute("aria-label", "Download failed, click to retry");
    return;
  }
  ref.btn.dataset.state = "working";
  if (job.total > 0 && job.done > 0) {
    const pct = Math.round((job.done / job.total) * 100);
    ref.btn.innerHTML = renderProgressRing(job.done / job.total);
    ref.btn.title = `${job.message} (${pct}%)`;
  } else {
    ref.btn.innerHTML = ICON_SPINNER;
    ref.btn.title = job.message || job.stage;
  }
  ref.btn.setAttribute("aria-label", ref.btn.title);
}

function updateHeaderButtonVisual(ref: ButtonRef): void {
  if (ref.kind === "header-song" && ref.songId) {
    const job = jobsBySongId.get(ref.songId);
    if (!job || job.stage === "cancelled") {
      ref.btn.dataset.state = "idle";
      ref.btn.innerHTML = `${ICON_DOWNLOAD}<span>Download</span>`;
      ref.btn.title = "Download song";
      return;
    }
    if (job.stage === "done") {
      ref.btn.dataset.state = "done";
      ref.btn.innerHTML = `${ICON_CHECK}<span>Downloaded</span>`;
      ref.btn.title = job.message;
      return;
    }
    if (job.stage === "error") {
      ref.btn.dataset.state = "error";
      ref.btn.innerHTML = `${ICON_ERROR}<span>Retry</span>`;
      ref.btn.title = job.error || job.message;
      return;
    }
    ref.btn.dataset.state = "working";
    const pct =
      job.total > 0 ? ` ${Math.round((job.done / job.total) * 100)}%` : "";
    ref.btn.innerHTML = `${ICON_SPINNER}<span>${job.stage}${pct}</span>`;
    ref.btn.title = job.message;
    return;
  }

  if (ref.kind === "header-album" && ref.albumId) {
    const album = albumTrackCache.get(`${ref.storefront}:${ref.albumId}`);
    if (!album || album.tracks.length === 0) {
      ref.btn.dataset.state = "idle";
      ref.btn.innerHTML = `${ICON_DOWNLOAD}<span>Download Album</span>`;
      ref.btn.title = "Download all tracks in this album";
      return;
    }
    let doneCount = 0;
    let activeCount = 0;
    let errCount = 0;
    for (const t of album.tracks) {
      const j = jobsBySongId.get(t.id);
      if (!j) continue;
      if (j.stage === "done") doneCount++;
      else if (j.stage === "error") errCount++;
      else if (j.stage !== "cancelled") activeCount++;
    }
    if (activeCount > 0) {
      ref.btn.dataset.state = "working";
      ref.btn.innerHTML = `${ICON_SPINNER}<span>Downloading ${doneCount}/${album.tracks.length}</span>`;
      ref.btn.title = `${activeCount} active, ${doneCount} done`;
    } else if (doneCount === album.tracks.length) {
      ref.btn.dataset.state = "done";
      ref.btn.innerHTML = `${ICON_CHECK}<span>Album Downloaded</span>`;
      ref.btn.title = `${doneCount} tracks saved`;
    } else if (errCount > 0) {
      ref.btn.dataset.state = "error";
      ref.btn.innerHTML = `${ICON_ERROR}<span>Retry Album (${errCount} failed)</span>`;
      ref.btn.title = `${errCount} tracks failed`;
    } else {
      ref.btn.dataset.state = "idle";
      ref.btn.innerHTML = `${ICON_DOWNLOAD}<span>Download Album</span>`;
      ref.btn.title = `Download all ${album.tracks.length} tracks`;
    }
  }
}

function refreshAllButtonVisuals(): void {
  for (const ref of Array.from(mountedButtons)) {
    if (!ref.host.isConnected) {
      mountedButtons.delete(ref);
      continue;
    }
    if (ref.kind === "row") updateRowButtonVisual(ref);
    else updateHeaderButtonVisual(ref);
  }
}

function createHeaderButton(
  route: RouteInfo,
  container: Element,
): void {
  const existing = container.querySelector<HTMLElement>(`[${HEADER_BTN_ATTR}]`);
  const key = `${route.type}:${route.storefront}:${route.id}`;
  if (existing) {
    if (existing.getAttribute(HEADER_BTN_ATTR) === key) return;
    existing.remove();
  }

  const host = document.createElement("span");
  host.setAttribute(HEADER_BTN_ATTR, key);
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = HEADER_CSS;
  const btn = document.createElement("button");
  btn.type = "button";
  shadow.append(style, btn);

  const ref: ButtonRef = {
    host,
    btn,
    kind: route.type === "album" ? "header-album" : "header-song",
    storefront: route.storefront,
    ...(route.type === "album"
      ? { albumId: route.id }
      : { songId: route.id }),
  };

  btn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    void (async () => {
      const tokens = await requestPageTokens();
      if (route.type === "song") {
        const titleHint =
          document.querySelector('[data-testid="song-title"]')?.textContent?.trim() ||
          undefined;
        const existingJob = jobsBySongId.get(route.id);
        if (existingJob?.stage === "error" || existingJob?.stage === "cancelled") {
          await sendRuntime({ type: "retry-job", jobId: existingJob.jobId });
        } else {
          await sendRuntime({
            type: "enqueue-song",
            storefront: route.storefront,
            songId: route.id,
            titleHint,
            tokens,
          });
        }
      } else {
        btn.dataset.state = "working";
        btn.innerHTML = `${ICON_SPINNER}<span>Queueing…</span>`;
        await sendRuntime({
          type: "enqueue-album",
          storefront: route.storefront,
          albumId: route.id,
          tokens,
        });
        await resolveAlbumTracks(route.storefront, route.id);
        refreshAllButtonVisuals();
      }
    })();
  });

  container.appendChild(host);
  mountedButtons.add(ref);
  updateHeaderButtonVisual(ref);
}

function createRowButton(
  storefront: string,
  songId: string,
  titleHint: string,
  rowEl: Element,
): void {
  const controls = rowEl.querySelector('[data-testid="track-column-controls"]');
  if (!controls) return;
  const existing = controls.querySelector<HTMLElement>(`[${ROW_BTN_ATTR}]`);
  if (existing) {
    if (existing.getAttribute(ROW_BTN_ATTR) === songId) return;
    existing.remove();
  }

  const host = document.createElement("span");
  host.setAttribute(ROW_BTN_ATTR, songId);
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = ROW_CSS;
  const btn = document.createElement("button");
  btn.type = "button";
  shadow.append(style, btn);

  const ref: ButtonRef = {
    host,
    btn,
    kind: "row",
    songId,
    storefront,
  };

  btn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    void (async () => {
      const existingJob = jobsBySongId.get(songId);
      if (existingJob?.stage === "error" || existingJob?.stage === "cancelled") {
        await sendRuntime({ type: "retry-job", jobId: existingJob.jobId });
        return;
      }
      const tokens = await requestPageTokens();
      await sendRuntime({
        type: "enqueue-song",
        storefront,
        songId,
        titleHint: titleHint || undefined,
        tokens,
      });
    })();
  });

  const innerControls = controls.querySelector(".songs-list-row__controls");
  if (innerControls) {
    innerControls.insertBefore(host, innerControls.firstChild);
  } else {
    controls.insertBefore(host, controls.firstChild);
  }
  mountedButtons.add(ref);
  updateRowButtonVisual(ref);
}

let scanScheduled = false;
function scheduleScan(): void {
  if (scanScheduled) return;
  scanScheduled = true;
  requestAnimationFrame(() => {
    scanScheduled = false;
    void scanAndInject();
  });
}

async function scanAndInject(): Promise<void> {
  const route = currentRoute();
  if (!route) return;

  if (route.type === "album") {
    const headerActions = document.querySelector(
      '[data-testid="container-detail-header"] .primary-actions',
    );
    if (headerActions) {
      createHeaderButton(route, headerActions);
    }

    const rows = Array.from(
      document.querySelectorAll('[data-testid="track-list-item"]'),
    );
    if (rows.length === 0) return;

    const cacheKey = `${route.storefront}:${route.id}`;
    let albumSummary = albumTrackCache.get(cacheKey) ?? null;
    let needAlbumResolve = false;

    for (const row of rows) {
      const info = extractSongIdFromRow(row, albumSummary);
      if (info) {
        createRowButton(route.storefront, info.songId, info.titleHint, row);
      } else {
        needAlbumResolve = true;
      }
    }

    if (needAlbumResolve && !albumSummary) {
      albumSummary = await resolveAlbumTracks(route.storefront, route.id);
      if (albumSummary) {
        for (const row of rows) {
          const info = extractSongIdFromRow(row, albumSummary);
          if (info) {
            createRowButton(route.storefront, info.songId, info.titleHint, row);
          }
        }
        refreshAllButtonVisuals();
      }
    }
  } else if (route.type === "song") {
    const songButtons =
      document.querySelector(".song-header-page__buttons") ||
      document.querySelector(
        '[data-testid="container-detail-header"] .primary-actions',
      );
    if (songButtons) {
      createHeaderButton(route, songButtons);
    }
  }
}

// Listen to job updates and token refresh requests from the Service Worker.
chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return false;
  const typed = msg as { type?: string; job?: JobSnapshot };
  if (typed.type === "job-update" && typed.job) {
    jobsBySongId.set(typed.job.songId, typed.job);
    refreshAllButtonVisuals();
    return false;
  }
  if (typed.type === "content-get-tokens") {
    void requestPageTokens().then(sendResponse);
    return true;
  }
  return false;
});

// Hydrate initial job states from offscreen.
void sendRuntime<{ ok?: boolean; jobs?: JobSnapshot[] }>({
  type: "get-jobs",
}).then((resp) => {
  if (resp?.ok && Array.isArray(resp.jobs)) {
    for (const j of resp.jobs) {
      if (!jobsBySongId.has(j.songId)) {
        jobsBySongId.set(j.songId, j);
      }
    }
    refreshAllButtonVisuals();
  }
});

// SPA navigation detection: Navigation API + popstate + URL polling fallback.
let lastHref = location.href;
const onUrlMaybeChanged = () => {
  if (location.href !== lastHref) {
    lastHref = location.href;
    scheduleScan();
  }
};

const nav = (window as unknown as { navigation?: EventTarget }).navigation;
nav?.addEventListener("navigatesuccess", onUrlMaybeChanged);
window.addEventListener("popstate", onUrlMaybeChanged);
setInterval(onUrlMaybeChanged, 600);

// MutationObserver scoped to <main> once available (falls back to document.body).
let observedRoot: Node | null = null;
const observer = new MutationObserver(() => scheduleScan());

function attachObserver(): void {
  const target = document.querySelector("main") || document.body;
  if (!target || target === observedRoot) return;
  observer.disconnect();
  observedRoot = target;
  observer.observe(target, { childList: true, subtree: true });
}

attachObserver();
scheduleScan();
// Re-attach to <main> once SPA renders it if body was observed initially.
const mainWaitTimer = setInterval(() => {
  const main = document.querySelector("main");
  if (main) {
    attachObserver();
    scheduleScan();
    clearInterval(mainWaitTimer);
  }
}, 500);
setTimeout(() => clearInterval(mainWaitTimer), 15_000);
