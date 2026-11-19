import type { Card } from "./model";

export interface FilterState {
  query: string;
  hideDone: boolean;
}

export const EMPTY_FILTER: FilterState = { query: "", hideDone: false };

const TAG_RE = /(^|[\s(（[,，])(#[^\s#()（）[\],，]+)/g;

/** 从一段文字里读出手打的标签（不带 `#`）。 */
export function readTags(text: string): string[] {
  return [...text.matchAll(TAG_RE)].map((match) => match[2].slice(1));
}

/** 标签由卡片自己画 chip，标题里不再重复显示一次。 */
export function withoutTags(text: string): string {
  return text
    .replace(TAG_RE, (_full, prefix: string) => prefix)
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function cardMatches(card: Card, filter: FilterState): boolean {
  if (filter.hideDone && card.done) return false;
  const terms = filter.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;

  const haystack = `${card.title}\n${card.body}`.toLowerCase();
  const tags = card.tags.map((tag) => tag.toLowerCase());
  return terms.every((term) => {
    if (term.startsWith("#")) {
      const needle = term.slice(1);
      return tags.some((tag) => tag.startsWith(needle));
    }
    return haystack.includes(term);
  });
}
