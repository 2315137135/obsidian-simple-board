import {
  FileView,
  MarkdownRenderer,
  Menu,
  Notice,
  TFile,
  WorkspaceLeaf,
  normalizePath,
  setIcon,
} from "obsidian";
import type SimpleBoardPlugin from "./main";
import { EMPTY_FILTER, cardMatches, type FilterState } from "./board/filter";
import type { BoardDoc, Card } from "./board/model";
import { cardsOf, findCard, isBoardPath } from "./board/model";
import { parseBoardFile } from "./board/io";
import {
  addColumn,
  archiveCards,
  restoreCards,
  deleteCards,
  insertCard,
  moveCards,
  moveCardsToAdjacentColumn,
  moveColumn,
  removeColumn,
  renameColumn,
  setCardBody,
  setCardTitle,
  setCardTags,
  toggleDone,
} from "./board/ops";
import { newCard } from "./board/parse";
import { serializeDoc } from "./board/serialize";
import { plainText } from "./board/text";
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
  archived: boolean;
  archivedAt?: string;
  column: string;
  columns: string[];
  boardName: string;
}

export interface CardPatch {
  title?: string;
  body?: string;
  tags?: string[];
  done?: boolean;
  column?: string;
}

/** 文件名去掉 `.board.md`，剩下的就是看板名。 */
function boardName(basename: string): string {
  return basename.replace(/\.board$/i, "");
}

const DENSITY_CLASS: Record<BoardDensity, string> = {
  comfortable: "sb-density-comfortable",
  compact: "sb-density-compact",
  single: "sb-density-single",
};

export class BoardView extends FileView {
  private doc: BoardDoc | null = null;
  private loadedFile: TFile | null = null;
  private loadVersion = 0;
  private filter: FilterState = { ...EMPTY_FILTER };
  private selection = new Set<string>();
  private history: string[] = [];
  private lastSaved = "";
  private saveTimer: number | null = null;
  private editor: HTMLTextAreaElement | null = null;
  private editingId: string | null = null;
  private gesturesOff: (() => void) | null = null;
  private rootEl!: HTMLElement;
  private titleEl!: HTMLElement;
  private columnsEl!: HTMLElement;
  private searchEl!: HTMLInputElement;
  private doneEl!: HTMLButtonElement;
  private archiveEl!: HTMLButtonElement;
  private archiveOpen = false;
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
    return this.file ? boardName(this.file.basename) : "看板";
  }

  override getIcon(): string {
    return "layout-dashboard";
  }

  override canAcceptExtension(_extension: string): boolean {
    // 扩展名 md 无法区分看板和普通笔记；看板由插件按完整路径打开。
    return false;
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
      onCardActivate: (id, additive) => {
        if (additive) this.toggleSelection(id);
        // 再点一次同一张卡就收起侧栏
        else if (this.detailOpen && this.cardEditor?.openCardId === id) this.closeDetail();
        else this.openCardDetail(id);
      },
      onDrop: (ids, columnIndex, beforeKey) => this.dropCards(ids, columnIndex, beforeKey),
    });

    this.installColumnDrag();

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (!(file instanceof TFile) || file.path !== this.file?.path) return;
        void this.handleExternalChange();
      }),
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (file.path !== this.file?.path && oldPath !== this.file?.path) return;
        this.renderTitle();
      }),
    );
  }

  override async onClose(): Promise<void> {
    await this.flushSave();
    this.gesturesOff?.();
    this.gesturesOff = null;
    this.cardEditor?.destroy();
    this.cardEditor = null;
  }

  override async onLoadFile(file: TFile): Promise<void> {
    await super.onLoadFile(file);
    await this.loadBoard();
    this.syncHeaderTitle();
  }

  override async onUnloadFile(file: TFile): Promise<void> {
    this.loadVersion += 1;
    await this.flushSave();
    await super.onUnloadFile(file);
    this.loadedFile = null;
    this.doc = null;
    this.selection.clear();
    this.history = [];
  }

  // ================ 读写 ================

  private get boardFile(): TFile | null {
    const file = this.file;
    return file && isBoardPath(file.path) ? file : null;
  }

  private async loadBoard(): Promise<void> {
    const version = ++this.loadVersion;
    this.loadedFile = null;
    this.doc = null;
    const file = this.boardFile;
    if (!file) {
      this.render();
      return;
    }
    const text = await this.app.vault.cachedRead(file);
    if (version !== this.loadVersion || file !== this.boardFile) return;
    this.loadedFile = file;
    this.lastSaved = text;
    this.doc = this.parseDocument(text);
    this.selection.clear();
    this.history = [];
    this.render();
  }

  private scheduleSave(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.flushSave(), 250);
  }

  private async flushSave(): Promise<void> {
    if (this.saveTimer === null) return;
    window.clearTimeout(this.saveTimer);
    this.saveTimer = null;
    await this.save();
  }

  private async save(): Promise<void> {
    const file = this.boardFile;
    const doc = this.doc;
    if (!file || file !== this.loadedFile || !doc) return;

    const next = serializeDoc(doc);
    const previous = this.lastSaved;
    if (next === previous) return;

    let conflict = false;
    await this.app.vault.process(file, (data) => {
      if (!isBoardPath(file.path)) return data;
      if (data !== previous) {
        conflict = true;
        return data;
      }
      return next;
    });

    if (file !== this.boardFile || doc !== this.doc) return;
    if (conflict) {
      new Notice("看板文件已被外部修改，已重新载入");
      const text = await this.app.vault.read(file);
      if (file !== this.boardFile || doc !== this.doc) return;
      this.lastSaved = text;
      this.doc = this.parseDocument(text);
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
    if (file !== this.boardFile || file !== this.loadedFile) return;
    if (text === this.lastSaved) return;
    this.lastSaved = text;
    this.doc = this.parseDocument(text);
    this.render();
  }

  private parseDocument(text: string): BoardDoc | null {
    try {
      return parseBoardFile(text);
    } catch (error) {
      console.error("看板索引解析失败", error);
      new Notice("看板索引不是合法 YAML，已暂停编辑；修复文件后重新载入");
      return null;
    }
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
    this.doc = parseBoardFile(previous);
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

    this.titleEl = this.contentEl.createDiv({ cls: "sb-title", attr: { title: "点击改名" } });
    this.titleEl.addEventListener("click", () => this.startRenameBoard());

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

    this.archiveEl = toolbar.createEl("button", { cls: "sb-tool", text: "归档箱 0" });
    this.archiveEl.addEventListener("click", () => {
      this.commitEdit();
      this.closeDetail();
      this.archiveOpen = !this.archiveOpen;
      this.selection.clear();
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
      archive: (id) => this.setArchived([id], true),
      restore: (id) => this.setArchived([id], false),
      close: () => this.closeDetail(),
      render: (source, el) => this.renderMarkdown(source, el),
      bodyMode: () => this.plugin.settings.bodyMode,
      saveBodyMode: (mode) => {
        this.plugin.settings.bodyMode = mode;
        void this.plugin.saveSettings();
      },
    });
    this.installPeekResize();
    this.applyPeekWidth();

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

  // ================ 侧栏宽度 ================

  private applyPeekWidth(): void {
    this.rootEl?.style.setProperty("--sb-peek-width", `${this.plugin.settings.peekWidth}px`);
  }

  private installPeekResize(): void {
    const grip = this.peekEl.createDiv({ cls: "sb-peek-grip", attr: { title: "拖动调整宽度" } });
    this.registerDomEvent(grip, "pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = this.peekEl.getBoundingClientRect().width;
      const max = Math.max(360, window.innerWidth * 0.9);

      const onMove = (move: PointerEvent): void => {
        const next = Math.min(max, Math.max(320, startWidth + (startX - move.clientX)));
        this.peekEl.style.width = `${next}px`;
      };
      const finish = (): void => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
        const width = Math.round(this.peekEl.getBoundingClientRect().width);
        this.peekEl.style.width = "";
        this.plugin.settings.peekWidth = width;
        this.applyPeekWidth();
        void this.plugin.saveSettings();
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
    });
  }

  // ================ 列拖拽换序 ================

  private installColumnDrag(): void {
    this.registerDomEvent(this.columnsEl, "pointerdown", (event) => {
      if (event.button !== 0 || event.pointerType === "touch") return;
      const target = event.target as HTMLElement | null;
      if (!target || target.closest("button, input, .sb-col-title-edit")) return;
      const head = target.closest<HTMLElement>(".sb-col-head");
      const columnEl = head?.closest<HTMLElement>(".sb-column");
      if (!head || !columnEl) return;

      const from = Number(columnEl.dataset.columnIndex);
      const rect = this.columnsEl.getBoundingClientRect();
      const bar = document.createElement("div");
      bar.className = "sb-col-drop";
      let to: number | null = null;
      let moved = false;
      const startX = event.clientX;

      const onMove = (move: PointerEvent): void => {
        if (!moved && Math.abs(move.clientX - startX) < 6) return;
        if (!moved) {
          moved = true;
          columnEl.addClass("sb-column--dragging");
          this.columnsEl.appendChild(bar);
        }
        const columns = [...this.columnsEl.querySelectorAll<HTMLElement>(".sb-column")];
        let index = columns.length;
        for (const [i, el] of columns.entries()) {
          const box = el.getBoundingClientRect();
          if (move.clientX < box.left + box.width / 2) {
            index = i;
            break;
          }
        }
        if (index === to) return;
        to = index;
        const edge = columns[Math.min(index, columns.length - 1)];
        const box = edge.getBoundingClientRect();
        const x = index >= columns.length ? box.right : box.left;
        bar.style.left = `${x - rect.left + this.columnsEl.scrollLeft + (index >= columns.length ? -1 : -2)}px`;
      };

      const finish = (): void => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
        columnEl.removeClass("sb-column--dragging");
        bar.remove();
        if (!moved || to === null) return;
        const index = to > from ? to - 1 : to;
        if (index === from) return;
        this.mutate(() => {
          const doc = this.doc;
          return doc ? moveColumn(doc, from, index) : false;
        });
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
    });
  }

  private renderMarkdown(source: string, el: HTMLElement): void {
    el.empty();
    void MarkdownRenderer.render(this.app, source, el, this.boardFile?.path ?? "", this);
  }

  applyDensity(): void {
    const density = this.plugin.settings.density;
    for (const cls of Object.values(DENSITY_CLASS)) this.rootEl?.classList.remove(cls);
    this.rootEl?.addClass(DENSITY_CLASS[density]);
  }

  // ================ 渲染 ================

  private render(): void {
    if (!this.rootEl || !this.columnsEl) return;
    this.renderTitle();
    this.rememberScroll();
    this.doneEl?.toggleClass("is-active", this.filter.hideDone && !this.archiveOpen);
    this.doneEl.disabled = this.archiveOpen;
    this.archiveEl.setText(this.archiveOpen ? "返回看板" : `归档箱 ${this.doc?.archived.length ?? 0}`);
    this.archiveEl.toggleClass("is-active", this.archiveOpen);
    this.searchEl.placeholder = this.archiveOpen ? "搜索归档：标题 / #标签 / 正文" : "筛选：标题 / #标签";
    this.columnsEl.toggleClass("sb-archive", this.archiveOpen);

    const doc = this.doc;
    this.columnsEl.empty();
    if (!doc) {
      this.columnsEl.createDiv({ cls: "sb-empty", text: this.file ? "看板无法读取，请检查 YAML 索引" : "打开一个 .board.md 文件" });
      return;
    }

    if (this.archiveOpen) {
      this.renderArchive(doc);
      this.renderBatch();
      if (this.detailOpen) this.cardEditor?.sync();
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

  /** 视图头与标签页的标题在拿到 file 之前就渲染过一次，这里补一次真实名字。 */
  private syncHeaderTitle(): void {
    const name = this.file ? boardName(this.file.basename) : "看板";
    this.containerEl.querySelector<HTMLElement>(".view-header-title")?.setText(name);
    (this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
  }

  private renderTitle(): void {
    if (!this.titleEl) return;
    this.titleEl.setText(this.file ? boardName(this.file.basename) : "看板");
  }

  // ================ 改名 ================

  /** 看板名就是文件名：点标题改名，改完同步到文件。 */
  private startRenameBoard(): void {
    const file = this.boardFile;
    if (!file || this.titleEl.querySelector("input")) return;
    const current = boardName(file.basename);

    const input = document.createElement("input");
    input.className = "sb-title-edit";
    input.value = current;
    this.titleEl.replaceChildren(input);
    input.focus();
    input.select();

    let done = false;
    const finish = (apply: boolean): void => {
      if (done) return;
      done = true;
      const value = input.value.trim();
      this.renderTitle();
      if (apply && value && value !== current) void this.renameBoard(file, value);
    };
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        finish(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
      }
    });
  }

  private async renameBoard(file: TFile, value: string): Promise<void> {
    const base = value.replace(/\.board(\.md)?$/i, "").trim();
    if (!base) return;
    const parent = file.parent?.path ?? "";
    const path = normalizePath(`${parent ? `${parent}/` : ""}${base}.board.md`);
    if (path === file.path) return;
    if (this.app.vault.getAbstractFileByPath(path)) {
      new Notice("同名文件已存在");
      return;
    }
    try {
      await this.app.fileManager.renameFile(file, path);
    } catch (error) {
      console.error("重命名看板失败", error);
      new Notice("重命名失败");
      return;
    }
    this.renderTitle();
    this.syncHeaderTitle();
  }

  private renderArchive(doc: BoardDoc): void {
    const cards = doc.archived.filter((card) => cardMatches(card, { ...this.filter, hideDone: false }));
    this.columnsEl.createDiv({ cls: "sb-archive-heading", text: `归档箱 · ${cards.length} / ${doc.archived.length}` });
    if (!cards.length) this.columnsEl.createDiv({ cls: "sb-empty", text: doc.archived.length ? "没有匹配的归档卡片" : "归档箱是空的" });
    for (const card of cards) {
      this.renderCard(this.columnsEl, card);
      const el = this.columnsEl.lastElementChild as HTMLElement;
      el.createDiv({ cls: "sb-archive-meta", text: `${card.archivedAt ?? "归档日期未记录"} · ${card.column}` });
      const restore = el.createEl("button", { cls: "sb-tool sb-archive-restore", text: "恢复" });
      restore.addEventListener("click", () => this.setArchived([card.id], false));
    }
  }

  private renderColumn(column: string, index: number): void {
    const doc = this.doc;
    if (!doc) return;
    const columnEl = this.columnsEl.createDiv({ cls: "sb-column" });
    columnEl.dataset.columnIndex = String(index);
    if (this.plugin.settings.hideDoneDefault) columnEl.addClass("sb-hide-done");

    const head = columnEl.createDiv({ cls: "sb-col-head" });
    const title = head.createDiv({ cls: "sb-col-title", text: column });
    title.addEventListener("click", () => this.editColumnTitle(column, title));

    const cards = cardsOf(doc, column);
    const visible = cards.filter((card) => cardMatches(card, this.filter)).length;
    head.createSpan({ cls: "sb-col-count", text: String(visible) });

    const menuBtn = head.createEl("button", { cls: "sb-col-menu", attr: { "aria-label": "列操作" } });
    menuBtn.textContent = "⋯";
    menuBtn.addEventListener("click", (event) => this.showColumnMenu(column, event));

    const body = columnEl.createDiv({ cls: "sb-col-body" });
    body.dataset.columnIndex = String(index);
    for (const card of cards) {
      if (!cardMatches(card, this.filter)) continue;
      this.renderCard(body, card);
    }

    const addCard = columnEl.createEl("button", { cls: "sb-add", text: "+ 新建卡片" });
    addCard.addEventListener("click", () => this.createCard(column));
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

    const edit = el.createEl("button", {
      cls: "sb-card-edit-btn",
      attr: { "aria-label": "编辑标题", title: "编辑标题" },
    });
    setIcon(edit, "pencil");
    edit.addEventListener("click", (event) => {
      event.stopPropagation();
      this.startTitleEdit(card.id);
    });

    const content = el.createDiv({ cls: "sb-card-content" });
    const text = content.createDiv({ cls: "sb-card-text" });
    // 卡片上只用纯文本：渲染过的正文会比标题还像标题
    if (card.title) {
      text.setText(card.title);
    } else {
      text.createSpan({ cls: "sb-card-empty", text: "空卡片" });
    }

    const preview = plainText(card.body);
    if (preview !== "") {
      content.createDiv({ cls: "sb-card-extra", text: preview });
    }

    if (card.tags.length > 0) {
      const meta = content.createDiv({ cls: "sb-card-meta" });
      for (const tag of card.tags) meta.createSpan({ cls: "sb-chip", text: `#${tag}` });
    }

    el.addEventListener("keydown", (event) => {
      // 只响应卡片自己的按键，别把输入框里的 Backspace 当成删卡片
      if (event.target !== el) return;
      if (event.key === "Enter") {
        event.preventDefault();
        if (event.metaKey || event.ctrlKey) this.startTitleEdit(card.id);
        else this.openCardDetail(card.id);
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
    if (!this.archiveOpen) {
      make("←", "移到左列", () => this.moveAdjacent(ids, -1));
      make("→", "移到右列", () => this.moveAdjacent(ids, 1));
    }
    make(this.archiveOpen ? "恢复" : "归档", "处理所选卡片", () => this.setArchived(ids, !this.archiveOpen));
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

  /** 卡片上只改标题（不含标签）；正文、标签与属性在侧栏里编。 */
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
    // 输入框里只有标题，标签仍由下面的 chip 行显示
    area.value = card.title;
    area.spellcheck = false;
    textEl.replaceWith(area);

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
    // setCardTitle 会把手打的 #标签 抽到 tags 里，标题只留正文
    if (!this.mutate(() => setCardTitle(card, value))) this.render();
  }

  private cancelEdit(): void {
    this.editor = null;
    this.editingId = null;
    this.render();
  }

  private editColumnTitle(column: string, titleEl: HTMLElement): void {
    const input = document.createElement("input");
    input.className = "sb-col-title-edit";
    input.value = column;
    titleEl.replaceWith(input);
    input.focus();
    input.select();

    let closed = false;
    const close = (apply: boolean): void => {
      if (closed) return;
      closed = true;
      const value = input.value.trim();
      if (!apply || !value || value === column) {
        this.render();
        return;
      }
      const doc = this.doc;
      this.mutate(() => {
        if (!doc) return false;
        if (!renameColumn(doc, column, value)) {
          new Notice("列名重复或为空");
          return false;
        }
        return true;
      });
      this.render();
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

  private createCard(column: string): void {
    const doc = this.doc;
    if (!doc) return;
    const card = newCard(column);
    this.mutate(() => insertCard(doc, column, card));
    this.startTitleEdit(card.id);
  }

  private setArchived(ids: string[], archived: boolean): void {
    this.commitEdit();
    this.cardEditor?.flush();
    const doc = this.doc;
    if (!doc) return;
    const cards = (archived ? doc.cards : doc.archived).filter((card) => ids.includes(card.id));
    if (!cards.length) return;
    if (!archived && !doc.columns.length) {
      new Notice("请先返回看板新建一列，再恢复卡片");
      return;
    }
    const fallback = !archived && cards.some((card) => !doc.columns.includes(card.column));
    const count = cards.length;
    this.selection.clear();
    if (this.cardEditor?.openCardId && ids.includes(this.cardEditor.openCardId)) this.closeDetail();
    if (this.mutate(() => archived ? archiveCards(doc, ids) : restoreCards(doc, ids))) {
      new Notice(`已${archived ? "归档" : "恢复"} ${count} 张卡片，可撤销${fallback ? `；原列已删除的卡片恢复至「${doc.columns[0]}」` : ""}`);
    }
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

  private dropCards(ids: string[], columnIndex: number, beforeId: string | null): void {
    const doc = this.doc;
    if (!doc) return;
    this.selection.clear();
    const column = doc.columns[columnIndex];
    if (!column) return;
    this.mutate(() => moveCards(doc, ids, column, beforeId));
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
      item.setTitle("打开/关闭详情").setIcon("panel-right").onClick(() => {
        if (this.cardEditor?.openCardId === id) this.closeDetail();
        else this.openCardDetail(id);
      }),
    );
    menu.addItem((item) =>
      item.setTitle("编辑标题").setIcon("pencil").onClick(() => this.startTitleEdit(id)),
    );
    menu.addSeparator();
    if (!this.archiveOpen) {
      menu.addItem((item) =>
        item.setTitle("移到左列").setIcon("arrow-left").onClick(() => this.moveAdjacent(ids, -1)),
      );
      menu.addItem((item) =>
        item.setTitle("移到右列").setIcon("arrow-right").onClick(() => this.moveAdjacent(ids, 1)),
      );
    }
    menu.addItem((item) => item
      .setTitle(`${this.archiveOpen ? "恢复" : "归档"} ${ids.length} 张卡片`)
      .setIcon(this.archiveOpen ? "archive-restore" : "archive")
      .onClick(() => this.setArchived(ids, !this.archiveOpen)));
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

  private showColumnMenu(column: string, event: MouseEvent): void {
    const doc = this.doc;
    if (!doc) return;
    const index = doc.columns.indexOf(column);
    if (index < 0) return;

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
      item.setTitle(`归档本列已完成（${cardsOf(doc, column).filter((card) => card.done).length} 张）`).setIcon("archive").onClick(() => {
        this.setArchived(cardsOf(doc, column).filter((card) => card.done).map((card) => card.id), true);
      }),
    );
    menu.addSeparator();
    menu.addItem((item) =>
      item.setTitle("删除本列").setIcon("trash").onClick(() => {
        this.mutate(() => removeColumn(doc, column));
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
    return {
      id,
      title: card.title,
      body: card.body,
      tags: card.tags,
      done: card.done,
      archived: doc.archived.includes(card),
      archivedAt: card.archivedAt,
      column: card.column,
      columns: doc.columns,
      boardName: file.basename.replace(/\.board$/, ""),
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
      if (patch.tags !== undefined && setCardTags(card, patch.tags)) changed = true;
      if (patch.column !== undefined && patch.column !== card.column) {
        if (doc.archived.includes(card) && doc.columns.includes(patch.column)) {
          card.column = patch.column;
          card.dirty = true;
          changed = true;
        } else changed = moveCards(doc, [card.id], patch.column, null) || changed;
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
    const archived = doc.archived.includes(card);
    if (this.archiveOpen !== archived) {
      this.archiveOpen = archived;
      this.selection.clear();
      this.render();
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
    return this.doc ? this.doc.cards.length : 0;
  }
}
