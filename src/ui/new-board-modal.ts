import { Modal, Setting, type App } from "obsidian";

/**
 * 新建看板只问一件事：叫什么名字。
 * 放在哪个文件夹由调用方决定（文件夹右键菜单 / 命令 / ribbon 各给各的）。
 */
export class NewBoardModal extends Modal {
  private name = "";

  constructor(
    app: App,
    private readonly where: string,
    private readonly submit: (name: string) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText("新建看板");
    this.contentEl.createEl("p", {
      cls: "setting-item-description",
      text: this.where ? `位置：${this.where}` : "位置：库根目录",
    });

    new Setting(this.contentEl)
      .setName("名称")
      .addText((text) => {
        text.setPlaceholder("未命名看板");
        text.onChange((value) => {
          this.name = value;
        });
        text.inputEl.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            this.accept();
          }
        });
        window.setTimeout(() => text.inputEl.focus(), 0);
      });

    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText("取消").onClick(() => this.close()))
      .addButton((button) =>
        button
          .setButtonText("创建")
          .setCta()
          .onClick(() => this.accept()),
      );
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private accept(): void {
    const name = this.name.trim();
    this.close();
    this.submit(name);
  }
}
