// 공용 카탈로그와 예제를 읽고, 검증된 장면과 인벤토리를 사용자 폴더에 원자적으로 저장한다.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { plugins } from "../domains/registry.ts";
import { connectorsFile, modelFile, parseDocument, sceneFile } from "../scene/files.ts";
import { loadSceneDocuments } from "../scene/load.ts";

export const sceneIdPattern = /^[a-z0-9_-]{1,80}$/;
const inventoryFile = z.array(sceneFile.shape.items.element.pick({ instanceId: true, modelId: true, revision: true, alias: true })
  .extend({ state: z.enum(["owned", "candidate"]) }));

export class LibraryError extends Error {
  readonly status: number;
  readonly path: string;

  constructor(status: number, path: string, message: string) {
    super(message);
    this.status = status;
    this.path = path;
  }
}

function readOptional(file: string): string | undefined {
  try { return readFileSync(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
}

function filesIn(dir: string): string[] {
  try { return readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isFile()).map(entry => entry.name).sort(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return [];
  }
}

function replaceJson(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = join(dirname(file), "." + randomUUID() + ".tmp");
  const fd = openSync(temp, "wx", 0o600);
  try {
    try { writeFileSync(fd, text); }
    finally { closeSync(fd); }
    renameSync(temp, file);
  } catch (error) {
    unlinkSync(temp);
    throw error;
  }
}

function validate<T>(parse: () => T): T {
  try { return parse(); }
  catch (error) {
    if (!(error instanceof Error)) throw error;
    // 장면 로더와 문서 스키마는 오류를 ‘문서#필드 — 이유’로 전한다.
    const separator = error.message.indexOf(" — ");
    if (separator < 0) throw error;
    const location = error.message.slice(0, separator);
    const field = location.indexOf("#");
    throw new LibraryError(422, field < 0 ? location : location.slice(field + 1), error.message.slice(separator + 3));
  }
}

function snapshot(text: string) {
  return { text, etag: '"' + createHash("sha256").update(text).digest("hex") + '"' };
}

export function openLibrary(root: string, dataDir: string) {
  const fixtureDir = join(root, "fixtures", "network");
  const exampleDir = join(root, "fixtures", "example");
  const catalogDir = join(root, "catalog");
  const exampleFile = join(exampleDir, "scene.json");
  const exampleSnapshot = snapshot(readFileSync(exampleFile, "utf8"));
  const example = parseDocument(sceneFile, JSON.parse(exampleSnapshot.text), exampleFile);
  const exampleInventoryFile = join(exampleDir, "inventory.json");
  const exampleInventory = parseDocument(inventoryFile, JSON.parse(readFileSync(exampleInventoryFile, "utf8")), exampleInventoryFile);
  const exampleSummary = { id: example.sceneId, title: "한 케이블의 PoE와 이더넷", example: true };
  const scenesDir = join(dataDir, "scenes");
  const inventoryPath = join(dataDir, "inventory.json");
  const models = new Map<string, z.infer<typeof modelFile>>();
  for (const dir of [fixtureDir, catalogDir]) for (const name of filesIn(dir)) {
    if (!name.includes("@") || !name.endsWith(".json")) continue;
    const file = join(dir, name);
    const model = parseDocument(modelFile, JSON.parse(readFileSync(file, "utf8")), file);
    const key = model.modelId + "@" + model.revision;
    if (name !== key + ".json" || models.has(key)) throw new Error(file + " — 모델 판본 이름이 다르거나 중복됩니다");
    models.set(key, model);
  }
  const exampleConnectors = join(exampleDir, "connectors.json");
  const connectors = parseDocument(connectorsFile, JSON.parse(readFileSync(exampleConnectors, "utf8")), exampleConnectors);
  const catalogConnectors = join(catalogDir, "connectors.json");
  const catalogText = readOptional(catalogConnectors);
  if (catalogText !== undefined) {
    const catalog = parseDocument(connectorsFile, JSON.parse(catalogText), catalogConnectors);
    connectors.sources.push(...catalog.sources);
    connectors.connectors.push(...catalog.connectors);
    connectors.mates.push(...catalog.mates);
  }
  const documents = { models, connectors };
  loadSceneDocuments(example, documents, plugins);

  // 접두어를 붙여 Windows 장치 이름과 장면 ID가 겹쳐도 일반 파일로 저장한다.
  const scenePath = (id: string) => join(scenesDir, "scene-" + id + ".json");
  function readScene(id: string) {
    if (id === example.sceneId) return exampleSnapshot;
    const text = readOptional(scenePath(id));
    return text === undefined ? undefined : snapshot(text);
  }

  return {
    describe() {
      const users = filesIn(scenesDir).flatMap(file => {
        const id = /^scene-([a-z0-9_-]{1,80})\.json$/.exec(file)?.[1];
        return id === undefined || id === example.sceneId ? [] : [{ id, title: id, example: false }];
      });
      let defaultSceneId = example.sceneId;
      let latest: bigint | undefined;
      for (const { id } of users) {
        const savedAt = statSync(scenePath(id), { bigint: true }).mtimeNs;
        if (latest === undefined || savedAt > latest) {
          defaultSceneId = id;
          latest = savedAt;
        }
      }
      const inventoryText = readOptional(inventoryPath);
      const inventory = inventoryText === undefined ? exampleInventory : parseDocument(inventoryFile, JSON.parse(inventoryText), "inventory.json");
      return { defaultSceneId, scenes: [exampleSummary, ...users], inventory, models: [...models.values()], connectors };
    },
    readScene,
    saveScene(id: string, body: unknown, ifMatch: string | undefined) {
      // 요청 본문을 받은 뒤부터 이 검사와 교체 사이에 다른 HTTP 요청이 끼어들지 않는다.
      const before = readScene(id);
      if (before && ifMatch === undefined) throw new LibraryError(428, "If-Match", "현재 장면의 ETag가 필요합니다");
      if (ifMatch !== undefined && before?.etag !== ifMatch) throw new LibraryError(412, "If-Match", "장면이 바뀌었습니다. 다시 열어 주세요");

      const scene = validate(() => loadSceneDocuments(body, documents, plugins));
      if (scene.id !== id) throw new LibraryError(422, "sceneId", "URL과 장면 ID가 다릅니다");
      const saved = body as z.input<typeof sceneFile>;
      const exampleCopy = id === example.sceneId;
      let target = id;
      if (exampleCopy) {
        target = id + "-copy";
        for (let number = 2; readScene(target); number++) target = id + "-copy-" + number;
      }
      const stored = snapshot(JSON.stringify({ ...saved, sceneId: target }, null, 2) + "\n");
      replaceJson(scenePath(target), stored.text);
      return { id: target, created: exampleCopy || before === undefined, ...stored };
    },
    saveInventory(body: unknown) {
      const rows = validate(() => parseDocument(inventoryFile, body, "inventory.json"));
      const instances = new Set<string>();
      for (const [index, row] of rows.entries()) {
        if (instances.has(row.instanceId)) throw new LibraryError(422, index + ".instanceId", "실물 ID가 중복됩니다");
        if (!models.has(row.modelId + "@" + row.revision)) throw new LibraryError(422, index + ".revision", "모델 판본을 찾을 수 없습니다");
        instances.add(row.instanceId);
      }
      replaceJson(inventoryPath, JSON.stringify(rows, null, 2) + "\n");
    },
  };
}
