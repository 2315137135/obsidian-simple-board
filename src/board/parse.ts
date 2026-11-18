import type { BoardDoc, Card, Column } from "./model";

const HEADING_RE = /^##[ \t]+(.+?)[ \t]*$/;
const CARD_RE = /^([ \t]*)([-*+])[ \t]+\[([ xX])\][ \t]*(.*)$/;
const BLOCK_ID_RE = /[ \t]\^([A-Za-z0-9][A-Za-z0-9-]{2,})[ \t]*$/;

export function genId(existing: Iterable<string> = []): string {
  const taken = new Set(existing);
  for (;;) {
    const id = Math.random().toString(36).slice(2, 8);
    if (id.length >= 5 && !taken.has(id)) return id;
  }
}

export function newCard(text = "", done = false): Card {
  return {
    kind: "card",
    id: genId(),
    text,
    body: [],
    done,
    indent: "",
    bullet: "-",
    raw: [],
    persisted: false,
    dirty: true,
  };
}

export function parseDoc(source: string): BoardDoc {
  const lines = source.split("\n");
  const doc: BoardDoc = { frontmatter: [], preamble: [], columns: [] };

  let i = 0;
  if (lines[0]?.trim() === "---") {
    for (let j = 1; j < lines.length; j++) {
      if (lines[j].trim() === "---") {
        doc.frontmatter = lines.slice(0, j + 1);
        i = j + 1;
        break;
      }
    }
  }

  const usedIds = new Set<string>();
  let rawSeq = 0;
  let column: Column | null = null;

  while (i < lines.length) {
    const line = lines[i];
    const heading = HEADING_RE.exec(line);
    if (heading) {
      column = { title: heading[1], headingRaw: line, items: [] };
      doc.columns.push(column);
      i++;
      continue;
    }
    if (!column) {
      doc.preamble.push(line);
      i++;
      continue;
    }

    const card = readCard(lines, i, usedIds);
    if (card) {
      usedIds.add(card.card.id);
      column.items.push(card.card);
      i = card.next;
      continue;
    }

    column.items.push({ kind: "raw", key: `r:${rawSeq++}`, raw: line });
    i++;
  }

  return doc;
}

function readCard(
  lines: string[],
  start: number,
  usedIds: Set<string>,
): { card: Card; next: number } | null {
  const match = CARD_RE.exec(lines[start]);
  if (!match) return null;

  const [, indent, bullet, state, tail] = match;
  const raw = [lines[start]];
  const body: string[] = [];
  let i = start + 1;
  while (i < lines.length) {
    const line = lines[i];
    if (line === "" || CARD_RE.test(line) || HEADING_RE.test(line)) break;
    body.push(line);
    raw.push(line);
    i++;
  }

  let text = tail;
  let id = "";
  const idMatch = BLOCK_ID_RE.exec(text);
  if (idMatch) {
    id = idMatch[1];
    text = text.slice(0, idMatch.index).trimEnd();
  }

  const persisted = id !== "" && !usedIds.has(id);
  if (!persisted) id = genId(usedIds);

  return {
    card: {
      kind: "card",
      id,
      text,
      body,
      done: state === "x" || state === "X",
      indent,
      bullet,
      raw,
      persisted,
      dirty: false,
    },
    next: i,
  };
}

export function boardHasMarker(frontmatter: Record<string, unknown> | undefined): boolean {
  return frontmatter?.["board"] === true;
}
