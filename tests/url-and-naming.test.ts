import { describe, expect, it } from "vitest";
import {
  DEFAULT_FILENAME_TEMPLATE,
  DEFAULT_PLAYLIST_FILENAME_TEMPLATE,
  albumSongNumbers,
  buildJobDedupKey,
  buildUiJobKey,
  defaultTrackFileName,
  formatDownloadPath,
  safeName,
} from "../src/core/naming.ts";
import type { Song } from "../src/core/types.ts";
import {
  extractSongRefFromHref,
  parseAppleMusicUrl,
  parseSongRef,
} from "../src/core/url.ts";

describe("URL parsing", () => {
  it("parses song, album, album?i=, playlist, artist, station, music-video", () => {
    expect(
      parseAppleMusicUrl(
        "https://music.apple.com/cn/album/test/1580904295?i=1580904297",
        "song",
      ),
    ).toMatchObject({
      storefront: "cn",
      type: "song",
      id: "1580904297",
      trackId: "1580904297",
    });

    expect(
      parseAppleMusicUrl(
        "https://music.apple.com/cn/album/test/1580904295?i=1580904297",
        "album",
      ),
    ).toMatchObject({
      storefront: "cn",
      type: "album",
      id: "1580904295",
      trackId: "1580904297",
    });

    expect(
      parseAppleMusicUrl("https://music.apple.com/jp/song/1783644604"),
    ).toMatchObject({
      storefront: "jp",
      type: "song",
      id: "1783644604",
    });

    expect(
      parseAppleMusicUrl(
        "https://music.apple.com/cn/playlist/pl.f4d106fed2bd41149aaacabb233eb5eb?l=en-GB",
      ),
    ).toMatchObject({
      storefront: "cn",
      type: "playlist",
      id: "pl.f4d106fed2bd41149aaacabb233eb5eb",
    });

    expect(() =>
      parseAppleMusicUrl("https://example.com/cn/song/123"),
    ).toThrow(/unsupported host/);
    expect(() =>
      parseAppleMusicUrl("https://music.apple.com/usa/song/123"),
    ).toThrow(/invalid storefront/);
  });

  it("parses library album and library playlist URLs with or without storefront prefix and strips query strings", () => {
    expect(
      parseAppleMusicUrl("https://music.apple.com/library/albums/l.ViWYEme"),
    ).toMatchObject({
      storefront: "",
      type: "library-album",
      id: "l.ViWYEme",
    });

    expect(
      parseAppleMusicUrl(
        "https://music.apple.com/us/library/albums/l.ViWYEme?l=en-GB",
      ),
    ).toMatchObject({
      storefront: "",
      type: "library-album",
      id: "l.ViWYEme",
    });

    expect(
      parseAppleMusicUrl(
        "https://music.apple.com/library/playlist/p.omUlzXO1KA",
      ),
    ).toMatchObject({
      storefront: "",
      type: "library-playlist",
      id: "p.omUlzXO1KA",
    });

    expect(
      parseAppleMusicUrl(
        "https://music.apple.com/us/library/playlist/p.omUlzXO1KA?l=en-GB",
      ),
    ).toMatchObject({
      storefront: "",
      type: "library-playlist",
      id: "p.omUlzXO1KA",
    });

    // Out-of-scope library pages must not parse as downloadable collections
    expect(() =>
      parseAppleMusicUrl("https://music.apple.com/library/songs"),
    ).toThrow();
    expect(() =>
      parseAppleMusicUrl("https://music.apple.com/us/library/recently-added"),
    ).toThrow();
    expect(() =>
      parseAppleMusicUrl("https://music.apple.com/library/albums"),
    ).toThrow();
    expect(() =>
      parseAppleMusicUrl("https://music.apple.com/us/library/playlist"),
    ).toThrow();
  });

  it("extractSongRefFromHref strips query strings from /song/ and /album/?i= links", () => {
    expect(
      extractSongRefFromHref(
        "https://music.apple.com/cn/song/some-title/1818784494?l=en-GB",
      ),
    ).toEqual({ songId: "1818784494", storefront: "cn" });

    expect(
      extractSongRefFromHref(
        "https://music.apple.com/cn/album/some-album/1818784232?i=1818784494&l=en-GB",
      ),
    ).toEqual({ songId: "1818784494", storefront: "cn" });

    expect(extractSongRefFromHref("/cn/song/1783644604?l=zh-Hans")).toEqual({
      songId: "1783644604",
      storefront: "cn",
    });

    expect(extractSongRefFromHref("#")).toBeNull();
  });

  it("parseSongRef handles bare ids, song URLs, album?i= URLs, and rejects bare albums", () => {
    expect(parseSongRef("1538278601", "cn")).toEqual({
      storefront: "cn",
      songId: "1538278601",
    });
    expect(
      parseSongRef("https://music.apple.com/jp/song/x/1542953977", "cn"),
    ).toEqual({ storefront: "jp", songId: "1542953977" });
    expect(
      parseSongRef(
        "https://music.apple.com/cn/album/x/1538278597?i=1538278601",
        "us",
      ),
    ).toEqual({ storefront: "cn", songId: "1538278601" });
    expect(() =>
      parseSongRef("https://music.apple.com/cn/album/x/1538278597", "cn"),
    ).toThrow(/expected a song link/);
  });
});

describe("naming", () => {
  it("sanitizes unsafe characters, dots, and UTF-8 length", () => {
    expect(safeName('A/B:C*"D"?<E>|F')).toBe("A_B_C__D___E__F");
    expect(safeName("  ...foo...  ")).toBe("foo");
    expect(safeName("...")).toBe("_");
    const longCjk = "音".repeat(100); // 300 UTF-8 bytes
    const trimmed = safeName(longCjk);
    expect(new TextEncoder().encode(trimmed).byteLength).toBeLessThanOrEqual(
      240,
    );
    expect(trimmed.length).toBe(80);
  });

  it("computes albumSongNumbers across multiple discs and handles gaps/collisions", () => {
    const mk = (discNumber: number, trackNumber: number): Song =>
      ({ discNumber, trackNumber }) as Song;

    // Disc 1 has track 1 and 3 (track 2 withheld) => disc 1 total = 3; disc 2 track 1 => #4
    expect(albumSongNumbers([mk(1, 1), mk(1, 3), mk(2, 1)])).toEqual([
      1, 3, 4,
    ]);
    // Duplicate falls back to 1..N
    expect(albumSongNumbers([mk(1, 1), mk(1, 1)])).toEqual([1, 2]);
  });

  it("formats album and playlist download paths safely from templates", () => {
    expect(defaultTrackFileName(3, "EMIYA / #LEGACY")).toBe(
      "03. EMIYA _ #LEGACY.m4a",
    );
    expect(
      formatDownloadPath(
        "Apple Music/{albumArtist}/{album}/{songNumber:02}. {title}.m4a",
        {
          albumArtist: "ReoNa",
          artist: "ReoNa",
          album: "生命線 / EP",
          title: "生命線",
          songNumber: 1,
          trackNumber: 1,
          discNumber: 1,
        },
      ),
    ).toBe("Apple Music/ReoNa/生命線 _ EP/01. 生命線.m4a");

    expect(
      formatDownloadPath(DEFAULT_PLAYLIST_FILENAME_TEMPLATE, {
        albumArtist: "NOMELON NOLEMON",
        artist: "NOMELON NOLEMON",
        album: "HALO - EP",
        title: "HALO",
        songNumber: 3,
        trackNumber: 3,
        discNumber: 1,
        playlistName: "My / Favs: 2026",
        playlistIndex: 7,
      }),
    ).toBe("Apple Music/Playlists/My _ Favs_ 2026/07. HALO.m4a");

    expect(
      formatDownloadPath(DEFAULT_PLAYLIST_FILENAME_TEMPLATE, {
        albumArtist: "A",
        artist: "A",
        album: "B",
        title: "Track 105",
        songNumber: 1,
        trackNumber: 1,
        discNumber: 1,
        playlistName: "Big List",
        playlistIndex: 105,
      }),
    ).toBe("Apple Music/Playlists/Big List/105. Track 105.m4a");
  });

  it("keys job deduplication on songId + destination context", () => {
    const albumKey = buildJobDedupKey({
      songId: "1818784494",
      filenameTemplate: DEFAULT_FILENAME_TEMPLATE,
    });
    const sameAlbumKey = buildJobDedupKey({
      songId: "1818784494",
      filenameTemplate: DEFAULT_FILENAME_TEMPLATE,
    });
    const pl1Key = buildJobDedupKey({
      songId: "1818784494",
      filenameTemplate: DEFAULT_FILENAME_TEMPLATE,
      playlistFilenameTemplate: DEFAULT_PLAYLIST_FILENAME_TEMPLATE,
      playlistContext: { playlistName: "Favourite Songs", playlistIndex: 4 },
    });
    const pl1SameSlotKey = buildJobDedupKey({
      songId: "1818784494",
      filenameTemplate: DEFAULT_FILENAME_TEMPLATE,
      playlistFilenameTemplate: DEFAULT_PLAYLIST_FILENAME_TEMPLATE,
      playlistContext: { playlistName: "Favourite Songs", playlistIndex: 4 },
    });
    const pl1OtherSlotKey = buildJobDedupKey({
      songId: "1818784494",
      filenameTemplate: DEFAULT_FILENAME_TEMPLATE,
      playlistFilenameTemplate: DEFAULT_PLAYLIST_FILENAME_TEMPLATE,
      playlistContext: { playlistName: "Favourite Songs", playlistIndex: 9 },
    });
    const pl2Key = buildJobDedupKey({
      songId: "1818784494",
      filenameTemplate: DEFAULT_FILENAME_TEMPLATE,
      playlistFilenameTemplate: DEFAULT_PLAYLIST_FILENAME_TEMPLATE,
      playlistContext: { playlistName: "Workout", playlistIndex: 4 },
    });

    // Double clicks in same context match
    expect(albumKey).toBe(sameAlbumKey);
    expect(pl1Key).toBe(pl1SameSlotKey);

    // Album vs playlist, different playlists, and different slots are distinct
    expect(albumKey).not.toBe(pl1Key);
    expect(pl1Key).not.toBe(pl2Key);
    expect(pl1Key).not.toBe(pl1OtherSlotKey);

    // UI lookup keys mirror context separation and match across DOM/API playlist title locales when playlistId is present
    expect(buildUiJobKey("1818784494")).not.toBe(
      buildUiJobKey("1818784494", {
        playlistId: "p.omUlzXO1KA",
        playlistName: "Favourite Songs",
        playlistIndex: 4,
      }),
    );
    expect(
      buildUiJobKey("1818784494", {
        playlistId: "p.omUlzXO1KA",
        playlistName: "Favourite Songs",
        playlistIndex: 4,
      }),
    ).toBe(
      buildUiJobKey("1818784494", {
        playlistId: "p.omUlzXO1KA",
        playlistName: "喜爱歌曲",
        playlistIndex: 4,
      }),
    );
  });
});
