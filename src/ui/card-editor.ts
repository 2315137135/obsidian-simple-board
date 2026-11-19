import { DropdownComponent, Notice, ToggleComponent, setIcon } from "obsidian";
import type { CardPatch, CardSnapshot } from "../view";

type BodyMode = "edit" | "preview" | "compare";

const BODY_MODES: BodyMode[] = ["edit", "preview", "compare"];
const BODY_LABEL: Record<BodyMode, string> = { edit: "编辑", preview: "预览", compare: "对比" };

export interface CardEditorHost {
  snapshot(id: string): (CardSnapshot & { filePath: string }) | null;
  applyPatch(id: string, patch: CardPatch): void;
  remove(id: string): void;
  close(): void;
  /** 把 Markdown 渲染进给定容器（正文预览用）。 */
  render(source: string, el: HTMLElement): void;
}

/**
 * 卡片编辑器：标题、状态、完成、标签、正文。
 * 只认宿主接口，自己不认识看板文件，也不持有可能过期的那份 doc。
 */
export class CardEditor {
  private cardId: string | null = null;
  private tags: string[] = [];
  private pending: CardPatch = {};
  private saveTimer: number | null = null;
  private crumbEl!: HTMLElement;
  private titleEl!: HTMLTextAreaElement;
  private propsEl!: HTMLElement;
  private tagsEl!: HTMLElement;
  private tagInputEl!: HTMLInputElement;
  private bodyEl!: HTMLTextAreaElement;
  private bodyWrapEl!: HTMLElement;
  private previewEl!: HTMLElement;
  private segButtons = new Map<BodyMode, HTMLElement>();
  private bodyMode: BodyMode = "edit";
  private previewTimer: number | null = null;

  constructor(
    private readonly container: HTMLElement,
    private readonly host: CardEditorHost,
  ) {
    this.build();
  }

  get openCardId(): string | null {
    return this.cardId;
  }

  open(cardId: string): void {
    this.cardId = cardId;
    this.render(true);
  }

  close(): void {
    this.flush();
    this.cardId = null;
    this.tags = [];
  }

  /** 看板变了：卡片没了就收起，其余字段在不抢焦点时同步。 */
  sync(): void {
    if (!this.cardId) return;
    const card = this.host.snapshot(this.cardId);
    if (!card) {
      this.close();
      this.host.close();
      return;
    }
    this.render(false);
  }

  destroy(): void {
    this.flush();
  }

  // ================ 骨架 ================

  private build(): void {
    this.container.empty();

    const head = this.container.createDiv({ cls: "sb-peek-head" });
    this.crumbEl = head.createDiv({ cls: "sb-peek-crumb" });
    const close = head.createEl("button", { cls: "sb-peek-close", attr: { "aria-label": "关闭" } });
    setIcon(close, "x");
    close.addEventListener("click", () => this.host.close());

    this.titleEl = this.container.createEl("textarea", {
      cls: "sb-peek-title",
      attr: { rows: "1", placeholder: "标题", spellcheck: "false" },
    });
    this.titleEl.addEventListener("input", () => {
      this.autoGrow(this.titleEl);
      this.schedule({ title: this.composeTitle() });
    });
    this.titleEl.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      this.flush();
    });

    this.propsEl = this.container.createDiv({ cls: "sb-props" });

    this.tagsEl = this.container.createDiv({ cls: "sb-tags" });
    this.tagInputEl = this.tagsEl.createEl("input", {
      cls: "sb-tag-input",
      attr: { type: "text", placeholder: "添加标签", spellcheck: "false" },
    });
    this.tagInputEl.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== ",") return;
      event.preventDefault();
      this.addTag(this.tagInputEl.value);
    });

    this.bodyWrapEl = this.container.createDiv({ cls: "sb-body" });
    this.bodyWrapEl.dataset.mode = "edit";

    const seg = this.bodyWrapEl.createDiv({ cls: "sb-seg" });
    for (const mode of BODY_MODES) {
      const button = seg.createEl("button", { cls: "sb-seg-btn", text: BODY_LABEL[mode] });
      if (mode === "edit") button.addClass("is-active");
      button.addEventListener("click", () => this.setBodyMode(mode));
      this.segButtons.set(mode, button);
    }

    const panes = this.bodyWrapEl.createDiv({ cls: "sb-panes" });
    this.bodyEl = panes.createEl("textarea", {
      cls: "sb-peek-body",
      attr: { rows: "6", placeholder: "正文（Markdown，可多行）", spellcheck: "false" },
    });
    this.previewEl = panes.createDiv({ cls: "sb-body-preview markdown-rendered" });

    this.bodyEl.addEventListener("input", () => {
      this.autoGrow(this.bodyEl);
      this.schedule({ body: this.bodyEl.value });
      // 对比模式边打边看，慢一点渲染，别抢输入
      if (this.bodyMode === "compare") {
        if (this.previewTimer !== null) window.clearTimeout(this.previewTimer);
        this.previewTimer = window.setTimeout(() => this.renderPreview(), 180);
      }
    });
    this.bodyEl.addEventListener("keydown", (event) => {
      if (event.key !== "Tab") return;
      event.preventDefault();
      const start = this.bodyEl.selectionStart;
      this.bodyEl.setRangeText("\t", start, this.bodyEl.selectionEnd, "end");
      this.schedule({ body: this.bodyEl.value });
    });

    const actions = this.container.createDiv({ cls: "sb-peek-actions" });
    const link = actions.createEl("button", { cls: "sb-tool", text: "复制块链接" });
    link.addEventListener("click", () => {
      const card = this.current();
      if (!card) return;
      void navigator.clipboard.writeText(`[[${card.boardName}#^${card.id}]]`);
      new Notice("已复制块链接");
    });
    const remove = actions.createEl("button", { cls: "sb-tool sb-tool-danger", text: "删除卡片" });
    remove.addEventListener("click", () => {
      if (this.cardId) this.host.remove(this.cardId);
      this.host.close();
    });
  }

  private current(): (CardSnapshot & { filePath: string }) | null {
    return this.cardId ? this.host.snapshot(this.cardId) : null;
  }

  // ================ 渲染 ================

  private render(force: boolean): void {
    const card = this.current();
    if (!card) return;

    this.crumbEl.setText(`${card.boardName} · ${card.column}`);
    // 标题框只放标题，标签是独立字段，由下面的 chip 行承担
    // 拷一份：直接引用模型数组的话，push 会绕过 setCardTags 的变更检测
    this.tags = [...card.tags];
    if (force || document.activeElement !== this.titleEl) this.titleEl.value = card.title;
    if (force || document.activeElement !== this.bodyEl) this.bodyEl.value = card.body;
    this.renderProps(card);
    this.renderTags();
    if (this.bodyMode !== "edit") this.renderPreview();

    window.requestAnimationFrame(() => {
      this.autoGrow(this.titleEl);
      this.autoGrow(this.bodyEl);
    });
  }

  /** 正文三种看法：原文、渲染结果，或左右分屏同时看。 */
  private setBodyMode(mode: BodyMode): void {
    this.bodyMode = mode;
    this.bodyWrapEl.dataset.mode = mode;
    for (const [key, button] of this.segButtons) button.toggleClass("is-active", key === mode);
    if (mode === "edit") {
      this.bodyEl.focus({ preventScroll: true });
      this.autoGrow(this.bodyEl);
      return;
    }
    this.flush();
    this.renderPreview();
    if (mode === "compare") this.autoGrow(this.bodyEl);
  }

  private renderPreview(): void {
    const text = this.bodyEl.value.trim();
    if (!text) {
      this.previewEl.empty();
      this.previewEl.createSpan({ cls: "sb-card-empty", text: "还没有正文" });
      return;
    }
    this.host.render(this.bodyEl.value, this.previewEl);
  }

  private renderProps(card: CardSnapshot): void {
    this.propsEl.empty();

    const statusRow = this.propsEl.createDiv({ cls: "sb-prop" });
    statusRow.createDiv({ cls: "sb-prop-label", text: "状态" });
    const status = statusRow.createDiv({ cls: "sb-prop-value" });
    new DropdownComponent(status)
      .addOptions(
        Object.fromEntries(card.columns.map((name) => [name, name || "未命名"])),
      )
      .setValue(card.column)
      .onChange((value) => this.schedule({ column: value }));

    const doneRow = this.propsEl.createDiv({ cls: "sb-prop" });
    doneRow.createDiv({ cls: "sb-prop-label", text: "完成" });
    const done = doneRow.createDiv({ cls: "sb-prop-value" });
    new ToggleComponent(done)
      .setValue(card.done)
      .onChange((value) => this.schedule({ done: value }));
  }

  private renderTags(): void {
    for (const chip of [...this.tagsEl.querySelectorAll(".sb-tag")]) chip.remove();
    for (const tag of this.tags) {
      const chip = this.tagsEl.createDiv({ cls: "sb-tag" });
      chip.createSpan({ text: `#${tag}` });
      const close = chip.createEl("button", {
        cls: "sb-tag-remove",
        attr: { "aria-label": `移除 #${tag}` },
      });
      setIcon(close, "x");
      close.addEventListener("click", () => this.removeTag(tag));
    }
    this.tagsEl.appendChild(this.tagInputEl);
  }

  // ================ 编辑动作 ================

  /** 标题框里手打的 `#标签` 由 setCardTitle 抽到 tags，这里只交标题原文。 */
  private composeTitle(): string {
    return this.titleEl.value.trim();
  }

  private addTag(raw: string): void {
    const value = raw.trim().replace(/^#/, "").replace(/\s+/g, "-");
    if (!value || this.tags.includes(value)) return;
    this.tagInputEl.value = "";
    this.tags.push(value);
    this.renderTags();
    this.flushTags();
    // chip 行重建会把输入框挪进 DOM，焦点会掉，粘回来好接着敲
    this.tagInputEl.focus({ preventScroll: true });
  }

  private removeTag(tag: string): void {
    this.tags = this.tags.filter((item) => item !== tag);
    this.renderTags();
    this.flushTags();
    this.tagInputEl.focus({ preventScroll: true });
  }

  private flushTags(): void {
    this.schedule({ tags: [...this.tags] });
    this.flush();
  }

  private schedule(patch: CardPatch): void {
    Object.assign(this.pending, patch);
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.flush(), 300);
  }

  private flush(): void {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const patch = this.pending;
    this.pending = {};
    if (!this.cardId || Object.keys(patch).length === 0) return;
    this.host.applyPatch(this.cardId, patch);
  }

  private autoGrow(el: HTMLTextAreaElement): void {
    if (!el.isConnected || el.clientWidth === 0) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }
}
