import { FORMAT_VERSION, usedIds, type BoardDoc, type Card } from "./model";

/**
 * 文件 → 模型。解析拆成两半：
 * - `splitBoard` 只做切分（结构块、正文段落、孤立段落），纯字符串操作；
 * - `buildDoc` 只做归一（字段校验、补 id、认列），输入是已经解析好的对象。
 *
 * 中间那次 YAML 解析由调用方交给 Obsidian 的 parseYaml，本层不依赖它，
 * 单测可以直接塞对象。
 */

const FENCE_OPEN = /^```ya?ml[ \t]+board[ \t]*$/i;
const FENCE_CLOSE = /^```[ \t]*$/;
const CARD_OPEN = /^<!--[ \t]*card[ \t]+([A-Za-z0-9_-]+)[ \t]*-->$/;
const CARD_CLOSE = /^<!--[ \t]*\/card[ \t]*-->$/;
const FLOW_CARD = /^\s*-\s*\{.*\}\s*$/;

export interface BoardParts {
  /** 结构块的 YAML 文本；没有结构块时是 null。 */
  yaml: string | null;
  /** 卡片 id → 正文。 */
  bodies: Map<string, string>;
  /** 认不出归属的段落，原样保留。 */
  orphans: string[];
  /** 每张卡片在文件里的原始行，行号与 cards 数组一致。 */
  cardLines: (string | undefined)[];
}

export function genId(existing: Iterable<string> = []): string {
  const taken = new Set(existing);
  for (;;) {
    const id = Math.random().toString(36).slice(2, 8);
    if (id.length >= 5 && !taken.has(id)) return id;
  }
}

export function newCard(column: string, title = "", done = false): Card {
  return {
    id: genId(),
    column,
    title,
    tags: [],
    body: "",
    done,
    persisted: false,
    dirty: true,
  };
}

export function splitBoard(text: string): BoardParts {
  const lines = text.split("\n");
  const parts: BoardParts = {
    yaml: null,
    bodies: new Map(),
    orphans: [],
    cardLines: [],
  };

  const outside: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (parts.yaml === null && FENCE_OPEN.test(lines[i])) {
      const start = i + 1;
      let end = -1;
      for (let j = start; j < lines.length; j++) {
        if (FENCE_CLOSE.test(lines[j])) {
          end = j;
          break;
        }
      }
      if (end > start - 1) {
        const block = lines.slice(start, end);
        parts.yaml = block.join("\n");
        parts.cardLines = readCardLines(block);
        i = end + 1;
        continue;
      }
    }
    outside.push(lines[i]);
    i++;
  }

  readSections(outside, parts);
  return parts;
}

function readSections(lines: string[], parts: BoardParts): void {
  let open: { id: string; lines: string[] } | null = null;
  let stray: string[] = [];

  const flushStray = (): void => {
    const text = trimBlank(stray).join("\n");
    if (text.trim()) parts.orphans.push(text);
    stray = [];
  };

  for (const line of lines) {
    const openMatch = CARD_OPEN.exec(line);
    if (openMatch && !open) {
      flushStray();
      open = { id: openMatch[1], lines: [] };
      continue;
    }
    if (CARD_CLOSE.test(line) && open) {
      parts.bodies.set(open.id, trimBlank(open.lines).join("\n"));
      open = null;
      continue;
    }
    if (open) open.lines.push(line);
    else stray.push(line);
  }
  if (open) stray.push(`<!--card ${open.id}-->`, ...open.lines);
  flushStray();
}

/** 结构块里每个卡片条目的原始行；块式写法占一行 entry 但不给 raw，保存时按规范重写。 */
function readCardLines(block: string[]): (string | undefined)[] {
  const start = block.findIndex((line) => /^cards:/.test(line));
  if (start < 0) return [];
  const out: (string | undefined)[] = [];
  for (const line of block.slice(start + 1)) {
    if (!/^\s*-\s/.test(line)) continue;
    out.push(FLOW_CARD.test(line) ? line : undefined);
  }
  return out;
}

export function buildDoc(data: unknown, parts: BoardParts): BoardDoc {
  const raw = (data ?? {}) as Record<string, unknown>;
  const columns = normalizeColumns(raw.columns);
  const doc: BoardDoc = {
    version: typeof raw.version === "number" ? raw.version : FORMAT_VERSION,
    columns,
    cards: [],
    orphans: parts.orphans,
  };

  const seen = usedIds(doc);
  const usedBodies = new Set<string>();
  const list = Array.isArray(raw.cards) ? raw.cards : [];
  list.forEach((item, index) => {
    if (!item || typeof item !== "object") return;
    const record = item as Record<string, unknown>;
    let id = typeof record.id === "string" ? record.id.trim() : "";
    const hasId = id !== "" && !seen.has(id);
    if (!hasId) id = genId(seen);
    seen.add(id);

    const named = typeof record.column === "string" ? record.column.trim() : "";
    const fixed = named !== "" && columns.includes(named);
    const column = fixed ? named : (columns[0] ?? "未命名");
    if (!fixed && columns.length === 0) columns.push(column);

    const card: Card = {
      id,
      column,
      title: typeof record.title === "string" ? record.title : "",
      tags: normalizeTags(record.tags),
      body: parts.bodies.get(id) ?? "",
      done: record.done === true,
      persisted: hasId,
      // 有改动（补 id、纠列）就标脏，保存时按规范重写这一行
      dirty: !hasId || !fixed,
      raw: parts.cardLines[index],
    };
    doc.cards.push(card);
    usedBodies.add(id);
  });

  // 正文段落找不到对应的卡片（手删了那一行）：原样留着，别在保存时吃掉
  for (const [id, body] of parts.bodies) {
    if (usedBodies.has(id)) continue;
    doc.orphans.push(`<!--card ${id}-->${body ? `\n${body}\n` : "\n"}<!--/card-->`);
  }

  return doc;
}

function normalizeColumns(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [];
  const out: string[] = [];
  for (const item of list) {
    const name = typeof item === "string" ? item.trim() : "";
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

function normalizeTags(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [];
  const out: string[] = [];
  for (const item of list) {
    const tag = typeof item === "string" ? item.trim().replace(/^#/, "") : "";
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

function trimBlank(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === "") start++;
  while (end > start && lines[end - 1].trim() === "") end--;
  return lines.slice(start, end);
}
