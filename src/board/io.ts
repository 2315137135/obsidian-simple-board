import { parseYaml } from "obsidian";
import type { BoardDoc } from "./model";
import { buildDoc, splitBoard } from "./parse";

/** 两个索引共用 YAML 解析；解析失败不生成可写的空索引。 */
export function parseBoardFile(text: string): BoardDoc {
  const parts = splitBoard(text);
  const data: unknown = parts.yaml === null ? null : parseYaml(parts.yaml);
  const archive: unknown = parts.archiveYaml === null ? null : parseYaml(parts.archiveYaml);
  return buildDoc(data, parts, archive);
}
