import { type BoardDoc, type Card } from "./model";

/**
 * 模型 → 文件。出口只有一个，规则全在这里：
 * - 结构块每张卡片一行，未改动的卡片复用原始行，diff 只落在真正改过的地方；
 * - 卡片的写出顺序是「按列分组」，列内保持 doc.cards 的顺序，便于人眼扫读；
 * - 正文段落跟在结构块后面，用 `<!--card id-->` 锚起来，卡片换列时不用搬走。
 */
export function serializeDoc(doc: BoardDoc): string {
  const cards = orderedCards(doc);
  const out: string[] = ["```yaml board", `version: ${doc.version}`];

  out.push(`columns: [${doc.columns.map(scalar).join(", ")}]`);
  out.push("cards:");
  for (const card of cards) out.push(cardLine(card));
  out.push("```");

  for (const card of cards) {
    const body = card.body.replace(/\s+$/, "");
    if (!body) continue;
    out.push("", `<!--card ${card.id}-->`, ...body.split("\n"), "<!--/card-->");
  }

  for (const orphan of doc.orphans) {
    const text = orphan.replace(/\s+$/, "");
    if (text.trim()) out.push("", text);
  }

  out.push("");
  return out.join("\n");
}

function orderedCards(doc: BoardDoc): Card[] {
  const out: Card[] = [];
  for (const column of doc.columns) {
    for (const card of doc.cards) if (card.column === column) out.push(card);
  }
  for (const card of doc.cards) if (!doc.columns.includes(card.column)) out.push(card);
  return out;
}

function cardLine(card: Card): string {
  if (!card.dirty && card.raw) return card.raw;
  const fields = [
    `id: ${scalar(card.id)}`,
    `column: ${scalar(card.column)}`,
    `title: ${scalar(card.title)}`,
  ];
  if (card.tags.length > 0) fields.push(`tags: [${card.tags.map(scalar).join(", ")}]`);
  if (card.done) fields.push("done: true");
  return `  - {${fields.join(", ")}}`;
}

/** 能裸写就裸写，剩下的交给 JSON 双引号标量（本身就是合法 YAML）。 */
function scalar(value: string): string {
  if (value === "") return '""';
  if (!/^[A-Za-z0-9\u4e00-\u9fff][^:#,[\]{}&*!|>'"%@`]*$/.test(value)) return JSON.stringify(value);
  if (/^(true|false|null|yes|no|on|off|~)$/i.test(value)) return JSON.stringify(value);
  if (/^[-+]?[\d._]+$/.test(value)) return JSON.stringify(value);
  return value;
}
