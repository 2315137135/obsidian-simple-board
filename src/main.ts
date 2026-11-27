import { MarkdownView, Plugin, TFolder, TFile, normalizePath } from "obsidian";
import { FORMAT_VERSION, isBoardPath, type BoardDoc } from "./board/model";
import { newCard } from "./board/parse";
import { serializeDoc } from "./board/serialize";
import {
  BoardSettingTab,
  DEFAULT_SETTINGS,
  isBodyMode,
  type BoardSettings,
} from "./settings";
import { BoardView, VIEW_TYPE_BOARD } from "./view";

export default class SimpleBoardPlugin extends Plugin {
  override settings: BoardSettings = { ...DEFAULT_SETTINGS };
  private switching = false;
  /** 用户明确要求用 Markdown 打开的文件，别再自动切回看板。 */
  private markdownPref = new Set<string>();

  override async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(VIEW_TYPE_BOARD, (leaf) => new BoardView(leaf, this));

    this.addRibbonIcon("layout-dashboard", "新建看板", () => void this.createBoard());
    this.addCommand({
      id: "create-board",
      name: "新建看板",
      callback: () => void this.createBoard(),
    });
    this.addCommand({
      id: "open-as-board",
      name: "打开为看板",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !isBoardPath(file.path)) return false;
        if (!checking) void this.openAsBoard(file);
        return true;
      },
    });
    this.addCommand({
      id: "open-as-markdown",
      name: "打开为 Markdown",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !isBoardPath(file.path)) return false;
        if (!checking) void this.openAsMarkdown(file);
        return true;
      },
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (file instanceof TFolder) {
          menu.addItem((item) =>
            item
              .setTitle("新建看板")
              .setIcon("layout-dashboard")
              .onClick(() => void this.createBoard(file.path)),
          );
          this.groupWithNewItems("新建看板", "新建笔记");
          return;
        }
        if (!(file instanceof TFile) || !isBoardPath(file.path)) return;
        menu.addItem((item) =>
          item
            .setTitle("打开为看板")
            .setIcon("layout-dashboard")
            .onClick(() => void this.openAsBoard(file)),
        );
        menu.addItem((item) =>
          item
            .setTitle("打开为 Markdown")
            .setIcon("file-text")
            .onClick(() => void this.openAsMarkdown(file)),
        );
      }),
    );

    this.addSettingTab(new BoardSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(this.app.workspace.on("file-open", (file) => void this.syncView(file)));
      // 启动时 file-open 可能早于视图就位，换叶子时再补一次
      this.registerEvent(
        this.app.workspace.on("active-leaf-change", () =>
          void this.syncView(this.app.workspace.getActiveFile()),
        ),
      );
      void this.syncView(this.app.workspace.getActiveFile());
    });
  }

  override onunload(): void {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_BOARD);
  }

  async loadSettings(): Promise<void> {
    const stored = (await this.loadData()) as Partial<BoardSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...stored };
    if (!isBodyMode(this.settings.bodyMode)) this.settings.bodyMode = DEFAULT_SETTINGS.bodyMode;
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  refreshViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_BOARD)) {
      if (leaf.view instanceof BoardView) leaf.view.applyDensity();
    }
  }

  /** 立刻落一个 `未命名看板.board.md` 并打开，名字在看板顶部点着改。 */
  private async createBoard(folder?: string): Promise<void> {
    const target = folder ?? (this.settings.newBoardFolder.trim() || this.activeFolder());
    const path = this.uniquePath(target, "未命名看板");
    const doc: BoardDoc = {
      version: FORMAT_VERSION,
      columns: ["待办", "进行中", "已完成"],
      cards: [newCard("待办", "第一张卡片")],
      archived: [],
      orphans: [],
    };
    const file = await this.app.vault.create(path, serializeDoc(doc));
    await this.openAsBoard(file);
  }

  async openAsBoard(file: TFile): Promise<void> {
    if (!isBoardPath(file.path)) return;
    this.markdownPref.delete(file.path);
    this.switching = true;
    try {
      const leaf = this.app.workspace.getLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE_BOARD, state: { file: file.path }, active: true });
    } finally {
      this.switching = false;
    }
  }

  async openAsMarkdown(file: TFile): Promise<void> {
    this.markdownPref.add(file.path);
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.setViewState({
      type: "markdown",
      state: { file: file.path, mode: "source", source: true },
      active: true,
    });
  }

  /** 看板与 Markdown 双向跟随：同一叶子里换文档时，视图类型要对得上。 */
  private async syncView(file: TFile | null): Promise<void> {
    if (!file || this.switching) return;
    const leaf = this.app.workspace.getLeaf(false);
    if (!leaf) return;
    const type = leaf.view.getViewType();
    const board = isBoardPath(file.path);

    if (type === VIEW_TYPE_BOARD) {
      if (board) return;
      this.switching = true;
      try {
        await leaf.setViewState({ type: "markdown", state: { file: file.path }, active: true });
      } finally {
        this.switching = false;
      }
      return;
    }

    if (!this.settings.autoOpen || type !== "markdown" || !board) return;
    if (this.markdownPref.has(file.path)) return;
    if ((leaf.view as MarkdownView).file?.path !== file.path) return;
    await this.openAsBoard(file);
  }

  /**
   * 插件只能把菜单项追加到末尾，而「新建看板」该和「新建笔记」排在一起。
   * 菜单渲染出来后把这一项挪进那一组：菜单是 Obsidian 自己排的 DOM，
   * 认不到目标分组就保持原样，不会把菜单弄坏。
   */
  private groupWithNewItems(itemText: string, anchorText: string): void {
    window.setTimeout(() => {
      const menus = document.querySelectorAll<HTMLElement>(".menu-scroll");
      const menuEl = menus[menus.length - 1];
      if (!menuEl) return;
      const item = [...menuEl.querySelectorAll<HTMLElement>(".menu-item")].find(
        (el) => el.textContent?.trim() === itemText,
      );
      if (!item) return;
      const host = item.closest<HTMLElement>(".menu-group");
      const anchor = [...menuEl.querySelectorAll<HTMLElement>(".menu-group")].find(
        (el) => el !== host && (el.textContent ?? "").includes(anchorText),
      );
      if (!host || !anchor) return;
      anchor.appendChild(item);
      if (host.children.length > 0) return;
      const before = host.previousElementSibling;
      host.remove();
      if (before?.classList.contains("menu-separator")) before.remove();
    }, 0);
  }

  private activeFolder(): string {
    return this.app.workspace.getActiveFile()?.parent?.path ?? "";
  }

  private uniquePath(folder: string, base: string): string {
    const prefix = folder ? `${folder}/` : "";
    let path = normalizePath(`${prefix}${base}.board.md`);
    let index = 2;
    while (this.app.vault.getAbstractFileByPath(path)) {
      path = normalizePath(`${prefix}${base} ${index}.board.md`);
      index += 1;
    }
    return path;
  }
}
