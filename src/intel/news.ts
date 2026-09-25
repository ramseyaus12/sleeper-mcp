/**
 * Cleanup and sorting for ESPN fantasy news. Pure; the tool fetches the items.
 */
import type { EspnNewsItem } from "../espn/types.js";

/** Item type ESPN uses for short single-player updates. "Story" (articles) and "Media" (videos) cover several players. */
export const PLAYER_UPDATE_TYPE = "Rotowire";

const ENTITIES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

export interface PlayerUpdate {
  headline: string | null;
  description: string | null;
  story: string | null;
  published: string;
  source: "espn";
  as_of: string;
}

export interface Mention {
  headline: string | null;
  /** Also serves as the item's as_of. */
  published: string;
  source: "espn";
}

export interface NewsOptions {
  /** Earliest publish time kept, in epoch ms. */
  since: number;
  /** Approximate story length after shortening. */
  storyChars: number;
  /** Most `mentioned_in` entries kept, newest first. */
  maxMentions: number;
}

/** Removes HTML tags and media placeholders such as <photo1>, decodes common entities, and collapses whitespace. */
export function stripHtml(text: string | null | undefined): string | null {
  if (!text) return null;
  const plain = text
    .replace(/<[^>]*>/g, " ")
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (entity) => ENTITIES[entity] ?? entity)
    .replace(/\s+/g, " ")
    .trim();
  return plain || null;
}

/** Cuts text to about `max` characters at a word boundary, marking the cut with an ellipsis. */
export function shorten(text: string | null, max: number): string | null {
  if (!text || text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max - 80 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * Splits one player's feed into short updates about that player alone (`news`, type "Rotowire") and
 * articles or videos that mention them among others (`mentioned_in`: headline, published and source).
 * Items published before `since`, or without a readable publish time, are dropped.
 */
export function splitNews(feed: readonly EspnNewsItem[], options: NewsOptions): { news: PlayerUpdate[]; mentioned_in: Mention[] } {
  const news: PlayerUpdate[] = [];
  const mentions: Mention[] = [];
  for (const item of feed) {
    const published = item.published;
    const time = Date.parse(published ?? "");
    if (!published || !Number.isFinite(time) || time < options.since) continue;
    if (item.type === PLAYER_UPDATE_TYPE) {
      news.push({
        headline: item.headline ?? null,
        description: stripHtml(item.description),
        story: shorten(stripHtml(item.story), options.storyChars),
        published,
        source: "espn",
        as_of: published,
      });
    } else {
      mentions.push({ headline: item.headline ?? null, published, source: "espn" });
    }
  }
  mentions.sort((a, b) => Date.parse(b.published) - Date.parse(a.published));
  return { news, mentioned_in: mentions.slice(0, options.maxMentions) };
}
