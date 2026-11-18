import type { Card } from "./model";

export interface FilterState {
  query: string;
  hideDone: boolean;
}

export const EMPTY_FILTER: FilterState = { query: "", hideDone: false };

const TAG_RE = /(^|[\s(（[,，])(#[^\s#()（）[\],，]+)/g;

export function cardTags(card: Card): string[] {
  const tags: string[] = [];
  for (const match of card.text.matchAll(TAG_RE)) tags.push(match[2]);
  return tags;
}

/** 标签由卡片自己画 chip，正文里不再重复渲染一次。 */
export function stripTags(text: string): string {
  return text
    .replace(TAG_RE, (_full, prefix: string) => prefix)
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function cardMatches(card: Card, filter: FilterState): boolean {
  if (filter.hideDone && card.done) return false;
  const terms = filter.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;

  const haystack = `${card.text}\n${card.body.join("\n")}`.toLowerCase();
  const tags = cardTags(card).map((tag) => tag.toLowerCase());
  return terms.every((term) => {
    if (term.startsWith("#")) {
      const needle = term.slice(1);
      return tags.some((tag) => tag.slice(1).startsWith(needle));
    }
    return haystack.includes(term);
  });
}
