import { load as yamlLoad } from "js-yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TFile } from "obsidian";
import type { BoardDoc } from "../src/board/model";
import { serializeDoc } from "../src/board/serialize";

vi.mock("obsidian", () => ({
  FileView: class {
    async onLoadFile() {}
    async onUnloadFile() {}
  },
  Notice: class {},
  parseYaml: yamlLoad,
}));

import { BoardView } from "../src/view";

interface ViewHarness {
  file: TFile;
  loadedFile: TFile | null;
  doc: BoardDoc | null;
  lastSaved: string;
  saveTimer: number | null;
  loadVersion: number;
  selection: Set<string>;
  history: string[];
  app: { vault: { cachedRead: ReturnType<typeof vi.fn>; process: ReturnType<typeof vi.fn> } };
  render: ReturnType<typeof vi.fn>;
  syncHeaderTitle: ReturnType<typeof vi.fn>;
  save(): Promise<void>;
  flushSave(): Promise<void>;
  scheduleSave(): void;
  loadBoard(): Promise<void>;
  onUnloadFile(file: TFile): Promise<void>;
  canAcceptExtension(extension: string): boolean;
}

const emptyDoc = (): BoardDoc => ({
  version: 2, columns: ["待办"], cards: [], archived: [], orphans: [],
});

function setup(path = "任务.board.md", text = serializeDoc(emptyDoc())) {
  const files = new Map([[path, text]]);
  const file = { path } as TFile;
  const view = Object.assign(Object.create(BoardView.prototype), {
    file,
    loadedFile: file,
    doc: emptyDoc(),
    lastSaved: text,
    saveTimer: null,
    loadVersion: 0,
    selection: new Set<string>(),
    history: [],
    render: vi.fn(),
    syncHeaderTitle: vi.fn(),
    app: { vault: {
      cachedRead: vi.fn(async (target: TFile) => files.get(target.path) ?? ""),
      process: vi.fn(async (target: TFile, update: (text: string) => string) => {
        files.set(target.path, update(files.get(target.path) ?? ""));
      }),
    } },
  }) as ViewHarness;
  return { view, files, file };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("看板视图的文件边界", () => {
  it("普通 Markdown 即使进入看板视图，也不会被读取或写入", async () => {
    const original = "# 项目说明\n正文\n";
    const { view, files } = setup("普通笔记.md", original);
    expect(view.canAcceptExtension("md")).toBe(false);
    await view.save();
    await view.loadBoard();
    expect(view.doc).toBeNull();
    expect(view.app.vault.cachedRead).not.toHaveBeenCalled();
    expect(view.app.vault.process).not.toHaveBeenCalled();
    expect(files.get("普通笔记.md")).toBe(original);
  });

  it("没有编辑时，关闭不会重新序列化文件", async () => {
    const { view } = setup();
    view.doc!.columns.push("新列");
    await view.flushSave();
    expect(view.app.vault.process).not.toHaveBeenCalled();
  });

  it("切换文件前保存待写的看板，定时器不会写到下一份笔记", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    const { view, files, file } = setup();
    view.doc!.columns.push("进行中");
    view.scheduleSave();
    await view.onUnloadFile(file);
    expect(files.get(file.path)).toContain("进行中");
    view.file = { path: "普通笔记.md" } as TFile;
    files.set(view.file.path, "正文\n");
    await vi.runAllTimersAsync();
    expect(files.get(view.file.path)).toBe("正文\n");
    expect(view.app.vault.process).toHaveBeenCalledTimes(1);
  });

  it("文件身份与已载入文档不匹配时拒绝保存", async () => {
    const { view } = setup();
    view.doc!.columns.push("新列");
    view.file = { path: "另一份.board.md" } as TFile;
    await view.save();
    expect(view.app.vault.process).not.toHaveBeenCalled();
  });

  it("过期的异步读取不会把上一份看板装进新文件", async () => {
    const { view } = setup();
    let resolve!: (text: string) => void;
    view.app.vault.cachedRead.mockReturnValueOnce(new Promise<string>((done) => { resolve = done; }));
    const pending = view.loadBoard();
    view.file = { path: "普通笔记.md" } as TFile;
    await view.loadBoard();
    resolve(serializeDoc(emptyDoc()));
    await pending;
    expect(view.doc).toBeNull();
    expect(view.loadedFile).toBeNull();
  });
});
