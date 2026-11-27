export type AppleUrlType =
  | "song"
  | "album"
  | "playlist"
  | "library-album"
  | "library-playlist"
  | "artist"
  | "music-video"
  | "station";

export interface ParsedAppleUrl {
  raw: string;
  /** Empty string for library URLs (whose path prefix is not the account storefront). */
  storefront: string;
  type: AppleUrlType;
  id: string;
  trackId?: string;
}

const STOREFRONT_RE = /^[a-z]{2}$/;
const DIGITS_RE = /^\d+$/;
const SUPPORTED_HOSTS = new Set([
  "music.apple.com",
  "beta.music.apple.com",
  "classical.music.apple.com",
]);
const LINK_SHAPE =
  "expected https://music.apple.com/{storefront}/{album|song|playlist|artist|station|music-video}/... or /library/{albums|playlist}/...";

function parseLibrarySubPath(
  raw: string,
  subKind: string | undefined,
  tailParts: string[],
): ParsedAppleUrl {
  const id = decodeURIComponent(tailParts[tailParts.length - 1] ?? "").trim();
  if (!id) {
    throw new Error("invalid Apple Music library URL");
  }
  switch (subKind) {
    case "albums":
    case "album":
      return { raw, storefront: "", type: "library-album", id };
    case "playlist":
    case "playlists":
      return { raw, storefront: "", type: "library-playlist", id };
    default:
      throw new Error(
        `unsupported Apple Music library URL type "${String(subKind ?? "")}"`,
      );
  }
}

export function parseAppleMusicUrl(
  raw: string,
  albumTrackUrlMode: "song" | "album" = "song",
): ParsedAppleUrl {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`not an http(s) URL; ${LINK_SHAPE}`);
  }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || !u.host) {
    throw new Error(`not an http(s) URL; ${LINK_SHAPE}`);
  }
  if (!SUPPORTED_HOSTS.has(u.hostname)) {
    throw new Error(`unsupported host "${u.hostname}"; ${LINK_SHAPE}`);
  }
  const parts = u.pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  if (parts.length < 3) {
    throw new Error("invalid Apple Music URL");
  }

  // Library URLs without storefront prefix: /library/albums/l.xxx, /library/playlist/p.xxx
  if (parts[0] === "library") {
    return parseLibrarySubPath(raw, parts[1], parts.slice(2));
  }

  const storefront = (parts[0] ?? "").toLowerCase();
  if (!STOREFRONT_RE.test(storefront)) {
    throw new Error(`invalid storefront "${storefront}"`);
  }

  // Library URLs with storefront redirect prefix: /{sf}/library/albums/l.xxx, /{sf}/library/playlist/p.xxx
  // Note: the storefront prefix on library URLs is NOT authoritative for the user's account storefront.
  if (parts[1] === "library") {
    if (parts.length < 4) {
      throw new Error("invalid Apple Music library URL");
    }
    return parseLibrarySubPath(raw, parts[2], parts.slice(3));
  }

  const kind = parts[1] as AppleUrlType;
  if (
    u.hostname === "classical.music.apple.com" &&
    (kind === "music-video" || kind === "station")
  ) {
    throw new Error(`unsupported Apple Music Classical URL type "${kind}"`);
  }
  const id = decodeURIComponent(parts[parts.length - 1] ?? "").trim();
  if (!id) {
    throw new Error("invalid Apple Music URL");
  }
  switch (kind) {
    case "album": {
      const songId = (u.searchParams.get("i") ?? "").trim();
      if (songId && albumTrackUrlMode === "song") {
        return {
          raw,
          storefront,
          type: "song",
          id: songId,
          trackId: songId,
        };
      }
      return {
        raw,
        storefront,
        type: "album",
        id,
        ...(songId ? { trackId: songId } : {}),
      };
    }
    case "song":
    case "playlist":
    case "artist":
    case "station":
    case "music-video":
      return { raw, storefront, type: kind, id };
    default:
      throw new Error(`unsupported Apple Music URL type "${String(kind)}"`);
  }
}

/**
 * Extracts a catalog song ID and storefront from an anchor href (either
 * `/song/<slug>/<id>` or `/album/<slug>/<albumId>?i=<songId>`), ignoring extra
 * query parameters such as `?l=en-GB`.
 */
export function extractSongRefFromHref(
  href: string,
  baseOrigin = "https://music.apple.com",
): { songId: string; storefront: string } | null {
  try {
    const resolved = new URL(href, baseOrigin);
    // Parse `/song/.../<id>` first (query params like ?l=en-GB are ignored by pathname parsing).
    const parsed = parseAppleMusicUrl(resolved.href, "song");
    if (parsed.type === "song" && DIGITS_RE.test(parsed.id)) {
      return { songId: parsed.id, storefront: parsed.storefront };
    }
  } catch {
    // fall through
  }
  try {
    const resolved = new URL(href, baseOrigin);
    const iParam = (resolved.searchParams.get("i") ?? "").trim();
    if (iParam && DIGITS_RE.test(iParam)) {
      const firstSeg = resolved.pathname.replace(/^\/+/, "").split("/")[0]?.toLowerCase() ?? "";
      return {
        songId: iParam,
        storefront: STOREFRONT_RE.test(firstSeg) ? firstSeg : "",
      };
    }
  } catch {
    // ignore
  }
  return null;
}

export function parseSongRef(
  ref: string,
  defaultStorefront = "cn",
): { storefront: string; songId: string } {
  const trimmed = ref.trim();
  if (DIGITS_RE.test(trimmed)) {
    return { storefront: defaultStorefront.toLowerCase(), songId: trimmed };
  }
  const parsed = parseAppleMusicUrl(trimmed, "song");
  if (parsed.type !== "song") {
    throw new Error(
      `expected a song link; got a ${parsed.type} link (an album link needs ?i=<song id>)`,
    );
  }
  return { storefront: parsed.storefront, songId: parsed.id };
}
