import { describe, expect, it } from "vitest";
import { parseDoc } from "../src/board/parse";
import { serializeDoc } from "../src/board/serialize";
import {
  bodyForEditing,
  clearDone,
  deleteCards,
  moveCards,
  setCardBody,
  setCardTitle,
  toggleDone,
} from "../src/board/ops";
import { cardMatches, cardTags, stripTags } from "../src/board/filter";
import { allCards, findCard, isCard, type BoardDoc } from "../src/board/model";

const SAMPLE = [
  "---",
  "board: true",
  "---",
  "",
  "## 待办",
  "- [ ] 整理索引文档 ^a1b2c3",
  "- [ ] 给甲方发确认单",
  "",
  "## 进行中",
  "- [x] 声呐格式对齐 ^d4e5f6",
  "\t续行正文",
  "",
  "## 已完成",
  "",
].join("\n");

function cardIds(doc: BoardDoc): string[] {
  return allCards(doc).map((card) => card.id);
}

describe("parse / serialize", () => {
  it("不改动时原样写回", () => {
    const doc = parseDoc(SAMPLE);
    expect(serializeDoc(doc)).toBe(SAMPLE);
  });

  it("识别列、复选框与块 id", () => {
    const doc = parseDoc(SAMPLE);
    expect(doc.columns.map((column) => column.title)).toEqual(["待办", "进行中", "已完成"]);
    const cards = allCards(doc);
    expect(cards).toHaveLength(3);
    expect(cards[0]).toMatchObject({ text: "整理索引文档", done: false, persisted: true });
    expect(cards[2]).toMatchObject({ done: true, body: ["\t续行正文"] });
  });

  it("首次编辑才补写块 id", () => {
    const doc = parseDoc(SAMPLE);
    const card = allCards(doc)[1];
    expect(card.persisted).toBe(false);
    setCardTitle(card, "给甲方发确认单（已改）");
    const text = serializeDoc(doc);
    expect(text).toContain(`- [ ] 给甲方发确认单（已改） ^${card.id}`);
    expect(text).toContain("- [ ] 整理索引文档 ^a1b2c3");
  });

  it("重复块 id 会被重建，且不再重复", () => {
    const doc = parseDoc("## A\n- [ ] 一 ^dupe1\n- [ ] 二 ^dupe1\n");
    const ids = cardIds(doc);
    expect(new Set(ids).size).toBe(2);
  });

  it("空文件与无列文件不炸", () => {
    expect(serializeDoc(parseDoc(""))).toBe("");
    expect(parseDoc("随便写的正文\n").columns).toHaveLength(0);
  });

  it("列间空行由序列化统一，列内空行不保留", () => {
    const messy = ["## A", "- [ ] 一 ^aaa111", "", "- [ ] 二 ^bbb222", "", "## B", "", "- [ ] 三 ^ccc333", ""].join("\n");
    expect(serializeDoc(parseDoc(messy))).toBe(
      ["## A", "- [ ] 一 ^aaa111", "- [ ] 二 ^bbb222", "", "## B", "- [ ] 三 ^ccc333", ""].join("\n"),
    );
  });
});

describe("ops", () => {
  it("跨列移动保持相对顺序", () => {
    const doc = parseDoc(SAMPLE);
    const [first, second] = allCards(doc);
    moveCards(doc, [first.id, second.id], 2, null);
    const moved = doc.columns[2].items.filter(isCard).map((card) => card.id);
    expect(moved).toEqual([first.id, second.id]);
    expect(doc.columns[0].items.filter(isCard)).toHaveLength(0);
  });

  it("落点是自身时保持原位", () => {
    const doc = parseDoc(SAMPLE);
    const [first, second] = allCards(doc);
    moveCards(doc, [first.id], 0, `c:${first.id}`);
    const order = doc.columns[0].items.filter(isCard).map((card) => card.id);
    expect(order).toEqual([first.id, second.id]);
  });

  it("勾选与清除已完成", () => {
    const doc = parseDoc(SAMPLE);
    const card = findCard(doc, "a1b2c3");
    expect(card).not.toBeNull();
    toggleDone(card!);
    expect(serializeDoc(doc)).toContain("- [x] 整理索引文档 ^a1b2c3");
    expect(clearDone(doc)).toBe(true);
    expect(cardIds(doc)).toHaveLength(1);
    expect(cardIds(doc)).not.toContain("a1b2c3");
    expect(cardIds(doc)).not.toContain("d4e5f6");
  });

  it("删除卡片只动卡片行", () => {
    const doc = parseDoc(SAMPLE);
    deleteCards(doc, ["a1b2c3"]);
    expect(serializeDoc(doc)).not.toContain("整理索引文档");
    expect(serializeDoc(doc).startsWith("---\nboard: true\n---")).toBe(true);
  });

  it("标题与正文分别写回", () => {
    const doc = parseDoc(SAMPLE);
    const card = allCards(doc)[0];
    expect(setCardTitle(card, card.text)).toBe(false);
    expect(setCardTitle(card, "改了标题")).toBe(true);
    expect(setCardBody(card, "第一行正文\n第二行")).toBe(true);
    const text = serializeDoc(doc);
    expect(text).toContain("- [ ] 改了标题 ^a1b2c3\n\t第一行正文\n\t第二行");
    expect(setCardBody(card, "第一行正文\n第二行")).toBe(false);
    expect(bodyForEditing(card)).toBe("第一行正文\n第二行");
  });
});

describe("filter", () => {
  const doc = parseDoc(SAMPLE);
  const card = allCards(doc)[0];
  setCardTitle(card, "整理索引文档 #文档");

  it("标签与文本都能筛", () => {
    expect(cardTags(card)).toEqual(["#文档"]);
    expect(cardMatches(card, { query: "#文", hideDone: false })).toBe(true);
    expect(cardMatches(card, { query: "索引", hideDone: false })).toBe(true);
    expect(cardMatches(card, { query: "不存在", hideDone: false })).toBe(false);
    expect(cardMatches(card, { query: "", hideDone: false })).toBe(true);
  });

  it("stripTags 只去掉标签本体", () => {
    expect(stripTags("整理索引 #文档")).toBe("整理索引");
    expect(stripTags("#a 开头 #b")).toBe("开头");
    expect(stripTags("没有标签")).toBe("没有标签");
  });

  it("隐藏已完成", () => {
    const done = findCard(doc, "d4e5f6")!;
    expect(cardMatches(done, { query: "", hideDone: true })).toBe(false);
    expect(cardMatches(done, { query: "", hideDone: false })).toBe(true);
  });
});
