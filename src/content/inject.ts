import {
  type PlaylistContext,
  buildUiJobKey,
} from "../core/naming.ts";
import type {
  CollectionKind,
  EnqueueCollectionResponse,
  JobSnapshot,
  PageTokens,
  ResolvedAlbumSummary,
} from "../shared/messages.ts";
import {
  type DownloadSubject,
  type PageRoute,
  extractArtworkStem,
  extractSongFromRowElement,
  findMenuInsertionPoint,
  isTrustedUserEvent,
  parsePageRoute,
  subjectFromHref,
} from "./dom-helpers.ts";
import { getUiStrings } from "./i18n.ts";

const HEADER_BTN_ATTR = "data-amdl-header";
const ROW_BTN_ATTR = "data-amdl-row";
const ROW_CELL_ATTR = "data-amdl-row-cell";
const HEADER_ANCHOR_ATTR = "data-amdl-header-anchor";
const MENU_ITEM_ATTR = "data-amdl-menu-item";
const STYLE_ATTR = "data-amdl-styles";
const INSTANCE_ATTR = "data-amdl-instance";

const INSTANCE_ID =
  typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

interface InjectWindow extends Window {
  __amdlInjectCleanup?: () => void;
  navigation?: EventTarget;
}

const win = window as unknown as InjectWindow;

// Idempotency: tear down any prior live instance in this isolated world.
if (typeof win.__amdlInjectCleanup === "function") {
  try {
    win.__amdlInjectCleanup();
  } catch {
    // ignore
  }
}

// Clean up orphaned DOM nodes from any previous (invalidated) extension instance,
// or only this instance's own nodes during teardown so a late-firing old timer
// never deletes a freshly re-injected instance's UI.
function removeInjectedDom(onlyOwnInstance: boolean): void {
  const selector = `[${HEADER_BTN_ATTR}], [${ROW_BTN_ATTR}], [${MENU_ITEM_ATTR}], style[${STYLE_ATTR}]`;
  for (const el of document.querySelectorAll(selector)) {
    const owner = el.getAttribute(INSTANCE_ATTR);
    if (onlyOwnInstance) {
      if (owner !== INSTANCE_ID) continue;
    } else if (owner === INSTANCE_ID) {
      continue;
    }
    el.remove();
  }
  for (const cell of document.querySelectorAll(`[${ROW_CELL_ATTR}]`)) {
    if (!cell.querySelector(`[${ROW_BTN_ATTR}]`)) {
      cell.removeAttribute(ROW_CELL_ATTR);
      cell.removeAttribute("data-amdl-active");
    }
  }
  for (const anchor of document.querySelectorAll(`[${HEADER_ANCHOR_ATTR}]`)) {
    if (!anchor.querySelector(`[${HEADER_BTN_ATTR}]`)) {
      anchor.removeAttribute(HEADER_ANCHOR_ATTR);
    }
  }
}

removeInjectedDom(false);

let disposed = false;

function isContextValid(): boolean {
  if (disposed) return false;
  try {
    return Boolean(chrome?.runtime?.id);
  } catch {
    return false;
  }
}

function isInvalidatedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("Extension context invalidated") ||
    msg.includes("context invalidated") ||
    !isContextValid()
  );
}

// Scoped stylesheet using Apple Music's own CSS variables & currentColor.
const INJECTED_CSS = `
  [${HEADER_ANCHOR_ATTR}="1"] {
    position: relative;
  }
  button[${HEADER_BTN_ATTR}][data-amdl-abs="1"] {
    position: absolute !important;
    top: 50%;
    left: calc(100% + 12px);
    transform: translateY(-50%);
    margin: 0 !important;
  }
  button[${HEADER_BTN_ATTR}] {
    margin-inline-start: 12px;
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    position: relative;
    cursor: pointer;
    box-sizing: border-box;
    padding: 0;
  }
  button[${HEADER_BTN_ATTR}][data-amdl-fallback="circle"] {
    width: var(--amdl-btn-w, 36px);
    height: var(--amdl-btn-h, 36px);
    border-radius: 50%;
    border: 0.625px solid var(--systemQuinary, rgba(128, 128, 128, 0.22));
    background: var(--systemQuinary, rgba(128, 128, 128, 0.1));
    color: var(--systemPrimary, currentColor);
    transition: background-color 0.15s ease, opacity 0.15s ease;
  }
  button[${HEADER_BTN_ATTR}][data-amdl-fallback="circle"]:hover {
    background: var(--systemQuaternary, rgba(128, 128, 128, 0.2));
  }
  button[${HEADER_BTN_ATTR}][data-amdl-fallback="song"] {
    width: 28px;
    height: 28px;
    margin-inline-start: 10px;
    border-radius: 50%;
    border: 0.625px solid var(--systemQuinary, rgba(128, 128, 128, 0.22));
    background: var(--systemQuinary, rgba(128, 128, 128, 0.12));
    color: var(--systemPrimary, currentColor);
    transition: background-color 0.15s ease, opacity 0.15s ease;
  }
  button[${HEADER_BTN_ATTR}][data-amdl-fallback="song"]:hover {
    background: var(--systemQuaternary, rgba(128, 128, 128, 0.22));
  }
  button[${HEADER_BTN_ATTR}] svg {
    width: 16px !important;
    height: 16px !important;
    display: block;
    fill: none !important;
    pointer-events: none;
  }
  button[${HEADER_BTN_ATTR}] svg * {
    fill: none !important;
  }
  button[${HEADER_BTN_ATTR}][data-state="error"],
  button[${ROW_BTN_ATTR}][data-state="error"] {
    color: var(--systemRed, #ff453a) !important;
  }
  button[${HEADER_BTN_ATTR}][data-state="unavailable"],
  button[${ROW_BTN_ATTR}][data-state="unavailable"] {
    opacity: 0.35;
    cursor: not-allowed;
  }

  /* Row buttons are absolutely positioned inside the native controls grid so they never
     create a grid track or change any column width / row height. */
  [${ROW_CELL_ATTR}="1"] {
    position: relative;
  }
  [data-testid="track-list-item"]:not(:hover):not(:focus-within)
    button[${ROW_BTN_ATTR}]:not([data-state="working"]):not([data-state="done"]):not([data-state="error"]) {
    opacity: 0;
    pointer-events: none;
  }

  button[${ROW_BTN_ATTR}] {
    position: absolute;
    top: 50%;
    right: 100%;
    transform: translateY(-50%);
    width: 28px;
    height: 28px;
    padding: 0;
    margin: 0 2px 0 0;
    border: 0;
    border-radius: 50%;
    background: transparent;
    color: var(--systemSecondary, currentColor);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    flex: 0 0 auto;
    transition: background-color 0.12s ease, color 0.12s ease;
  }
  button[${ROW_BTN_ATTR}]:hover,
  button[${ROW_BTN_ATTR}]:focus-visible {
    color: var(--systemPrimary, currentColor);
    background: var(--systemQuinary, rgba(128, 128, 128, 0.14));
  }
  button[${ROW_BTN_ATTR}][data-state="working"],
  button[${ROW_BTN_ATTR}][data-state="done"] {
    color: var(--systemPrimary, currentColor);
  }
  button[${ROW_BTN_ATTR}] svg {
    width: 15px;
    height: 15px;
    display: block;
    fill: none;
    pointer-events: none;
  }

  .amdl-ring-bg {
    stroke: currentColor;
    opacity: 0.25;
  }
  .amdl-ring-fg {
    stroke: currentColor;
    transform: rotate(-90deg);
    transform-origin: center;
    transition: stroke-dashoffset 0.15s linear;
  }
  .amdl-spin {
    animation: amdl-rotate 1s linear infinite;
    transform-origin: center;
  }
  @keyframes amdl-rotate {
    to { transform: rotate(360deg); }
  }

  li[${MENU_ITEM_ATTR}] .contextual-menu-item__icon-container svg {
    width: 16px;
    height: 16px;
    display: block;
    fill: none;
    stroke: currentColor;
  }
`;

function ensureStylesheet(): void {
  if (
    document.querySelector(
      `style[${STYLE_ATTR}][${INSTANCE_ATTR}="${INSTANCE_ID}"]`,
    )
  ) {
    return;
  }
  const style = document.createElement("style");
  style.setAttribute(STYLE_ATTR, "1");
  style.setAttribute(INSTANCE_ATTR, INSTANCE_ID);
  style.textContent = INJECTED_CSS;
  (document.head || document.documentElement).appendChild(style);
}

// Clean, subtle SF-Symbol-inspired SVG icons using currentColor only.
const ICON_DOWNLOAD = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.25v7.5"/><path d="M5 7.25 8 10.25l3-3"/><path d="M2.75 11.75v1a1 1 0 0 0 1 1h8.5a1 1 0 0 0 1-1v-1"/></svg>`;
const ICON_CHECK = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.25 8.5 6.5 11.75 12.75 4.75"/></svg>`;
const ICON_ERROR = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M8 5v3.5"/><path d="M8 11h.01"/></svg>`;
const ICON_MENU_DOWNLOAD = `<svg class="context-menu__option-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.25v7.5"/><path d="M5 7.25 8 10.25l3-3"/><path d="M2.75 11.75v1a1 1 0 0 0 1 1h8.5a1 1 0 0 0 1-1v-1"/></svg>`;

function renderProgressRing(ratio: number | null): string {
  const r = 6.5;
  const c = 2 * Math.PI * r;
  if (ratio === null) {
    // Indeterminate: rotating partial arc around a miniature download arrow
    const arc = c * 0.28;
    return `<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle class="amdl-ring-bg" cx="8" cy="8" r="${r}" stroke-width="1.5"/><circle class="amdl-spin" cx="8" cy="8" r="${r}" stroke="currentColor" stroke-width="1.5" stroke-dasharray="${arc.toFixed(2)} ${(c - arc).toFixed(2)}" stroke-linecap="round"/><path d="M8 5.25v4.5M6.25 8.25 8 10l1.75-1.75" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }
  const clamped = Math.max(0.05, Math.min(1, ratio));
  const offset = c * (1 - clamped);
  return `<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle class="amdl-ring-bg" cx="8" cy="8" r="${r}" stroke-width="1.5"/><circle class="amdl-ring-fg" cx="8" cy="8" r="${r}" stroke-width="1.5" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}" stroke-linecap="round"/><path d="M8 5.25v4.5M6.25 8.25 8 10l1.75-1.75" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

// Runtime state
const jobsByUiKey = new Map<string, JobSnapshot>();
const collectionCache = new Map<string, ResolvedAlbumSummary>();
const collectionInFlight = new Map<string, Promise<ResolvedAlbumSummary | null>>();
const collectionNotes = new Map<string, string>();
const enqueueInFlight = new Set<string>();

interface ButtonRef {
  btn: HTMLButtonElement;
  cell?: Element;
  kind:
    | "header-album"
    | "header-library-album"
    | "header-playlist"
    | "header-library-playlist"
    | "header-song"
    | "row";
  storefront: string;
  songId?: string;
  collectionId?: string;
  playlistContext?: PlaylistContext;
  unavailable?: boolean;
}

const mountedButtons = new Set<ButtonRef>();

function makeNonce(): string {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function callMainWorld<T>(
  reqType: string,
  resType: string,
  payload: Record<string, unknown>,
  fallback: T,
  timeoutMs = 1500,
): Promise<T> {
  return new Promise((resolve) => {
    if (disposed) {
      resolve(fallback);
      return;
    }
    const nonce = makeNonce();
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      channel.port1.close();
      resolve(fallback);
    }, timeoutMs);
    channel.port1.onmessage = (ev: MessageEvent) => {
      const data = ev.data as Record<string, unknown> | null;
      if (data?.type === resType && data.nonce === nonce) {
        clearTimeout(timer);
        channel.port1.close();
        resolve(data as T);
      }
    };
    window.postMessage(
      { type: reqType, nonce, ...payload },
      location.origin,
      [channel.port2],
    );
  });
}

async function requestPageTokens(timeoutMs = 1500): Promise<PageTokens> {
  const res = await callMainWorld<{ tokens?: PageTokens }>(
    "amdl:token-req",
    "amdl:token-res",
    {},
    {},
    timeoutMs,
  );
  return res.tokens ?? {};
}

async function lookupLockupInMainWorld(query: {
  title?: string;
  subtitle?: string;
  artworkStem?: string;
}): Promise<{ kind: "library-album" | "library-playlist"; id: string; name: string } | null> {
  const res = await callMainWorld<{
    match?: {
      kind: "library-album" | "library-playlist";
      id: string;
      name: string;
    } | null;
  }>("amdl:lockup-lookup", "amdl:lockup-lookup-res", { query }, {}, 600);
  return res.match ?? null;
}

async function fetchActiveMenuTriggerElement(): Promise<Element | null> {
  const res = await callMainWorld<{ triggerToken?: string }>(
    "amdl:menu-trigger-req",
    "amdl:menu-trigger-res",
    {},
    {},
    500,
  );
  if (!res.triggerToken) return null;
  return document.querySelector(
    `[data-amdl-active-trigger="${CSS.escape(res.triggerToken)}"]`,
  );
}

async function sendRuntime<T = unknown>(
  msg: Record<string, unknown>,
): Promise<T | null> {
  if (!isContextValid()) {
    teardown();
    return null;
  }
  try {
    return (await chrome.runtime.sendMessage(msg)) as T;
  } catch (err) {
    if (isInvalidatedError(err)) {
      teardown();
    }
    return null;
  }
}

function collectionKey(kind: CollectionKind, storefront: string, id: string): string {
  return `${kind}:${storefront}:${id}`;
}

async function resolveCollection(
  kind: CollectionKind,
  storefront: string,
  id: string,
): Promise<ResolvedAlbumSummary | null> {
  const key = collectionKey(kind, storefront, id);
  const cached = collectionCache.get(key);
  if (cached) return cached;
  const inflight = collectionInFlight.get(key);
  if (inflight) return inflight;

  const p = (async () => {
    const tokens = await requestPageTokens();
    const resp = await sendRuntime<{
      ok?: boolean;
      collection?: ResolvedAlbumSummary;
    }>({
      type: "resolve-collection",
      kind,
      storefront,
      id,
      tokens,
    });
    if (resp?.ok && resp.collection) {
      collectionCache.set(key, resp.collection);
      return resp.collection;
    }
    return null;
  })().finally(() => {
    collectionInFlight.delete(key);
  });

  collectionInFlight.set(key, p);
  return p;
}

function readDomCollectionTitle(): string {
  const el =
    document.querySelector('[data-testid="non-editable-product-title"]') ||
    document.querySelector('[data-testid="container-detail-header"] h1');
  return el?.textContent?.trim() || "";
}

function getCollectionKindForHeader(ref: ButtonRef): CollectionKind | null {
  switch (ref.kind) {
    case "header-album":
      return "album";
    case "header-library-album":
      return "library-album";
    case "header-playlist":
      return "playlist";
    case "header-library-playlist":
      return "library-playlist";
    default:
      return null;
  }
}

function isPlaylistHeader(ref: ButtonRef): boolean {
  return (
    ref.kind === "header-playlist" || ref.kind === "header-library-playlist"
  );
}

function updateRowButtonVisual(ref: ButtonRef): void {
  const t = getUiStrings();
  if (ref.unavailable || !ref.songId) {
    ref.btn.dataset.state = "unavailable";
    ref.btn.innerHTML = ICON_DOWNLOAD;
    ref.btn.title = t.unavailable;
    ref.btn.setAttribute("aria-label", t.unavailable);
    ref.btn.disabled = true;
    ref.cell?.removeAttribute("data-amdl-active");
    return;
  }
  ref.btn.disabled = false;

  const uiKey = buildUiJobKey(ref.songId, ref.playlistContext);
  const job = jobsByUiKey.get(uiKey);

  if (!job || job.stage === "cancelled") {
    ref.btn.dataset.state = "idle";
    ref.btn.innerHTML = ICON_DOWNLOAD;
    ref.btn.title = t.downloadTrack;
    ref.btn.setAttribute("aria-label", t.downloadTrack);
    ref.cell?.removeAttribute("data-amdl-active");
    return;
  }
  if (job.stage === "done") {
    ref.btn.dataset.state = "done";
    ref.btn.innerHTML = ICON_CHECK;
    const detail = job.notes.length
      ? `${t.downloaded} — ${job.message} (${job.notes.join("; ")})`
      : `${t.downloaded} — ${job.message}`;
    ref.btn.title = detail;
    ref.btn.setAttribute("aria-label", t.downloaded);
    ref.cell?.setAttribute("data-amdl-active", "true");
    return;
  }
  if (job.stage === "error") {
    ref.btn.dataset.state = "error";
    ref.btn.innerHTML = ICON_ERROR;
    const msg = `${t.failed}: ${job.error || job.message} (${t.retry})`;
    ref.btn.title = msg;
    ref.btn.setAttribute("aria-label", msg);
    ref.cell?.setAttribute("data-amdl-active", "true");
    return;
  }
  ref.btn.dataset.state = "working";
  const ratio = job.total > 0 && job.done > 0 ? job.done / job.total : null;
  ref.btn.innerHTML = renderProgressRing(ratio);
  const pct = ratio !== null ? ` (${Math.round(ratio * 100)}%)` : "";
  const msg = `${t.downloading}${pct} — ${job.message || job.stage}`;
  ref.btn.title = msg;
  ref.btn.setAttribute("aria-label", msg);
  ref.cell?.setAttribute("data-amdl-active", "true");
}

function updateHeaderButtonVisual(ref: ButtonRef): void {
  const t = getUiStrings();

  if (ref.kind === "header-song" && ref.songId) {
    const job = jobsByUiKey.get(buildUiJobKey(ref.songId));
    if (!job || job.stage === "cancelled") {
      ref.btn.dataset.state = "idle";
      ref.btn.innerHTML = ICON_DOWNLOAD;
      ref.btn.title = t.downloadTrack;
      ref.btn.setAttribute("aria-label", t.downloadTrack);
      return;
    }
    if (job.stage === "done") {
      ref.btn.dataset.state = "done";
      ref.btn.innerHTML = ICON_CHECK;
      ref.btn.title = `${t.downloaded} — ${job.message}`;
      ref.btn.setAttribute("aria-label", t.downloaded);
      return;
    }
    if (job.stage === "error") {
      ref.btn.dataset.state = "error";
      ref.btn.innerHTML = ICON_ERROR;
      const errMsg = `${t.failed}: ${job.error || job.message} (${t.retry})`;
      ref.btn.title = errMsg;
      ref.btn.setAttribute("aria-label", errMsg);
      return;
    }
    ref.btn.dataset.state = "working";
    const ratio = job.total > 0 && job.done > 0 ? job.done / job.total : null;
    ref.btn.innerHTML = renderProgressRing(ratio);
    const pct = ratio !== null ? ` (${Math.round(ratio * 100)}%)` : "";
    const msg = `${t.downloading}${pct}`;
    ref.btn.title = `${msg} — ${job.message}`;
    ref.btn.setAttribute("aria-label", msg);
    return;
  }

  const colKind = getCollectionKindForHeader(ref);
  if (!colKind || !ref.collectionId) return;

  const isPl = isPlaylistHeader(ref);
  const idleLabel = isPl ? t.downloadPlaylist : t.downloadAlbum;
  const doneLabel = isPl ? t.playlistDownloaded : t.albumDownloaded;
  const key = collectionKey(colKind, ref.storefront, ref.collectionId);
  const summary = collectionCache.get(key);
  const extraNote = collectionNotes.get(key) || "";

  if (enqueueInFlight.has(key)) {
    ref.btn.dataset.state = "working";
    ref.btn.innerHTML = renderProgressRing(null);
    ref.btn.title = t.queueing;
    ref.btn.setAttribute("aria-label", t.queueing);
    return;
  }

  if (!summary) {
    ref.btn.dataset.state = "idle";
    ref.btn.innerHTML = ICON_DOWNLOAD;
    ref.btn.title = extraNote ? `${idleLabel} (${extraNote})` : idleLabel;
    ref.btn.setAttribute("aria-label", idleLabel);
    return;
  }

  const downloadable = summary.tracks.filter((tr) => Boolean(tr.id) && !tr.nonSong);
  if (downloadable.length === 0) {
    const msg =
      (summary.skippedUnavailableCount ?? 0) > 0
        ? t.unavailable
        : idleLabel;
    ref.btn.dataset.state =
      (summary.skippedUnavailableCount ?? 0) > 0 ? "unavailable" : "idle";
    ref.btn.innerHTML = ICON_DOWNLOAD;
    ref.btn.title = msg;
    ref.btn.setAttribute("aria-label", msg);
    return;
  }

  let doneCount = 0;
  let activeCount = 0;
  let errCount = 0;
  for (let i = 0; i < downloadable.length; i++) {
    const tr = downloadable[i]!;
    const plCtx: PlaylistContext | undefined = isPl
      ? {
          playlistId: summary.id,
          playlistName: summary.name || readDomCollectionTitle() || "Playlist",
          playlistIndex: tr.playlistIndex ?? i + 1,
        }
      : undefined;
    const j = jobsByUiKey.get(buildUiJobKey(tr.id, plCtx));
    if (!j) continue;
    if (j.stage === "done") doneCount++;
    else if (j.stage === "error") errCount++;
    else if (j.stage !== "cancelled") activeCount++;
  }

  const suffix = extraNote ? ` · ${extraNote}` : "";
  if (activeCount > 0) {
    ref.btn.dataset.state = "working";
    const ratio = doneCount > 0 ? doneCount / downloadable.length : null;
    ref.btn.innerHTML = renderProgressRing(ratio);
    const msg = `${t.downloading} ${doneCount}/${downloadable.length}${suffix}`;
    ref.btn.title = msg;
    ref.btn.setAttribute("aria-label", msg);
  } else if (doneCount === downloadable.length) {
    ref.btn.dataset.state = "done";
    ref.btn.innerHTML = ICON_CHECK;
    const msg = `${doneLabel} (${doneCount}/${downloadable.length})${suffix}`;
    ref.btn.title = msg;
    ref.btn.setAttribute("aria-label", doneLabel);
  } else if (errCount > 0) {
    ref.btn.dataset.state = "error";
    ref.btn.innerHTML = ICON_ERROR;
    const msg = `${t.failed} (${errCount}/${downloadable.length}) — ${t.retry}${suffix}`;
    ref.btn.title = msg;
    ref.btn.setAttribute("aria-label", msg);
  } else {
    ref.btn.dataset.state = "idle";
    ref.btn.innerHTML = ICON_DOWNLOAD;
    const msg = `${idleLabel} (${downloadable.length})${suffix}`;
    ref.btn.title = msg;
    ref.btn.setAttribute("aria-label", idleLabel);
  }
}

function refreshAllButtonVisuals(): void {
  for (const ref of Array.from(mountedButtons)) {
    if (!ref.btn.isConnected) {
      mountedButtons.delete(ref);
      continue;
    }
    if (ref.kind === "row") updateRowButtonVisual(ref);
    else updateHeaderButtonVisual(ref);
  }
}

function attachEventIsolation(el: HTMLElement): void {
  const stopBubble = (ev: Event) => {
    ev.stopPropagation();
  };
  for (const type of [
    "pointerdown",
    "mousedown",
    "mouseup",
    "touchstart",
    "keydown",
    "keyup",
  ]) {
    el.addEventListener(type, stopBubble);
  }
}

async function enqueueSubject(subject: DownloadSubject): Promise<void> {
  const tokens = await requestPageTokens();

  if (subject.kind === "song") {
    const uiKey = buildUiJobKey(subject.songId, subject.playlistContext);
    const existing = jobsByUiKey.get(uiKey);
    if (existing?.stage === "error" || existing?.stage === "cancelled") {
      await sendRuntime({ type: "retry-job", jobId: existing.jobId });
      return;
    }
    await sendRuntime({
      type: "enqueue-song",
      storefront: subject.storefront,
      songId: subject.songId,
      titleHint: subject.titleHint || undefined,
      playlistContext: subject.playlistContext,
      useAccountStorefront: subject.useAccountStorefront,
      tokens,
    });
    return;
  }

  const key = collectionKey(
    subject.kind,
    subject.kind === "album" || subject.kind === "playlist"
      ? subject.storefront
      : "",
    subject.id,
  );
  if (enqueueInFlight.has(key)) return;
  enqueueInFlight.add(key);
  refreshAllButtonVisuals();

  try {
    let resp: EnqueueCollectionResponse | null = null;
    if (subject.kind === "album") {
      resp = await sendRuntime<EnqueueCollectionResponse>({
        type: "enqueue-album",
        storefront: subject.storefront,
        albumId: subject.id,
        tokens,
      });
    } else if (subject.kind === "library-album") {
      resp = await sendRuntime<EnqueueCollectionResponse>({
        type: "enqueue-library-album",
        libraryAlbumId: subject.id,
        tokens,
      });
    } else if (subject.kind === "playlist") {
      resp = await sendRuntime<EnqueueCollectionResponse>({
        type: "enqueue-playlist",
        storefront: subject.storefront,
        playlistId: subject.id,
        tokens,
      });
    } else if (subject.kind === "library-playlist") {
      resp = await sendRuntime<EnqueueCollectionResponse>({
        type: "enqueue-library-playlist",
        libraryPlaylistId: subject.id,
        tokens,
      });
    }

    if (resp?.collection) {
      collectionCache.set(key, resp.collection);
    }
    if (resp?.skippedCount && resp.skippedCount > 0) {
      collectionNotes.set(
        key,
        getUiStrings().skippedUnavailable(resp.skippedCount),
      );
    } else if (resp?.message) {
      collectionNotes.set(key, resp.message);
    } else if (resp && !resp.ok && resp.error) {
      collectionNotes.set(key, resp.error);
    }
  } finally {
    enqueueInFlight.delete(key);
    refreshAllButtonVisuals();
  }
}

function headerKindFromRoute(route: PageRoute): ButtonRef["kind"] {
  switch (route.type) {
    case "album":
      return "header-album";
    case "library-album":
      return "header-library-album";
    case "playlist":
      return "header-playlist";
    case "library-playlist":
      return "header-library-playlist";
    case "song":
      return "header-song";
  }
}

function subjectFromRoute(route: PageRoute): DownloadSubject {
  switch (route.type) {
    case "song": {
      const titleHint =
        document
          .querySelector('[data-testid="song-title"], .song-header-page h1')
          ?.textContent?.trim() || undefined;
      return {
        kind: "song",
        storefront: route.storefront,
        songId: route.id,
        titleHint,
      };
    }
    case "album":
      return {
        kind: "album",
        storefront: route.storefront,
        id: route.id,
        titleHint: readDomCollectionTitle() || undefined,
      };
    case "library-album":
      return {
        kind: "library-album",
        id: route.id,
        titleHint: readDomCollectionTitle() || undefined,
      };
    case "playlist":
      return {
        kind: "playlist",
        storefront: route.storefront,
        id: route.id,
        titleHint: readDomCollectionTitle() || undefined,
      };
    case "library-playlist":
      return {
        kind: "library-playlist",
        id: route.id,
        titleHint: readDomCollectionTitle() || undefined,
      };
  }
}

function withOwnDomMutation<T>(fn: () => T): T {
  return fn();
}

const routeFirstSeenAt = new Map<string, number>();

function mountHeaderButton(route: PageRoute): void {
  const key = `${route.type}:${route.storefront}:${route.id}`;
  const headerRoot =
    document.querySelector('[data-testid="container-detail-header"]') ||
    document.querySelector(".song-header-page");
  if (!headerRoot) return;

  if (!routeFirstSeenAt.has(key)) {
    routeFirstSeenAt.set(key, Date.now());
  }

  const cloudButtons = headerRoot.querySelector<HTMLElement>(
    '.primary-actions__button--add-to-library [data-testid="cloud-buttons"], [data-testid="cloud-buttons"]',
  );
  const nativeAddBtn = cloudButtons?.querySelector<HTMLButtonElement>(
    'button[data-testid="add-to-library-button"], button[data-testid="delete-from-library-button"], button.add-to-library-button',
  );

  const existing = headerRoot.querySelector<HTMLButtonElement>(
    `button[${HEADER_BTN_ATTR}]`,
  );

  if (cloudButtons && nativeAddBtn) {
    // Already mounted in the exact right slot next to the native library button.
    if (
      existing &&
      existing.getAttribute(HEADER_BTN_ATTR) === key &&
      existing.parentElement === cloudButtons &&
      existing.previousElementSibling === nativeAddBtn
    ) {
      return;
    }
  } else if (route.type === "song") {
    const songBtns = headerRoot.querySelector(".song-header-page__buttons");
    if (
      existing &&
      existing.getAttribute(HEADER_BTN_ATTR) === key &&
      existing.parentElement === songBtns
    ) {
      return;
    }
  } else {
    // On collection pages where `--add-to-library` exists, wait briefly for Apple's
    // auth hydration to render `.cloud-buttons` before falling back to `--cta-button`
    // (putting anything in `--cta-button` while `--add-to-library` hydrates wraps the grid).
    const addToLibCell = headerRoot.querySelector(
      ".primary-actions__button--add-to-library",
    );
    if (addToLibCell) {
      const elapsed = Date.now() - (routeFirstSeenAt.get(key) ?? 0);
      if (elapsed < 3000) {
        setTimeout(() => scheduleScan(), 350);
        return;
      }
    }
    if (existing && existing.getAttribute(HEADER_BTN_ATTR) === key) {
      return;
    }
  }

  withOwnDomMutation(() => {
    if (existing) existing.remove();

    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute(HEADER_BTN_ATTR, key);
    btn.setAttribute(INSTANCE_ATTR, INSTANCE_ID);

    if (cloudButtons && nativeAddBtn) {
      // Clone the native add-to-library button's Svelte classes so size, bg, border & hover match natively.
      const clonedClasses = nativeAddBtn.className
        .split(/\s+/)
        .filter((c) => c && c !== "is-in-library")
        .join(" ");
      btn.className = clonedClasses;
      // Absolutely positioned next to the native button so the header grid keeps its size.
      cloudButtons.setAttribute(HEADER_ANCHOR_ATTR, "1");
      btn.setAttribute("data-amdl-abs", "1");
      // Align vertically with the native button regardless of the container's box.
      btn.style.top = `${(nativeAddBtn as HTMLElement).offsetTop}px`;
      btn.style.transform = "none";
      nativeAddBtn.insertAdjacentElement("afterend", btn);
    } else if (route.type === "song") {
      const songBtns = headerRoot.querySelector(".song-header-page__buttons");
      if (!songBtns) return;
      btn.setAttribute("data-amdl-fallback", "song");
      songBtns.appendChild(btn);
    } else {
      // Fallback: insert inside the existing empty --cta-button cell (never add a new grid child to .primary-actions).
      const ctaCell = headerRoot.querySelector<HTMLElement>(
        ".primary-actions__button--cta-button",
      );
      if (!ctaCell || ctaCell.children.length > 0) return;
      btn.setAttribute("data-amdl-fallback", "circle");
      const shuffleBtn = headerRoot.querySelector<HTMLElement>(
        ".primary-actions__button--shuffle button",
      );
      if (shuffleBtn) {
        const rect = shuffleBtn.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          btn.style.setProperty("--amdl-btn-w", `${Math.round(rect.width)}px`);
          btn.style.setProperty("--amdl-btn-h", `${Math.round(rect.height)}px`);
        }
      }
      btn.style.marginInlineStart = "0";
      ctaCell.setAttribute(HEADER_ANCHOR_ATTR, "1");
      btn.setAttribute("data-amdl-abs", "1");
      btn.style.left = "0";
      ctaCell.appendChild(btn);
    }

    attachEventIsolation(btn);

    const ref: ButtonRef = {
      btn,
      kind: headerKindFromRoute(route),
      storefront: route.storefront,
      ...(route.type === "song"
        ? { songId: route.id }
        : { collectionId: route.id }),
    };

    btn.addEventListener("click", (ev) => {
      if (!isTrustedUserEvent(ev)) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (btn.disabled) return;
      void enqueueSubject(subjectFromRoute(route));
    });

    mountedButtons.add(ref);
    updateHeaderButtonVisual(ref);
  });
}

function mountRowButton(args: {
  route: PageRoute;
  rowEl: Element;
  songId: string;
  storefront: string;
  titleHint: string;
  playlistContext?: PlaylistContext;
  unavailable?: boolean;
}): void {
  const controls = args.rowEl.querySelector(
    '[data-testid="track-column-controls"]',
  );
  if (!controls) return;
  const addCell = controls.querySelector<HTMLElement>(
    ".songs-list-row__add-to-library",
  );
  const ctxCell = controls.querySelector<HTMLElement>(
    ".songs-list-row__context-menu",
  );
  // Mount on the native controls grid itself (absolutely positioned, left of the
  // add-to-library cell) so no grid track, column width or row height changes.
  const targetCell =
    (addCell || ctxCell)?.parentElement ?? (controls.firstElementChild as HTMLElement | null);
  if (!targetCell) return;

  const key = args.unavailable
    ? `unavailable:${args.playlistContext?.playlistIndex ?? 0}`
    : buildUiJobKey(args.songId, args.playlistContext);

  const existing = controls.querySelector<HTMLButtonElement>(
    `button[${ROW_BTN_ATTR}]`,
  );
  if (
    existing &&
    existing.getAttribute(ROW_BTN_ATTR) === key &&
    existing.parentElement === targetCell
  ) {
    return;
  }

  withOwnDomMutation(() => {
    if (existing) {
      const oldCell = existing.parentElement;
      existing.remove();
      if (oldCell && oldCell !== targetCell) {
        oldCell.removeAttribute(ROW_CELL_ATTR);
        oldCell.removeAttribute("data-amdl-active");
      }
    }
    targetCell.setAttribute(ROW_CELL_ATTR, "1");

    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute(ROW_BTN_ATTR, key);
    btn.setAttribute(INSTANCE_ATTR, INSTANCE_ID);
    attachEventIsolation(btn);

    const ref: ButtonRef = {
      btn,
      cell: targetCell,
      kind: "row",
      storefront: args.storefront,
      songId: args.songId || undefined,
      playlistContext: args.playlistContext,
      unavailable: args.unavailable,
    };

    btn.addEventListener("click", (ev) => {
      if (!isTrustedUserEvent(ev)) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (ref.unavailable || !ref.songId) return;
      const isLibraryRoute =
        args.route.type === "library-album" ||
        args.route.type === "library-playlist";
      void enqueueSubject({
        kind: "song",
        storefront: isLibraryRoute ? "" : args.storefront,
        songId: ref.songId,
        titleHint: args.titleHint || undefined,
        playlistContext: args.playlistContext,
        useAccountStorefront: isLibraryRoute,
      });
    });

    targetCell.appendChild(btn);
    mountedButtons.add(ref);
    updateRowButtonVisual(ref);
  });
}

// ---------------------------------------------------------------------------
// Context menu integration (••• triggers + right-click menus across Apple Music)
// ---------------------------------------------------------------------------

interface TrackedTrigger {
  element: Element;
  timestamp: number;
}

let lastTrackedTrigger: TrackedTrigger | null = null;

function isIgnoredMenuTrigger(el: Element): boolean {
  if (
    el.querySelector(
      '[data-testid="account-menu-trigger"], [data-testid="sort-menu-trigger"]',
    ) ||
    el.closest(
      '[data-testid="account-menu-trigger"], [data-testid="sort-menu-trigger"], .account-menu, [data-testid="accessory-button"]',
    )
  ) {
    return true;
  }
  return false;
}

function recordTriggerFromTarget(target: EventTarget | null): void {
  if (!(target instanceof Element)) return;
  const menuBtn = target.closest("amp-contextual-menu-button");
  if (menuBtn) {
    lastTrackedTrigger = { element: menuBtn, timestamp: Date.now() };
    return;
  }
  const container = target.closest(
    '[data-testid="track-list-item"], [data-testid="product-lockup"], [data-testid="grid-item"], nav li, aside li',
  );
  if (container) {
    lastTrackedTrigger = { element: container, timestamp: Date.now() };
  }
}

function extractLockupMeta(lockup: Element): {
  title: string;
  subtitle: string;
  artworkStem: string;
} {
  const titleEl =
    lockup.querySelector('[data-testid="product-lockup-title"]') ||
    lockup.querySelector('[data-testid="product-lockup-link"]');
  const subtitleEl = lockup.querySelector(
    '[data-testid="product-lockup-subtitle"]',
  );
  let title = titleEl?.textContent?.trim() || "";
  let subtitle = subtitleEl?.textContent?.trim() || "";

  if (!title) {
    const aria = lockup.getAttribute("aria-label")?.trim() || "";
    if (aria) {
      const idx = aria.lastIndexOf(", ");
      if (idx > 0) {
        title = aria.slice(0, idx).trim();
        if (!subtitle) subtitle = aria.slice(idx + 2).trim();
      } else {
        title = aria;
      }
    }
  }

  let artworkStem = "";
  const sourceEl = lockup.querySelector<HTMLSourceElement>(
    'picture source[srcset*="mzstatic.com"]',
  );
  if (sourceEl?.srcset) {
    artworkStem = extractArtworkStem(sourceEl.srcset);
  }
  if (!artworkStem) {
    const imgEl = lockup.querySelector<HTMLImageElement>(
      'img[src*="mzstatic.com"]',
    );
    if (imgEl?.src) {
      artworkStem = extractArtworkStem(imgEl.src);
    }
  }
  return { title, subtitle, artworkStem };
}

async function resolveSubjectForTrigger(
  triggerEl: Element | null,
): Promise<DownloadSubject | null> {
  if (!triggerEl || !triggerEl.isConnected) return null;
  if (isIgnoredMenuTrigger(triggerEl)) return null;

  const route = parsePageRoute(location.href);

  // 1. Track row menu (album, library album, playlist, library playlist).
  const rowEl = triggerEl.closest('[data-testid="track-list-item"]');
  if (rowEl) {
    const allRows = Array.from(
      document.querySelectorAll('[data-testid="track-list-item"]'),
    );
    const domIdx = Math.max(0, allRows.indexOf(rowEl));
    const isPlRoute =
      route?.type === "playlist" || route?.type === "library-playlist";
    const isLibRoute =
      route?.type === "library-album" || route?.type === "library-playlist";

    let summary: ResolvedAlbumSummary | null = null;
    if (route && route.type !== "song") {
      summary =
        collectionCache.get(collectionKey(route.type, route.storefront, route.id)) ??
        null;
    }
    let rowInfo = extractSongFromRowElement(rowEl, domIdx, summary, location.origin);
    if (!rowInfo && route && route.type !== "song" && !summary) {
      summary = await resolveCollection(route.type, route.storefront, route.id);
      rowInfo = extractSongFromRowElement(rowEl, domIdx, summary, location.origin);
    }
    if (!rowInfo || !rowInfo.songId || rowInfo.unavailableInCatalog || rowInfo.nonSong) {
      return null;
    }

    let playlistContext: PlaylistContext | undefined;
    if (isPlRoute && route) {
      const playlistName =
        summary?.name || readDomCollectionTitle() || "Playlist";
      playlistContext = {
        playlistId: route.id,
        playlistName,
        playlistIndex: rowInfo.playlistIndex,
      };
    }

    return {
      kind: "song",
      storefront: isLibRoute
        ? ""
        : route?.storefront || rowInfo.storefront || "cn",
      songId: rowInfo.songId,
      titleHint: rowInfo.titleHint || undefined,
      playlistContext,
      useAccountStorefront: isLibRoute,
    };
  }

  // 2. Product lockup in grids / shelves (home, search, artist, song page, /library/albums, /library/recently-added).
  const lockupEl = triggerEl.closest(
    '[data-testid="product-lockup"], [data-testid="square-lockup-wrapper"], [data-testid="grid-item"]',
  );
  if (lockupEl) {
    const meta = extractLockupMeta(lockupEl);
    const anchors = Array.from(lockupEl.querySelectorAll<HTMLAnchorElement>("a[href]"));
    for (const a of anchors) {
      const rawHref = a.getAttribute("href") || "";
      const subj = subjectFromHref(rawHref, location.origin, meta.title || undefined);
      if (subj) return subj;
    }

    // Library grid lockups use `href="#"` — resolve via MAIN-world passive cache, then offscreen API fallback.
    const pathLower = location.pathname.toLowerCase();
    const isLibraryGrid =
      pathLower.includes("/library/albums") ||
      pathLower.includes("/library/recently-added") ||
      pathLower.includes("/library/all-playlists") ||
      pathLower.includes("/library/");
    if (isLibraryGrid && (meta.title || meta.artworkStem)) {
      const localMatch = await lookupLockupInMainWorld({
        title: meta.title,
        subtitle: meta.subtitle,
        artworkStem: meta.artworkStem,
      });
      if (localMatch) {
        return {
          kind: localMatch.kind,
          id: localMatch.id,
          titleHint: localMatch.name || meta.title || undefined,
        };
      }
      const source = pathLower.includes("recently-added")
        ? "recently-added"
        : "albums";
      const tokens = await requestPageTokens();
      const resp = await sendRuntime<{
        ok?: boolean;
        match?: {
          kind: "library-album" | "library-playlist";
          id: string;
          name: string;
        } | null;
      }>({
        type: "resolve-library-lockup",
        source,
        title: meta.title,
        subtitle: meta.subtitle || undefined,
        artworkStem: meta.artworkStem || undefined,
        tokens,
      });
      if (resp?.ok && resp.match) {
        return {
          kind: resp.match.kind,
          id: resp.match.id,
          titleHint: resp.match.name || meta.title || undefined,
        };
      }
    }
    return null;
  }

  // 3. Sidebar pins / sidebar playlists.
  const navContainer = triggerEl.closest("nav, aside");
  if (navContainer) {
    const navItem = triggerEl.closest("li, [role='listitem'], [class*='navigation-item']") || triggerEl.parentElement;
    if (navItem) {
      for (const a of navItem.querySelectorAll<HTMLAnchorElement>("a[href]")) {
        const subj = subjectFromHref(
          a.getAttribute("href") || "",
          location.origin,
          a.textContent?.trim() || undefined,
        );
        if (subj) return subj;
      }
    }
    return null;
  }

  // 4. Detail page header ••• button (album, library album, playlist, library playlist, song).
  if (route) {
    const inHeaderOrTopBar =
      Boolean(
        triggerEl.closest(
          '[data-testid="container-detail-header"], .song-header-page, .song__action-buttons, [data-testid="header-component-model"], .header-nav',
        ),
      ) ||
      (Boolean(triggerEl.closest("main")) &&
        triggerEl.getBoundingClientRect().top < 420);
    if (inHeaderOrTopBar) {
      return subjectFromRoute(route);
    }
  }

  return null;
}

function menuLabelForSubject(subject: DownloadSubject): string {
  const t = getUiStrings();
  switch (subject.kind) {
    case "album":
    case "library-album":
      return t.downloadAlbum;
    case "playlist":
    case "library-playlist":
      return t.downloadPlaylist;
    case "song":
      return t.download;
  }
}

function closeOpenContextMenu(): void {
  const scrim = document.querySelector("amp-contextual-menu-scrim");
  const scrimBtn = scrim?.shadowRoot?.querySelector<HTMLButtonElement>("button");
  if (scrimBtn) {
    scrimBtn.click();
    return;
  }
  document.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Escape",
      code: "Escape",
      bubbles: true,
      cancelable: true,
    }),
  );
}

const menuInjecting = new WeakSet<Element>();
const menuRecheckScheduled = new WeakSet<Element>();

function findActiveTriggerSync(): Element | null {
  // 1. Apple Music marks the open trigger button with `aria-expanded="true"`.
  const expanded = document.querySelector(
    'amp-contextual-menu-button button[aria-expanded="true"]',
  );
  if (expanded) {
    return expanded.closest("amp-contextual-menu-button") || expanded;
  }
  // 2. Fallback to capture-tracked trigger (covers right-click contextmenu too).
  if (lastTrackedTrigger && Date.now() - lastTrackedTrigger.timestamp < 5000) {
    return lastTrackedTrigger.element;
  }
  return null;
}

async function injectIntoContextMenu(menuEl: Element): Promise<void> {
  if (disposed || !menuEl.isConnected) return;
  // Find the top-level menu list (skip nested submenus).
  const lists = Array.from(
    menuEl.querySelectorAll<HTMLUListElement>(
      'ul.contextual-menu__list[role="menu"]',
    ),
  );
  const topList = lists.find(
    (ul) => !ul.closest(".contextual-menu--in-submenu, .contextual-menu--nested"),
  );
  if (!topList) return;

  const insertion = findMenuInsertionPoint(topList);
  if (!insertion) {
    // Stencil hasn't hydrated item buttons yet; recheck shortly in case mutation already fired.
    if (!menuRecheckScheduled.has(topList)) {
      menuRecheckScheduled.add(topList);
      setTimeout(() => {
        menuRecheckScheduled.delete(topList);
        if (!disposed && menuEl.isConnected) void injectIntoContextMenu(menuEl);
      }, 60);
    }
    return;
  }

  // If already injected, ensure Stencil didn't hydrate/reorder items around us.
  const existingItem = topList.querySelector<HTMLLIElement>(
    `:scope > li[${MENU_ITEM_ATTR}]`,
  );
  if (existingItem) {
    const alreadyInPlace =
      insertion.position === "afterend"
        ? insertion.anchor.nextElementSibling === existingItem
        : insertion.anchor.previousElementSibling === existingItem;
    if (!alreadyInPlace) {
      withOwnDomMutation(() => {
        insertion.anchor.insertAdjacentElement(insertion.position, existingItem);
      });
    }
    return;
  }

  if (menuInjecting.has(topList)) return;

  menuInjecting.add(topList);
  try {
    let triggerEl = findActiveTriggerSync();
    if (!triggerEl) {
      triggerEl = await fetchActiveMenuTriggerElement();
    }

    const subject = await resolveSubjectForTrigger(triggerEl);
    if (!subject || !topList.isConnected) return;
    if (topList.querySelector(`:scope > li[${MENU_ITEM_ATTR}]`)) return;

    // Re-evaluate anchor in case Apple finished rendering menu items while we awaited.
    const freshInsertion = findMenuInsertionPoint(topList);
    if (!freshInsertion) return;

    const templateLi =
      freshInsertion.anchor.matches("li.contextual-menu-item")
        ? freshInsertion.anchor
        : freshInsertion.anchor.querySelector("li.contextual-menu-item");

    const label = menuLabelForSubject(subject);
    const li = templateLi
      ? (templateLi.cloneNode(true) as HTMLLIElement)
      : document.createElement("li");

    li.className = templateLi?.className || "contextual-menu-item";
    li.setAttribute(MENU_ITEM_ATTR, "1");
    li.setAttribute(INSTANCE_ATTR, INSTANCE_ID);
    // Strip any submenu container accidentally cloned from a nested item.
    for (const sub of li.querySelectorAll(".contextual-menu-item--nested")) {
      sub.remove();
    }

    let btn = li.querySelector<HTMLButtonElement>("button");
    if (!btn) {
      btn = document.createElement("button");
      li.replaceChildren(btn);
    }
    btn.type = "button";
    btn.title = label;
    btn.setAttribute("aria-label", label);
    btn.removeAttribute("aria-expanded");
    btn.removeAttribute("aria-haspopup");
    btn.removeAttribute("disabled");

    const textSpan = btn.querySelector(".contextual-menu-item__option-text");
    if (textSpan) {
      textSpan.textContent = label;
      const afterSpan = btn.querySelector(
        ".contextual-menu-item__option-text--after",
      );
      if (afterSpan) afterSpan.textContent = "";
      let iconBox = btn.querySelector(".contextual-menu-item__icon-container");
      if (!iconBox) {
        iconBox = document.createElement("span");
        iconBox.className = "contextual-menu-item__icon-container";
        btn
          .querySelector(".contextual-menu-item__option-wrapper")
          ?.appendChild(iconBox);
      }
      iconBox.innerHTML = ICON_MENU_DOWNLOAD;
    } else {
      btn.innerHTML = `<span class="contextual-menu-item__option-wrapper"><span class="contextual-menu-item__option-text">${label}</span><span class="contextual-menu-item__option-text contextual-menu-item__option-text--after"></span><span class="contextual-menu-item__icon-container">${ICON_MENU_DOWNLOAD}</span></span>`;
    }

    // Mirror separator styling if the native wrapper carried a border-bottom.
    const anchorBorder = getComputedStyle(freshInsertion.anchor).borderBottom;
    if (
      anchorBorder &&
      !anchorBorder.startsWith("0px") &&
      getComputedStyle(li).borderBottom.startsWith("0px")
    ) {
      li.style.borderBottom = anchorBorder;
    }

    // Never block ArrowUp/ArrowDown/Escape so native keyboard navigation stays intact.
    btn.addEventListener("click", (ev) => {
      if (!isTrustedUserEvent(ev)) return;
      ev.preventDefault();
      ev.stopPropagation();
      void enqueueSubject(subject);
      closeOpenContextMenu();
    });

    withOwnDomMutation(() => {
      freshInsertion.anchor.insertAdjacentElement(freshInsertion.position, li);
    });

    // Follow-up check after Stencil finishes any delayed async menu hydration.
    setTimeout(() => {
      if (!disposed && menuEl.isConnected) void injectIntoContextMenu(menuEl);
    }, 180);
  } finally {
    menuInjecting.delete(topList);
  }
}

function processOpenContextMenus(): void {
  if (!isContextValid()) {
    teardown();
    return;
  }
  const menus = document.querySelectorAll("amp-contextual-menu");
  for (const menu of menus) {
    void injectIntoContextMenu(menu);
  }
}

// ---------------------------------------------------------------------------
// Main scan & inject loop
// ---------------------------------------------------------------------------

async function scanAndInject(): Promise<void> {
  if (!isContextValid()) {
    teardown();
    return;
  }
  ensureStylesheet();
  processOpenContextMenus();

  const route = parsePageRoute(location.href);
  if (!route) return;

  mountHeaderButton(route);

  if (route.type === "song") return;

  const rows = Array.from(
    document.querySelectorAll('[data-testid="track-list-item"]'),
  );
  if (rows.length === 0) return;

  const isPlRoute =
    route.type === "playlist" || route.type === "library-playlist";
  const isLibRoute =
    route.type === "library-album" || route.type === "library-playlist";
  const cacheKey = collectionKey(route.type, route.storefront, route.id);
  let summary = collectionCache.get(cacheKey) ?? null;
  let needCollectionResolve = false;

  const domPlaylistName = isPlRoute ? readDomCollectionTitle() : "";

  const mountRowsWithSummary = (s: ResolvedAlbumSummary | null): boolean => {
    let missingAny = false;
    const plName = s?.name || domPlaylistName || "Playlist";
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const info = extractSongFromRowElement(row, i, s, location.origin);
      if (!info) {
        missingAny = true;
        continue;
      }
      if (info.nonSong) continue;
      const playlistContext: PlaylistContext | undefined = isPlRoute
        ? {
            playlistId: route.id,
            playlistName: plName,
            playlistIndex: info.playlistIndex,
          }
        : undefined;
      mountRowButton({
        route,
        rowEl: row,
        songId: info.songId,
        storefront: isLibRoute
          ? ""
          : route.storefront || info.storefront || "cn",
        titleHint: info.titleHint,
        playlistContext,
        unavailable: info.unavailableInCatalog,
      });
    }
    return missingAny;
  };

  needCollectionResolve = mountRowsWithSummary(summary);

  if (needCollectionResolve && !summary) {
    summary = await resolveCollection(route.type, route.storefront, route.id);
    if (disposed) return;
    if (summary) {
      mountRowsWithSummary(summary);
      refreshAllButtonVisuals();
    }
  }
}

// Dual-path scheduler: setTimeout fallback + rAF when visible (fixes B2).
let scanTimeoutId: ReturnType<typeof setTimeout> | null = null;
let scanRafId: number | null = null;

function flushScheduledScan(): void {
  if (scanTimeoutId !== null) {
    clearTimeout(scanTimeoutId);
    scanTimeoutId = null;
  }
  if (scanRafId !== null) {
    cancelAnimationFrame(scanRafId);
    scanRafId = null;
  }
  void scanAndInject();
}

function scheduleScan(): void {
  if (!isContextValid()) {
    teardown();
    return;
  }
  if (scanTimeoutId !== null || scanRafId !== null) return;
  scanTimeoutId = setTimeout(flushScheduledScan, 80);
  if (
    document.visibilityState === "visible" &&
    typeof requestAnimationFrame === "function"
  ) {
    scanRafId = requestAnimationFrame(flushScheduledScan);
  }
}

// ---------------------------------------------------------------------------
// Listeners, observers & clean teardown
// ---------------------------------------------------------------------------

const onRuntimeMessage = (
  msg: unknown,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (resp?: unknown) => void,
): boolean => {
  if (!isContextValid()) {
    teardown();
    return false;
  }
  if (!msg || typeof msg !== "object") return false;
  const typed = msg as { type?: string; job?: JobSnapshot };
  if (typed.type === "job-update" && typed.job) {
    const key = buildUiJobKey(typed.job.songId, typed.job.playlistContext);
    jobsByUiKey.set(key, typed.job);
    refreshAllButtonVisuals();
    return false;
  }
  if (typed.type === "content-get-tokens") {
    void requestPageTokens().then(sendResponse);
    return true;
  }
  return false;
};

chrome.runtime.onMessage.addListener(onRuntimeMessage);

let lastHref = location.href;
const onUrlMaybeChanged = () => {
  if (!isContextValid()) {
    teardown();
    return;
  }
  if (location.href !== lastHref) {
    lastHref = location.href;
    scheduleScan();
  }
};

const onVisibilityChange = () => {
  if (!isContextValid()) {
    teardown();
    return;
  }
  if (document.visibilityState === "visible") {
    scheduleScan();
  }
};

const onCapturePointerOrClick = (ev: Event) => {
  if (!isContextValid()) {
    teardown();
    return;
  }
  recordTriggerFromTarget(ev.target);
};

const onCaptureKeydown = (ev: KeyboardEvent) => {
  if (!isContextValid()) {
    teardown();
    return;
  }
  if (ev.key === "Enter" || ev.key === " ") {
    recordTriggerFromTarget(ev.target);
  }
};

win.navigation?.addEventListener("navigatesuccess", onUrlMaybeChanged);
window.addEventListener("popstate", onUrlMaybeChanged);
document.addEventListener("visibilitychange", onVisibilityChange);
document.addEventListener("pointerdown", onCapturePointerOrClick, true);
document.addEventListener("mousedown", onCapturePointerOrClick, true);
document.addEventListener("contextmenu", onCapturePointerOrClick, true);
document.addEventListener("keydown", onCaptureKeydown, true);

const urlPollInterval = setInterval(onUrlMaybeChanged, 600);

function isOnlyOwnAdditionOrInnerUpdate(records: MutationRecord[]): boolean {
  for (const r of records) {
    const targetEl = r.target instanceof Element ? r.target : null;
    // Ignore innerHTML / SVG progress updates inside our own buttons.
    if (
      targetEl &&
      (targetEl.hasAttribute(HEADER_BTN_ATTR) ||
        targetEl.hasAttribute(ROW_BTN_ATTR) ||
        targetEl.hasAttribute(MENU_ITEM_ATTR))
    ) {
      continue;
    }
    // Never ignore removals (e.g. Stencil wiping our injected item during re-render).
    if (r.removedNodes.length > 0) return false;
    const added = Array.from(r.addedNodes);
    if (
      added.length > 0 &&
      added.every(
        (n) =>
          n instanceof Element &&
          (n.hasAttribute(HEADER_BTN_ATTR) ||
            n.hasAttribute(ROW_BTN_ATTR) ||
            n.hasAttribute(MENU_ITEM_ATTR) ||
            n.hasAttribute(STYLE_ATTR)),
      )
    ) {
      continue;
    }
    return false;
  }
  return true;
}

const observer = new MutationObserver((records) => {
  if (!isContextValid()) {
    teardown();
    return;
  }
  if (isOnlyOwnAdditionOrInnerUpdate(records)) return;

  // React immediately when a context menu opens, hydrates, or re-renders its items.
  let sawMenuMutation = false;
  for (const r of records) {
    if (
      r.target instanceof Element &&
      r.target.closest("amp-contextual-menu")
    ) {
      sawMenuMutation = true;
      break;
    }
    for (const n of r.addedNodes) {
      if (
        n instanceof Element &&
        (n.tagName === "AMP-CONTEXTUAL-MENU" ||
          n.querySelector?.("amp-contextual-menu, ul.contextual-menu__list"))
      ) {
        sawMenuMutation = true;
        break;
      }
    }
    if (sawMenuMutation) break;
  }
  if (sawMenuMutation) {
    processOpenContextMenus();
  }
  scheduleScan();
});

function attachObserver(): void {
  const target = document.body || document.documentElement;
  if (!target) return;
  observer.disconnect();
  observer.observe(target, { childList: true, subtree: true });
}

function teardown(): void {
  if (disposed) return;
  disposed = true;
  observer.disconnect();
  clearInterval(urlPollInterval);
  if (scanTimeoutId !== null) clearTimeout(scanTimeoutId);
  if (scanRafId !== null) cancelAnimationFrame(scanRafId);
  scanTimeoutId = null;
  scanRafId = null;

  try {
    chrome.runtime.onMessage.removeListener(onRuntimeMessage);
  } catch {
    // ignore if runtime already invalidated
  }
  win.navigation?.removeEventListener("navigatesuccess", onUrlMaybeChanged);
  window.removeEventListener("popstate", onUrlMaybeChanged);
  document.removeEventListener("visibilitychange", onVisibilityChange);
  document.removeEventListener("pointerdown", onCapturePointerOrClick, true);
  document.removeEventListener("mousedown", onCapturePointerOrClick, true);
  document.removeEventListener("contextmenu", onCapturePointerOrClick, true);
  document.removeEventListener("keydown", onCaptureKeydown, true);

  mountedButtons.clear();
  removeInjectedDom(true);
}

win.__amdlInjectCleanup = teardown;

// Hydrate initial job states from offscreen.
void sendRuntime<{ ok?: boolean; jobs?: JobSnapshot[] }>({
  type: "get-jobs",
}).then((resp) => {
  if (disposed) return;
  if (resp?.ok && Array.isArray(resp.jobs)) {
    for (const j of resp.jobs) {
      const key = buildUiJobKey(j.songId, j.playlistContext);
      if (!jobsByUiKey.has(key)) {
        jobsByUiKey.set(key, j);
      }
    }
    refreshAllButtonVisuals();
  }
});

ensureStylesheet();
attachObserver();
scheduleScan();
