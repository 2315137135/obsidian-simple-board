import { FileView, MarkdownRenderer, Menu, Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type SimpleBoardPlugin from "./main";
import { EMPTY_FILTER, cardMatches, cardTags, stripTags, type FilterState } from "./board/filter";
import type { BoardDoc, Card, Column } from "./board/model";
import { allCards, findCard, findColumnOf, isCard } from "./board/model";
import {
  addColumn,
  bodyForEditing,
  clearDone,
  deleteCards,
  insertCard,
  moveCards,
  moveCardsToAdjacentColumn,
  removeColumn,
  renameColumn,
  setCardBody,
  setCardTitle,
  toggleDone,
} from "./board/ops";
import { newCard, parseDoc } from "./board/parse";
import { serializeDoc } from "./board/serialize";
import { CardEditor } from "./ui/card-editor";
import { installGestures } from "./ui/drag";
import type { BoardDensity } from "./settings";

export const VIEW_TYPE_BOARD = "simple-board-view";

/** 抽屉只读这一份投影，写入仍走 BoardView.patchCard。 */
export interface CardSnapshot {
  id: string;
  title: string;
  body: string;
  tags: string[];
  done: boolean;
  columnIndex: number;
  columnTitle: string;
  columns: string[];
  boardName: string;
}

export interface CardPatch {
  title?: string;
  body?: string;
  done?: boolean;
  columnIndex?: number;
}

const DENSITY_CLASS: Record<BoardDensity, string> = {
  comfortable: "sb-density-comfortable",
  compact: "sb-density-compact",
  single: "sb-density-single",
};

export class BoardView extends FileView {
  private doc: BoardDoc | null = null;
  private filter: FilterState = { ...EMPTY_FILTER };
  private selection = new Set<string>();
  private history: string[] = [];
  private lastSaved = "";
  private saveTimer: number | null = null;
  private editor: HTMLTextAreaElement | null = null;
  private editingId: string | null = null;
  private gesturesOff: (() => void) | null = null;
  private rootEl!: HTMLElement;
  private columnsEl!: HTMLElement;
  private searchEl!: HTMLInputElement;
  private doneEl!: HTMLButtonElement;
  private batchEl!: HTMLElement;
  private scrollLeft = 0;
  private columnScroll = new Map<number, number>();
  private peekEl!: HTMLElement;
  private cardEditor: CardEditor | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: SimpleBoardPlugin,
  ) {
    super(leaf);
  }

  override getViewType(): string {
    return VIEW_TYPE_BOARD;
  }

  override getDisplayText(): string {
    return this.file?.basename ?? "看板";
  }

  override getIcon(): string {
    return "layout-dashboard";
  }

  override canAcceptExtension(extension: string): boolean {
    return extension === "md";
  }

  // ================ 生命周期 ================

  override async onOpen(): Promise<void> {
    this.addAction("file-code", "打开为 Markdown", () => {
      const file = this.file;
      if (file) void this.plugin.openAsMarkdown(file);
    });
    this.buildShell();
    this.filter.hideDone = this.plugin.settings.hideDoneDefault;
    this.gesturesOff = installGestures({
      root: this.rootEl,
      columns: () =>
        [...this.columnsEl.querySelectorAll<HTMLElement>(".sb-column")].map((el) => ({
          index: Number(el.dataset.columnIndex),
          bodyEl: el.querySelector<HTMLElement>(".sb-col-body") ?? el,
        })),
      scroller: () => this.columnsEl,
      selected: () => this.selection,
      onCardActivate: (id, additive, region) => {
        if (additive) this.toggleSelection(id);
        // 覆盖层开着时，点任何一张卡都切到那张卡（含标题区），不要在底下改标题
        else if (region === "title" && !this.detailOpen) this.startTitleEdit(id);
        else this.openCardDetail(id);
      },
      onDrop: (ids, columnIndex, beforeKey) => this.dropCards(ids, columnIndex, beforeKey),
    });

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (!(file instanceof TFile) || file.path !== this.file?.path) return;
        void this.handleExternalChange();
      }),
    );
  }

  override async onClose(): Promise<void> {
    this.flushSave();
    this.gesturesOff?.();
    this.gesturesOff = null;
    this.cardEditor?.destroy();
    this.cardEditor = null;
  }

  override async onLoadFile(file: TFile): Promise<void> {
    await super.onLoadFile(file);
    await this.loadBoard();
  }

  override async onUnloadFile(file: TFile): Promise<void> {
    await super.onUnloadFile(file);
    this.doc = null;
    this.selection.clear();
    this.history = [];
  }

  // ================ 读写 ================

  private get boardFile(): TFile | null {
    return this.file ?? null;
  }

  private async loadBoard(): Promise<void> {
    const file = this.boardFile;
    if (!file) return;
    const text = await this.app.vault.cachedRead(file);
    this.lastSaved = text;
    this.doc = parseDoc(text);
    this.selection.clear();
    this.history = [];
    this.render();
  }

  private scheduleSave(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.flushSave(), 250);
  }

  private flushSave(): void {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    void this.save();
  }

  private async save(): Promise<void> {
    const file = this.boardFile;
    const doc = this.doc;
    if (!file || !doc) return;

    const next = serializeDoc(doc);
    if (next === this.lastSaved) return;

    let conflict = false;
    await this.app.vault.process(file, (data) => {
      if (data !== this.lastSaved) {
        conflict = true;
        return data;
      }
      return next;
    });

    if (conflict) {
      new Notice("看板文件已被外部修改，已重新载入");
      const text = await this.app.vault.read(file);
      this.lastSaved = text;
      this.doc = parseDoc(text);
      this.render();
      return;
    }
    this.lastSaved = next;
  }

  private async handleExternalChange(): Promise<void> {
    const file = this.boardFile;
    if (!file) return;
    if (this.editingId || this.saveTimer !== null) return;
    const text = await this.app.vault.cachedRead(file);
    if (text === this.lastSaved) return;
    this.lastSaved = text;
    this.doc = parseDoc(text);
    this.render();
  }

  /** 所有结构性改动的唯一入口：先存快照，再落盘，最后重绘。返回是否真的改了。 */
  private mutate(change: () => boolean | void): boolean {
    const doc = this.doc;
    if (!doc) return false;
    const before = serializeDoc(doc);
    if (change() === false) return false;
    this.history.push(before);
    if (this.history.length > 30) this.history.shift();
    this.scheduleSave();
    this.render();
    return true;
  }

  undo(): void {
    const previous = this.history.pop();
    if (previous === undefined) {
      new Notice("没有可撤销的操作");
      return;
    }
    this.doc = parseDoc(previous);
    this.selection.clear();
    this.scheduleSave();
    this.render();
  }

  // ================ 界面骨架 ================

  private buildShell(): void {
    this.contentEl.empty();
    this.contentEl.addClass("sb-root");
    this.rootEl = this.contentEl;
    this.applyDensity();

    const toolbar = this.contentEl.createDiv({ cls: "sb-toolbar" });
    this.searchEl = toolbar.createEl("input", {
      cls: "sb-search",
      attr: { type: "text", placeholder: "筛选：标题 / #标签", spellcheck: "false" },
    });
    this.searchEl.addEventListener("input", () => {
      this.filter.query = this.searchEl.value;
      this.render();
    });
    this.searchEl.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      this.searchEl.value = "";
      this.filter.query = "";
      this.render();
    });

    this.doneEl = toolbar.createEl("button", { cls: "sb-tool", text: "隐藏已完成" });
    this.doneEl.addEventListener("click", () => {
      this.filter.hideDone = !this.filter.hideDone;
      this.render();
    });

    const undoBtn = toolbar.createEl("button", { cls: "sb-tool", text: "撤销" });
    undoBtn.addEventListener("click", () => this.undo());

    this.batchEl = toolbar.createDiv({ cls: "sb-batch" });

    this.columnsEl = this.contentEl.createDiv({ cls: "sb-columns" });

    this.peekEl = this.contentEl.createDiv({ cls: "sb-peek" });
    this.cardEditor = new CardEditor(this.peekEl, {
      snapshot: (id) => this.snapshotCard(id),
      applyPatch: (id, patch) => this.applyPatch(id, patch),
      remove: (id) => this.deleteCard(id),
      close: () => this.closeDetail(),
    });

    this.registerDomEvent(document, "keydown", (event) => {
      if (event.key !== "Escape" || !this.peekEl.hasClass("is-open")) return;
      if (this.editingId) return;
      event.stopPropagation();
      this.closeDetail();
    });

    // 不用遮罩层：遮罩会吃掉卡片 hover，面板一开卡片就掉高亮，看着像卡片在动。
    // 改成捕获阶段的 pointerdown 判定，点面板外任意处收起。
    this.registerDomEvent(
      document,
      "pointerdown",
      (event) => {
        if (!this.peekEl?.hasClass("is-open")) return;
        const target = event.target as HTMLElement | null;
        if (!target) return;
        if (this.peekEl.contains(target)) return;
        // 点卡片交给卡片自己的逻辑：换标题或在覆盖层里切换卡片，不闪一次开合
        if (target.closest(".sb-card")) return;
        this.closeDetail();
      },
      true,
    );

    this.registerDomEvent(this.columnsEl, "contextmenu", (event) => {
      const cardEl = (event.target as HTMLElement | null)?.closest<HTMLElement>(".sb-card");
      if (!cardEl?.dataset.id) return;
      event.preventDefault();
      this.showCardMenu(cardEl.dataset.id, event);
    });
  }

  applyDensity(): void {
    const density = this.plugin.settings.density;
    for (const cls of Object.values(DENSITY_CLASS)) this.rootEl?.classList.remove(cls);
    this.rootEl?.addClass(DENSITY_CLASS[density]);
  }

  // ================ 渲染 ================

  private render(): void {
    if (!this.rootEl || !this.columnsEl) return;
    this.rememberScroll();
    this.doneEl?.toggleClass("is-active", this.filter.hideDone);

    const doc = this.doc;
    this.columnsEl.empty();
    if (!doc) {
      this.columnsEl.createDiv({ cls: "sb-empty", text: "打开一个带 board: true 的笔记" });
      return;
    }

    doc.columns.forEach((column, index) => this.renderColumn(column, index));

    const addColumnEl = this.columnsEl.createEl("button", { cls: "sb-add-column", text: "+ 列" });
    addColumnEl.addEventListener("click", () => {
      this.mutate(() => {
        addColumn(doc);
        return true;
      });
      const last = this.columnsEl.querySelectorAll(".sb-col-title");
      (last[last.length - 1] as HTMLElement | undefined)?.click();
    });

    this.renderBatch();
    this.restoreScroll();
    if (this.detailOpen) this.cardEditor?.sync();
  }

  private renderColumn(column: Column, index: number): void {
    const columnEl = this.columnsEl.createDiv({ cls: "sb-column" });
    columnEl.dataset.columnIndex = String(index);
    if (this.plugin.settings.hideDoneDefault) columnEl.addClass("sb-hide-done");

    const head = columnEl.createDiv({ cls: "sb-col-head" });
    const title = head.createDiv({ cls: "sb-col-title", text: column.title });
    title.addEventListener("click", () => this.editColumnTitle(column, title));

    const visible = column.items.filter(
      (item) => isCard(item) && cardMatches(item, this.filter),
    ).length;
    head.createSpan({ cls: "sb-col-count", text: String(visible) });

    const menuBtn = head.createEl("button", { cls: "sb-col-menu", attr: { "aria-label": "列操作" } });
    menuBtn.textContent = "⋯";
    menuBtn.addEventListener("click", (event) => this.showColumnMenu(index, event));

    const body = columnEl.createDiv({ cls: "sb-col-body" });
    body.dataset.columnIndex = String(index);
    for (const item of column.items) {
      if (!isCard(item) || !cardMatches(item, this.filter)) continue;
      this.renderCard(body, item);
    }

    const addCard = columnEl.createEl("button", { cls: "sb-add", text: "+ 新建卡片" });
    addCard.addEventListener("click", () => this.createCard(index));
  }

  private renderCard(parent: HTMLElement, card: Card): void {
    const el = parent.createDiv({ cls: "sb-card" });
    el.dataset.id = card.id;
    el.tabIndex = 0;
    if (this.selection.has(card.id)) el.addClass("sb-card--selected");
    if (card.done) el.addClass("sb-card--done");

    const check = el.createEl("button", {
      cls: "sb-check",
      attr: { "aria-label": "切换完成", role: "checkbox", "aria-checked": String(card.done) },
    });
    if (card.done) setIcon(check, "check");
    check.addEventListener("click", (event) => {
      event.stopPropagation();
      this.toggleCardDone(card.id);
    });

    const open = el.createEl("button", {
      cls: "sb-card-open",
      attr: { "aria-label": "打开详情", title: "打开详情" },
    });
    setIcon(open, "panel-right");
    open.addEventListener("click", (event) => {
      event.stopPropagation();
      this.openCardDetail(card.id);
    });

    const content = el.createDiv({ cls: "sb-card-content" });
    const text = content.createDiv({ cls: "sb-card-text" });
    const title = stripTags(card.text);
    if (title) {
      // 删除线交给 Markdown 的 <del>，比给容器加 text-decoration 更可靠
      const source = card.done ? `~~${title}~~` : title;
      void MarkdownRenderer.render(this.app, source, text, this.boardFile?.path ?? "", this);
    } else {
      text.createSpan({ cls: "sb-card-empty", text: "空卡片" });
    }

    if (card.body.length > 0) {
      const extra = content.createDiv({ cls: "sb-card-extra" });
      void MarkdownRenderer.render(
        this.app,
        card.body.join("\n").trim(),
        extra,
        this.boardFile?.path ?? "",
        this,
      );
    }

    const tags = cardTags(card);
    if (tags.length > 0) {
      const meta = content.createDiv({ cls: "sb-card-meta" });
      for (const tag of tags) meta.createSpan({ cls: "sb-chip", text: tag });
    }

    el.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        if (event.metaKey || event.ctrlKey) this.openCardDetail(card.id);
        else this.startTitleEdit(card.id);
      } else if (event.key === " ") {
        event.preventDefault();
        this.toggleCardDone(card.id);
      } else if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        this.removeCards([card.id]);
      }
    });
  }

  private renderBatch(): void {
    this.batchEl.empty();
    const count = this.selection.size;
    this.batchEl.toggleClass("is-visible", count > 0);
    if (count === 0) return;

    this.batchEl.createSpan({ cls: "sb-batch-count", text: `已选 ${count} 张` });
    const make = (label: string, title: string, run: () => void): void => {
      const btn = this.batchEl.createEl("button", { cls: "sb-tool", text: label, attr: { title } });
      btn.addEventListener("click", run);
    };
    const ids = [...this.selection];
    make("←", "移到左列", () => this.moveAdjacent(ids, -1));
    make("→", "移到右列", () => this.moveAdjacent(ids, 1));
    make("删除", "删除所选", () => this.removeCards(ids));
    make("取消", "清除选择", () => this.clearSelection());
  }

  private rememberScroll(): void {
    if (!this.columnsEl) return;
    this.scrollLeft = this.columnsEl.scrollLeft;
    this.columnScroll.clear();
    for (const el of this.columnsEl.querySelectorAll<HTMLElement>(".sb-column")) {
      const body = el.querySelector<HTMLElement>(".sb-col-body");
      if (body) this.columnScroll.set(Number(el.dataset.columnIndex), body.scrollTop);
    }
  }

  private restoreScroll(): void {
    this.columnsEl.scrollLeft = this.scrollLeft;
    for (const el of this.columnsEl.querySelectorAll<HTMLElement>(".sb-column")) {
      const body = el.querySelector<HTMLElement>(".sb-col-body");
      if (!body) continue;
      const saved = this.columnScroll.get(Number(el.dataset.columnIndex));
      if (saved !== undefined) body.scrollTop = saved;
    }
  }

  // ================ 编辑 ================

  /** 卡片上只改标题；正文与属性在抽屉里编。 */
  private startTitleEdit(id: string): void {
    const doc = this.doc;
    if (!doc || this.editingId === id) return;
    this.commitEdit();

    const card = findCard(doc, id);
    const el = this.columnsEl.querySelector<HTMLElement>(`.sb-card[data-id="${CSS.escape(id)}"]`);
    const textEl = el?.querySelector<HTMLElement>(".sb-card-text");
    if (!card || !textEl) return;

    this.selection.clear();

    const area = document.createElement("textarea");
    area.className = "sb-card-edit";
    area.value = card.text;
    area.spellcheck = false;
    textEl.replaceWith(area);
    // 标题输入框里已经带着标签文本，标签 chip 暂时让位
    el?.querySelector(".sb-card-meta")?.remove();

    const resize = (): void => {
      area.style.height = "auto";
      area.style.height = `${area.scrollHeight}px`;
    };
    area.addEventListener("input", resize);
    area.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.cancelEdit();
      } else if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        this.commitEdit();
      }
    });
    area.addEventListener("blur", () => {
      if (this.editor === area) this.commitEdit();
    });

    this.editor = area;
    this.editingId = id;
    area.focus();
    resize();
    window.requestAnimationFrame(resize);
    area.setSelectionRange(area.value.length, area.value.length);
  }

  private commitEdit(): void {
    const area = this.editor;
    const id = this.editingId;
    this.editor = null;
    this.editingId = null;
    if (!area || !id) return;
    const value = area.value;
    const card = this.doc ? findCard(this.doc, id) : null;
    if (!card) {
      this.render();
      return;
    }
    this.selection.delete(id);
    if (!this.mutate(() => setCardTitle(card, value))) this.render();
  }

  private cancelEdit(): void {
    this.editor = null;
    this.editingId = null;
    this.render();
  }

  private editColumnTitle(column: Column, titleEl: HTMLElement): void {
    const input = document.createElement("input");
    input.className = "sb-col-title-edit";
    input.value = column.title;
    titleEl.replaceWith(input);
    input.focus();
    input.select();

    let closed = false;
    const close = (apply: boolean): void => {
      if (closed) return;
      closed = true;
      const value = input.value.trim();
      if (!apply || !value || value === column.title) {
        this.render();
        return;
      }
      this.mutate(() => {
        renameColumn(column, value);
        return true;
      });
    };
    input.addEventListener("blur", () => close(true));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        close(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        close(false);
      }
    });
  }

  // ================ 卡片与列操作 ================

  private createCard(columnIndex: number): void {
    const doc = this.doc;
    if (!doc) return;
    const card = newCard("");
    this.mutate(() => insertCard(doc, columnIndex, card));
    this.startTitleEdit(card.id);
  }

  private toggleCardDone(id: string): void {
    const doc = this.doc;
    if (!doc) return;
    const card = findCard(doc, id);
    if (!card) return;
    this.mutate(() => {
      toggleDone(card);
      return true;
    });
  }

  private removeCards(ids: string[]): void {
    const doc = this.doc;
    if (!doc || ids.length === 0) return;
    for (const id of ids) this.selection.delete(id);
    this.mutate(() => deleteCards(doc, ids));
  }

  private dropCards(ids: string[], columnIndex: number, beforeKey: string | null): void {
    const doc = this.doc;
    if (!doc) return;
    this.selection.clear();
    this.mutate(() => moveCards(doc, ids, columnIndex, beforeKey));
  }

  private moveAdjacent(ids: string[], delta: number): void {
    const doc = this.doc;
    if (!doc) return;
    this.mutate(() => moveCardsToAdjacentColumn(doc, ids, delta));
  }

  private toggleSelection(id: string): void {
    if (this.selection.has(id)) this.selection.delete(id);
    else this.selection.add(id);
    this.render();
  }

  private clearSelection(): void {
    this.selection.clear();
    this.render();
  }

  private showCardMenu(id: string, event: MouseEvent): void {
    const doc = this.doc;
    if (!doc) return;
    const ids =
      this.selection.has(id) && this.selection.size > 1 ? [...this.selection] : [id];
    const menu = new Menu();

    menu.addItem((item) =>
      item.setTitle("打开详情").setIcon("panel-right").onClick(() => this.openCardDetail(id)),
    );
    menu.addItem((item) =>
      item.setTitle("编辑标题").setIcon("pencil").onClick(() => this.startTitleEdit(id)),
    );
    menu.addSeparator();
    menu.addItem((item) =>
      item.setTitle("移到左列").setIcon("arrow-left").onClick(() => this.moveAdjacent(ids, -1)),
    );
    menu.addItem((item) =>
      item.setTitle("移到右列").setIcon("arrow-right").onClick(() => this.moveAdjacent(ids, 1)),
    );
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle(ids.length > 1 ? `删除 ${ids.length} 张卡片` : "删除卡片")
        .setIcon("trash")
        .onClick(() => this.removeCards(ids)),
    );
    menu.addItem((item) =>
      item
        .setTitle("复制块链接")
        .setIcon("link")
        .onClick(() => {
          const base = this.file?.basename ?? "";
          void navigator.clipboard.writeText(`[[${base}#^${id}]]`);
        }),
    );
    menu.showAtMouseEvent(event);
  }

  private showColumnMenu(index: number, event: MouseEvent): void {
    const doc = this.doc;
    if (!doc) return;
    const column = doc.columns[index];
    if (!column) return;

    const menu = new Menu();
    menu.addItem((item) =>
      item.setTitle("重命名").setIcon("pencil").onClick(() => {
        const titleEl = this.columnsEl.querySelector<HTMLElement>(
          `.sb-column[data-column-index="${index}"] .sb-col-title`,
        );
        if (titleEl) this.editColumnTitle(column, titleEl);
      }),
    );
    menu.addItem((item) =>
      item.setTitle("在右侧插入列").setIcon("plus").onClick(() => {
        this.mutate(() => {
          addColumn(doc, "新列", index + 1);
          return true;
        });
      }),
    );
    menu.addItem((item) =>
      item.setTitle("清除本列已完成").setIcon("check").onClick(() => {
        this.mutate(() => clearDone(doc, index));
      }),
    );
    menu.addSeparator();
    menu.addItem((item) =>
      item.setTitle("删除本列").setIcon("trash").onClick(() => {
        this.mutate(() => {
          removeColumn(doc, index);
          return true;
        });
      }),
    );
    menu.showAtMouseEvent(event);
  }

  // ================ 外部入口 ================

  focusSearch(): void {
    this.searchEl?.focus();
  }

  // ================ 抽屉的读写接口 ================

  snapshotCard(id: string): (CardSnapshot & { filePath: string }) | null {
    const doc = this.doc;
    const file = this.file;
    if (!doc || !file) return null;
    const card = findCard(doc, id);
    if (!card) return null;
    const columnIndex = findColumnOf(doc, id);
    return {
      id,
      title: card.text,
      body: bodyForEditing(card),
      tags: cardTags(card),
      done: card.done,
      columnIndex,
      columnTitle: doc.columns[columnIndex]?.title ?? "",
      columns: doc.columns.map((column) => column.title),
      boardName: file.basename,
      filePath: file.path,
    };
  }

  applyPatch(id: string, patch: CardPatch): void {
    const doc = this.doc;
    if (!doc) return;
    const card = findCard(doc, id);
    if (!card) return;
    const applied = this.mutate(() => {
      let changed = false;
      if (patch.title !== undefined && setCardTitle(card, patch.title)) changed = true;
      if (patch.body !== undefined && setCardBody(card, patch.body)) changed = true;
      if (patch.done !== undefined && patch.done !== card.done) {
        card.done = patch.done;
        card.dirty = true;
        changed = true;
      }
      if (patch.columnIndex !== undefined && patch.columnIndex !== findColumnOf(doc, card.id)) {
        changed = moveCards(doc, [card.id], patch.columnIndex, null) || changed;
      }
      return changed;
    });
    void applied;
  }

  /** 抽屉传来的宽松 patch，字段可能一次只来一个。 */
  patchCard(id: string, patch: Record<string, unknown>): void {
    this.applyPatch(id, patch as CardPatch);
  }

  deleteCard(id: string): void {
    const doc = this.doc;
    if (!doc) return;
    this.selection.delete(id);
    this.mutate(() => deleteCards(doc, [id]));
  }

  openCardDetail(id: string): void {
    const doc = this.doc;
    if (!doc || !this.cardEditor) return;
    this.commitEdit();
    const card = findCard(doc, id);
    if (!card) return;
    // 覆盖层按块 id 认卡片；没有持久 id 的卡片先写进文件，否则重载后就对不上
    if (!card.persisted) {
      card.dirty = true;
      card.persisted = true;
      this.scheduleSave();
    }
    this.cardEditor.open(id);
    this.peekEl.addClass("is-open");
    window.requestAnimationFrame(() => {
      // preventScroll：否则聚焦会把 overflow 容器滚一下，整个看板会横向错位
      this.peekEl
        .querySelector<HTMLTextAreaElement>(".sb-peek-title")
        ?.focus({ preventScroll: true });
      this.rootEl.scrollLeft = 0;
      this.rootEl.scrollTop = 0;
    });
  }

  closeDetail(): void {
    if (!this.peekEl) return;
    this.cardEditor?.close();
    this.peekEl.removeClass("is-open");
  }

  private get detailOpen(): boolean {
    return this.peekEl?.hasClass("is-open") ?? false;
  }

  /** 供抽屉确认卡片仍在本视图里。 */
  hasCard(id: string): boolean {
    return this.doc ? findCard(this.doc, id) !== null : false;
  }

  /** 未使用但保留：抽屉可能要求刷新整表。 */
  cardCount(): number {
    return this.doc ? allCards(this.doc).length : 0;
  }
}
