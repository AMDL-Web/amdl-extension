import {
  type Collection,
  type Logger,
  type Song,
  firstNonEmpty,
  noopLogger,
} from "./types.ts";

const AMP_API_BASE = "https://amp-api.music.apple.com";
const WEB_PLAYBACK_URL =
  "https://play.music.apple.com/WebObjects/MZPlay.woa/wa/webPlayback";
const WEB_LICENSE_URL =
  "https://play.itunes.apple.com/WebObjects/MZPlay.woa/wa/acquireWebPlaybackLicense";
const WEB_AACLC_FLAVOR = "28:ctrp256";
const DEFAULT_LANGUAGE = "zh-Hans_CN";

const INDEX_JS_RE = /\/assets\/index~[^"']+\.js/;
const JWT_RE = /eyJ[A-Za-z0-9_\-=]+\.[A-Za-z0-9_\-=]+\.[A-Za-z0-9_\-=]+/;

export interface AppleTransport {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

export const defaultAppleTransport: AppleTransport = {
  fetch: (url, init) => globalThis.fetch(url, init),
};

export interface AppleApiOptions {
  transport?: AppleTransport;
  language?: string;
  logger?: Logger;
  /**
   * Optional provider returning fresh page tokens (e.g. from MusicKit on
   * music.apple.com). When it returns a non-empty `developerToken`, scraping
   * music.apple.com is skipped.
   */
  getDeveloperToken?: (forceRefresh: boolean) => Promise<string | null>;
  /**
   * Set Origin/Referer headers directly (works in Node CLI; in Chrome extension
   * offscreen documents DNR rewrites them instead).
   */
  sendOriginHeader?: boolean;
  requestTimeoutMs?: number;
}

export class AppleApiError extends Error {
  readonly statusCode: number;
  readonly path: string;
  readonly userTokenRejected: boolean;
  readonly notFound: boolean;
  readonly nonRetryable: boolean;

  constructor(
    message: string,
    opts: {
      statusCode: number;
      path?: string;
      userTokenRejected?: boolean;
      nonRetryable?: boolean;
    },
  ) {
    super(message);
    this.name = "AppleApiError";
    this.statusCode = opts.statusCode;
    this.path = opts.path ?? "";
    this.notFound = opts.statusCode === 404;
    this.userTokenRejected =
      opts.userTokenRejected ??
      (opts.statusCode === 401 || opts.statusCode === 403);
    this.nonRetryable =
      opts.nonRetryable ??
      (opts.statusCode >= 400 &&
        opts.statusCode < 500 &&
        opts.statusCode !== 408 &&
        opts.statusCode !== 429);
  }
}

export const ERR_NO_ENHANCED_HLS = new AppleApiError(
  "no enhanced hls manifest",
  { statusCode: 0, nonRetryable: true },
);

export const ERR_NO_LYRICS = new AppleApiError("Apple Music returned no lyrics", {
  statusCode: 0,
  nonRetryable: true,
});

export function isAppleNotFound(err: unknown): boolean {
  return err instanceof AppleApiError && err.notFound;
}

export function isUserTokenRejected(err: unknown): boolean {
  return err instanceof AppleApiError && err.userTokenRejected;
}

interface RawArtwork {
  url?: string;
}

interface RawArtistData {
  id: string;
  attributes?: {
    name?: string;
    url?: string;
    genreNames?: string[];
    artwork?: RawArtwork;
  };
}

interface RawAlbumData {
  id: string;
  type?: string;
  attributes?: {
    name?: string;
    artistName?: string;
    artistUrl?: string;
    genreNames?: string[];
    releaseDate?: string;
    trackCount?: number;
    copyright?: string;
    recordLabel?: string;
    upc?: string;
    artwork?: RawArtwork;
    contentRating?: string;
    isMasteredForItunes?: boolean;
    url?: string;
    audioTraits?: string[];
  };
  relationships?: {
    tracks?: RawSongList;
    artists?: { data?: RawArtistData[] };
  };
}

interface RawSongData {
  id: string;
  type?: string;
  attributes?: {
    name?: string;
    artistName?: string;
    albumName?: string;
    composerName?: string;
    genreNames?: string[];
    releaseDate?: string;
    trackNumber?: number;
    discNumber?: number;
    durationInMillis?: number;
    isrc?: string;
    contentRating?: string;
    isAppleDigitalMaster?: boolean;
    hasTimeSyncedLyrics?: boolean;
    hasLyrics?: boolean;
    artwork?: RawArtwork;
    extendedAssetUrls?: {
      enhancedHls?: string;
    };
    audioTraits?: string[];
    url?: string;
  };
  relationships?: {
    albums?: { data?: RawAlbumData[] };
    artists?: { data?: RawArtistData[] };
  };
}

interface RawSongList {
  data?: RawSongData[];
  next?: string;
}

function mapSong(raw: RawSongData): Song {
  const a = raw.attributes ?? {};
  const audioTraits = a.audioTraits ?? [];
  const song: Song = {
    id: raw.id,
    name: a.name ?? "",
    artistName: a.artistName ?? "",
    albumName: a.albumName ?? "",
    composerName: a.composerName ?? "",
    genreNames: a.genreNames ?? [],
    releaseDate: a.releaseDate ?? "",
    trackNumber: a.trackNumber ?? 0,
    discNumber: a.discNumber ?? 0,
    trackCount: 0,
    discCount: 0,
    durationInMillis: a.durationInMillis ?? 0,
    isrc: a.isrc ?? "",
    contentRating: a.contentRating ?? "",
    hasLyrics: Boolean(a.hasLyrics || a.hasTimeSyncedLyrics),
    appleDigitalMaster: Boolean(a.isAppleDigitalMaster),
    artworkUrl: a.artwork?.url ?? "",
    albumArtworkUrl: "",
    artistArtworkUrl: "",
    enhancedHls: a.extendedAssetUrls?.enhancedHls ?? "",
    albumId: "",
    albumArtist: "",
    albumArtistId: "",
    albumRelease: "",
    copyright: "",
    recordLabel: "",
    upc: "",
    artistId: "",
    artistUrl: "",
    hiResLossless: audioTraits.includes("hi-res-lossless"),
    audioTraits,
    url: a.url ?? "",
  };

  const album = raw.relationships?.albums?.data?.[0];
  if (album) {
    const aa = album.attributes ?? {};
    song.albumId = album.id;
    song.albumArtist = aa.artistName ?? "";
    song.albumRelease = aa.releaseDate ?? "";
    song.albumArtworkUrl = aa.artwork?.url ?? "";
    song.copyright = aa.copyright ?? "";
    song.recordLabel = aa.recordLabel ?? "";
    song.upc = aa.upc ?? "";
    song.trackCount = aa.trackCount ?? 0;
  }

  const artist = raw.relationships?.artists?.data?.[0];
  if (artist) {
    const ara = artist.attributes ?? {};
    song.artistId = artist.id;
    song.artistArtworkUrl = ara.artwork?.url ?? "";
    song.artistUrl = ara.url ?? "";
  }
  return song;
}

function discTrackTotals(tracks: readonly Song[]): Map<number, number> {
  const totals = new Map<number, number>();
  const counts = new Map<number, number>();
  for (const track of tracks) {
    const disc = Math.max(1, track.discNumber);
    counts.set(disc, (counts.get(disc) ?? 0) + 1);
    totals.set(disc, Math.max(totals.get(disc) ?? 0, track.trackNumber));
  }
  for (const [disc, count] of counts) {
    totals.set(disc, Math.max(totals.get(disc) ?? 0, count));
  }
  return totals;
}

function maxDisc(tracks: readonly Song[]): number {
  let highest = 1;
  for (const t of tracks) {
    if (t.discNumber > highest) highest = t.discNumber;
  }
  return highest;
}

export function discTrackCount(tracks: readonly Song[], discNumber: number): number {
  const totals = discTrackTotals(tracks);
  if (maxDisc(tracks) <= 1) {
    return Math.max(totals.get(1) ?? 0, tracks.length);
  }
  return totals.get(Math.max(1, discNumber)) ?? tracks.length;
}

export function enrichWithAlbum(song: Song, album: Collection): Song {
  const out: Song = { ...song };
  out.albumArtworkUrl = album.artworkUrl;
  out.albumArtistId = album.artistId;
  for (const track of album.tracks) {
    if (track.id === song.id) {
      out.trackCount = track.trackCount;
      out.discCount = track.discCount;
      break;
    }
  }
  if (out.trackCount === 0) {
    out.trackCount = discTrackCount(album.tracks, out.discNumber);
  }
  if (out.discCount === 0) {
    out.discCount = maxDisc(album.tracks);
  }
  out.albumArtist = album.artist;
  if (!out.artistUrl) {
    out.artistUrl = album.artistUrl;
  }
  return out;
}

function coverSizeFallbacks(preferred: string): string[] {
  const defaults = ["5000x5000", "3000x3000", "1400x1400", "600x600", "300x300"];
  if (!preferred) return defaults;
  return [preferred, ...defaults.filter((s) => s !== preferred)];
}

export function formatArtworkUrl(
  artworkUrl: string,
  format: string,
  size: string,
): string {
  let u = artworkUrl;
  if (format && format !== "jpg" && u.includes("bb.jpg")) {
    u = u.replace("bb.jpg", `bb.${format}`);
  }
  u = u.replaceAll("{w}x{h}", size).replaceAll("{f}", format);
  return u;
}

function parseFailureType(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  const s = String(raw).trim();
  return s === "null" ? "" : s;
}

export class AppleApi {
  private readonly transport: AppleTransport;
  private readonly defaultLanguage: string;
  private readonly logger: Logger;
  private readonly getDeveloperToken?: (
    forceRefresh: boolean,
  ) => Promise<string | null>;
  private readonly sendOriginHeader: boolean;
  private readonly requestTimeoutMs: number;

  private cachedWebToken: { token: string; expiresAt: number } | null = null;
  private webTokenInFlight: Promise<string> | null = null;
  private accountStorefrontCache = new Map<string, string>();

  constructor(opts: AppleApiOptions = {}) {
    this.transport = opts.transport ?? defaultAppleTransport;
    this.defaultLanguage = opts.language || DEFAULT_LANGUAGE;
    this.logger = opts.logger ?? noopLogger;
    this.getDeveloperToken = opts.getDeveloperToken;
    this.sendOriginHeader = opts.sendOriginHeader ?? false;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
  }

  /**
   * Seed a known developer token in memory (e.g. captured from MusicKit).
   * Never persisted to disk or storage.
   */
  setDeveloperToken(token: string, ttlMs = 12 * 3600 * 1000): void {
    if (token.trim()) {
      this.cachedWebToken = { token: token.trim(), expiresAt: Date.now() + ttlMs };
    }
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        throw new DOMException("Aborted", "AbortError");
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      return await this.transport.fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async scrapeWebToken(signal?: AbortSignal): Promise<string> {
    const pageResp = await this.fetchWithTimeout(
      "https://music.apple.com",
      { method: "GET" },
      signal,
    );
    if (!pageResp.ok) {
      throw new AppleApiError(
        `fetch Apple Music web player failed: ${pageResp.status}`,
        { statusCode: pageResp.status, path: "/" },
      );
    }
    const html = await pageResp.text();
    const jsMatch = html.match(INDEX_JS_RE);
    if (!jsMatch) {
      throw new Error("cannot find Apple Music index js");
    }
    const jsResp = await this.fetchWithTimeout(
      `https://music.apple.com${jsMatch[0]}`,
      { method: "GET" },
      signal,
    );
    if (!jsResp.ok) {
      throw new AppleApiError(
        `fetch Apple Music web player script failed: ${jsResp.status}`,
        { statusCode: jsResp.status, path: jsMatch[0] },
      );
    }
    const jsBody = await jsResp.text();
    const tokenMatch = jsBody.match(JWT_RE);
    if (!tokenMatch) {
      throw new Error("cannot find Apple Music authorization token");
    }
    return tokenMatch[0];
  }

  private async resolveWebToken(
    forceRefresh: boolean,
    signal?: AbortSignal,
  ): Promise<string> {
    if (
      !forceRefresh &&
      this.cachedWebToken &&
      Date.now() < this.cachedWebToken.expiresAt
    ) {
      return this.cachedWebToken.token;
    }
    if (this.webTokenInFlight && !forceRefresh) {
      return this.webTokenInFlight;
    }
    const p = (async () => {
      if (this.getDeveloperToken) {
        try {
          const supplied = await this.getDeveloperToken(forceRefresh);
          if (supplied && supplied.trim()) {
            this.cachedWebToken = {
              token: supplied.trim(),
              expiresAt: Date.now() + 12 * 3600 * 1000,
            };
            return this.cachedWebToken.token;
          }
        } catch (err) {
          this.logger.warn("developer token provider failed; falling back to scrape", {
            error: String(err),
          });
        }
      }
      const scraped = await this.scrapeWebToken(signal);
      this.cachedWebToken = {
        token: scraped,
        expiresAt: Date.now() + 12 * 3600 * 1000,
      };
      return scraped;
    })();
    this.webTokenInFlight = p;
    try {
      return await p;
    } finally {
      if (this.webTokenInFlight === p) {
        this.webTokenInFlight = null;
      }
    }
  }

  private async doWithWebAuth(
    opts: {
      method: "GET" | "POST";
      url: string;
      body?: string;
      mediaUserToken?: string;
      userTokenHeader?: string;
    },
    signal?: AbortSignal,
  ): Promise<Response> {
    const send = async (jwt: string) => {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${jwt}`,
      };
      if (opts.body !== undefined) {
        headers["Content-Type"] = "application/json";
      }
      if (opts.mediaUserToken) {
        headers[opts.userTokenHeader || "Media-User-Token"] =
          opts.mediaUserToken;
      }
      if (this.sendOriginHeader) {
        headers["Origin"] = "https://music.apple.com";
        headers["Referer"] = "https://music.apple.com/";
      }
      return this.fetchWithTimeout(
        opts.url,
        {
          method: opts.method,
          headers,
          body: opts.body,
        },
        signal,
      );
    };

    const token = await this.resolveWebToken(false, signal);
    let resp = await send(token);
    if (resp.status === 401) {
      await resp.arrayBuffer().catch(() => {});
      if (this.cachedWebToken?.token === token) {
        this.cachedWebToken = null;
      }
      const fresh = await this.resolveWebToken(true, signal);
      resp = await send(fresh);
    }
    return resp;
  }

  private async decodeJson<T>(resp: Response, url: string): Promise<T> {
    if (!resp.ok) {
      let path = "";
      try {
        path = new URL(url).pathname;
      } catch {
        // ignore
      }
      await resp.text().catch(() => "");
      throw new AppleApiError(
        `Apple Music request ${path || url} failed: ${resp.status} ${resp.statusText}`.trim(),
        { statusCode: resp.status, path },
      );
    }
    return (await resp.json()) as T;
  }

  async songMetadata(
    storefront: string,
    id: string,
    language?: string,
    signal?: AbortSignal,
  ): Promise<Song> {
    const params = new URLSearchParams({
      include: "albums,artists",
      extend: "extendedAssetUrls",
      l: language || this.defaultLanguage,
    });
    const url = `${AMP_API_BASE}/v1/catalog/${storefront}/songs/${id}?${params.toString()}`;
    const resp = await this.doWithWebAuth({ method: "GET", url }, signal);
    const body = await this.decodeJson<{ data?: RawSongData[] }>(resp, url);
    const first = body.data?.[0];
    if (!first) {
      throw new AppleApiError(`song ${id} not found`, {
        statusCode: 404,
        path: `/v1/catalog/${storefront}/songs/${id}`,
      });
    }
    return mapSong(first);
  }

  private catalogNextUrl(next: string): string {
    if (next.startsWith("http://") || next.startsWith("https://")) return next;
    return next.startsWith("/") ? `${AMP_API_BASE}${next}` : `${AMP_API_BASE}/${next}`;
  }

  private async allTrackPages(
    first: RawSongList | undefined,
    signal?: AbortSignal,
  ): Promise<RawSongData[]> {
    const tracks: RawSongData[] = [...(first?.data ?? [])];
    let next = (first?.next ?? "").trim();
    while (next) {
      const url = this.catalogNextUrl(next);
      const resp = await this.doWithWebAuth({ method: "GET", url }, signal);
      const page = await this.decodeJson<RawSongList>(resp, url);
      tracks.push(...(page.data ?? []));
      next = (page.next ?? "").trim();
    }
    return tracks;
  }

  async album(
    storefront: string,
    id: string,
    language?: string,
    signal?: AbortSignal,
  ): Promise<Collection> {
    const params = new URLSearchParams({
      include: "tracks,artists,record-labels",
      "include[songs]": "artists",
      extend: "artistUrl",
      l: language || this.defaultLanguage,
    });
    const url = `${AMP_API_BASE}/v1/catalog/${storefront}/albums/${id}?${params.toString()}`;
    const resp = await this.doWithWebAuth({ method: "GET", url }, signal);
    const body = await this.decodeJson<{ data?: RawAlbumData[] }>(resp, url);
    const album = body.data?.[0];
    if (!album) {
      throw new AppleApiError(`album ${id} not found`, {
        statusCode: 404,
        path: `/v1/catalog/${storefront}/albums/${id}`,
      });
    }
    const rawTracks = await this.allTrackPages(album.relationships?.tracks, signal);
    const aa = album.attributes ?? {};
    const albumArtist = album.relationships?.artists?.data?.[0];
    const albumArtistId = albumArtist?.id ?? "";
    const albumArtistArtworkUrl = albumArtist?.attributes?.artwork?.url ?? "";
    const albumArtistUrl = firstNonEmpty(
      albumArtist?.attributes?.url,
      aa.artistUrl,
    );

    const tracks: Song[] = [];
    let discCount = 0;
    for (const raw of rawTracks) {
      if (raw.type !== "songs") continue;
      const s = mapSong(raw);
      s.albumId = album.id;
      s.albumName = firstNonEmpty(s.albumName, aa.name);
      s.albumArtist = aa.artistName ?? "";
      s.albumArtistId = albumArtistId;
      s.albumRelease = aa.releaseDate ?? "";
      s.copyright = aa.copyright ?? "";
      s.recordLabel = aa.recordLabel ?? "";
      s.upc = aa.upc ?? "";
      s.trackCount = aa.trackCount ?? 0;
      if (s.discNumber > discCount) discCount = s.discNumber;
      tracks.push(s);
    }
    if (discCount > 0) {
      for (const t of tracks) t.discCount = discCount;
    }
    if (discCount > 1) {
      const perDisc = discTrackTotals(tracks);
      for (const t of tracks) {
        const total = perDisc.get(Math.max(1, t.discNumber));
        if (total && total > 0) t.trackCount = total;
      }
    }

    return {
      id: album.id,
      type: "album",
      name: aa.name ?? "",
      artist: aa.artistName ?? "",
      artworkUrl: aa.artwork?.url ?? "",
      artistId: albumArtistId,
      artistArtworkUrl: albumArtistArtworkUrl,
      artistUrl: albumArtistUrl,
      releaseDate: aa.releaseDate ?? "",
      genreNames: aa.genreNames ?? [],
      contentRating: aa.contentRating ?? "",
      appleDigitalMaster: Boolean(aa.isMasteredForItunes),
      url: aa.url ?? "",
      trackCount: aa.trackCount ?? tracks.length,
      audioTraits: aa.audioTraits ?? [],
      tracks,
    };
  }

  async fetchCover(
    artworkUrls: readonly string[],
    format = "jpg",
    size = "5000x5000",
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const fmt = format || "jpg";
    let lastErr: unknown = null;
    for (const artworkUrl of artworkUrls) {
      if (!artworkUrl) continue;
      for (const coverSize of coverSizeFallbacks(size)) {
        const u = formatArtworkUrl(artworkUrl, fmt, coverSize);
        try {
          const resp = await this.fetchWithTimeout(
            u,
            { method: "GET" },
            signal,
          );
          if (resp.ok) {
            const bytes = new Uint8Array(await resp.arrayBuffer());
            if (bytes.length > 0) return bytes;
          }
          lastErr = new Error(`cover request failed: ${resp.status}`);
        } catch (err) {
          if (signal?.aborted) throw err;
          lastErr = err;
        }
      }
    }
    if (lastErr instanceof Error) throw lastErr;
    throw new Error("no artwork url available");
  }

  async accountStorefront(
    mediaUserToken: string,
    signal?: AbortSignal,
  ): Promise<string> {
    // Key by SHA-256 so raw token is not stored as map key if inspected.
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(mediaUserToken),
    );
    const cacheKey = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const cached = this.accountStorefrontCache.get(cacheKey);
    if (cached) return cached;

    const url = `${AMP_API_BASE}/v1/me/storefront`;
    const resp = await this.doWithWebAuth(
      { method: "GET", url, mediaUserToken },
      signal,
    );
    const out = await this.decodeJson<{ data?: { id?: string }[] }>(resp, url);
    const sf = out.data?.[0]?.id ?? "";
    if (!sf) {
      throw new Error("read the account storefront: Apple named none");
    }
    this.accountStorefrontCache.set(cacheKey, sf);
    return sf;
  }

  async songLyrics(
    mediaUserToken: string,
    storefront: string,
    id: string,
    language?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const params = new URLSearchParams({
      "l[lyrics]": language || "en",
      extend: "ttmlLocalizations",
      "l[script]": "en-Latn",
    });
    const url = `${AMP_API_BASE}/v1/catalog/${storefront}/songs/${id}/syllable-lyrics?${params.toString()}`;
    const resp = await this.doWithWebAuth(
      { method: "GET", url, mediaUserToken },
      signal,
    );
    const out = await this.decodeJson<{
      data?: {
        attributes?: { ttmlLocalizations?: string; text?: string };
      }[];
    }>(resp, url);
    const attrs = out.data?.[0]?.attributes;
    if (attrs?.ttmlLocalizations) return attrs.ttmlLocalizations;
    if (attrs?.text) return attrs.text;
    throw ERR_NO_LYRICS;
  }

  async webPlayback(
    mediaUserToken: string,
    adamId: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const resp = await this.doWithWebAuth(
      {
        method: "POST",
        url: WEB_PLAYBACK_URL,
        body: JSON.stringify({ salableAdamId: adamId }),
        mediaUserToken,
        userTokenHeader: "X-Apple-Music-User-Token",
      },
      signal,
    );
    const out = await this.decodeJson<{
      failureType?: unknown;
      songList?: {
        "hls-playlist-url"?: string;
        assets?: { flavor?: string; URL?: string }[];
      }[];
    }>(resp, WEB_PLAYBACK_URL);
    const failure = parseFailureType(out.failureType);
    if (failure) {
      throw new AppleApiError(
        `Apple Music webPlayback refused the media-user-token (failureType ${failure})`,
        { statusCode: 200, userTokenRejected: true, nonRetryable: true },
      );
    }
    const song = out.songList?.[0];
    if (!song) {
      throw new AppleApiError("Apple Music webPlayback returned no AAC-LC asset", {
        statusCode: 200,
        nonRetryable: true,
      });
    }
    if (song["hls-playlist-url"]) return song["hls-playlist-url"];
    for (const asset of song.assets ?? []) {
      if (asset.flavor === WEB_AACLC_FLAVOR && asset.URL) {
        return asset.URL;
      }
    }
    throw new AppleApiError("Apple Music webPlayback returned no AAC-LC asset", {
      statusCode: 200,
      nonRetryable: true,
    });
  }

  async license(
    mediaUserToken: string,
    adamId: string,
    challengeBase64: string,
    keyUri: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const resp = await this.doWithWebAuth(
      {
        method: "POST",
        url: WEB_LICENSE_URL,
        body: JSON.stringify({
          challenge: challengeBase64,
          uri: keyUri,
          "key-system": "com.widevine.alpha",
          adamId,
          isLibrary: false,
          "user-initiated": true,
        }),
        mediaUserToken,
        userTokenHeader: "X-Apple-Music-User-Token",
      },
      signal,
    );
    const out = await this.decodeJson<{
      failureType?: unknown;
      status?: number;
      license?: string;
    }>(resp, WEB_LICENSE_URL);
    const failure = parseFailureType(out.failureType);
    if (failure) {
      throw new AppleApiError(
        `Apple Music acquireWebPlaybackLicense refused the media-user-token (failureType ${failure})`,
        { statusCode: 200, userTokenRejected: true, nonRetryable: true },
      );
    }
    if (!out.license) {
      throw new Error(
        `acquireWebPlaybackLicense: no license in answer (status ${out.status ?? 0})`,
      );
    }
    return out.license;
  }
}
