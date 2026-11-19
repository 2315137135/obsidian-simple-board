/**
 * 看板的纯数据模型。这一层不依赖 Obsidian，可被单测直接驱动。
 *
 * 一个看板 = 一个 `.board.md` 文件：
 *
 *   ```yaml board
 *   version: 1
 *   columns: [待办, 进行中]
 *   cards:
 *     - {id: a1b2c3, column: 待办, title: 补齐演示场景, tags: [声呐]}
 *   ```
 *
 *   <!--card a1b2c3-->
 *   复用现有车体、管道……
 *   <!--/card-->
 *
 * 后缀说明身份，结构块说明字段，正文段落是普通 Markdown。卡片是扁平记录，
 * 靠 `column` 认列：换列只改一行里的一个值，正文不用跟着搬。文件顺序即列内顺序。
 */

export const BOARD_SUFFIX = ".board.md";
export const FORMAT_VERSION = 1;

export interface Card {
  id: string;
  /** 所属列名，与 BoardDoc.columns 里的值相等。 */
  column: string;
  title: string;
  /** 标签不带 `#`。 */
  tags: string[];
  /** 正文原文，Markdown，可多行；空串表示没有正文。 */
  body: string;
  done: boolean;
  /** 文件里本来就有这张卡；新卡第一次落盘时才补写。 */
  persisted: boolean;
  /** 内容改过，写回时不能复用原始那一行。 */
  dirty: boolean;
  /** 文件里那一行的原文，未改动时原样写回。 */
  raw?: string;
}

export interface BoardDoc {
  version: number;
  columns: string[];
  cards: Card[];
  /** 手写但认不出对应卡片的正文段落，原样写回，保存时不吃掉别人的东西。 */
  orphans: string[];
}

export function isBoardPath(path: string): boolean {
  return path.toLowerCase().endsWith(BOARD_SUFFIX);
}

export function findCard(doc: BoardDoc, id: string): Card | null {
  return doc.cards.find((card) => card.id === id) ?? null;
}

/** 某一列的卡片，按文件顺序。 */
export function cardsOf(doc: BoardDoc, column: string): Card[] {
  return doc.cards.filter((card) => card.column === column);
}

export function columnIndexOf(doc: BoardDoc, column: string): number {
  return doc.columns.indexOf(column);
}

export function usedIds(doc: BoardDoc): Set<string> {
  return new Set(doc.cards.map((card) => card.id));
}
