// 실제 장면 파일과 고정 모델을 메모리에 읽어 변경 전후를 같은 로더로 시험한다.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadSceneDocuments } from "../scene/load.ts";
import { plugins } from "../domains/registry.ts";

export function fixture(folder: string, name: string) {
  const read = (key: string) => JSON.parse(readFileSync(join(import.meta.dirname, folder, key + ".json"), "utf8"));
  const document = read(name), connectors = read("connectors");
  const models = new Map<string, ReturnType<typeof read>>();
  for (const { modelId, revision } of document.items) {
    const key = modelId + "@" + revision;
    if (!models.has(key)) models.set(key, read(key));
  }
  return { document, models, load: () => loadSceneDocuments(document, { models, connectors }, plugins) };
}
