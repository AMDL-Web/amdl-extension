import { formatDownloadPath } from "../core/naming.ts";
import type {
  Codec,
  CoverFormat,
  LyricsExtra,
  LyricsTiming,
} from "../core/types.ts";
import { normalizeWrapperAddress } from "../core/wrapper-client.ts";
import { applyI18n, t } from "../shared/i18n.ts";
import type { TestWrapperResponse } from "../shared/messages.ts";
import {
  DEFAULT_SETTINGS,
  type ExtensionSettings,
  loadSettings,
  saveSettings,
  wrapperOriginPattern,
} from "../shared/settings.ts";

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const form = $<HTMLFormElement>("settings-form");
const wrapperUrlEl = $<HTMLInputElement>("wrapper-url");
const wrapperTokenEl = $<HTMLInputElement>("wrapper-token");
const toggleTokenBtn = $<HTMLButtonElement>("toggle-token");
const testWrapperBtn = $<HTMLButtonElement>("test-wrapper");
const wrapperStatusEl = $<HTMLParagraphElement>("wrapper-status");
const codecEl = $<HTMLSelectElement>("codec");
const codecHintEl = $<HTMLParagraphElement>("codec-hint");
const languageEl = $<HTMLInputElement>("language");
const maxRateEl = $<HTMLSelectElement>("max-sample-rate");
const maxDepthEl = $<HTMLSelectElement>("max-bit-depth");
const fallbackEl = $<HTMLInputElement>("fallback");
const embedLyricsEl = $<HTMLInputElement>("embed-lyrics");
const lyricsTimingEl = $<HTMLSelectElement>("lyrics-timing");
const lyricsTransEl = $<HTMLInputElement>("lyrics-translation");
const lyricsPronEl = $<HTMLInputElement>("lyrics-pronunciation");
const embedCoverEl = $<HTMLInputElement>("embed-cover");
const coverSizeEl = $<HTMLSelectElement>("cover-size");
const coverFormatEl = $<HTMLSelectElement>("cover-format");
const filenameTemplateEl = $<HTMLInputElement>("filename-template");
const templatePreviewEl = $<HTMLParagraphElement>("template-preview");
const playlistFilenameTemplateEl = $<HTMLInputElement>(
  "playlist-filename-template",
);
const playlistTemplatePreviewEl = $<HTMLParagraphElement>(
  "playlist-template-preview",
);
const concurrencyEl = $<HTMLInputElement>("concurrency");
const saveAsEl = $<HTMLInputElement>("save-as");
const resetBtn = $<HTMLButtonElement>("reset-btn");
const saveToastEl = $<HTMLSpanElement>("save-toast");

function syncDisabledStates(): void {
  const hasWrapper = wrapperUrlEl.value.trim() !== "";
  codecEl.disabled = !hasWrapper;
  maxRateEl.disabled = !hasWrapper || codecEl.value !== "alac";
  maxDepthEl.disabled = !hasWrapper || codecEl.value !== "alac";
  fallbackEl.disabled = !hasWrapper;
  codecHintEl.textContent = hasWrapper
    ? t("optCodecHintWrapper")
    : t("optCodecHintNoWrapper");

  lyricsTimingEl.disabled = !embedLyricsEl.checked;
  lyricsTransEl.disabled = !embedLyricsEl.checked;
  lyricsPronEl.disabled = !embedLyricsEl.checked;
  coverSizeEl.disabled = !embedCoverEl.checked;
  coverFormatEl.disabled = !embedCoverEl.checked;
}

function updateTemplatePreview(): void {
  const effectiveCodec = wrapperUrlEl.value.trim() ? codecEl.value : "aac-lc";
  const preview = formatDownloadPath(filenameTemplateEl.value, {
    albumArtist: "ReoNa",
    artist: "ReoNa",
    album: "月姫 -A piece of blue glass moon- THEME SONG E.P.",
    title: "生命線",
    songNumber: 1,
    trackNumber: 1,
    discNumber: 1,
    codec: effectiveCodec,
  });
  templatePreviewEl.textContent = t("optPreview", preview);

  const playlistPreview = formatDownloadPath(playlistFilenameTemplateEl.value, {
    albumArtist: "ReoNa",
    artist: "ReoNa",
    album: "月姫 -A piece of blue glass moon- THEME SONG E.P.",
    title: "生命線",
    songNumber: 1,
    trackNumber: 1,
    discNumber: 1,
    codec: effectiveCodec,
    playlistName: "Favourite Songs",
    playlistIndex: 3,
  });
  playlistTemplatePreviewEl.textContent = t("optPreview", playlistPreview);
}

function populateForm(s: ExtensionSettings): void {
  wrapperUrlEl.value = s.wrapperUrl;
  wrapperTokenEl.value = s.wrapperToken;
  codecEl.value = s.codec;
  languageEl.value = s.language;
  maxRateEl.value = String(s.maxSampleRate);
  maxDepthEl.value = String(s.maxBitDepth);
  fallbackEl.checked = s.fallbackOnCodecNotFound;
  embedLyricsEl.checked = s.embedLyrics;
  lyricsTimingEl.value = s.lyricsTiming;
  lyricsTransEl.checked = s.lyricsExtras.includes("translation");
  lyricsPronEl.checked = s.lyricsExtras.includes("pronunciation");
  embedCoverEl.checked = s.embedCover;
  coverSizeEl.value = s.coverSize;
  coverFormatEl.value = s.coverFormat;
  filenameTemplateEl.value = s.filenameTemplate;
  playlistFilenameTemplateEl.value = s.playlistFilenameTemplate;
  concurrencyEl.value = String(s.concurrency);
  saveAsEl.checked = s.saveAs;
  syncDisabledStates();
  updateTemplatePreview();
}

function readForm(): ExtensionSettings {
  const extras: LyricsExtra[] = [];
  if (lyricsTransEl.checked) extras.push("translation");
  if (lyricsPronEl.checked) extras.push("pronunciation");
  const rawUrl = wrapperUrlEl.value.trim();
  return {
    schemaVersion: 1,
    wrapperUrl: rawUrl ? normalizeWrapperAddress(rawUrl) : "",
    wrapperToken: wrapperTokenEl.value.trim(),
    codec: codecEl.value as Codec,
    maxSampleRate: Number.parseInt(maxRateEl.value, 10) || 192000,
    maxBitDepth: Number.parseInt(maxDepthEl.value, 10) || 24,
    fallbackOnCodecNotFound: fallbackEl.checked,
    embedLyrics: embedLyricsEl.checked,
    lyricsTiming: lyricsTimingEl.value as LyricsTiming,
    lyricsExtras: extras,
    embedCover: embedCoverEl.checked,
    coverSize: coverSizeEl.value,
    coverFormat: coverFormatEl.value as CoverFormat,
    filenameTemplate: filenameTemplateEl.value.trim(),
    playlistFilenameTemplate: playlistFilenameTemplateEl.value.trim(),
    concurrency: Number.parseInt(concurrencyEl.value, 10) || 2,
    saveAs: saveAsEl.checked,
    language: languageEl.value.trim(),
  };
}

async function ensureWrapperOriginPermission(
  address: string,
): Promise<{ granted: boolean; pattern: string | null }> {
  const pattern = wrapperOriginPattern(address);
  if (!pattern) return { granted: false, pattern: null };
  const already = await chrome.permissions.contains({ origins: [pattern] });
  if (already) return { granted: true, pattern };
  const granted = await chrome.permissions.request({ origins: [pattern] });
  return { granted, pattern };
}

function showToast(msg: string, isErr = false): void {
  saveToastEl.textContent = msg;
  saveToastEl.className = isErr ? "toast err" : "toast";
  setTimeout(() => {
    if (saveToastEl.textContent === msg) saveToastEl.textContent = "";
  }, 3500);
}

toggleTokenBtn.addEventListener("click", () => {
  const masked = wrapperTokenEl.type === "password";
  wrapperTokenEl.type = masked ? "text" : "password";
  toggleTokenBtn.textContent = masked ? t("optHide") : t("optShow");
});

testWrapperBtn.addEventListener("click", () => {
  void (async () => {
    const raw = wrapperUrlEl.value.trim();
    if (!raw) {
      wrapperStatusEl.textContent = t("optEnterUrlFirst");
      wrapperStatusEl.className = "hint err";
      return;
    }
    const normalized = normalizeWrapperAddress(raw);
    wrapperUrlEl.value = normalized;

    wrapperStatusEl.textContent = t("optRequestingPermission");
    wrapperStatusEl.className = "hint";

    const perm = await ensureWrapperOriginPermission(normalized);
    if (!perm.pattern) {
      wrapperStatusEl.textContent = t("optInvalidUrl");
      wrapperStatusEl.className = "hint err";
      return;
    }
    if (!perm.granted) {
      wrapperStatusEl.textContent = t("optPermissionDenied", perm.pattern);
      wrapperStatusEl.className = "hint err";
      return;
    }

    wrapperStatusEl.textContent = t("optConnecting", normalized);
    const res = (await chrome.runtime.sendMessage({
      type: "test-wrapper",
      address: normalized,
      token: wrapperTokenEl.value.trim(),
    })) as TestWrapperResponse;

    if (res?.ok && res.status) {
      const regions = res.status.regions.length
        ? res.status.regions.join(", ")
        : t("optNone");
      wrapperStatusEl.textContent = t(
        "optConnected",
        res.status.ready ? t("optReady") : t("optNotReady"),
        regions,
      );
      wrapperStatusEl.className = res.status.ready ? "hint ok" : "hint err";
    } else {
      wrapperStatusEl.textContent = t("optConnectionFailed", res?.error || t("optUnknownError"));
      wrapperStatusEl.className = "hint err";
    }
  })();
});

form.addEventListener("submit", (ev) => {
  ev.preventDefault();
  void (async () => {
    const settings = readForm();
    if (settings.wrapperUrl) {
      const perm = await ensureWrapperOriginPermission(settings.wrapperUrl);
      if (!perm.pattern) {
        showToast(t("optInvalidUrl"), true);
        return;
      }
      if (!perm.granted) {
        showToast(t("optPermissionDenied", perm.pattern), true);
        return;
      }
    }
    const saved = await saveSettings(settings);
    populateForm(saved);
    await chrome.runtime
      .sendMessage({ type: "settings-updated", settings: saved })
      .catch(() => {});
    showToast(t("optSaved"));
  })();
});

resetBtn.addEventListener("click", () => {
  void (async () => {
    const saved = await saveSettings(DEFAULT_SETTINGS);
    populateForm(saved);
    await chrome.runtime
      .sendMessage({ type: "settings-updated", settings: saved })
      .catch(() => {});
    showToast(t("optDefaultsRestored"));
  })();
});

for (const el of [
  wrapperUrlEl,
  codecEl,
  embedLyricsEl,
  embedCoverEl,
  filenameTemplateEl,
  playlistFilenameTemplateEl,
]) {
  el.addEventListener("input", () => {
    syncDisabledStates();
    updateTemplatePreview();
  });
  el.addEventListener("change", () => {
    syncDisabledStates();
    updateTemplatePreview();
  });
}

applyI18n();
void loadSettings().then(populateForm);
