import type { PlaylistContext } from "../core/naming.ts";
import { extractSongRefFromHref, parseAppleMusicUrl } from "../core/url.ts";
import type { ResolvedAlbumSummary } from "../shared/messages.ts";

export type PageRoute =
  | { type: "album"; storefront: string; id: string; trackId?: string }
  | { type: "song"; storefront: string; id: string }
  | { type: "playlist"; storefront: string; id: string }
  | { type: "library-album"; storefront: ""; id: string }
  | { type: "library-playlist"; storefront: ""; id: string };

export type DownloadSubject =
  | {
      kind: "song";
      storefront: string;
      songId: string;
      titleHint?: string;
      useAccountStorefront?: boolean;
      playlistContext?: PlaylistContext;
    }
  | { kind: "album"; storefront: string; id: string; titleHint?: string }
  | { kind: "library-album"; id: string; titleHint?: string }
  | { kind: "playlist"; storefront: string; id: string; titleHint?: string }
  | { kind: "library-playlist"; id: string; titleHint?: string };

export function parsePageRoute(href: string): PageRoute | null {
  try {
    const parsed = parseAppleMusicUrl(href, "album");
    switch (parsed.type) {
      case "album":
        return {
          type: "album",
          storefront: parsed.storefront,
          id: parsed.id,
          trackId: parsed.trackId,
        };
      case "song":
        return {
          type: "song",
          storefront: parsed.storefront,
          id: parsed.id,
        };
      case "playlist":
        return {
          type: "playlist",
          storefront: parsed.storefront,
          id: parsed.id,
        };
      case "library-album":
        return {
          type: "library-album",
          storefront: "",
          id: parsed.id,
        };
      case "library-playlist":
        return {
          type: "library-playlist",
          storefront: "",
          id: parsed.id,
        };
      default:
        return null;
    }
  } catch {
    return null;
  }
}

export function subjectFromHref(
  href: string,
  baseOrigin = "https://music.apple.com",
  titleHint?: string,
): DownloadSubject | null {
  if (!href || href === "#" || href.endsWith("#")) return null;
  try {
    const resolved = new URL(href, baseOrigin);
    if (resolved.hash && resolved.pathname === new URL(baseOrigin).pathname) {
      return null;
    }
    const parsed = parseAppleMusicUrl(resolved.href, "album");
    switch (parsed.type) {
      case "song":
        return {
          kind: "song",
          storefront: parsed.storefront,
          songId: parsed.id,
          titleHint,
        };
      case "album":
        if (parsed.trackId) {
          return {
            kind: "song",
            storefront: parsed.storefront,
            songId: parsed.trackId,
            titleHint,
          };
        }
        return {
          kind: "album",
          storefront: parsed.storefront,
          id: parsed.id,
          titleHint,
        };
      case "library-album":
        return { kind: "library-album", id: parsed.id, titleHint };
      case "playlist":
        return {
          kind: "playlist",
          storefront: parsed.storefront,
          id: parsed.id,
          titleHint,
        };
      case "library-playlist":
        return { kind: "library-playlist", id: parsed.id, titleHint };
      default:
        return null;
    }
  } catch {
    return null;
  }
}

export interface RowTrackInfo {
  songId: string;
  storefront: string;
  titleHint: string;
  playlistIndex: number;
  unavailableInCatalog: boolean;
  nonSong: boolean;
}

export function extractSongFromRowElement(
  rowEl: Element,
  rowDomIndex: number,
  summary?: ResolvedAlbumSummary | null,
  baseOrigin = "https://music.apple.com",
): RowTrackInfo | null {
  const titleHint = rowEl.getAttribute("aria-label")?.trim() || "";
  const rowIdxAttr = rowEl.getAttribute("data-row");
  const parsedIdx = rowIdxAttr !== null ? Number.parseInt(rowIdxAttr, 10) : NaN;
  const zeroIdx = Number.isFinite(parsedIdx) && parsedIdx >= 0 ? parsedIdx : rowDomIndex;
  const playlistIndex = zeroIdx + 1;

  // 1. Direct `/song/.../<id>` anchor inside row (strips query strings like `?l=en-GB`).
  const songLink = rowEl.querySelector<HTMLAnchorElement>('a[href*="/song/"]');
  const songLinkAttr = songLink?.getAttribute("href") || songLink?.href || "";
  if (songLinkAttr) {
    const ref = extractSongRefFromHref(songLinkAttr, baseOrigin);
    if (ref) {
      return {
        songId: ref.songId,
        storefront: ref.storefront,
        titleHint,
        playlistIndex,
        unavailableInCatalog: false,
        nonSong: false,
      };
    }
  }

  // 2. Fallback: album link with `?i=<songId>` (common on playlist rows).
  const iLink = rowEl.querySelector<HTMLAnchorElement>('a[href*="i="]');
  const iLinkAttr = iLink?.getAttribute("href") || iLink?.href || "";
  if (iLinkAttr) {
    const ref = extractSongRefFromHref(iLinkAttr, baseOrigin);
    if (ref) {
      return {
        songId: ref.songId,
        storefront: ref.storefront,
        titleHint,
        playlistIndex,
        unavailableInCatalog: false,
        nonSong: false,
      };
    }
  }

  // 3. Fallback: `data-row` 0-based index against resolved collection tracks.
  if (summary) {
    const track = summary.tracks[zeroIdx];
    if (track) {
      if (track.nonSong) {
        return {
          songId: "",
          storefront: summary.storefront || "",
          titleHint: titleHint || track.name,
          playlistIndex: track.playlistIndex ?? playlistIndex,
          unavailableInCatalog: false,
          nonSong: true,
        };
      }
      if (track.unavailableInCatalog || !track.id) {
        return {
          songId: "",
          storefront: summary.storefront || "",
          titleHint: titleHint || track.name,
          playlistIndex: track.playlistIndex ?? playlistIndex,
          unavailableInCatalog: true,
          nonSong: false,
        };
      }
      return {
        songId: track.id,
        storefront: summary.storefront || "",
        titleHint: titleHint || track.name,
        playlistIndex: track.playlistIndex ?? playlistIndex,
        unavailableInCatalog: false,
        nonSong: false,
      };
    }
  }

  return null;
}

export function extractArtworkStem(url: string): string {
  if (!url) return "";
  const first = url.split(",")[0]?.trim().split(/\s+/)[0] ?? "";
  if (!first) return "";
  const m = first.match(
    /\/image\/thumb\/([^?]+?)(?:\/\d+x\d+[^/?]*|\/\{w\}x\{h\}[^/?]*)?$/i,
  );
  if (m?.[1]) return m[1].toLowerCase();
  const m2 = first.match(/\/([^/]+\.(?:jpg|jpeg|png|webp))(?=\/|$|\?)/i);
  return m2?.[1]?.toLowerCase() ?? "";
}

/**
 * Only trust real user-initiated events (`isTrusted === true`) to prevent
 * synthetic clicks dispatched by Apple's own scripts from triggering downloads.
 */
export function isTrustedUserEvent(ev: Event): boolean {
  return Boolean(ev && ev.isTrusted === true);
}

const LIBRARY_MENU_ITEM_RE =
  /^(添加到资料库|从资料库中删除|加入資料庫|從資料庫中?移除|從資料庫刪除|add to library|delete from library|remove from library|ライブラリに追加|ライブラリから削除)$/i;

const COPY_LINK_MENU_ITEM_RE =
  /^(拷贝链接|拷貝連結|复制链接|copy link|リンクをコピー)$/i;

export interface MenuInsertionPoint {
  anchor: Element;
  position: "afterend" | "beforebegin";
  matchedBy: "library" | "copy-link" | "fallback";
}

function menuEntryLabel(el: Element): string {
  const btn = el.matches("button") ? el : el.querySelector("button");
  const title = btn?.getAttribute("title")?.trim();
  if (title) return title;
  const textEl = el.querySelector(".contextual-menu-item__option-text");
  return (textEl?.textContent || btn?.textContent || el.textContent || "").trim();
}

/**
 * Finds where to insert our Download item inside an open `ul.contextual-menu__list`:
 * 1. Returns `null` if Stencil has not hydrated the native menu item buttons yet
 *    (so we never inject at the wrong fallback position before labels render).
 * 2. Immediately AFTER the native Add/Delete from Library item.
 * 3. Otherwise immediately BEFORE the Copy Link item.
 * 4. Otherwise after the last top-level item.
 */
export function findMenuInsertionPoint(
  menuList: Element,
): MenuInsertionPoint | null {
  const entries = Array.from(menuList.children).filter(
    (el) =>
      !el.hasAttribute("data-amdl-menu-item") &&
      (el.tagName === "AMP-CONTEXTUAL-MENU-ITEM" ||
        el.matches("li.contextual-menu-item")),
  );
  if (entries.length === 0) return null;

  const labeled = entries.map((el) => ({ el, label: menuEntryLabel(el) }));
  // Wait until Stencil has rendered the item buttons/labels before placing our item.
  if (!labeled.some((x) => x.label.length > 0)) {
    return null;
  }

  for (const { el, label } of labeled) {
    if (LIBRARY_MENU_ITEM_RE.test(label)) {
      return { anchor: el, position: "afterend", matchedBy: "library" };
    }
  }
  for (const { el, label } of labeled) {
    if (COPY_LINK_MENU_ITEM_RE.test(label)) {
      return { anchor: el, position: "beforebegin", matchedBy: "copy-link" };
    }
  }
  return {
    anchor: entries[entries.length - 1]!,
    position: "afterend",
    matchedBy: "fallback",
  };
}
