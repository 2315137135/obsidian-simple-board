/**
 * 卡片上只显示纯文本：标题和正文都不渲染 Markdown。
 * 渲染过的正文（尤其是 `##` 与小标题）会比标题还显眼，卡片上一眼分不清主次。
 */

const RULES: [RegExp, string][] = [
  [/^#{1,6}[ \t]+/gm, ""],
  [/^[ \t]*>[ \t]?/gm, ""],
  [/^[ \t]*[-*+][ \t]+/gm, ""],
  [/^[ \t]*\d+\.[ \t]+/gm, ""],
  [/^[ \t]*(-{3,}|\*{3,}|_{3,})[ \t]*$/gm, ""],
  [/!\[([^\]]*)\]\([^)]*\)/g, "$1"],
  [/\[([^\]]*)\]\([^)]*\)/g, "$1"],
  [/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2"],
  [/\[\[([^\]]*)\]\]/g, "$1"],
  [/(\*\*|__)(.*?)\1/g, "$2"],
  [/(\*|_)(.*?)\1/g, "$2"],
  [/~~(.*?)~~/g, "$1"],
  [/`([^`]*)`/g, "$1"],
  [/<\/?[a-z][^>]*>/gi, ""],
];

/** Markdown 源文本 → 一行行干净的纯文本。 */
export function plainText(source: string): string {
  let text = source;
  for (const [pattern, replacement] of RULES) text = text.replace(pattern, replacement);
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join("\n");
}
