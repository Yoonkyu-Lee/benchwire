// 파일을 읽어 메모리 로더에 넘기고 저장 오류에 원래 경로를 보존한다.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DomainPlugin } from "../engine/contract.ts";
import { parseDocument, sceneFile } from "../scene/files.ts";
import { loadSceneDocuments } from "../scene/load.ts";

function read(file: string, reference = file): unknown {
  let body: string;
  try { body = readFileSync(file, "utf8"); }
  catch (error) { throw new Error(reference + " — 파일을 열 수 없습니다: " + file, { cause: error }); }
  try { return JSON.parse(body); }
  catch (error) { throw new Error(file + " — JSON 문법 오류", { cause: error }); }
}

export function loadScene(file: string, files: { modelsDir: string; connectorsFile: string }, plugins: readonly DomainPlugin[]) {
  const saved = parseDocument(sceneFile, read(file), file);
  const connectors = read(files.connectorsFile);
  const modelName = (key: string) => join(files.modelsDir, key + ".json");
  const models = new Map<string, unknown>();
  saved.items.forEach(({ modelId, revision }, i) => {
    const key = modelId + "@" + revision;
    if (!models.has(key)) models.set(key, read(modelName(key), file + "#items." + i + ".revision"));
  });
  return loadSceneDocuments(saved, { connectors, models }, plugins, { scene: file, connectors: files.connectorsFile, model: modelName });
}
