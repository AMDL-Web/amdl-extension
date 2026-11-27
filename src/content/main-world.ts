/**
 * MAIN-world content script injected at `document_start` on music.apple.com.
 *
 * Responsibilities:
 * 1. Answers token requests (`amdl:token-req`) from the isolated-world content
 *    script over a per-request transferred `MessagePort` + random nonce so
 *    tokens are never broadcast on `window` and never persisted.
 * 2. Passively indexes library collection items (`/v1/me/library/albums`,
 *    `/v1/me/library/recently-added`, `/v1/me/library/playlists`) observed in
 *    Apple Music's own `window.fetch` JSON responses (without reading or logging
 *    any request headers/tokens) so lockup context menus on library grids whose
 *    anchors use `href="#"` resolve cleanly.
 * 3. Exposes the active `amp-contextual-menu.menuItemElementTrigger` element to
 *    the isolated world by tagging it with a temporary attribute on request.
 *
 * Idempotent: re-injecting on extension reload cleanly replaces any previous
 * listener while preserving the passive library index.
 */

interface MusicKitInstanceLike {
  developerToken?: string;
  musicUserToken?: string;
  storefrontId?: string;
  isAuthorized?: boolean;
}

interface MusicKitGlobal {
  getInstance?: () => MusicKitInstanceLike | undefined;
}

interface IndexedLibraryItem {
  kind: "library-album" | "library-playlist";
  id: string;
  name: string;
  artistName: string;
  artworkStem: string;
}

interface MainWorldWindow extends Window {
  MusicKit?: MusicKitGlobal;
  __amdlMainWorldCleanup?: () => void;
  __amdlFetchHooked?: boolean;
  __amdlLibraryIndex?: Map<string, IndexedLibraryItem>;
}

const win = window as unknown as MainWorldWindow;

if (typeof win.__amdlMainWorldCleanup === "function") {
  try {
    win.__amdlMainWorldCleanup();
  } catch {
    // ignore
  }
}

const libraryIndex: Map<string, IndexedLibraryItem> =
  win.__amdlLibraryIndex instanceof Map
    ? win.__amdlLibraryIndex
    : new Map<string, IndexedLibraryItem>();
win.__amdlLibraryIndex = libraryIndex;

function extractArtworkStem(url: string): string {
  if (!url) return "";
  const m = url.match(
    /\/image\/thumb\/([^?]+?)(?:\/\d+x\d+[^/?]*|\/\{w\}x\{h\}[^/?]*)?$/i,
  );
  if (m?.[1]) return m[1].toLowerCase();
  const m2 = url.match(/\/([^/]+\.(?:jpg|jpeg|png|webp))(?=\/|$|\?)/i);
  return m2?.[1]?.toLowerCase() ?? "";
}

function recordLibraryEntry(
  kind: "library-album" | "library-playlist",
  id: string,
  attrs?: {
    name?: string;
    artistName?: string;
    artwork?: { url?: string };
  },
): void {
  if (!id) return;
  const key = `${kind}:${id}`;
  const prev = libraryIndex.get(key);
  const name = attrs?.name?.trim() || prev?.name || "";
  const artistName = attrs?.artistName?.trim() || prev?.artistName || "";
  const artworkStem =
    extractArtworkStem(attrs?.artwork?.url ?? "") || prev?.artworkStem || "";
  libraryIndex.set(key, { kind, id, name, artistName, artworkStem });
}

function ingestLibraryPayload(payload: unknown): void {
  if (!payload || typeof payload !== "object") return;
  const obj = payload as {
    data?: unknown;
    resources?: Record<
      string,
      Record<
        string,
        {
          id?: string;
          type?: string;
          attributes?: {
            name?: string;
            artistName?: string;
            artwork?: { url?: string };
          };
        }
      >
    >;
  };

  // Standard resource-array responses (`data[]` carries full attributes).
  if (Array.isArray(obj.data)) {
    for (const raw of obj.data) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as {
        id?: string;
        type?: string;
        attributes?: {
          name?: string;
          artistName?: string;
          artwork?: { url?: string };
        };
      };
      const kind =
        item.type === "library-albums"
          ? "library-album"
          : item.type === "library-playlists"
            ? "library-playlist"
            : null;
      if (kind && item.id) {
        recordLibraryEntry(kind, item.id, item.attributes);
      }
    }
  }

  // Apple Music web player uses `format[resources]=map`, placing full attributes under `resources`.
  if (obj.resources && typeof obj.resources === "object") {
    const mapSources: [string, "library-album" | "library-playlist"][] = [
      ["library-albums", "library-album"],
      ["library-playlists", "library-playlist"],
    ];
    for (const [resKey, kind] of mapSources) {
      const bucket = obj.resources[resKey];
      if (!bucket || typeof bucket !== "object") continue;
      for (const [id, entry] of Object.entries(bucket)) {
        if (!entry || typeof entry !== "object") continue;
        recordLibraryEntry(kind, entry.id || id, entry.attributes);
      }
    }
  }
}

const LIBRARY_LIST_URL_RE =
  /amp-api\.music\.apple\.com\/v1\/me\/library\/(albums|recently-added|playlists|playlist-folders|pins)(?:\/|\?|$)/;

if (!win.__amdlFetchHooked && typeof window.fetch === "function") {
  win.__amdlFetchHooked = true;
  const origFetch = window.fetch.bind(window);
  window.fetch = function amdlWrappedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const reqUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input?.url || "";
    const promise = origFetch(input, init);
    if (LIBRARY_LIST_URL_RE.test(reqUrl)) {
      void promise
        .then((resp) => {
          if (!resp.ok) return;
          return resp.clone().json().then(ingestLibraryPayload);
        })
        .catch(() => {
          // Passive observation must never interfere with Apple Music.
        });
    }
    return promise;
  };
}

function lookupLibraryLockup(query: {
  title?: string;
  subtitle?: string;
  artworkStem?: string;
}): IndexedLibraryItem | null {
  const stem = (query.artworkStem || "").toLowerCase();
  const title = (query.title || "").trim().toLowerCase();
  const sub = (query.subtitle || "").trim().toLowerCase();

  if (stem) {
    for (const item of libraryIndex.values()) {
      if (item.artworkStem && item.artworkStem === stem) return item;
    }
  }
  if (title && sub) {
    for (const item of libraryIndex.values()) {
      if (
        item.name.trim().toLowerCase() === title &&
        item.artistName.trim().toLowerCase() === sub
      ) {
        return item;
      }
    }
  }
  if (title) {
    for (const item of libraryIndex.values()) {
      if (item.name.trim().toLowerCase() === title) return item;
    }
  }
  return null;
}

function tagActiveMenuTrigger(): string {
  try {
    const menus = Array.from(document.querySelectorAll("amp-contextual-menu"));
    for (const menu of menus) {
      const trigger = (
        menu as HTMLElement & { menuItemElementTrigger?: Element | null }
      ).menuItemElementTrigger;
      if (trigger instanceof Element) {
        const token = `amdl-trig-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        trigger.setAttribute("data-amdl-active-trigger", token);
        setTimeout(() => {
          if (trigger.getAttribute("data-amdl-active-trigger") === token) {
            trigger.removeAttribute("data-amdl-active-trigger");
          }
        }, 2000);
        return token;
      }
    }
  } catch {
    // ignore
  }
  return "";
}

function readPageTokens() {
  let developerToken = "";
  let musicUserToken = "";
  let storefrontId = "";

  try {
    const inst = win.MusicKit?.getInstance?.();
    if (inst) {
      if (typeof inst.developerToken === "string") {
        developerToken = inst.developerToken;
      }
      if (typeof inst.musicUserToken === "string") {
        musicUserToken = inst.musicUserToken;
      }
      if (typeof inst.storefrontId === "string") {
        storefrontId = inst.storefrontId;
      }
    }
  } catch {
    // MusicKit may not be initialized yet.
  }

  const language = document.documentElement?.lang || navigator.language || "";
  return {
    ...(developerToken ? { developerToken } : {}),
    ...(musicUserToken ? { musicUserToken } : {}),
    ...(storefrontId ? { storefrontId } : {}),
    ...(language ? { language } : {}),
  };
}

const onMessage = (ev: MessageEvent) => {
  if (ev.source !== window) return;
  const data = ev.data as {
    type?: string;
    nonce?: string;
    query?: { title?: string; subtitle?: string; artworkStem?: string };
  } | null;
  if (!data || typeof data.nonce !== "string") return;
  const port = ev.ports?.[0];
  if (!port) return;

  if (data.type === "amdl:token-req") {
    port.postMessage({
      type: "amdl:token-res",
      nonce: data.nonce,
      tokens: readPageTokens(),
    });
    port.close();
  } else if (data.type === "amdl:lockup-lookup") {
    port.postMessage({
      type: "amdl:lockup-lookup-res",
      nonce: data.nonce,
      match: lookupLibraryLockup(data.query ?? {}),
    });
    port.close();
  } else if (data.type === "amdl:menu-trigger-req") {
    port.postMessage({
      type: "amdl:menu-trigger-res",
      nonce: data.nonce,
      triggerToken: tagActiveMenuTrigger(),
    });
    port.close();
  }
};

window.addEventListener("message", onMessage);
win.__amdlMainWorldCleanup = () => {
  window.removeEventListener("message", onMessage);
};
