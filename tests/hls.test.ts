import { describe, expect, it } from "vitest";
import {
  CodecNotFoundError,
  PREFETCH_KEY,
  parseAacLcPlaylist,
  parseMaster,
  parseMedia,
  selectVariant,
} from "../src/core/hls.ts";

const SAMPLE_MASTER = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-alac-stereo-44100-16",NAME="ALAC 16/44.1",BIT-DEPTH=16,SAMPLE-RATE=44100
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-alac-stereo-96000-24",NAME="ALAC 24/96",BIT-DEPTH=24,SAMPLE-RATE=96000
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-stereo-256",NAME="AAC 256"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-atmos-2768",NAME="Atmos"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-stereo-256-binaural",NAME="Binaural"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-stereo-256-downmix",NAME="Downmix"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-ac3-448",NAME="AC3"
#EXT-X-STREAM-INF:BANDWIDTH=900000,AVERAGE-BANDWIDTH=850000,AUDIO="audio-alac-stereo-44100-16"
alac44.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3200000,AVERAGE-BANDWIDTH=3000000,AUDIO="audio-alac-stereo-96000-24"
alac96.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=260000,AUDIO="audio-stereo-256"
aac.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=768000,AUDIO="audio-atmos-2768"
atmos.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=260000,AUDIO="audio-stereo-256-binaural"
binaural.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=260000,AUDIO="audio-stereo-256-downmix"
downmix.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=448000,AUDIO="audio-ac3-448"
ac3.m3u8
`;

describe("HLS master/media parsing & variant selection", () => {
  it("parses variants and respects codec patterns and ALAC caps", () => {
    const variants = parseMaster(
      SAMPLE_MASTER,
      "https://aod.itunes.apple.com/path/master.m3u8",
    );
    expect(variants).toHaveLength(7);

    const hiRes = selectVariant(variants, "alac", 192000, 24);
    expect(hiRes.sampleRate).toBe(96000);
    expect(hiRes.bitDepth).toBe(24);
    expect(hiRes.uri).toBe("https://aod.itunes.apple.com/path/alac96.m3u8");

    const cappedRate = selectVariant(variants, "alac", 48000, 24);
    expect(cappedRate.sampleRate).toBe(44100);
    expect(cappedRate.bitDepth).toBe(16);

    const cappedDepth = selectVariant(variants, "alac", 192000, 16);
    expect(cappedDepth.bitDepth).toBe(16);

    expect(selectVariant(variants, "aac").audio).toBe("audio-stereo-256");
    expect(selectVariant(variants, "ec3").audio).toBe("audio-atmos-2768");
    expect(selectVariant(variants, "aac-binaural").audio).toBe(
      "audio-stereo-256-binaural",
    );
    expect(selectVariant(variants, "aac-downmix").audio).toBe(
      "audio-stereo-256-downmix",
    );
    expect(selectVariant(variants, "ac3").audio).toBe("audio-ac3-448");

    expect(() => selectVariant(variants, "alac", 22050, 16)).toThrow(
      CodecNotFoundError,
    );
  });

  it("parses media playlist keys with prefetch key + codec suffix filter", () => {
    const media = `#EXTM3U
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://itunes.apple.com/P123/s1/c23"
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://itunes.apple.com/P123/s1/c22"
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://itunes.apple.com/P123/s1/c6"
#EXT-X-MAP:URI="track.mp4"
`;
    const alac = parseMedia(
      media,
      "https://aod.itunes.apple.com/a/b.m3u8",
      "alac",
    );
    expect(alac.mediaUri).toBe("https://aod.itunes.apple.com/a/track.mp4");
    expect(alac.keys).toEqual([
      PREFETCH_KEY,
      "skd://itunes.apple.com/P123/s1/c23",
      "skd://itunes.apple.com/P123/s1/c6",
    ]);

    const aac = parseMedia(
      media,
      "https://aod.itunes.apple.com/a/b.m3u8",
      "aac",
    );
    expect(aac.keys).toEqual([
      PREFETCH_KEY,
      "skd://itunes.apple.com/P123/s1/c22",
      "skd://itunes.apple.com/P123/s1/c6",
    ]);
  });

  it("parses AAC-LC Widevine playlist", () => {
    const kid = Buffer.from("0123456789abcdef").toString("base64");
    const playlist = `#EXTM3U
#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,URI="data:;base64,${kid}"
#EXT-X-MAP:URI="audio.m4a"
`;
    const m = parseAacLcPlaylist(
      playlist,
      "https://aod.itunes.apple.com/x/track.m3u8",
    );
    expect(m.mediaUri).toBe("https://aod.itunes.apple.com/x/audio.m4a");
    expect(m.kid).toBe(kid);
    expect(m.keyUri).toBe(`data:;base64,${kid}`);
  });
});
