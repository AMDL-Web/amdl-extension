import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { lyricsLrc } from "../src/core/lyrics.ts";
import type { LyricsExtra } from "../src/core/types.ts";

const FIXTURE_DIR = path.resolve("tests/fixtures/lyrics");

function readFixture(name: string): string {
  return readFileSync(path.join(FIXTURE_DIR, name), "utf8").replace(/\n$/, "");
}

describe("TTML -> LRC conversion (Go golden fixtures)", () => {
  const both: LyricsExtra[] = ["translation", "pronunciation"];
  const cases: {
    name: string;
    input: string;
    word: boolean;
    extras: LyricsExtra[];
  }[] = [
    { name: "line_timed", input: "word_timed.ttml", word: false, extras: [] },
    {
      name: "line_timed_extras",
      input: "word_timed.ttml",
      word: false,
      extras: both,
    },
    {
      name: "word_timed_extras",
      input: "word_timed.ttml",
      word: true,
      extras: both,
    },
    {
      name: "word_timing_without_spans",
      input: "lines_only.ttml",
      word: true,
      extras: [],
    },
    {
      name: "word_no_paragraph_begin",
      input: "word_no_paragraph_begin.ttml",
      word: true,
      extras: [],
    },
    {
      name: "time_formats",
      input: "time_formats.ttml",
      word: false,
      extras: [],
    },
    {
      name: "timing_none",
      input: "timing_none.ttml",
      word: true,
      extras: [],
    },
    {
      name: "plain_text_passthrough",
      input: "plain.txt",
      word: false,
      extras: ["translation"],
    },
    {
      name: "text_attributes_and_escapes",
      input: "text_attributes.ttml",
      word: false,
      extras: [],
    },
    {
      name: "extras_from_text_attributes",
      input: "extras_text_attributes.ttml",
      word: false,
      extras: both,
    },
  ];

  for (const tc of cases) {
    it(tc.name, () => {
      const got = lyricsLrc(readFixture(tc.input), tc.word, tc.extras);
      const want = readFixture(`${tc.name}.lrc`);
      expect(got).toBe(want);
    });
  }

  it("rejects untimed synced paragraphs and malformed XML", () => {
    expect(() =>
      lyricsLrc("<tt><body><div><p>no time</p></div></body></tt>", false, []),
    ).toThrow(/synchronised/);
    expect(() => lyricsLrc("<tt><body>", false, [])).toThrow(/lyrics/);
  });
});
