import { describe, expect, it } from "vitest";
import type { EspnNewsItem } from "../src/espn/types.js";
import { splitNews, stripHtml } from "../src/intel/news.js";

describe("stripHtml", () => {
  it("removes tags and media placeholders and collapses whitespace", () => {
    const story =
      '<p><photo1></p>\n<p>Everything that happens in the NFL has additional context when viewed from a <a href="https://www.espn.com/fantasy/football/">fantasy football</a> perspective.</p>\n<p><video1></p>';
    expect(stripHtml(story)).toBe("Everything that happens in the NFL has additional context when viewed from a fantasy football perspective.");
  });

  it("decodes common entities", () => {
    expect(stripHtml("Hall &amp; Wilson&#39;s &quot;split&quot;&nbsp;is 60&lt;40")).toBe(`Hall & Wilson's "split" is 60<40`);
  });

  it("leaves plain text alone and returns null for empty or tag-only text", () => {
    expect(stripHtml("Warren (shoulder) was limited Thursday.")).toBe("Warren (shoulder) was limited Thursday.");
    expect(stripHtml("<p><photo1></p>")).toBeNull();
    expect(stripHtml(null)).toBeNull();
    expect(stripHtml(undefined)).toBeNull();
  });
});

describe("splitNews", () => {
  const SINCE = Date.parse("2026-09-21T00:00:00Z");
  const options = { since: SINCE, storyChars: 400, maxMentions: 3 };
  const update = (headline: string, published: string, story?: string): EspnNewsItem => ({ type: "Rotowire", headline, description: headline, story, published, playerId: 1 });
  const article = (type: string, headline: string, published: string): EspnNewsItem => ({
    type,
    headline,
    description: "<p>roundup</p>",
    story: "<p><photo1></p><p>Many players.</p>",
    published,
    playerId: 1,
  });

  it("keeps Rotowire updates as news, with cleaned text, source and as_of", () => {
    const { news, mentioned_in } = splitNews([update("Warren limited Thursday", "2026-09-24T20:43:24Z", "<p>For a second day, Warren practiced.</p>")], options);
    expect(news).toEqual([
      {
        headline: "Warren limited Thursday",
        description: "Warren limited Thursday",
        story: "For a second day, Warren practiced.",
        published: "2026-09-24T20:43:24Z",
        source: "espn",
        as_of: "2026-09-24T20:43:24Z",
      },
    ]);
    expect(mentioned_in).toEqual([]);
  });

  it("puts articles, videos and untyped items under mentioned_in with headline, published and source", () => {
    const untyped: EspnNewsItem = { headline: "Untyped", published: "2026-09-22T10:00:00Z" };
    const { news, mentioned_in } = splitNews(
      [article("Story", "Buzz file", "2026-09-23T18:01:27Z"), article("Media", "Why Yates is hesitant", "2026-09-24T15:05:15Z"), untyped],
      options,
    );
    expect(news).toEqual([]);
    expect(mentioned_in).toEqual([
      { headline: "Why Yates is hesitant", published: "2026-09-24T15:05:15Z", source: "espn" },
      { headline: "Buzz file", published: "2026-09-23T18:01:27Z", source: "espn" },
      { headline: "Untyped", published: "2026-09-22T10:00:00Z", source: "espn" },
    ]);
  });

  it("keeps at most 3 mentions, newest first", () => {
    const feed = ["2026-09-21T01:00:00Z", "2026-09-24T01:00:00Z", "2026-09-22T01:00:00Z", "2026-09-23T01:00:00Z"].map((t, i) => article("Story", `a${i}`, t));
    expect(splitNews(feed, options).mentioned_in.map((m) => m.headline)).toEqual(["a1", "a3", "a2"]);
  });

  it("drops items outside the window or without a readable publish time", () => {
    const feed = [update("old", "2026-09-20T23:59:59Z"), update("undated", ""), article("Story", "old article", "2026-09-01T00:00:00Z"), update("new", "2026-09-21T00:00:00Z")];
    const { news, mentioned_in } = splitNews(feed, options);
    expect(news.map((n) => n.headline)).toEqual(["new"]);
    expect(mentioned_in).toEqual([]);
  });

  it("strips HTML before shortening a long story", () => {
    const story = `<p>${"word ".repeat(200)}</p>`;
    const [item] = splitNews([update("long", "2026-09-22T00:00:00Z", story)], options).news;
    expect(item!.story!.length).toBeLessThanOrEqual(401);
    expect(item!.story).not.toContain("<");
    expect(item!.story!.endsWith("word…")).toBe(true);
  });
});
