// 예제와 공용 카탈로그를 합칠 때 판본·커넥터의 충돌과 출처의 범위를 확인한다.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { openLibrary } from "./library.ts";

function exampleLibrary(t: TestContext) {
  const work = resolve("work");
  mkdirSync(work, { recursive: true });
  const root = mkdtempSync(join(work, "library-test-"));
  assert.equal(dirname(root), work);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  function write(file: string, body: unknown) {
    const target = join(root, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(body));
  }

  write("fixtures/example/index.json", { examples: [
    { title: "첫 예제", scene: "first", fixture: "first" }, { title: "둘째 예제", scene: "second", fixture: "second" },
  ] });
  const model = { modelId: "device", revision: "1", kind: "device", name: "시험 장치", brand: "합성", category: "시험",
    sources: [], nodes: [], ports: [], edges: [], resources: [] };
  for (const id of ["first", "second"]) {
    write(`fixtures/example/${id}.json`, { sceneId: id, sources: [], connections: [], workloads: [], scenarios: [],
      items: [{ instanceId: id, modelId: "device", revision: "1", alias: id === "first" ? "첫 장치" : "둘째 장치" }] });
    write(`fixtures/${id}/device@1.json`, model);
  }
  const source = { id: "connector-source", title: "첫 결합표", locator: "fixture:first", retrievedAt: "2026-11-27" };
  const form = { value: "plug", confidence: "inferred", sources: [source.id] };
  const connector = { id: "plug", endForm: form };
  const registry = { sources: [source], connectors: [connector, { id: "socket", endForm: { ...form, value: "receptacle" } }],
    mates: [{ a: "plug", b: "socket", evidence: { ...form, value: true } }] };
  write("fixtures/first/connectors.json", registry);
  write("fixtures/second/connectors.json", { ...registry, mates: [{ ...registry.mates[0], a: "socket", b: "plug" }] });
  write("catalog/connectors.json", {
    sources: [{ ...source, title: "공용 결합표", locator: "fixture:catalog" }],
    connectors: [{ ...connector, id: "catalog-plug" }], mates: [],
  });
  return { open: () => openLibrary(root, join(root, "userdata")), write, model, registry, connector, form };
}

test("같은 판본과 결합 정의는 하나로 합치고 파일별 출처와 보유 실물을 유지한다", t => {
  const files = exampleLibrary(t);
  const library = files.open().describe();
  assert.equal(library.defaultSceneId, "first");
  assert.deepEqual(library.scenes.map(row => row.title), ["첫 예제", "둘째 예제"]);
  assert.deepEqual(library.models.map(model => model.modelId), ["device"]);
  assert.deepEqual(library.inventory.map(row => [row.alias, row.state]), [["첫 장치", "owned"], ["둘째 장치", "owned"]]);
  const { connectors, sources, mates } = library.connectors;
  assert.equal(mates.length, 1);
  assert.equal(sources.length, 2);
  assert.deepEqual(connectors.map(row => [row.id, sources.find(source => source.id === row.endForm.sources[0])?.locator]),
    [["plug", "fixture:first"], ["socket", "fixture:first"], ["catalog-plug", "fixture:catalog"]]);
  assert.deepEqual(mates[0]?.evidence.sources, connectors[0]?.endForm.sources);

  files.write("userdata/inventory.json", []);
  assert.deepEqual(files.open().describe().inventory, []);
});

test("같은 모델 판본이나 커넥터 ID의 정의가 다르면 시작할 때 해당 파일을 알린다", t => {
  const files = exampleLibrary(t);
  files.write("fixtures/second/device@1.json", { ...files.model, name: "다른 시험 장치" });
  assert.throws(files.open, /second[\\/]device@1\.json.*device@1/);
  files.write("fixtures/second/device@1.json", files.model);
  files.write("fixtures/second/connectors.json", { ...files.registry,
    connectors: [{ ...files.connector, endForm: { ...files.form, value: "다른 형태" } }] });
  assert.throws(files.open, /second[\\/]connectors\.json.*plug/);
});
