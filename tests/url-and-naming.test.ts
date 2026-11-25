import { describe, expect, it } from "vitest";
import {
  albumSongNumbers,
  defaultTrackFileName,
  formatDownloadPath,
  safeName,
} from "../src/core/naming.ts";
import type { Song } from "../src/core/types.ts";
import { parseAppleMusicUrl, parseSongRef } from "../src/core/url.ts";

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

    expect(() =>
      parseAppleMusicUrl("https://example.com/cn/song/123"),
    ).toThrow(/unsupported host/);
    expect(() =>
      parseAppleMusicUrl("https://music.apple.com/usa/song/123"),
    ).toThrow(/invalid storefront/);
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

  it("formats download paths safely from templates", () => {
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
  });
});
