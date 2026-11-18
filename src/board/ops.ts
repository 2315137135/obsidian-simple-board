import type { BoardDoc, Card, Column } from "./model";
import { isCard, keyOf } from "./model";

/**
 * 所有操作都在原地改模型，返回是否真的改动了结构。
 * 调用方负责序列化与写盘：模型没有隐藏状态，serializeDoc 是唯一出口。
 */

export function moveCards(
  doc: BoardDoc,
  ids: string[],
  columnIndex: number,
  beforeKey: string | null,
): boolean {
  const target = doc.columns[columnIndex];
  if (!target || ids.length === 0) return false;

  const moving = new Set(ids);
  const collected: Card[] = [];
  for (const column of doc.columns) {
    for (const item of column.items) {
      if (isCard(item) && moving.has(item.id)) collected.push(item);
    }
  }
  if (collected.length === 0) return false;

  const anchor = resolveAnchor(target.items, beforeKey, moving);

  for (const column of doc.columns) {
    column.items = column.items.filter((item) => !(isCard(item) && moving.has(item.id)));
  }

  const at = anchor === null ? -1 : target.items.findIndex((item) => keyOf(item) === anchor);
  if (at < 0) target.items.push(...collected);
  else target.items.splice(at, 0, ...collected);
  return true;
}

/** 落点若指向被拖动的卡片本身，顺延到它之后第一个不动的项。 */
function resolveAnchor(
  items: BoardDoc["columns"][number]["items"],
  beforeKey: string | null,
  moving: Set<string>,
): string | null {
  if (!beforeKey) return null;
  const index = items.findIndex((item) => keyOf(item) === beforeKey);
  if (index < 0) return null;
  const hit = items[index];
  if (!isCard(hit) || !moving.has(hit.id)) return beforeKey;
  for (let i = index + 1; i < items.length; i++) {
    const item = items[i];
    if (!(isCard(item) && moving.has(item.id))) return keyOf(item);
  }
  return null;
}

export function insertCard(doc: BoardDoc, columnIndex: number, card: Card): boolean {
  const column = doc.columns[columnIndex];
  if (!column) return false;
  column.items.push(card);
  return true;
}

export function deleteCards(doc: BoardDoc, ids: string[]): boolean {
  const drop = new Set(ids);
  let changed = false;
  for (const column of doc.columns) {
    const kept = column.items.filter((item) => !(isCard(item) && drop.has(item.id)));
    if (kept.length !== column.items.length) {
      changed = true;
      column.items = kept;
    }
  }
  return changed;
}

export function toggleDone(card: Card): void {
  card.done = !card.done;
  card.dirty = true;
}

export function setCardTitle(card: Card, title: string): boolean {
  const text = title.trimEnd();
  if (text === card.text) return false;
  card.text = text;
  card.dirty = true;
  return true;
}

/**
 * 正文在文件里是卡片下一级的缩进块。编辑器只面对去掉一级缩进的文本，
 * 写回时统一补一级，这样界面里不会出现凭空多出来的制表符。
 */
const ONE_LEVEL = /^(?:\t| {1,4})/;

function stripOneLevel(line: string, indent: string): string {
  const withoutCardIndent = line.startsWith(indent) ? line.slice(indent.length) : line;
  return withoutCardIndent.replace(ONE_LEVEL, "");
}

export function bodyForEditing(card: Card): string {
  return card.body.map((line) => stripOneLevel(line, card.indent)).join("\n");
}

export function setCardBody(card: Card, body: string): boolean {
  const raw = body.replace(/\n+$/, "");
  const next =
    raw === ""
      ? []
      : raw.split("\n").map((line) =>
          line === "" ? "" : `${card.indent}\t${stripOneLevel(line, card.indent)}`,
        );
  if (next.join("\n") === card.body.join("\n")) return false;
  card.body = next;
  card.dirty = true;
  return true;
}

export function addColumn(doc: BoardDoc, title = "新列", index = doc.columns.length): Column {
  const column: Column = { title, headingRaw: `## ${title}`, items: [] };
  doc.columns.splice(Math.min(Math.max(index, 0), doc.columns.length), 0, column);
  return column;
}

export function renameColumn(column: Column, title: string): void {
  column.title = title;
  column.headingRaw = `## ${title}`;
}

export function removeColumn(doc: BoardDoc, index: number): Card[] {
  const column = doc.columns[index];
  if (!column) return [];
  doc.columns.splice(index, 1);
  return column.items.filter(isCard);
}

export function moveCardsToAdjacentColumn(
  doc: BoardDoc,
  ids: string[],
  delta: number,
): boolean {
  if (ids.length === 0) return false;
  const first = doc.columns.findIndex((column) =>
    column.items.some((item) => isCard(item) && ids.includes(item.id)),
  );
  const target = first + delta;
  if (first < 0 || target < 0 || target >= doc.columns.length) return false;
  return moveCards(doc, ids, target, null);
}

export function clearDone(doc: BoardDoc, columnIndex?: number): boolean {
  const scope = columnIndex === undefined ? doc.columns : [doc.columns[columnIndex]];
  let changed = false;
  for (const column of scope) {
    if (!column) continue;
    const kept = column.items.filter((item) => !(isCard(item) && item.done));
    if (kept.length !== column.items.length) {
      changed = true;
      column.items = kept;
    }
  }
  return changed;
}
