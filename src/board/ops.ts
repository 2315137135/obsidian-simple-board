import { readTags, withoutTags } from "./filter";
import { cardsOf, type BoardDoc, type Card } from "./model";

/**
 * 所有操作都在原地改模型，返回是否真的改动了内容。
 * 调用方负责序列化与写盘：模型没有隐藏状态，serializeDoc 是唯一出口。
 */

/** 换列与落点：改 `column` 字段，并把卡片挪到 anchor 之前（null = 落到底）。 */
export function moveCards(
  doc: BoardDoc,
  ids: string[],
  column: string,
  beforeId: string | null,
): boolean {
  if (ids.length === 0 || !doc.columns.includes(column)) return false;
  const moving = doc.cards.filter((card) => ids.includes(card.id));
  if (moving.length === 0) return false;

  let changed = false;
  for (const card of moving) {
    if (card.column !== column) {
      card.column = column;
      card.dirty = true;
      changed = true;
    }
  }

  const from = beforeId === null ? -1 : doc.cards.findIndex((card) => card.id === beforeId);
  const movingIds = new Set(ids);
  // 落点指着被拖动的卡片自己：顺延到它之后第一张不动的卡
  let anchor: Card | null = null;
  for (let i = from; i >= 0 && i < doc.cards.length; i++) {
    const candidate = doc.cards[i];
    if (!movingIds.has(candidate.id)) {
      anchor = candidate;
      break;
    }
  }
  const rest = doc.cards.filter((card) => !ids.includes(card.id));
  let at = anchor ? rest.indexOf(anchor) : rest.length;
  if (at < 0) at = rest.length;
  const next = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
  if (next.some((card, index) => card !== doc.cards[index])) {
    doc.cards = next;
    changed = true;
  }
  return changed;
}

export function moveCardsToAdjacentColumn(
  doc: BoardDoc,
  ids: string[],
  delta: number,
): boolean {
  const first = doc.cards.find((card) => ids.includes(card.id));
  if (!first) return false;
  const target = doc.columns.indexOf(first.column) + delta;
  if (target < 0 || target >= doc.columns.length) return false;
  return moveCards(doc, ids, doc.columns[target], null);
}

export function insertCard(doc: BoardDoc, column: string, card: Card): boolean {
  if (!doc.columns.includes(column)) return false;
  card.column = column;
  doc.cards.push(card);
  doc.bodySections?.push({ id: card.id, text: "", originalBody: "" });
  return true;
}

export function deleteCards(doc: BoardDoc, ids: string[]): boolean {
  const before = doc.cards.length + doc.archived.length;
  doc.cards = doc.cards.filter((card) => !ids.includes(card.id));
  doc.archived = doc.archived.filter((card) => !ids.includes(card.id));
  return doc.cards.length + doc.archived.length !== before;
}

export function archiveCards(doc: BoardDoc, ids: string[], date = archiveDate()): boolean {
  const cards = doc.cards.filter((card) => ids.includes(card.id));
  if (!cards.length) return false;
  doc.cards = doc.cards.filter((card) => !ids.includes(card.id));
  for (const card of cards) {
    card.archivedAt = date;
    card.dirty = true;
  }
  doc.archived.push(...cards);
  return true;
}

export function restoreCards(doc: BoardDoc, ids: string[]): boolean {
  const cards = doc.archived.filter((card) => ids.includes(card.id));
  if (!cards.length || !doc.columns.length) return false;
  doc.archived = doc.archived.filter((card) => !ids.includes(card.id));
  for (const card of cards) {
    if (!doc.columns.includes(card.column)) card.column = doc.columns[0];
    card.archivedAt = undefined;
    card.dirty = true;
  }
  doc.cards.push(...cards);
  return true;
}

function archiveDate(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function toggleDone(card: Card): void {
  card.done = !card.done;
  card.dirty = true;
}

/** 标题里手打的 `#标签` 仍然认：抽成 tags，标题只留正文。 */
export function setCardTitle(card: Card, title: string): boolean {
  const inline = readTags(title);
  const text = withoutTags(title).trimEnd();
  const tags = mergeTags(card.tags, inline);
  if (text === card.title && sameTags(tags, card.tags)) return false;
  card.title = text;
  card.tags = tags;
  card.dirty = true;
  return true;
}

export function setCardTags(card: Card, tags: string[]): boolean {
  const next = mergeTags([], tags);
  if (sameTags(next, card.tags)) return false;
  card.tags = next;
  card.dirty = true;
  return true;
}

export function setCardBody(card: Card, body: string): boolean {
  const next = body.replace(/\s+$/, "").replace(/^\n+/, "");
  if (next === card.body) return false;
  card.body = next;
  return true;
}

export function setCardColumn(card: Card, column: string): boolean {
  if (card.column === column) return false;
  card.column = column;
  card.dirty = true;
  return true;
}

export function addColumn(doc: BoardDoc, title = "新列", index = doc.columns.length): string {
  let name = title.trim() || "新列";
  let suffix = 2;
  while (doc.columns.includes(name)) name = `${title} ${suffix++}`;
  doc.columns.splice(Math.min(Math.max(index, 0), doc.columns.length), 0, name);
  return name;
}

/** 换列名要连带改掉卡片里的引用，一次改完，别留下指向不存在列的卡。 */
export function renameColumn(doc: BoardDoc, from: string, to: string): boolean {
  const name = to.trim();
  const index = doc.columns.indexOf(from);
  if (index < 0 || !name || name === from || doc.columns.includes(name)) return false;
  doc.columns[index] = name;
  for (const card of [...cardsOf(doc, from), ...doc.archived.filter((card) => card.column === from)]) {
    card.column = name;
    card.dirty = true;
  }
  return true;
}

/** 换列次序：只动 columns 数组，卡片靠列名引用，不受影响。 */
export function moveColumn(doc: BoardDoc, from: number, to: number): boolean {
  const size = doc.columns.length;
  if (from < 0 || from >= size || to < 0 || to >= size || from === to) return false;
  const [moved] = doc.columns.splice(from, 1);
  doc.columns.splice(to, 0, moved);
  return true;
}

/** 删列连带删掉列里的卡片：没有列可以容纳它们。 */
export function removeColumn(doc: BoardDoc, column: string): boolean {
  const index = doc.columns.indexOf(column);
  if (index < 0) return false;
  doc.columns.splice(index, 1);
  doc.cards = doc.cards.filter((card) => card.column !== column);
  return true;
}

export function clearDone(doc: BoardDoc, column?: string): boolean {
  const before = doc.cards.length;
  doc.cards = doc.cards.filter(
    (card) => !card.done || (column !== undefined && card.column !== column),
  );
  return doc.cards.length !== before;
}

function mergeTags(base: string[], extra: string[]): string[] {
  const out: string[] = [];
  for (const tag of [...base, ...extra]) {
    const value = tag.trim().replace(/^#/, "");
    if (value && !out.includes(value)) out.push(value);
  }
  return out;
}

function sameTags(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((tag, index) => tag === b[index]);
}
