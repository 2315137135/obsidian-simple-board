import { FORMAT_VERSION, type BoardDoc, type Card } from "./model";

export const BODY_START_MIN_LINE = 101;
const GUIDE = [
  "<!--board:guide",
  "日常安排只读顶部活跃 cards，至 board:active-end 为止；正文与归档按需读取。",
  "正文定位：rg -n 'card ID' -- 本文件；从对应起始行读至 /card 结束行。",
  "归档索引在末尾 yaml board-archive 块；归档/恢复只搬元数据行，正文不动，ID 跨索引唯一。",
  "-->",
];

/** 元数据与正文分别写出，原有正文块保留字节与排列。 */
export function serializeDoc(doc: BoardDoc): string {
  const out = [...GUIDE, "", "```yaml board", `version: ${Math.max(FORMAT_VERSION, doc.version)}`];
  out.push(`columns: [${doc.columns.map(scalar).join(", ")}]`);
  out.push(doc.cards.length ? "cards:" : "cards: []");
  for (const card of doc.cards) out.push(cardLine(card));
  out.push("```", "", "<!--board:active-end-->");
  // 小窗口读取头部时不捎带正文；标记而非行号才是读取边界。
  while (out.length < BODY_START_MIN_LINE - 2) out.push("");
  out.push("", "<!--board:bodies-start-->");

  const bodies = bodyText(doc);
  if (bodies) out.push(bodies);
  out.push("", "```yaml board-archive", doc.archived.length ? "cards:" : "cards: []");
  for (const card of doc.archived) out.push(cardLine(card));
  out.push("```", "");
  return out.join("\n");
}

function bodyText(doc: BoardDoc): string {
  const cards = new Map([...doc.cards, ...doc.archived].map((card) => [card.id, card]));
  const emitted = new Set<string>();
  const chunks: string[] = [];
  for (const section of doc.bodySections ?? []) {
    if (!section.id) {
      chunks.push(section.text);
      continue;
    }
    const card = cards.get(section.id);
    if (!card) continue;
    emitted.add(card.id);
    chunks.push(card.body === section.originalBody ? section.text : bodyBlock(card));
  }
  const text = chunks.join("\n").replace(/^\n+|\n+$/g, "");
  const extra = [...cards.values()].filter((card) => !emitted.has(card.id) && card.body)
    .map(bodyBlock);
  if (!doc.bodySections) extra.push(...doc.orphans);
  return [text, ...extra].filter(Boolean).join("\n\n");
}

function bodyBlock(card: Card): string {
  return `<!--card ${card.id}-->\n${card.body}\n<!--/card-->`;
}

function cardLine(card: Card): string {
  if (!card.dirty && card.raw) return card.raw;
  const fields = [`id: ${scalar(card.id)}`, `column: ${scalar(card.column)}`, `title: ${scalar(card.title)}`];
  if (card.tags.length > 0) fields.push(`tags: [${card.tags.map(scalar).join(", ")}]`);
  if (card.done) fields.push("done: true");
  if (card.archivedAt) fields.push(`archived_at: ${JSON.stringify(card.archivedAt)}`);
  return `  - {${fields.join(", ")}}`;
}

/** JSON 双引号也是合法 YAML 标量。 */
function scalar(value: string): string {
  if (value === "") return '""';
  if (!/^[A-Za-z0-9\u4e00-\u9fff][^:#,[\]{}&*!|>'"%@`]*$/.test(value)) return JSON.stringify(value);
  if (/^(true|false|null|yes|no|on|off|~)$/i.test(value)) return JSON.stringify(value);
  if (/^[-+]?[\d._]+$/.test(value)) return JSON.stringify(value);
  return value;
}
