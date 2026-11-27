import { describe, expect, it } from "vitest";
import {
  extractArtworkStem,
  findMenuInsertionPoint,
  isTrustedUserEvent,
  parsePageRoute,
  subjectFromHref,
} from "../src/content/dom-helpers.ts";
import { getUiStrings } from "../src/content/i18n.ts";
import { AppleApi } from "../src/core/apple-api.ts";
import { DEFAULT_PLAYLIST_FILENAME_TEMPLATE } from "../src/core/naming.ts";
import { sanitizeSettings } from "../src/shared/settings.ts";

describe("AppleApi library & playlist endpoints", () => {
  it("fetches catalog playlist with pagination and skips non-song items while preserving playlistIndex", async () => {
    const seenUrls: string[] = [];
    const api = new AppleApi({
      getDeveloperToken: async () => "fake-jwt",
      transport: {
        async fetch(url: string, init?: RequestInit): Promise<Response> {
          seenUrls.push(url);
          const headers = (init?.headers ?? {}) as Record<string, string>;
          // Catalog playlist calls must never send Media-User-Token
          expect(headers["Media-User-Token"]).toBeUndefined();

          if (url.includes("/v1/catalog/cn/playlists/pl.demo?")) {
            return new Response(
              JSON.stringify({
                data: [
                  {
                    id: "pl.demo",
                    type: "playlists",
                    attributes: {
                      name: "Demo Hits",
                      curatorName: "Apple Music",
                      artwork: { url: "https://is1-ssl.mzstatic.com/image/thumb/a/{w}x{h}bb.jpg" },
                    },
                    relationships: {
                      tracks: {
                        meta: { total: 3 },
                        data: [
                          {
                            id: "1818784494",
                            type: "songs",
                            attributes: { name: "Track One", artistName: "Artist A" },
                          },
                          {
                            id: "9999999",
                            type: "music-videos",
                            attributes: { name: "MV Clip", artistName: "Artist A" },
                          },
                        ],
                        next: "/v1/catalog/cn/playlists/pl.demo/tracks?offset=2",
                      },
                    },
                  },
                ],
              }),
              { status: 200 },
            );
          }
          if (url.includes("/v1/catalog/cn/playlists/pl.demo/tracks?offset=2")) {
            return new Response(
              JSON.stringify({
                data: [
                  {
                    id: "1783644604",
                    type: "songs",
                    attributes: { name: "Track Three", artistName: "Artist B" },
                  },
                ],
              }),
              { status: 200 },
            );
          }
          return new Response("not found", { status: 404 });
        },
      },
    });

    const pl = await api.playlist("cn", "pl.demo", "zh-Hans_CN");
    expect(seenUrls).toHaveLength(2);
    expect(pl.name).toBe("Demo Hits");
    expect(pl.artist).toBe("Apple Music");
    expect(pl.totalCount).toBe(3);
    expect(pl.tracks).toEqual([
      expect.objectContaining({
        playlistIndex: 1,
        catalogId: "1818784494",
        kind: "song",
        unavailableInCatalog: false,
      }),
      expect.objectContaining({
        playlistIndex: 2,
        catalogId: undefined,
        kind: "non-song",
      }),
      expect.objectContaining({
        playlistIndex: 3,
        catalogId: "1783644604",
        kind: "song",
        unavailableInCatalog: false,
      }),
    ]);
  });

  it("maps library album catalog relationship and per-track playParams.catalogId", async () => {
    let sawUserToken = false;
    const api = new AppleApi({
      getDeveloperToken: async () => "fake-jwt",
      transport: {
        async fetch(url: string, init?: RequestInit): Promise<Response> {
          const headers = (init?.headers ?? {}) as Record<string, string>;
          sawUserToken = headers["Media-User-Token"] === "fake-mut";
          if (url.includes("/v1/me/library/albums/l.demoAlbum")) {
            return new Response(
              JSON.stringify({
                data: [
                  {
                    id: "l.demoAlbum",
                    type: "library-albums",
                    attributes: {
                      name: "HALO - EP",
                      artistName: "NOMELON NOLEMON",
                    },
                    relationships: {
                      catalog: {
                        data: [{ id: "1818784232", type: "albums" }],
                      },
                      tracks: {
                        data: [
                          {
                            id: "i.track1",
                            type: "library-songs",
                            attributes: {
                              name: "Track 1",
                              artistName: "NOMELON NOLEMON",
                              trackNumber: 1,
                              discNumber: 1,
                              playParams: {
                                id: "i.track1",
                                kind: "song",
                                isLibrary: true,
                                catalogId: "1818784494",
                              },
                            },
                          },
                          {
                            id: "i.upload1",
                            type: "library-songs",
                            attributes: {
                              name: "Local Rip",
                              artistName: "Unknown",
                              trackNumber: 2,
                              discNumber: 1,
                              playParams: {
                                id: "i.upload1",
                                kind: "song",
                                isLibrary: true,
                              },
                            },
                          },
                        ],
                      },
                    },
                  },
                ],
              }),
              { status: 200 },
            );
          }
          return new Response("not found", { status: 404 });
        },
      },
    });

    const res = await api.libraryAlbum("fake-mut", "l.demoAlbum", "en-US");
    expect(sawUserToken).toBe(true);
    expect(res.catalogAlbumId).toBe("1818784232");
    expect(res.tracks).toHaveLength(2);
    expect(res.tracks[0]).toMatchObject({
      catalogId: "1818784494",
      unavailableInCatalog: false,
      playlistIndex: 1,
    });
    expect(res.tracks[1]).toMatchObject({
      catalogId: undefined,
      unavailableInCatalog: true,
      playlistIndex: 2,
    });
  });

  it("paginates library playlist tracks and marks user uploads without catalogId", async () => {
    const seenUrls: string[] = [];
    const api = new AppleApi({
      getDeveloperToken: async () => "fake-jwt",
      transport: {
        async fetch(url: string, init?: RequestInit): Promise<Response> {
          seenUrls.push(url);
          const headers = (init?.headers ?? {}) as Record<string, string>;
          expect(headers["Media-User-Token"]).toBe("fake-mut");

          if (url.includes("/v1/me/library/playlists/p.demoList?")) {
            return new Response(
              JSON.stringify({
                data: [
                  {
                    id: "p.demoList",
                    type: "library-playlists",
                    attributes: { name: "Favourite Songs" },
                  },
                ],
              }),
              { status: 200 },
            );
          }
          if (url.includes("/v1/me/library/playlists/p.demoList/tracks?limit=100")) {
            return new Response(
              JSON.stringify({
                meta: { total: 3 },
                data: [
                  {
                    id: "i.s1",
                    type: "library-songs",
                    attributes: {
                      name: "Song A",
                      artistName: "Artist A",
                      playParams: { catalogId: "1818784494" },
                    },
                  },
                  {
                    id: "i.u1",
                    type: "library-songs",
                    attributes: {
                      name: "User Upload",
                      artistName: "Local",
                      playParams: { id: "i.u1", isLibrary: true },
                    },
                  },
                ],
                next: "/v1/me/library/playlists/p.demoList/tracks?offset=2",
              }),
              { status: 200 },
            );
          }
          if (url.includes("/v1/me/library/playlists/p.demoList/tracks?offset=2")) {
            return new Response(
              JSON.stringify({
                data: [
                  {
                    id: "i.s3",
                    type: "library-songs",
                    attributes: {
                      name: "Song C",
                      artistName: "Artist C",
                      playParams: { catalogId: "1783644604" },
                    },
                  },
                ],
              }),
              { status: 200 },
            );
          }
          return new Response("not found", { status: 404 });
        },
      },
    });

    const pl = await api.libraryPlaylist("fake-mut", "p.demoList", "zh-Hans_CN");
    expect(seenUrls).toHaveLength(3);
    expect(pl.name).toBe("Favourite Songs");
    expect(pl.totalCount).toBe(3);
    expect(pl.tracks.map((t) => [t.playlistIndex, t.catalogId, t.unavailableInCatalog])).toEqual([
      [1, "1818784494", false],
      [2, undefined, true],
      [3, "1783644604", false],
    ]);
  });

  it("treats 404 on empty library playlist /tracks as empty list", async () => {
    const api = new AppleApi({
      getDeveloperToken: async () => "fake-jwt",
      transport: {
        async fetch(url: string): Promise<Response> {
          if (url.includes("/tracks")) {
            return new Response("not found", { status: 404 });
          }
          return new Response(
            JSON.stringify({
              data: [{ id: "p.empty", type: "library-playlists", attributes: { name: "Empty" } }],
            }),
            { status: 200 },
          );
        },
      },
    });
    const pl = await api.libraryPlaylist("fake-mut", "p.empty");
    expect(pl.name).toBe("Empty");
    expect(pl.tracks).toEqual([]);
  });
});

describe("settings, content helpers, B1 trusted-event guard, and i18n", () => {
  it("sanitizes playlistFilenameTemplate with default fallback", () => {
    const def = sanitizeSettings({});
    expect(def.playlistFilenameTemplate).toBe(DEFAULT_PLAYLIST_FILENAME_TEMPLATE);
    const custom = sanitizeSettings({
      playlistFilenameTemplate: "  Playlists/{playlistName}/{title}.m4a  ",
    });
    expect(custom.playlistFilenameTemplate).toBe(
      "Playlists/{playlistName}/{title}.m4a",
    );
  });

  it("rejects untrusted synthetic events (B1 hardening)", () => {
    const synthetic = new Event("click");
    expect(synthetic.isTrusted).toBe(false);
    expect(isTrustedUserEvent(synthetic)).toBe(false);

    const trustedLike = { isTrusted: true } as unknown as Event;
    expect(isTrustedUserEvent(trustedLike)).toBe(true);
  });

  it("parses page routes and lockup href subjects cleanly", () => {
    expect(
      parsePageRoute("https://music.apple.com/library/albums/l.ViWYEme"),
    ).toEqual({ type: "library-album", storefront: "", id: "l.ViWYEme" });
    expect(
      parsePageRoute("https://music.apple.com/us/library/playlist/p.omUlzXO1KA"),
    ).toEqual({ type: "library-playlist", storefront: "", id: "p.omUlzXO1KA" });
    expect(
      parsePageRoute("https://music.apple.com/cn/playlist/pl.f4d106fed2bd41149aaacabb233eb5eb"),
    ).toEqual({
      type: "playlist",
      storefront: "cn",
      id: "pl.f4d106fed2bd41149aaacabb233eb5eb",
    });
    expect(
      parsePageRoute("https://music.apple.com/library/songs"),
    ).toBeNull();

    expect(subjectFromHref("#")).toBeNull();
    expect(
      subjectFromHref(
        "https://music.apple.com/cn/album/test/1783644603?l=en-GB",
      ),
    ).toEqual({
      kind: "album",
      storefront: "cn",
      id: "1783644603",
      titleHint: undefined,
    });
  });

  it("extracts matching artwork stems across API templates and DOM srcsets", () => {
    const apiUrl =
      "https://is1-ssl.mzstatic.com/image/thumb/Music211/v4/88/b2/f8/88b2f80a-6688-c72e-9ca6-c6066f30c0d8/198704278525_Cover.jpg/{w}x{h}bb.jpg";
    const srcset =
      "https://is1-ssl.mzstatic.com/image/thumb/Music211/v4/88/b2/f8/88b2f80a-6688-c72e-9ca6-c6066f30c0d8/198704278525_Cover.jpg/180x180bb.webp 180w, https://is1-ssl.mzstatic.com/image/thumb/Music211/v4/88/b2/f8/88b2f80a-6688-c72e-9ca6-c6066f30c0d8/198704278525_Cover.jpg/316x316bb.webp 316w";
    expect(extractArtworkStem(apiUrl)).toBe(extractArtworkStem(srcset));
    expect(extractArtworkStem(apiUrl)).toContain("198704278525_cover.jpg");
  });

  it("localises UI strings for zh-Hans, zh-Hant, ja, and default English", () => {
    expect(getUiStrings("zh-Hans-CN").downloadAlbum).toBe("下载专辑");
    expect(getUiStrings("zh-Hans-CN").downloadPlaylist).toBe("下载播放列表");
    expect(getUiStrings("zh-Hant-TW").downloadAlbum).toBe("下載專輯");
    expect(getUiStrings("ja-JP").downloadAlbum).toBe("アルバムをダウンロード");
    expect(getUiStrings("en-US").downloadAlbum).toBe("Download album");
    expect(getUiStrings("en-US").downloadPlaylist).toBe("Download playlist");
  });

  it("chooses context menu insertion point right after library item or before Copy Link", () => {
    const makeFakeEntry = (title: string) => ({
      tagName: "AMP-CONTEXTUAL-MENU-ITEM",
      hasAttribute: () => false,
      matches: () => false,
      querySelector: (sel: string) =>
        sel === "button"
          ? { getAttribute: (k: string) => (k === "title" ? title : null) }
          : null,
      textContent: title,
    });

    const withLib = {
      children: [
        makeFakeEntry("置顶歌曲"),
        makeFakeEntry("从资料库中删除"),
        makeFakeEntry("添加到歌单"),
        makeFakeEntry("拷贝链接"),
      ],
    } as unknown as Element;
    const res1 = findMenuInsertionPoint(withLib);
    expect(res1?.matchedBy).toBe("library");
    expect(res1?.position).toBe("afterend");
    expect(res1?.anchor).toBe(withLib.children[1]);

    const withoutLib = {
      children: [makeFakeEntry("Copy Link"), makeFakeEntry("Copy Embed Code")],
    } as unknown as Element;
    const res2 = findMenuInsertionPoint(withoutLib);
    expect(res2?.matchedBy).toBe("copy-link");
    expect(res2?.position).toBe("beforebegin");
    expect(res2?.anchor).toBe(withoutLib.children[0]);

    // Unhydrated Stencil shells (empty labels) must return null so we wait for hydration
    const unhydrated = {
      children: [makeFakeEntry(""), makeFakeEntry("")],
    } as unknown as Element;
    expect(findMenuInsertionPoint(unhydrated)).toBeNull();
  });
});
