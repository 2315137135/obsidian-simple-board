import { FORMAT_VERSION, type BoardDoc, type BodySection, type Card } from "./model";

const FENCE_OPEN = /^```ya?ml[ \t]+(board|board-archive)[ \t]*$/i;
const FENCE_CLOSE = /^```[ \t]*$/;
const CARD_OPEN = /^<!--[ \t]*card[ \t]+([A-Za-z0-9_-]+)[ \t]*-->$/;
const CARD_CLOSE = /^<!--[ \t]*\/card[ \t]*-->$/;
const FLOW_CARD = /^\s*-\s*\{.*\}\s*$/;

export interface BoardParts {
  yaml: string | null;
  archiveYaml: string | null;
  bodies: Map<string, string>;
  orphans: string[];
  cardLines: (string | undefined)[];
  archiveLines: (string | undefined)[];
  sections: BodySection[];
}

export function genId(existing: Iterable<string> = []): string {
  const taken = new Set(existing);
  for (;;) {
    const id = Math.random().toString(36).slice(2, 8);
    if (id.length >= 5 && !taken.has(id)) return id;
  }
}

export function newCard(column: string, title = "", done = false): Card {
  return { id: genId(), column, title, tags: [], body: "", done, persisted: false, dirty: true };
}

export function splitBoard(text: string): BoardParts {
  const lines = text.replace(/^<!--board:guide\n[\s\S]*?\n-->\n?/, "").split("\n");
  const parts: BoardParts = {
    yaml: null, archiveYaml: null, bodies: new Map(), orphans: [],
    cardLines: [], archiveLines: [], sections: [],
  };
  const outside: string[] = [];
  let inCard = false;
  let fence: { char: string; length: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inCard && !fence) {
      const match = FENCE_OPEN.exec(line);
      const archive = match?.[1].toLowerCase() === "board-archive";
      if (match && (archive ? parts.archiveYaml : parts.yaml) === null) {
        const end = lines.findIndex((candidate, index) => index > i && FENCE_CLOSE.test(candidate));
        if (end >= 0) {
          const block = lines.slice(i + 1, end);
          if (archive) {
            parts.archiveYaml = block.join("\n");
            parts.archiveLines = readCardLines(block);
          } else {
            parts.yaml = block.join("\n");
            parts.cardLines = readCardLines(block);
          }
          i = end;
          continue;
        }
      }
      if (/^<!--board:(active-end|bodies-start)-->$/.test(line)) continue;
      if (CARD_OPEN.test(line)) inCard = true;
    } else if (inCard && !fence && CARD_CLOSE.test(line)) {
      inCard = false;
    }
    const code = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (code) {
      if (!fence) fence = { char: code[1][0], length: code[1].length };
      else if (code[1][0] === fence.char && code[1].length >= fence.length && !code[2].trim()) fence = null;
    }
    outside.push(line);
  }
  readSections(outside, parts);
  return parts;
}

function readSections(lines: string[], parts: BoardParts): void {
  let open: { id: string; lines: string[] } | null = null;
  let stray: string[] = [];
  let fence: { char: string; length: number } | null = null;
  const flushStray = (): void => {
    if (stray.length) parts.sections.push({ text: stray.join("\n") });
    const text = trimBlank(stray).join("\n");
    if (text.trim()) parts.orphans.push(text);
    stray = [];
  };
  for (const line of lines) {
    const match = !fence ? CARD_OPEN.exec(line) : null;
    if (match && !open) {
      flushStray();
      open = { id: match[1], lines: [line] };
      continue;
    }
    if (!fence && CARD_CLOSE.test(line) && open) {
      const body = trimBlank(open.lines.slice(1)).join("\n");
      parts.bodies.set(open.id, body);
      parts.sections.push({ id: open.id, text: [...open.lines, line].join("\n"), originalBody: body });
      open = null;
      continue;
    }
    const code = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (code) {
      if (!fence) fence = { char: code[1][0], length: code[1].length };
      else if (code[1][0] === fence.char && code[1].length >= fence.length && !code[2].trim()) fence = null;
    }
    if (open) open.lines.push(line);
    else stray.push(line);
  }
  if (open) stray.push(...open.lines);
  flushStray();
}

/** 每个 YAML 条目对应一个 raw 槽位，块式条目交给序列化器规范化。 */
function readCardLines(block: string[]): (string | undefined)[] {
  const start = block.findIndex((line) => /^cards:/.test(line));
  if (start < 0) return [];
  const entries = block.slice(start + 1);
  const indent = entries.find((line) => /^\s*-\s/.test(line))?.match(/^\s*/)?.[0].length;
  return entries.filter((line) => /^\s*-\s/.test(line) && line.match(/^\s*/)?.[0].length === indent)
    .map((line) => FLOW_CARD.test(line) ? line : undefined);
}

export function buildDoc(data: unknown, parts: BoardParts, archiveData: unknown = null): BoardDoc {
  const raw = (data ?? {}) as Record<string, unknown>;
  const columns = normalizeColumns(raw.columns);
  const doc: BoardDoc = {
    version: Math.max(FORMAT_VERSION, typeof raw.version === "number" ? raw.version : FORMAT_VERSION),
    columns, cards: [], archived: [], orphans: [...parts.orphans],
  };
  const seen = new Set<string>();
  const usedBodies = new Set<string>();
  const readCards = (value: unknown, lines: (string | undefined)[], archived: boolean): Card[] => {
    const cards: Card[] = [];
    (Array.isArray(value) ? value : []).forEach((item, index) => {
      if (!item || typeof item !== "object") return;
      const record = item as Record<string, unknown>;
      let id = typeof record.id === "string" ? record.id.trim() : "";
      const hasId = /^[A-Za-z0-9_-]+$/.test(id) && !seen.has(id);
      if (!hasId) id = genId(seen);
      seen.add(id);
      const named = typeof record.column === "string" ? record.column.trim() : "";
      const fixed = named !== "" && (archived || columns.includes(named));
      const column = fixed ? named : (columns[0] ?? "未命名");
      if (!archived && !fixed && columns.length === 0) columns.push(column);
      cards.push({
        id, column, title: typeof record.title === "string" ? record.title : "",
        tags: normalizeTags(record.tags), body: parts.bodies.get(id) ?? "", done: record.done === true,
        archivedAt: archived && typeof record.archived_at === "string" ? record.archived_at : undefined,
        persisted: hasId, dirty: !hasId || !fixed, raw: lines[index],
      });
      usedBodies.add(id);
    });
    return cards;
  };
  doc.cards = readCards(raw.cards, parts.cardLines, false);
  doc.archived = readCards((archiveData as Record<string, unknown> | null)?.cards, parts.archiveLines, true);
  doc.bodySections = parts.sections.map((section) => {
    if (!section.id || usedBodies.has(section.id)) return section;
    doc.orphans.push(section.text);
    return { text: section.text };
  });
  for (const card of [...doc.cards, ...doc.archived]) {
    if (!doc.bodySections.some((section) => section.id === card.id)) {
      doc.bodySections.push({ id: card.id, text: "", originalBody: "" });
    }
  }
  return doc;
}

function normalizeColumns(value: unknown): string[] {
  const out: string[] = [];
  for (const item of Array.isArray(value) ? value : []) {
    const name = typeof item === "string" ? item.trim() : "";
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

function normalizeTags(value: unknown): string[] {
  const out: string[] = [];
  for (const item of Array.isArray(value) ? value : []) {
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
