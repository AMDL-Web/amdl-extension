import { describe, expect, it } from "vitest";
import { AppleApi } from "../src/core/apple-api.ts";
import { runPipeline } from "../src/core/pipeline.ts";
import { createConsoleLogger } from "../src/core/types.ts";
import {
  DEFAULT_SETTINGS,
  sanitizeSettings,
  wrapperOriginPattern,
} from "../src/shared/settings.ts";

describe("extension settings", () => {
  it("sanitizes unknown/out-of-range fields cleanly", () => {
    const s = sanitizeSettings({
      wrapperUrl: "  http://wrapper.lan  ",
      codec: "bogus",
      maxSampleRate: 999999,
      maxBitDepth: 32,
      concurrency: 99,
      lyricsExtras: ["translation", "invalid"],
    });
    expect(s.wrapperUrl).toBe("http://wrapper.lan");
    expect(s.codec).toBe(DEFAULT_SETTINGS.codec);
    expect(s.maxSampleRate).toBe(DEFAULT_SETTINGS.maxSampleRate);
    expect(s.maxBitDepth).toBe(DEFAULT_SETTINGS.maxBitDepth);
    expect(s.concurrency).toBe(4);
    expect(s.lyricsExtras).toEqual(["translation"]);
  });

  it("extracts optional_host_permissions origin pattern", () => {
    expect(wrapperOriginPattern("wrapper.lan/foo")).toBe("http://wrapper.lan/*");
    expect(wrapperOriginPattern("https://am.example.com:8443/api")).toBe(
      "https://am.example.com:8443/*",
    );
    expect(wrapperOriginPattern("")).toBeNull();
    expect(wrapperOriginPattern("ftp://bad.example")).toBeNull();
  });
});

describe("zero-config AAC-LC mode validation", () => {
  it("fails immediately with a sign-in error when neither wrapper nor mediaUserToken is supplied", async () => {
    const appleApi = new AppleApi({
      transport: {
        fetch: async () => {
          throw new Error("should not call network");
        },
      },
      logger: createConsoleLogger("[test]"),
    });

    await expect(
      runPipeline({
        url: "https://music.apple.com/cn/song/1542953977",
        codec: "alac", // forced to aac-lc when wrapper is absent
        appleApi,
      }),
    ).rejects.toThrow(/Not signed in to Apple Music/);
  });

  it("forces codec to aac-lc and calls Apple webPlayback directly when mediaUserToken is provided without wrapper", async () => {
    const seenUrls: { url: string; userToken: string | null }[] = [];
    const fakeTransport = {
      async fetch(url: string, init?: RequestInit): Promise<Response> {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        seenUrls.push({
          url,
          userToken:
            headers["X-Apple-Music-User-Token"] ??
            headers["Media-User-Token"] ??
            null,
        });
        if (url.includes("/v1/catalog/cn/songs/1542953977")) {
          return new Response(
            JSON.stringify({
              data: [
                {
                  id: "1542953977",
                  type: "songs",
                  attributes: {
                    name: "One Last Kiss",
                    artistName: "Utada",
                    albumName: "One Last Kiss",
                    trackNumber: 1,
                    discNumber: 1,
                    hasLyrics: false,
                  },
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (url.includes("MZPlay.woa/wa/webPlayback")) {
          return new Response(
            JSON.stringify({ failureType: "2002" }),
            { status: 200 },
          );
        }
        return new Response("not found", { status: 404 });
      },
    };

    const appleApi = new AppleApi({
      transport: fakeTransport,
      getDeveloperToken: async () => "fake-jwt-token",
    });

    // Without wrapper, an expired token surfaces Apple's failureType 2002 clearly
    await expect(
      runPipeline({
        url: "https://music.apple.com/cn/song/1542953977",
        codec: "alac", // must be forced to aac-lc without wrapper
        mediaUserToken: "fake-mut",
        embedCover: false,
        embedLyrics: false,
        appleApi,
      }),
    ).rejects.toThrow(/failureType 2002/);

    const wpCall = seenUrls.find((c) => c.url.includes("webPlayback"));
    expect(wpCall).toBeDefined();
    expect(wpCall?.userToken).toBe("fake-mut");
  });
});
