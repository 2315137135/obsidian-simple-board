import { PluginSettingTab, Setting, type App } from "obsidian";

import type SimpleBoardPlugin from "./main";

export type BoardDensity = "comfortable" | "compact" | "single";

export interface BoardSettings {
  density: BoardDensity;
  hideDoneDefault: boolean;
  autoOpen: boolean;
  newBoardFolder: string;
}

export const DEFAULT_SETTINGS: BoardSettings = {
  density: "comfortable",
  hideDoneDefault: false,
  autoOpen: true,
  newBoardFolder: "",
};

export class BoardSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: SimpleBoardPlugin,
  ) {
    super(app, plugin);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("卡片密度")
      .setDesc("只影响显示，不改动数据。")
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ comfortable: "舒适", compact: "紧凑", single: "单行" })
          .setValue(this.plugin.settings.density)
          .onChange(async (value) => {
            this.plugin.settings.density = value as BoardDensity;
            await this.plugin.saveSettings();
            this.plugin.refreshViews();
          }),
      );

    new Setting(containerEl)
      .setName("默认隐藏已完成")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.hideDoneDefault).onChange(async (value) => {
          this.plugin.settings.hideDoneDefault = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("自动用看板视图打开")
      .setDesc("打开 .board.md 文件时用看板视图显示。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoOpen).onChange(async (value) => {
          this.plugin.settings.autoOpen = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("新建看板目录")
      .setDesc("库内相对路径，留空则用当前笔记所在目录。")
      .addText((text) =>
        text
          .setPlaceholder("例如 项目/看板")
          .setValue(this.plugin.settings.newBoardFolder)
          .onChange(async (value) => {
            this.plugin.settings.newBoardFolder = value.trim();
            await this.plugin.saveSettings();
          }),
      );
  }
}
