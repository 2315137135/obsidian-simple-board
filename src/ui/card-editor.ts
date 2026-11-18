import { DropdownComponent, Notice, ToggleComponent, setIcon } from "obsidian";
import { stripTags } from "../board/filter";
import type { CardPatch, CardSnapshot } from "../view";

export interface CardEditorHost {
  snapshot(id: string): (CardSnapshot & { filePath: string }) | null;
  applyPatch(id: string, patch: CardPatch): void;
  remove(id: string): void;
  close(): void;
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

    this.bodyEl = this.container.createEl("textarea", {
      cls: "sb-peek-body",
      attr: { rows: "6", placeholder: "正文（Markdown，可多行）", spellcheck: "false" },
    });
    this.bodyEl.addEventListener("input", () => {
      this.autoGrow(this.bodyEl);
      this.schedule({ body: this.bodyEl.value });
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

    this.crumbEl.setText(`${card.boardName} · ${card.columnTitle}`);
    // 标题只放标题，标签由 chip 行承担；写回时再拼成一行
    this.tags = card.tags;
    if (force || document.activeElement !== this.titleEl) this.titleEl.value = stripTags(card.title);
    if (force || document.activeElement !== this.bodyEl) this.bodyEl.value = card.body;
    this.renderProps(card);
    this.renderTags();

    window.requestAnimationFrame(() => {
      this.autoGrow(this.titleEl);
      this.autoGrow(this.bodyEl);
    });
  }

  private renderProps(card: CardSnapshot): void {
    this.propsEl.empty();

    const statusRow = this.propsEl.createDiv({ cls: "sb-prop" });
    statusRow.createDiv({ cls: "sb-prop-label", text: "状态" });
    const status = statusRow.createDiv({ cls: "sb-prop-value" });
    new DropdownComponent(status)
      .addOptions(
        Object.fromEntries(
          card.columns.map((title, index) => [String(index), title || `第 ${index + 1} 列`]),
        ),
      )
      .setValue(String(card.columnIndex))
      .onChange((value) => this.schedule({ columnIndex: Number(value) }));

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
      chip.createSpan({ text: tag });
      const close = chip.createEl("button", {
        cls: "sb-tag-remove",
        attr: { "aria-label": `移除 ${tag}` },
      });
      close.textContent = "×";
      close.addEventListener("click", () => this.removeTag(tag));
    }
    this.tagsEl.appendChild(this.tagInputEl);
  }

  // ================ 编辑动作 ================

  private composeTitle(): string {
    const title = stripTags(this.titleEl.value);
    return [title, ...this.tags].filter(Boolean).join(" ");
  }

  private addTag(raw: string): void {
    const value = raw.trim().replace(/^#/, "").replace(/\s+/g, "-");
    if (!value) return;
    this.tagInputEl.value = "";
    const tag = `#${value}`;
    if (this.tags.includes(tag)) return;
    this.tags.push(tag);
    this.renderTags();
    this.flushTitle();
  }

  private removeTag(tag: string): void {
    this.tags = this.tags.filter((item) => item !== tag);
    this.renderTags();
    this.flushTitle();
  }

  private flushTitle(): void {
    this.schedule({ title: this.composeTitle() });
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
