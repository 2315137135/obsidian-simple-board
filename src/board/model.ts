/**
 * 看板的纯数据模型。这一层不依赖 Obsidian，可被单测直接驱动。
 *
 * 文档结构（一个看板 = 一个 md 文件）：
 *
 *   ---
 *   board: true
 *   ---
 *   ## 待办
 *   - [ ] 标题 ^a1b2c3
 *   	续行正文
 *
 * 只有 `##` 二级标题开列；卡片是带复选框的列表项；其余行一律原样保留（raw），
 * 保证不装插件时仍是正常 Markdown，也保证插件不会重排用户手写的格式。
 */

export const BOARD_MARKER = "board";

export interface RawLine {
  kind: "raw";
  /** 本会话内的稳定键，用于拖拽落点定位。 */
  key: string;
  raw: string;
}

export interface Card {
  kind: "card";
  id: string;
  text: string;
  body: string[];
  done: boolean;
  indent: string;
  bullet: string;
  /** 解析时的原始行；内容未改过时原样写回，避免无意义 diff。 */
  raw: string[];
  /** 文件里本来就有块 id。新卡第一次落盘时才补写 id。 */
  persisted: boolean;
  dirty: boolean;
}

export type BlockItem = Card | RawLine;

export interface Column {
  title: string;
  headingRaw: string;
  items: BlockItem[];
}

export interface BoardDoc {
  frontmatter: string[];
  preamble: string[];
  columns: Column[];
}

export function isCard(item: BlockItem): item is Card {
  return item.kind === "card";
}

export function keyOf(item: BlockItem): string {
  return item.kind === "card" ? `c:${item.id}` : item.key;
}

export function columnCards(column: Column): Card[] {
  return column.items.filter(isCard);
}

/** 全局可见卡片，按文档顺序。 */
export function allCards(doc: BoardDoc): Card[] {
  return doc.columns.flatMap(columnCards);
}

export function findCard(doc: BoardDoc, id: string): Card | null {
  for (const column of doc.columns) {
    for (const item of column.items) {
      if (isCard(item) && item.id === id) return item;
    }
  }
  return null;
}

export function findColumnOf(doc: BoardDoc, id: string): number {
  return doc.columns.findIndex((column) => columnCards(column).some((card) => card.id === id));
}
