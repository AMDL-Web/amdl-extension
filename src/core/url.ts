export type AppleUrlType =
  | "song"
  | "album"
  | "playlist"
  | "artist"
  | "music-video"
  | "station";

export interface ParsedAppleUrl {
  raw: string;
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
  "expected https://music.apple.com/{storefront}/{album|song|playlist|artist|station|music-video}/...";

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
  const storefront = (parts[0] ?? "").toLowerCase();
  if (!STOREFRONT_RE.test(storefront)) {
    throw new Error(`invalid storefront "${storefront}"`);
  }
  const kind = parts[1] as AppleUrlType;
  if (
    u.hostname === "classical.music.apple.com" &&
    (kind === "music-video" || kind === "station")
  ) {
    throw new Error(`unsupported Apple Music Classical URL type "${kind}"`);
  }
  const id = parts[parts.length - 1] ?? "";
  switch (kind) {
    case "album": {
      const songId = u.searchParams.get("i") ?? "";
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
