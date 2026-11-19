import { parseYaml } from "obsidian";
import { FORMAT_VERSION, type BoardDoc } from "./model";
import { buildDoc, splitBoard } from "./parse";

/**
 * 文件文本 ↔ 模型。只有这一层碰 YAML 解析器：切分与归一在 parse.ts（纯逻辑），
 * 这里只把它们接上 Obsidian 的 parseYaml。
 */
export function parseBoardFile(text: string): BoardDoc {
  const parts = splitBoard(text);
  if (parts.yaml === null) {
    return { version: FORMAT_VERSION, columns: [], cards: [], orphans: parts.orphans };
  }
  let data: unknown = null;
  try {
    data = parseYaml(parts.yaml);
  } catch (error) {
    console.error("看板结构块不是合法 YAML", error);
  }
  return buildDoc(data, parts);
}
