// 공용 카탈로그와 예제를 읽고, 검증된 장면과 인벤토리를 사용자 폴더에 원자적으로 저장한다.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { plugins } from "../domains/registry.ts";
import { connectorsFile, modelFile, parseDocument, sceneFile, type Fact } from "../scene/files.ts";
import { loadSceneDocuments } from "../scene/load.ts";

export const sceneIdPattern = /^[a-z0-9_-]{1,80}$/;
const inventoryFile = z.array(sceneFile.shape.items.element.pick({ instanceId: true, modelId: true, revision: true, alias: true })
  .extend({ state: z.enum(["owned", "candidate"]) }));
const fileStem = z.string().regex(sceneIdPattern);
const examplesFile = z.strictObject({
  examples: z.array(z.strictObject({ title: z.string().min(1), scene: fileStem, fixture: fileStem })).nonempty(),
  inventory: inventoryFile.default([]),
});
type ConnectorRegistry = z.infer<typeof connectorsFile>;

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

function writeJson(file: string, text: string, exclusive = false): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = join(dirname(file), "." + randomUUID() + ".tmp");
  const fd = openSync(temp, "wx", 0o600);
  let moved = false;
  try {
    try { writeFileSync(fd, text); }
    finally { closeSync(fd); }
    if (exclusive) linkSync(temp, file);
    else { renameSync(temp, file); moved = true; }
  } finally {
    if (!moved) unlinkSync(temp);
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

function mergeRow<T>(rows: Map<string, T>, key: string, row: T, file: string, label: string) {
  const previous = rows.get(key);
  if (previous === undefined) rows.set(key, row);
  else if (!isDeepStrictEqual(previous, row)) throw new Error(`${file} — ${label} 정의가 충돌합니다: ${key}`);
}

function readConnectors(files: readonly { file: string; text: string }[]): ConnectorRegistry {
  const sources = new Map<string, ConnectorRegistry["sources"][number]>();
  const connectors = new Map<string, ConnectorRegistry["connectors"][number]>();
  const mates = new Map<string, ConnectorRegistry["mates"][number]>();
  for (const { file, text } of files) {
    const registry = parseDocument(connectorsFile, JSON.parse(text), file);
    const localIds = new Map<string, string>();
    // 출처 ID는 파일마다 지역 이름이다. 같은 출처만 합친 표에서 한 행을 공유한다.
    for (const { id: localId, ...source } of registry.sources) {
      if (localIds.has(localId)) throw new Error(`${file} — 중복 출처 ID: ${localId}`);
      const key = JSON.stringify(source);
      const id = sources.get(key)?.id ?? String(sources.size + 1);
      sources.set(key, { ...source, id });
      localIds.set(localId, id);
    }
    function cite(id: string) {
      const row = localIds.get(id);
      if (row === undefined) throw new Error(`${file} — 찾을 수 없는 출처: ${id}`);
      return row;
    }
    function citations(fact: Fact): Fact {
      return { ...fact, sources: fact.sources.map(cite), ...(fact.conflicts && {
        conflicts: fact.conflicts.map(c => ({ ...c, sources: c.sources.map(cite) })),
      }) };
    }
    for (const row of registry.connectors) {
      const connector = { ...row, endForm: citations(row.endForm) };
      mergeRow(connectors, row.id, connector, file, "커넥터");
    }
    for (const row of registry.mates) {
      const [a, b] = row.a <= row.b ? [row.a, row.b] : [row.b, row.a];
      const mate = { a, b, evidence: citations(row.evidence) };
      mergeRow(mates, JSON.stringify([a, b]), mate, file, "결합쌍");
    }
  }
  return { sources: [...sources.values()], connectors: [...connectors.values()], mates: [...mates.values()] };
}

export function openLibrary(root: string, dataDir: string) {
  const fixtureDir = join(root, "fixtures");
  const exampleDir = join(fixtureDir, "example");
  const catalogDir = join(root, "catalog");
  const indexFile = join(exampleDir, "index.json");
  const index = parseDocument(examplesFile, JSON.parse(readFileSync(indexFile, "utf8")), indexFile);
  const scenesDir = join(dataDir, "scenes");
  const inventoryPath = join(dataDir, "inventory.json");
  const modelsDir = join(dataDir, "models");
  const modelPath = (key: string) => join(modelsDir, "model-" + key + ".json");
  const fixtureDirs = [...new Set(index.examples.map(example => join(fixtureDir, example.fixture)))];
  const models = new Map<string, z.infer<typeof modelFile>>();
  for (const dir of [...fixtureDirs, catalogDir, modelsDir]) for (const name of filesIn(dir)) {
    if (!name.includes("@") || !name.endsWith(".json") || dir === modelsDir && !name.startsWith("model-")) continue;
    const file = join(dir, name);
    const model = parseDocument(modelFile, JSON.parse(readFileSync(file, "utf8")), file);
    const key = model.modelId + "@" + model.revision;
    if (name !== (dir === modelsDir ? "model-" : "") + key + ".json") throw new Error(`${file} — 모델 판본 이름이 ${key}와 다릅니다`);
    mergeRow(models, key, model, file, "모델 판본");
  }
  const connectorFiles = fixtureDirs.map(dir => join(dir, "connectors.json")).map(file => ({ file, text: readFileSync(file, "utf8") }));
  const catalogConnectors = join(catalogDir, "connectors.json");
  const catalogText = readOptional(catalogConnectors);
  if (catalogText !== undefined) connectorFiles.push({ file: catalogConnectors, text: catalogText });
  const connectors = readConnectors(connectorFiles);
  const documents = { models, connectors };
  const examples = new Map<string, { title: string; saved: ReturnType<typeof snapshot> }>();
  const exampleInventory = new Map<string, z.infer<typeof inventoryFile>[number]>();
  for (const { scene, title } of index.examples) {
    const file = join(exampleDir, scene + ".json");
    const saved = snapshot(readFileSync(file, "utf8"));
    const example = parseDocument(sceneFile, JSON.parse(saved.text), file);
    const id = parseDocument(fileStem, example.sceneId, file + "#sceneId");
    if (examples.has(id)) throw new Error(`${file} — 중복 예제 장면 ID: ${id}`);
    loadSceneDocuments(example, documents, plugins, { scene: file, connectors: "connectors.json", model: key => key + ".json" });
    examples.set(id, { title, saved });
    for (const item of example.items) mergeRow(exampleInventory, item.instanceId, { ...item, state: "owned" }, file, "실물");
  }
  for (const item of index.inventory) {
    if (!models.has(item.modelId + "@" + item.revision)) throw new Error(`${indexFile} — 실물의 모델 판본을 찾을 수 없습니다: ${item.instanceId}`);
    mergeRow(exampleInventory, item.instanceId, item, indexFile, "실물");
  }

  // 접두어를 붙여 Windows 장치 이름과 장면 ID가 겹쳐도 일반 파일로 저장한다.
  const scenePath = (id: string) => join(scenesDir, "scene-" + id + ".json");
  function readScene(id: string) {
    const example = examples.get(id);
    if (example) return example.saved;
    const text = readOptional(scenePath(id));
    return text === undefined ? undefined : snapshot(text);
  }

  function readInventory() {
    const text = readOptional(inventoryPath);
    return text === undefined ? [...exampleInventory.values()] : parseDocument(inventoryFile, JSON.parse(text), "inventory.json");
  }

  function sameRevision(previous: z.output<typeof modelFile>, next: z.output<typeof modelFile>) {
    if (!isDeepStrictEqual(previous, next)) throw new LibraryError(409, "revision", "이미 있는 판본입니다. 새 판본으로 저장하세요");
  }

  return {
    describe() {
      const users = filesIn(scenesDir).flatMap(file => {
        const id = /^scene-([a-z0-9_-]{1,80})\.json$/.exec(file)?.[1];
        return id === undefined || examples.has(id) ? [] : [{ id, title: id, example: false }];
      });
      const exampleSummaries = [...examples].map(([id, { title }]) => ({ id, title, example: true }));
      let defaultSceneId = exampleSummaries[0]!.id;
      let latest: bigint | undefined;
      for (const { id } of users) {
        const savedAt = statSync(scenePath(id), { bigint: true }).mtimeNs;
        if (latest === undefined || savedAt > latest) {
          defaultSceneId = id;
          latest = savedAt;
        }
      }
      return { defaultSceneId, scenes: [...exampleSummaries, ...users], inventory: readInventory(), models: [...models.values()], connectors };
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
      const exampleCopy = examples.has(id);
      let target = id;
      if (exampleCopy) {
        target = id + "-copy";
        for (let number = 2; readScene(target); number++) target = id + "-copy-" + number;
      }
      const stored = snapshot(JSON.stringify({ ...saved, sceneId: target }, null, 2) + "\n");
      writeJson(scenePath(target), stored.text);
      return { id: target, created: exampleCopy || before === undefined, ...stored };
    },
    saveModel(id: string, revision: string, body: unknown) {
      const model = validate(() => parseDocument(modelFile, body, "model.json"));
      if (model.modelId !== id) throw new LibraryError(422, "modelId", "URL과 모델 ID가 다릅니다");
      if (model.revision !== revision) throw new LibraryError(422, "revision", "URL과 판본이 다릅니다");
      const key = model.modelId + "@" + model.revision;
      const previous = models.get(key);
      if (previous) { sameRevision(previous, model); return false; }
      const instance = { instanceId: "model-check", modelId: id, revision };
      validate(() => loadSceneDocuments({ sceneId: "model-check", sources: [], items: [instance], connections: [], workloads: [], scenarios: [] },
        { connectors, models: new Map([[key, model]]) }, plugins));
      const file = modelPath(key);
      const text = JSON.stringify(model, null, 2) + "\n";
      try { writeJson(file, text, true); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        sameRevision(parseDocument(modelFile, JSON.parse(readFileSync(file, "utf8")), file), model);
        models.set(key, model);
        return false;
      }
      models.set(key, model);
      return true;
    },
    saveInventoryItem(id: string, body: unknown) {
      const row = validate(() => parseDocument(inventoryFile.element, body, "inventory.json"));
      if (row.instanceId !== id) throw new LibraryError(422, "instanceId", "URL과 실물 ID가 다릅니다");
      if (!models.has(row.modelId + "@" + row.revision)) throw new LibraryError(422, "revision", "모델 판본을 찾을 수 없습니다");
      const inventory = readInventory();
      const prior = inventory.find(item => item.instanceId === id);
      if (prior) {
        if (!isDeepStrictEqual(prior, row)) throw new LibraryError(409, "instanceId", "같은 ID의 실물이 이미 있습니다");
        return false;
      }
      writeJson(inventoryPath, JSON.stringify([...inventory, row], null, 2) + "\n");
      return true;
    },
  };
}
