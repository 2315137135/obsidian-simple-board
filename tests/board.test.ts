import { load as yamlLoad } from "js-yaml";
import { describe, expect, it } from "vitest";
import { cardMatches, readTags, withoutTags } from "../src/board/filter";
import {
  cardsOf,
  findCard,
  isBoardPath,
  FORMAT_VERSION,
  type BoardDoc,
} from "../src/board/model";
import {
  addColumn,
  archiveCards,
  restoreCards,
  clearDone,
  deleteCards,
  insertCard,
  moveCards,
  moveCardsToAdjacentColumn,
  removeColumn,
  renameColumn,
  setCardBody,
  setCardTags,
  setCardTitle,
  toggleDone,
} from "../src/board/ops";
import { buildDoc, newCard, splitBoard } from "../src/board/parse";
import { serializeDoc } from "../src/board/serialize";

/** 测试里替掉 Obsidian 的 parseYaml：同一套切分 + 归一，只是换了 YAML 解析器。 */
function load(text: string): BoardDoc {
  const parts = splitBoard(text);
  const data = parts.yaml === null ? null : yamlLoad(parts.yaml);
  return buildDoc(data, parts, parts.archiveYaml === null ? null : yamlLoad(parts.archiveYaml));
}

function makeDoc(): BoardDoc {
  return {
    version: FORMAT_VERSION,
    columns: ["待办", "进行中", "已完成"],
    cards: [],
    archived: [],
    orphans: [],
  };
}

function add(doc: BoardDoc, column: string, title: string, extra: Partial<{ done: boolean }> = {}) {
  const card = newCard(column, title, extra.done ?? false);
  card.persisted = true;
  doc.cards.push(card);
  return card;
}

describe("文件格式", () => {
  it("后缀即身份", () => {
    expect(isBoardPath("a/项目看板.board.md")).toBe(true);
    expect(isBoardPath("a/项目看板.md")).toBe(false);
  });

  it("结构块每张卡一行，正文跟在后面", () => {
    const doc = makeDoc();
    const card = add(doc, "待办", "补齐演示场景");
    card.tags = ["声呐"];
    card.body = "第一行\n第二行";

    const text = serializeDoc(doc);
    expect(text).toContain("```yaml board");
    expect(text.split("\n").filter((line) => line.startsWith("  - {"))).toHaveLength(1);
    expect(text).toContain(`<!--card ${card.id}-->`);
    expect(text).toContain("第一行\n第二行");
    expect(text.endsWith("\n")).toBe(true);
  });

  it("写出去的文件能被解析回来", () => {
    const doc = makeDoc();
    const one = add(doc, "待办", "补齐演示场景");
    one.tags = ["声呐", "视觉"];
    one.body = "正文第一行\n\n正文第三行";
    add(doc, "进行中", "索引文档交接", { done: true });

    const back = load(serializeDoc(doc));
    expect(back.columns).toEqual(doc.columns);
    expect(back.cards.map((card) => card.title)).toEqual(["补齐演示场景", "索引文档交接"]);
    expect(findCard(back, one.id)?.tags).toEqual(["声呐", "视觉"]);
    expect(findCard(back, one.id)?.body).toBe("正文第一行\n\n正文第三行");
    expect(back.cards[1].done).toBe(true);
  });

  it("标题里的冒号、井号不会让 YAML 破形", () => {
    const doc = makeDoc();
    add(doc, "待办", "视觉整理：材质、灯光 #不是标签的味道");
    const back = load(serializeDoc(doc));
    expect(back.cards[0].title).toBe("视觉整理：材质、灯光 #不是标签的味道");
  });

  it("换列只改那一行的 column 字段", () => {
    const doc = makeDoc();
    const a = add(doc, "待办", "卡片甲");
    a.body = "很长的正文\n第二行\n第三行";
    add(doc, "待办", "卡片乙");

    const before = serializeDoc(doc).split("\n");
    moveCards(doc, [a.id], "进行中", null);
    const after = serializeDoc(doc).split("\n");

    const changed = before.filter((line, index) => line !== after[index]).length;
    expect(changed).toBeLessThanOrEqual(2);
    expect(after.join("\n")).toContain("column: 进行中");
    // 正文段落没有跟着搬
    expect(after.join("\n")).toContain(`<!--card ${a.id}-->\n很长的正文`);
  });

  it("未改动的卡片复用原始行", () => {
    const source = [
      "```yaml board",
      "version: 1",
      "columns: [待办]",
      "cards:",
      "  - {id: abc123, column: 待办, title: 手写格式}",
      "```",
      "",
    ].join("\n");
    const doc = load(source);
    const saved = serializeDoc(doc);
    expect(saved).toContain("  - {id: abc123, column: 待办, title: 手写格式}");
    expect(serializeDoc(load(saved))).toBe(saved);
  });

  it("认得出手写的块式写法，保存时改成一行", () => {
    const source = [
      "```yaml board",
      "version: 1",
      "columns: [待办, 进行中]",
      "cards:",
      "  - id: abc123",
      "    column: 待办",
      "    title: 块式写的卡",
      "```",
      "",
    ].join("\n");
    const doc = load(source);
    expect(doc.cards[0].title).toBe("块式写的卡");
    const text = serializeDoc(doc);
    // 原始多行写法没被当成一行缓存住
    expect(text).toContain("{id: abc123, column: 待办, title: 块式写的卡}");
  });

  it("列名对不上时归到第一列并标脏", () => {
    const source = [
      "```yaml board",
      "version: 1",
      "columns: [待办]",
      "cards:",
      "  - {id: abc123, column: 不存在的列, title: 迷路的卡}",
      "```",
      "",
    ].join("\n");
    const doc = load(source);
    expect(doc.cards[0].column).toBe("待办");
    expect(doc.cards[0].dirty).toBe(true);
  });

  it("没有 id 的卡片补一个，且不重复", () => {
    const source = [
      "```yaml board",
      "version: 1",
      "columns: [待办]",
      "cards:",
      "  - {column: 待办, title: 甲}",
      "  - {column: 待办, title: 乙}",
      "```",
      "",
    ].join("\n");
    const doc = load(source);
    expect(doc.cards).toHaveLength(2);
    expect(doc.cards[0].id).not.toBe(doc.cards[1].id);
    expect(doc.cards.every((card) => card.persisted === false)).toBe(true);
  });

  it("只改一张卡时，其余卡片的原始行不会被错位复用", () => {
    const source = [
      "```yaml board",
      "version: 1",
      "columns: [待办, 进行中]",
      "cards:",
      "  - {id: aaa111, column: 待办, title: 甲}",
      "  - {id: bbb222, column: 待办, title: 乙}",
      "  - {id: ccc333, column: 进行中, title: 丙}",
      "```",
      "",
    ].join("\n");
    const doc = load(source);
    toggleDone(doc.cards[0]);
    const back = load(serializeDoc(doc));
    expect(back.cards.map((card) => card.id)).toEqual(["aaa111", "bbb222", "ccc333"]);
    expect(back.cards.map((card) => card.title)).toEqual(["甲", "乙", "丙"]);
  });

  it("认不出的段落原样保留", () => {
    const source = [
      "```yaml board",
      "version: 1",
      "columns: [待办]",
      "cards: []",
      "```",
      "",
      "手写的一段备注，别在保存时吃掉。",
      "",
    ].join("\n");
    const doc = load(source);
    expect(serializeDoc(doc)).toContain("手写的一段备注，别在保存时吃掉。");
  });

  it("找不到卡片的正文段落不会丢", () => {
    const source = [
      "```yaml board",
      "version: 1",
      "columns: [待办]",
      "cards: []",
      "```",
      "",
      "<!--card ghost1-->",
      "孤儿正文",
      "<!--/card-->",
      "",
    ].join("\n");
    const text = serializeDoc(load(source));
    expect(text).toContain("孤儿正文");
  });

  it("正文段落按卡片 id 对上", () => {
    const source = [
      "```yaml board",
      "version: 1",
      "columns: [待办]",
      "cards:",
      "  - {id: abc123, column: 待办, title: 甲}",
      "```",
      "",
      "<!--card abc123-->",
      "正文",
      "<!--/card-->",
      "",
    ].join("\n");
    const doc = load(source);
    expect(doc.cards[0].body).toBe("正文");
  });
});

describe("归档与按需阅读", () => {
  const source = [
    "```yaml board", "version: 1", "columns: [待办, 已完成]", "cards:",
    "  - {id: a1, column: 待办, title: 当前任务}",
    "  - {id: a2, column: 已完成, title: 已验收, done: true}", "```", "",
    "<!--card a2-->", "", "保留末尾空格  ", "", "<!--/card-->", "",
    "手写备注", "", "<!--card a1-->", "当前正文", "<!--/card-->", "",
    "<!--card ghost-->", "未挂接正文", "<!--/card-->", "",
  ].join("\n");
  const bodyArea = (text: string): string => text.split("<!--board:bodies-start-->\n")[1].split("\n```yaml board-archive")[0];

  it("归档、换列、恢复只移动索引，正文与孤立段落保持原样", () => {
    const doc = load(source);
    const before = serializeDoc(doc);
    expect(archiveCards(doc, ["a2"], "2026-11-25")).toBe(true);
    const archived = serializeDoc(doc);
    expect(archived.split("<!--board:active-end-->")[0]).not.toContain("id: a2");
    expect(bodyArea(archived)).toBe(bodyArea(before));
    expect(archived).toContain("保留末尾空格  \n\n<!--/card-->");
    const reopened = load(archived);
    expect(reopened.archived[0]).toMatchObject({ id: "a2", done: true, archivedAt: "2026-11-25" });
    expect(serializeDoc(reopened)).toBe(archived);
    moveCards(reopened, ["a1"], "已完成", null);
    expect(restoreCards(reopened, ["a2"])).toBe(true);
    const restored = serializeDoc(reopened);
    expect(bodyArea(restored)).toBe(bodyArea(before));
    expect(load(restored).archived).toEqual([]);
    expect(restored).not.toContain("archived_at:");
  });

  it("头部补白、全归档与原列删除后的恢复能往返", () => {
    const doc = load(source);
    archiveCards(doc, ["a1", "a2"]);
    removeColumn(doc, "已完成");
    const saved = serializeDoc(doc);
    expect(saved.split("\n").slice(0, 100).join("\n")).not.toContain("当前正文");
    expect(saved).toContain("cards: []");
    const reopened = load(saved);
    expect(reopened.archived).toHaveLength(2);
    expect(reopened.archived[1].column).toBe("已完成");
    restoreCards(reopened, ["a2"]);
    expect(reopened.cards[0]).toMatchObject({ id: "a2", column: "待办", done: true });
    expect(load(serializeDoc(reopened)).archived).toHaveLength(1);
  });
});

describe("卡片操作", () => {
  it("换列并落到指定卡片之前", () => {
    const doc = makeDoc();
    const a = add(doc, "待办", "甲");
    const b = add(doc, "进行中", "乙");
    const c = add(doc, "进行中", "丙");

    moveCards(doc, [a.id], "进行中", c.id);
    expect(a.column).toBe("进行中");
    expect(doc.cards.map((card) => card.title)).toEqual(["乙", "甲", "丙"]);
    expect(cardsOf(doc, "进行中").map((card) => card.id)).toEqual([b.id, a.id, c.id]);
  });

  it("拖到自己头上时顺序不乱", () => {
    const doc = makeDoc();
    const a = add(doc, "待办", "甲");
    const b = add(doc, "待办", "乙");
    moveCards(doc, [a.id], "待办", a.id);
    expect(doc.cards.map((card) => card.id)).toEqual([a.id, b.id]);
  });

  it("相邻列移动遇到边界不动", () => {
    const doc = makeDoc();
    const a = add(doc, "待办", "甲");
    expect(moveCardsToAdjacentColumn(doc, [a.id], -1)).toBe(false);
    expect(a.column).toBe("待办");
  });

  it("标题里手打的标签抽到 tags", () => {
    const doc = makeDoc();
    const card = add(doc, "待办", "旧标题");
    setCardTitle(card, "视觉整理 #视觉 #声呐");
    expect(card.title).toBe("视觉整理");
    expect(card.tags).toEqual(["视觉", "声呐"]);
  });

  it("标签独立增删", () => {
    const doc = makeDoc();
    const card = add(doc, "待办", "甲");
    setCardTags(card, ["声呐", "#视觉", "声呐"]);
    expect(card.tags).toEqual(["声呐", "视觉"]);
  });

  it("正文去掉尾部空行", () => {
    const doc = makeDoc();
    const card = add(doc, "待办", "甲");
    setCardBody(card, "\n第一行\n第二行\n\n");
    expect(card.body).toBe("第一行\n第二行");
  });

  it("改列名会连带改卡片引用", () => {
    const doc = makeDoc();
    const card = add(doc, "待办", "甲");
    expect(renameColumn(doc, "待办", "待处理")).toBe(true);
    expect(doc.columns[0]).toBe("待处理");
    expect(card.column).toBe("待处理");
  });

  it("列名重复时改名失败", () => {
    const doc = makeDoc();
    expect(renameColumn(doc, "待办", "进行中")).toBe(false);
    expect(doc.columns).toEqual(["待办", "进行中", "已完成"]);
  });

  it("删列连带删掉列里的卡片", () => {
    const doc = makeDoc();
    add(doc, "待办", "甲");
    add(doc, "进行中", "乙");
    removeColumn(doc, "待办");
    expect(doc.columns).toEqual(["进行中", "已完成"]);
    expect(doc.cards.map((card) => card.title)).toEqual(["乙"]);
  });

  it("新建列名不重复", () => {
    const doc = makeDoc();
    expect(addColumn(doc, "待办")).toBe("待办 2");
  });

  it("删除、勾选、清空已完成", () => {
    const doc = makeDoc();
    const a = add(doc, "待办", "甲");
    const b = add(doc, "进行中", "乙", { done: true });
    expect(deleteCards(doc, [a.id])).toBe(true);
    expect(doc.cards).toHaveLength(1);
    toggleDone(b);
    expect(b.done).toBe(false);
    b.done = true;
    expect(clearDone(doc, "进行中")).toBe(true);
    expect(doc.cards).toHaveLength(0);
  });

  it("插入卡片必须落在已有的列里", () => {
    const doc = makeDoc();
    expect(insertCard(doc, "不存在", newCard("不存在", "甲"))).toBe(false);
    expect(insertCard(doc, "待办", newCard("待办", "乙"))).toBe(true);
  });
});

describe("过滤", () => {
  const doc = makeDoc();
  const card = add(doc, "待办", "补齐演示场景");
  card.tags = ["声呐"];
  card.body = "复用现有车体与管道";

  it("按标题、正文、标签过滤", () => {
    expect(cardMatches(card, { query: "管道", hideDone: false })).toBe(true);
    expect(cardMatches(card, { query: "#声", hideDone: false })).toBe(true);
    expect(cardMatches(card, { query: "#视觉", hideDone: false })).toBe(false);
    expect(cardMatches(card, { query: "场景 车体", hideDone: false })).toBe(true);
  });

  it("隐藏已完成", () => {
    const done = add(doc, "已完成", "收尾", { done: true });
    expect(cardMatches(done, { query: "", hideDone: true })).toBe(false);
  });

  it("标签抽取", () => {
    expect(readTags("标题 #甲 尾 #乙")).toEqual(["甲", "乙"]);
    expect(withoutTags("标题 #甲 尾 #乙")).toBe("标题 尾");
  });
});
