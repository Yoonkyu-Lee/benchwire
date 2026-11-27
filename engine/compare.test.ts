// 합성 장면의 교체와 행 재배치, 양쪽 판정 참조와 값·범위 비교를 검증한다.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { loadScene } from "../cli/load.ts";
import { trialDomain } from "../fixtures/trial.ts";
import { compare, type Snapshot } from "./compare.ts";
import type { DomainPlugin } from "./contract.ts";
import { evaluate } from "./evaluate.ts";
import { effectiveClaim } from "./scene.ts";

const directory = join(import.meta.dirname, "../fixtures/compare");
const trial = trialDomain();
function load(file: string, dir = directory, plugin = trial): Snapshot {
  const scene = loadScene(join(dir, file + ".json"), { modelsDir: dir, connectorsFile: join(dir, "connectors.json") }, [plugin]);
  const result = evaluate(scene, [plugin]);
  assert.deepEqual(result.errors, []);
  return { scene, result };
}

function workKey(scenario: string, work: string) {
  return JSON.stringify(["workload", scenario, work]);
}

function saved<T = Record<string, unknown>>(file: string): T {
  return JSON.parse(readFileSync(join(directory, file), "utf8")) as T;
}

function copies(t: TestContext, rewrite: (file: string, contents: string) => string) {
  const work = join(import.meta.dirname, "../work");
  mkdirSync(work, { recursive: true });
  const temp = mkdtempSync(join(work, "비교시험-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  for (const name of readdirSync(directory)) {
    if (!name.endsWith(".json")) continue;
    writeFileSync(join(temp, name), rewrite(name, readFileSync(join(directory, name), "utf8")));
  }
  return temp;
}

test("T9 매체가 100에서 200으로 바뀌면 경쟁자 둘의 성능도 차이에 남는다", () => {
  const a = load("before"), b = load("after");
  const left = structuredClone(a), right = structuredClone(b);
  const rows = compare(a, b);
  assert.deepEqual(rows.map(row => row.key), ["first", "peer-b", "peer-c"].map(id => workKey("t9", id)));
  for (const [i, [before, after]] of [[100, 200], [400, 350], [400, 350]].entries()) {
    const row = rows[i]!;
    assert.ok(row.before !== null && row.after !== null);
    const old = a.result.outcomes[row.before]!, next = b.result.outcomes[row.after]!;
    assert.equal(old.verdict, "conditional");
    assert.equal(next.verdict, i === 0 ? "ok" : "conditional");
    assert.equal(a.result.metrics.find(m => m.outcome === row.before && m.kind === "together")!.value, before);
    assert.equal(b.result.metrics.find(m => m.outcome === row.after && m.kind === "together")!.value, after);
    assert.deepEqual(row.changed, i === 0 ? ["verdict", "value"] : ["value"]);
  }
  assert.deepEqual([a, b], [left, right]);
});

test("T9 저장 순서를 뒤집고 다시 평가해도 영속 ID가 같은 판정은 차이가 없다", t => {
  const reordered = copies(t, (_file, contents) => {
    function reverse(value: unknown): unknown {
      if (Array.isArray(value)) return value.toReversed().map(reverse);
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, reverse(v)]));
      return value;
    }
    return JSON.stringify(reverse(JSON.parse(contents)));
  });
  const a = load("after"), b = load("after", reordered);
  assert.notDeepEqual(a.scene.workloads.map(w => w.id), b.scene.workloads.map(w => w.id));
  assert.notDeepEqual(a.scene.resources.map(r => a.scene.items[r.item]!.id), b.scene.resources.map(r => b.scene.items[r.item]!.id));
  assert.deepEqual(compare(a, b), []);
  const original = load("before");
  const normalize = (rows: ReturnType<typeof compare>) => rows.map(({ key, changed }) => ({ key, changed }));
  assert.deepEqual(normalize(compare(original, b)), normalize(compare(original, a)));
});

test("한쪽에만 있는 작업과 연결은 추가·삭제로 표시한다", t => {
  const rewritten = copies(t, (name, contents) => {
    if (name !== "before.json") return contents;
    const doc = saved<{
      connections: { id: string }[]; workloads: { id: string }[]; scenarios: { members: string[] }[];
    }>(name);
    doc.connections.find(c => c.id === "link-d")!.id = "new-link-d";
    doc.workloads.find(w => w.id === "alone")!.id = "new-work";
    for (const s of doc.scenarios) s.members = s.members.map(id => id === "alone" ? "new-work" : id);
    return JSON.stringify(doc);
  });
  const rows = compare(load("before"), load("before", rewritten));
  for (const [id, action] of [["link-d", "removed"], ["new-link-d", "added"]] as const) {
    for (const direction of ["forward", "reverse"]) {
      const key = JSON.stringify(["connection", id, direction, "trial", "회/s", null, null]);
      assert.deepEqual(rows.find(r => r.key === key)?.changed, [action]);
    }
  }
  const removed = rows.find(r => r.key === workKey("t9", "alone"))!;
  const added = rows.find(r => r.key === workKey("t9", "new-work"))!;
  assert.deepEqual(removed.changed, ["removed"]);
  assert.ok(removed.before !== null && removed.after === null);
  assert.deepEqual(added.changed, ["added"]);
  assert.ok(added.before === null && added.after !== null);
  assert.equal(rows.length, 6);
});

test("공유 정책이 미확인이 되면 범위·가정과 정책 퀘스트의 변화가 남는다", () => {
  const a = load("after");
  const scene = structuredClone(a.scene);
  const trunk = scene.resources.findIndex(r => r.id === "trunk");
  const policy = effectiveClaim(scene, "resource", trunk, trial.id, "policy")!;
  scene.claims[policy]!.value = null;
  scene.claims[policy]!.confidence = "unknown";
  const b = { scene, result: evaluate(scene, [trial]) };
  const rows = compare(a, b);
  const peer = rows.find(row => row.key === workKey("t9", "peer-b"))!;
  assert.ok(["range", "assumption", "quest"].every(field => peer.changed.includes(field)));
  assert.ok(b.result.quests.some(q => q.outcome === peer.after && q.claim === policy));
  assert.ok(!rows.some(row => row.key === workKey("t9", "alone")));
});

test("수치가 같아도 병목이 새로 나타나면 해당 작업이 남는다", () => {
  const a = load("after");
  const scene = structuredClone(a.scene);
  const device = scene.items.findIndex(i => i.id === "peer-b");
  const medium = scene.resources.findIndex(r => r.item === device && r.id === "medium");
  scene.claims[effectiveClaim(scene, "resource", medium, trial.id, "capacity")!]!.value = 800;
  const rows = compare(a, { scene, result: evaluate(scene, [trial]) });
  assert.deepEqual(rows.map(r => [r.key, r.changed]), [
    [workKey("peer-alone", "peer-b"), ["bottleneck"]],
    [workKey("t9", "peer-b"), ["bottleneck"]],
  ]);
});

test("같은 연결의 단위·공용 예산을 구별하고 선택된 한도만 비교한다", () => {
  function plugin(limit: number): DomainPlugin {
    return { ...trial,
      negotiate(link) {
        const [o] = trial.negotiate(link);
        return [o!, ...["p1", "p2"].map(id => ({ ...o!, unit: "W", mode: "power", limit: 20, pool: { domain: trial.id, id, perUnit: 1 } }))];
      },
      pools(link) {
        const change = link.scene.connections[link.connection]!.id === "link-a" && link.direction === "forward";
        return ["p1", "p2"].map(id => ({ id, unit: "W", scope: "direction" as const, limit: change && id === "p1" ? limit : 12,
          inputs: [], specs: [], rule: "합성 전력 한도" }));
      },
    };
  }
  const rows = compare(load("before", directory, plugin(10)), load("before", directory, plugin(14)));
  assert.deepEqual(rows.map(r => [r.key, r.changed]), [
    [JSON.stringify(["connection", "link-a", "forward", "trial", "W", "trial", "p1"]), ["value"]],
  ]);
});

test("추가 지표의 범위는 비교하고 증거 행 번호와 지표 배열 순서는 무시한다", () => {
  const a = load("after");
  const outcome = a.result.outcomes.findIndex(o => o.subjectKind === "workload" &&
    a.scene.workloads[o.subjectRow]!.id === "first");
  a.result.measures.push({ outcome, run: "together", kind: "순충전", unit: "W", low: 0, high: 4 });
  const b = structuredClone(a);
  b.result.metrics.reverse();
  b.result.reasonInputs.reverse();
  b.result.reasonSpecs.reverse();
  assert.deepEqual(compare(a, b), []);
  b.result.measures[0]!.high = 8;
  assert.deepEqual(compare(a, b).map(r => [r.key, r.changed]), [[workKey("t9", "first"), ["range"]]]);
});
