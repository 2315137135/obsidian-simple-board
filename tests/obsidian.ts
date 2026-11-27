import { load } from "js-yaml";

export class FileView {
  async onLoadFile(): Promise<void> {}
  async onUnloadFile(): Promise<void> {}
}
export class Notice {}
export const parseYaml = load;
