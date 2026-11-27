export interface UiStrings {
  download: string;
  downloadTrack: string;
  downloadAlbum: string;
  downloadPlaylist: string;
  downloading: string;
  downloaded: string;
  albumDownloaded: string;
  playlistDownloaded: string;
  failed: string;
  retry: string;
  unavailable: string;
  skippedUnavailable: (count: number) => string;
  queueing: string;
}

const EN: UiStrings = {
  download: "Download",
  downloadTrack: "Download track",
  downloadAlbum: "Download album",
  downloadPlaylist: "Download playlist",
  downloading: "Downloading",
  downloaded: "Downloaded",
  albumDownloaded: "Album downloaded",
  playlistDownloaded: "Playlist downloaded",
  failed: "Download failed",
  retry: "Retry download",
  unavailable: "Not available in the Apple Music catalog",
  skippedUnavailable: (n) =>
    `${n} track${n === 1 ? "" : "s"} skipped: not available in the Apple Music catalog`,
  queueing: "Queueing…",
};

const ZH_HANS: UiStrings = {
  download: "下载",
  downloadTrack: "下载歌曲",
  downloadAlbum: "下载专辑",
  downloadPlaylist: "下载播放列表",
  downloading: "正在下载",
  downloaded: "已下载",
  albumDownloaded: "专辑已下载",
  playlistDownloaded: "播放列表已下载",
  failed: "下载失败",
  retry: "重试下载",
  unavailable: "Apple Music 目录中不可用",
  skippedUnavailable: (n) => `已跳过 ${n} 首歌曲：Apple Music 目录中不可用`,
  queueing: "正在加入队列…",
};

const ZH_HANT: UiStrings = {
  download: "下載",
  downloadTrack: "下載歌曲",
  downloadAlbum: "下載專輯",
  downloadPlaylist: "下載播放列表",
  downloading: "正在下載",
  downloaded: "已下載",
  albumDownloaded: "專輯已下載",
  playlistDownloaded: "播放列表已下載",
  failed: "下載失敗",
  retry: "重試下載",
  unavailable: "Apple Music 目錄中未提供",
  skippedUnavailable: (n) => `已略過 ${n} 首歌曲：Apple Music 目錄中未提供`,
  queueing: "正在加入佇列…",
};

const JA: UiStrings = {
  download: "ダウンロード",
  downloadTrack: "曲をダウンロード",
  downloadAlbum: "アルバムをダウンロード",
  downloadPlaylist: "プレイリストをダウンロード",
  downloading: "ダウンロード中",
  downloaded: "ダウンロード済み",
  albumDownloaded: "アルバムをダウンロード済み",
  playlistDownloaded: "プレイリストをダウンロード済み",
  failed: "ダウンロード失敗",
  retry: "再試行",
  unavailable: "Apple Musicカタログでは利用できません",
  skippedUnavailable: (n) =>
    `${n}曲をスキップしました（Apple Musicカタログでは利用できません）`,
  queueing: "キューに追加中…",
};

export function getUiStrings(lang?: string): UiStrings {
  const raw = (
    lang ||
    (typeof document !== "undefined" ? document.documentElement?.lang : "") ||
    (typeof navigator !== "undefined" ? navigator.language : "") ||
    "en"
  )
    .trim()
    .toLowerCase();

  if (raw.startsWith("zh")) {
    if (
      raw.includes("hant") ||
      raw.includes("-tw") ||
      raw.includes("_tw") ||
      raw.includes("-hk") ||
      raw.includes("_hk") ||
      raw.includes("-mo") ||
      raw.includes("_mo")
    ) {
      return ZH_HANT;
    }
    return ZH_HANS;
  }
  if (raw.startsWith("ja")) {
    return JA;
  }
  return EN;
}
