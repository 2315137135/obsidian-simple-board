import { Plugin, TFile, normalizePath } from "obsidian";
import { genId } from "./board/parse";
import { BOARD_MARKER } from "./board/model";
import { BoardSettingTab, DEFAULT_SETTINGS, type BoardSettings } from "./settings";
import { BoardView, VIEW_TYPE_BOARD } from "./view";

export default class SimpleBoardPlugin extends Plugin {
  override settings: BoardSettings = { ...DEFAULT_SETTINGS };
  private switching = false;

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
      name: "以看板视图打开当前笔记",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") return false;
        if (!checking) void this.openAsBoard(file);
        return true;
      },
    });

    this.addSettingTab(new BoardSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(this.app.workspace.on("file-open", (file) => void this.maybeOpenBoard(file)));
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

  private async createBoard(): Promise<void> {
    const folder = this.settings.newBoardFolder.trim() || this.activeFolder();
    const path = this.uniquePath(folder, "未命名看板");
    const id = genId();
    const content = [
      "---",
      `${BOARD_MARKER}: true`,
      "---",
      "",
      "## 待办",
      `- [ ] 第一张卡片 ^${id}`,
      "",
      "## 进行中",
      "",
      "## 已完成",
      "",
    ].join("\n");

    const file = await this.app.vault.create(path, content);
    await this.openAsBoard(file);
  }

  private async openAsBoard(file: TFile): Promise<void> {
    this.switching = true;
    try {
      const leaf = this.app.workspace.getLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE_BOARD, state: { file: file.path }, active: true });
    } finally {
      this.switching = false;
    }
  }

  private async maybeOpenBoard(file: TFile | null): Promise<void> {
    if (!file || file.extension !== "md" || !this.settings.autoOpen || this.switching) return;
    const leaf = this.app.workspace.getLeaf(false);
    if (!leaf) return;
    const type = leaf.view.getViewType();
    if (type === VIEW_TYPE_BOARD || type !== "markdown") return;
    if (this.app.metadataCache.getFileCache(file)?.frontmatter?.[BOARD_MARKER] !== true) return;
    await this.openAsBoard(file);
  }

  refreshViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_BOARD)) {
      if (leaf.view instanceof BoardView) leaf.view.applyDensity();
    }
  }

  private activeFolder(): string {
    return this.app.workspace.getActiveFile()?.parent?.path ?? "";
  }

  private uniquePath(folder: string, base: string): string {
    const prefix = folder ? `${folder}/` : "";
    let path = normalizePath(`${prefix}${base}.md`);
    let index = 2;
    while (this.app.vault.getAbstractFileByPath(path)) {
      path = normalizePath(`${prefix}${base} ${index}.md`);
      index += 1;
    }
    return path;
  }
}
