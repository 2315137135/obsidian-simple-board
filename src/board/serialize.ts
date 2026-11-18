import type { BoardDoc, Card } from "./model";
import { isCard } from "./model";

/**
 * 内容未改动的卡片按原始行写回，只有被编辑过的卡片才会重建文本。
 * 空白行由序列化统一管理：列与列之间恒为一行空行，列内的空行不保留，
 * 这样拖拽不会把上一列的分隔空行留在列表中间。
 */
export function serializeDoc(doc: BoardDoc): string {
  const out: string[] = [...doc.frontmatter, ...doc.preamble];
  doc.columns.forEach((column, index) => {
    if (index > 0) out.push("");
    out.push(column.headingRaw);
    for (const item of column.items) {
      if (isCard(item)) out.push(...cardLines(item));
      else if (item.raw.trim() !== "") out.push(item.raw);
    }
  });
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  if (out.length === 0) return "";
  out.push("");
  return out.join("\n");
}

function cardLines(card: Card): string[] {
  if (!card.dirty && card.raw.length > 0) return card.raw;
  const box = card.done ? "x" : " ";
  const head = `${card.indent}${card.bullet} [${box}] ${card.text}`.trimEnd();
  return [`${head} ^${card.id}`, ...card.body];
}
