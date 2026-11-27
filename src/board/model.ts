/** 单文件看板：顶部活跃索引、独立正文、末尾归档索引；元数据顺序决定列内顺序。 */

export const BOARD_SUFFIX = ".board.md";
export const FORMAT_VERSION = 2;

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
  archivedAt?: string;
  /** 文件里本来就有这张卡；新卡第一次落盘时才补写。 */
  persisted: boolean;
  /** 元数据改过，写回时不能复用原始那一行。 */
  dirty: boolean;
  /** 文件里那一行的原文，未改动时原样写回。 */
  raw?: string;
}

export interface BoardDoc {
  version: number;
  columns: string[];
  cards: Card[];
  archived: Card[];
  /** 正文与手写段落的原始排列；元数据移动不改变它。 */
  bodySections?: BodySection[];
  /** 手写但认不出对应卡片的正文段落，原样写回，保存时不吃掉别人的东西。 */
  orphans: string[];
}

export interface BodySection {
  id?: string;
  text: string;
  originalBody?: string;
}

export function isBoardPath(path: string): boolean {
  return path.toLowerCase().endsWith(BOARD_SUFFIX);
}

export function findCard(doc: BoardDoc, id: string): Card | null {
  return [...doc.cards, ...doc.archived].find((card) => card.id === id) ?? null;
}

/** 某一列的卡片，按文件顺序。 */
export function cardsOf(doc: BoardDoc, column: string): Card[] {
  return doc.cards.filter((card) => card.column === column);
}

export function columnIndexOf(doc: BoardDoc, column: string): number {
  return doc.columns.indexOf(column);
}

export function usedIds(doc: BoardDoc): Set<string> {
  return new Set([...doc.cards, ...doc.archived].map((card) => card.id));
}
