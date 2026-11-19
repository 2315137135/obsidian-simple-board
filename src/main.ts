import { MarkdownView, Plugin, TFolder, TFile, normalizePath } from "obsidian";
import { FORMAT_VERSION, isBoardPath, type BoardDoc } from "./board/model";
import { newCard } from "./board/parse";
import { serializeDoc } from "./board/serialize";
import { BoardSettingTab, DEFAULT_SETTINGS, type BoardSettings } from "./settings";
import { NewBoardModal } from "./ui/new-board-modal";
import { BoardView, VIEW_TYPE_BOARD } from "./view";

export default class SimpleBoardPlugin extends Plugin {
  override settings: BoardSettings = { ...DEFAULT_SETTINGS };
  private switching = false;
  /** 用户明确要求用 Markdown 打开的文件，别再自动切回看板。 */
  private markdownPref = new Set<string>();

  override async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(VIEW_TYPE_BOARD, (leaf) => new BoardView(leaf, this));

    this.addRibbonIcon("layout-dashboard", "新建看板", () => this.askNewBoard());
    this.addCommand({
      id: "create-board",
      name: "新建看板",
      callback: () => this.askNewBoard(),
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
              .onClick(() => this.askNewBoard(file.path)),
          );
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
    this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) as Partial<BoardSettings>) };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  refreshViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_BOARD)) {
      if (leaf.view instanceof BoardView) leaf.view.applyDensity();
    }
  }

  /** 问名字，再在指定文件夹（缺省用设置或当前文件所在目录）里落一个空看板。 */
  private askNewBoard(folder?: string): void {
    const target = folder ?? (this.settings.newBoardFolder.trim() || this.activeFolder());
    new NewBoardModal(this.app, target, (name) => void this.createBoard(target, name)).open();
  }

  private async createBoard(folder: string, name: string): Promise<void> {
    const path = this.uniquePath(folder, name.trim() || "未命名看板");
    const doc: BoardDoc = {
      version: FORMAT_VERSION,
      columns: ["待办", "进行中", "已完成"],
      cards: [newCard("待办", "第一张卡片")],
      orphans: [],
    };
    const file = await this.app.vault.create(path, serializeDoc(doc));
    await this.openAsBoard(file);
  }

  async openAsBoard(file: TFile): Promise<void> {
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
