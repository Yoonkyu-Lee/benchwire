// 라이브러리의 원자적 저장과 판본·커넥터·출처 병합을 검증한다.
import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { openLibrary, writeAtomic } from "./library.ts";

function libraryDirectory(t: TestContext) {
  const work = resolve("work");
  mkdirSync(work, { recursive: true });
  const root = mkdtempSync(join(work, "library-test-"));
  assert.equal(dirname(root), work);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function exampleLibrary(t: TestContext) {
  const root = libraryDirectory(t);
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

function mockRename(t: TestContext, method: typeof fs.renameSync) {
  const replacement = t.mock.method(fs, "renameSync", method);
  syncBuiltinESMExports();
  t.after(() => {
    replacement.mock.restore();
    syncBuiltinESMExports();
  });
  return replacement.mock;
}

function renameClock(t: TestContext) {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const waits = t.mock.method(Atomics, "wait", (_array: Int32Array | BigInt64Array, _index: number, _value: number | bigint, timeout = 0) => {
    now += timeout;
    return "timed-out";
  });
  return { now: () => now, count: () => waits.mock.callCount() };
}

const windows = { skip: process.platform !== "win32" };

for (const code of ["EPERM", "EACCES", "EBUSY"]) {
  test("원자적 저장은 Windows " + code + " 두 번 뒤 같은 임시 파일을 교체한다", windows, t => {
    const dir = libraryDirectory(t);
    const file = join(dir, "scene.json");
    writeFileSync(file, "이전 장면");
    const realRename = fs.renameSync;
    const times = renameClock(t);
    let attempts = 0;
    const rename = mockRename(t, (from, to) => {
      assert.equal(readFileSync(file, "utf8"), "이전 장면");
      if (++attempts <= 2) throw Object.assign(new Error("잠긴 파일"), { code });
      realRename(from, to);
    });
    writeAtomic(file, "새 장면");
    assert.equal(attempts, 3);
    assert.equal(times.count(), 2);
    assert(rename.calls.every(call => call.arguments[0] === rename.calls[0]!.arguments[0] && call.arguments[1] === file));
    assert.equal(readFileSync(file, "utf8"), "새 장면");
    assert.deepEqual(readdirSync(dir), ["scene.json"]);
  });
}

test("원자적 저장은 Windows 재시도 상한에서 첫 EPERM을 전달하고 임시 파일을 지운다", windows, t => {
  const dir = libraryDirectory(t);
  const file = join(dir, "inventory.json");
  writeFileSync(file, "이전 실물");
  const times = renameClock(t);
  const first = Object.assign(new Error("첫 오류"), { code: "EPERM" });
  const next = Object.assign(new Error("계속 잠긴 파일"), { code: "EPERM" });
  const attempts: number[] = [];
  mockRename(t, () => {
    attempts.push(times.now());
    throw attempts.length === 1 ? first : next;
  });
  assert.throws(() => writeAtomic(file, "새 실물"), error => error === first);
  assert(attempts.length > 1);
  assert(attempts.every(time => time < 100));
  assert.equal(times.now(), 100);
  assert.equal(readFileSync(file, "utf8"), "이전 실물");
  assert.deepEqual(readdirSync(dir), ["inventory.json"]);
});

test("원자적 저장은 재시도 대상이 아닌 오류를 그대로 전달한다", t => {
  const dir = libraryDirectory(t);
  const file = join(dir, "prices.json");
  const io = Object.assign(new Error("입출력 오류"), { code: "EIO" });
  const rename = mockRename(t, () => { throw io; });
  assert.throws(() => writeAtomic(file, "{}"), error => error === io);
  assert.equal(rename.callCount(), 1);
  assert.deepEqual(readdirSync(dir), []);
});

test("원자적 저장은 임시 파일 삭제도 막혔을 때 원래 교체 오류를 전달한다", windows, t => {
  const dir = libraryDirectory(t);
  const file = join(dir, "research.json");
  renameClock(t);
  const first = Object.assign(new Error("교체 잠금"), { code: "EPERM" });
  const blocked = Object.assign(new Error("삭제 잠금"), { code: "EBUSY" });
  const realUnlink = fs.unlinkSync;
  mockRename(t, () => { throw first; });
  const unlink = t.mock.method(fs, "unlinkSync", () => { throw blocked; });
  syncBuiltinESMExports();
  const warning = t.mock.method(console, "warn", () => {});
  try {
    assert.throws(() => writeAtomic(file, "{}"), error => error === first);
    assert.equal(unlink.mock.callCount(), 1);
    assert.equal(warning.mock.callCount(), 1);
  } finally {
    unlink.mock.restore();
    syncBuiltinESMExports();
    for (const entry of readdirSync(dir)) realUnlink(join(dir, entry));
  }
});

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

test("커넥터 형태의 대체 출처도 공용 출처로 연결하고 결합의 구조 근거는 참값만 받는다", t => {
  const files = exampleLibrary(t);
  const source = files.registry.sources[0]!, second = {...source,id:"alt",locator:"fixture:other"};
  files.write("catalog/connectors.json", {sources:[source,second], connectors:[{id:"catalog-plug",
    endForm:{...files.form,conflicts:[{value:"other",confidence:"review",sources:["alt"]}]}}],mates:[]});
  const library = files.open().describe().connectors;
  const alt = library.connectors.find(c => c.id === "catalog-plug")!.endForm.conflicts![0]!;
  assert.equal(library.sources.find(s => s.id === alt.sources[0])!.locator, second.locator);
  files.write("catalog/connectors.json", {...files.registry, mates:[{...files.registry.mates[0],
    evidence:{...files.form,value:true,conflicts:[{value:false,confidence:"review",sources:[source.id]}]}}]});
  assert.throws(files.open,/mates\.0\.evidence/u);
});
