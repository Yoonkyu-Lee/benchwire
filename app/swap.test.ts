// 슬롯 교체의 영속 ID, 실측·배선·구매행과 비교 판정을 검증한다.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { plugins } from "../domains/registry.ts";
import { evaluate } from "../engine/evaluate.ts";
import { loadSceneDocuments } from "../scene/load.ts";
import { openLibrary } from "../server/library.ts";
import type { PriceBook, Quote } from "../server/prices.ts";
import { calculateBudget, compareBudgets } from "./budget.ts";
import { modelKey, type Model, type SceneDocument } from "./document.ts";
import { compareSwap, swapSlot } from "./swap.ts";
import { resultView } from "./results.ts";

const library = openLibrary(resolve(), resolve("work", "swap-unit-library"));
const { models, connectors } = library.describe();
const base = JSON.parse(library.readScene("network")!.text) as SceneDocument;
const docs = (additional: readonly Model[] = []) => ({
  connectors, models: new Map([...models, ...additional].map(model => [modelKey(model), model])),
});
const copy = { replacementId: "b-new", sceneId: "network-swap" };
function swap(scene: SceneDocument, originalId: string, model: Model, extra: readonly Model[] = [], choices?: ReadonlyMap<string, string>) {
  return swapSlot(scene, docs([model, ...extra]), { ...copy, originalId, replacement: model, choices });
}
const model = (id: string) => models.find(row => row.modelId === id)!;
const snapshot = (document: SceneDocument, documents = docs()) => {
  const scene = loadSceneDocuments(document, documents, plugins);
  return { scene, result: evaluate(scene, plugins) };
};

test("교체한 실물은 모델 값으로 판정하고 연결 관측은 배선 이력으로 남긴다", () => {
  const router = { ...model("network-router"), revision: "swap" };
  const lan = base.connections.find(row => row.id === "lan-a")!;
  const observation = { domain: "network", field: "linkSpeed", claim: { value: 1000, unit: "Mbps", confidence: "user_verified" as const, sources: ["network-scene"] },
    ports: [lan.from, { instanceId: "lan-a-wire", id: "a" }, { instanceId: "lan-a-wire", id: "b" }, lan.to] };
  const personal = { instanceId: "router", ownerKind: "resource" as const, ownerId: "uplink", domain: "network", field: "capacity",
    claim: { value: 600, unit: "Mbps", confidence: "user_verified" as const, sources: ["network-scene"] } };
  const before: SceneDocument = { ...base, personal: [personal],
    connections: base.connections.map(row => row === lan ? { ...row, observations: [observation] } : row) };
  const unchanged = structuredClone(before);
  const result = swap(before, "router", router);
  assert(result.document);
  assert.deepEqual(result.pending, []);
  assert.deepEqual(before, unchanged);
  const after = result.document;
  assert.deepEqual(after.personal, []);
  assert.deepEqual(after.items.find(row => row.instanceId === copy.replacementId),
    { instanceId: copy.replacementId, modelId: router.modelId, revision: router.revision, state: "candidate" });
  assert.deepEqual(after.connections.find(row => row.id === lan.id)?.observations, [observation]);
  const old = snapshot(before);
  const next = snapshot(after, docs([router]));
  const delivered = (snap: ReturnType<typeof snapshot>) => snap.result.metrics.find(m => m.kind === "together" &&
    snap.result.outcomes[m.outcome]?.subjectKind === "workload" &&
    snap.scene.workloads[snap.result.outcomes[m.outcome]!.subjectRow]?.id === "lan-a")?.value;
  assert.equal(delivered(old), 300);
  assert.equal(delivered(next), 600);
  assert.equal(next.scene.claims.find(row => row.field === "linkSpeed" && row.scope === "personal")?.inactive, "wiring");
});

test("가격만 다른 교체는 새 실물 ID를 써도 기술 차이 없이 차액을 보인다", () => {
  const network = model("network-router");
  const replacement = { ...network, revision: "price-swap" };
  const before: SceneDocument = { ...base, items: base.items.map(i => i.instanceId === "router" ? { ...i, state: "candidate" } : i),
    scenarios: base.scenarios.map(s => ({ ...s, purchases: [{ instanceId: "router" }] })) };
  const { document: after } = swap(before, "router", replacement);
  assert(after);
  const a = snapshot(before), b = snapshot(after,docs([replacement]));
  const changes = compareSwap(a,b,"router",copy.replacementId);
  assert.deepEqual(changes, []);
  const offer: Quote = { modelRef: modelKey(network), seller: "시험 매장", productId: "A", unitPriceCents: 2000,
    saleUnit: 1, currency: "USD", stock: "in", retrievedAt: "2026-01-01T00:00:00Z", source: "시험 판매가", provider: "manual" };
  const prices: PriceBook = { quotes: [offer, { ...offer, modelRef: modelKey(replacement), productId: "B", unitPriceCents: 3500 }], preferredSellers: [] };
  assert.equal(compareBudgets(calculateBudget(before.scenarios[0]!,before.items,prices,resultView(a.scene,a.result,0,"together")),
    calculateBudget(after.scenarios[0]!,after.items,prices,resultView(b.scene,b.result,0,"together"))),1500n);
});

test("포트 대응이 여럿이면 배선 위치 선택이 필요하고 호환 포트를 고른 뒤에만 장면이 완성된다", () => {
  const host = model("network-host");
  const p = host.ports[0]!;
  const replacement = { ...host, revision: "ports-swap", ports: ["left", "right"].map(id => ({
    ...p, id, interfaces: p.interfaces.map(iface => ({ ...iface, id: iface.id + "-" + id })),
  })) };
  const goal = { id: "host-port", label: "LAN 단말 포트", kind: "port" as const, workloads: ["lan-a"], instanceId: "host-a", portId: "lan" };
  const before: SceneDocument = { ...base, scenarios: [{ ...base.scenarios[0]!, goals: [goal] }] };
  const waiting = swap(before, "host-a", replacement);
  assert.equal(waiting.document, null);
  assert.equal(waiting.pending.length, 1);
  const choice = waiting.pending[0]!;
  assert.equal(choice.kind, "port");
  assert.equal(choice.source, "lan");
  assert.deepEqual(choice.options.map(port => port.id), ["left", "right"]);
  assert.deepEqual(choice.uses, ["연결 lan-a", "목표 LAN 단말 포트"]);
  assert.equal(swap(before, "host-a", replacement, [], new Map([[choice.key, "missing"]])).document, null);
  const { document: after } = swap(before, "host-a", replacement, [], new Map([[choice.key, "right"]]));
  assert(after);
  assert.deepEqual(after.connections.find(row => row.id === "lan-a")?.from, { instanceId: copy.replacementId, id: "right" });
  assert.deepEqual(after.scenarios[0]?.goals, [{ ...goal, instanceId: copy.replacementId, portId: "right" }]);
  assert.equal(after.workloads.length, base.workloads.length);
  snapshot(after, docs([replacement]));
});

test("한 실물의 두 끝을 함께 옮기면 교체 모델의 실제 결합쌍을 검사한다", () => {
  const host = model("network-host");
  const socket = host.ports[0]!;
  const plug = model("network-copper").ports[0]!.connector;
  const original = { ...host, ports: [socket, { ...socket, id: "loop", connector: plug, interfaces: [] }] };
  const replacement = { ...original, revision: "local-pair", ports: [
    { ...socket, connector: plug }, { ...socket, id: "loop", interfaces: [] },
  ] };
  const from = { instanceId: "host-a", id: socket.id }, to = { instanceId: "host-a", id: "loop" };
  const before = { ...base, items: base.items.filter(item => item.instanceId === "host-a"),
    connections: [{ ...base.connections[0]!, from, to, parts: [] }], workloads: [], scenarios: [] };
  const { document: after } = swap(before, "host-a", replacement, [original]);
  assert(after);
  assert.deepEqual(after.connections[0]?.from, { instanceId: copy.replacementId, id: socket.id });
  assert.deepEqual(after.connections[0]?.to, { instanceId: copy.replacementId, id: "loop" });
  const invalid = { ...replacement, ports: [{ ...replacement.ports[0]!, connector: socket.connector }, replacement.ports[1]!] };
  const pending = swap(before, "host-a", invalid, [original]);
  assert.equal(pending.document, null);
  assert.equal(pending.pending.length, 2);
});

test("포트 이름의 작업 끝점은 대응 포트의 내부 노드를 쓰고 경유 부품과 구매행은 새 실물을 쓴다", () => {
  const host = model("network-host");
  const port = host.ports[0]!;
  const original = { ...host, nodes: [{ ...host.nodes[0]!, id: port.id }],
    ports: [{ ...port, attachment: { ...port.attachment, value: port.id } }] };
  const replacement = { ...host, revision: "node-swap", nodes: [{ ...host.nodes[0]!, id: "new-nic" }],
    ports: [{ ...port, attachment: { ...port.attachment, value: "new-nic" } }] };
  const before: SceneDocument = { ...base, workloads: base.workloads.map(row => row.from.instanceId === "host-a"
    ? { ...row, from: { ...row.from, id: port.id } } : row) };
  const { document: after } = swap(before, "host-a", replacement, [original]);
  assert(after);
  assert.deepEqual(after.workloads.find(row => row.id === "lan-a")?.from, { instanceId: copy.replacementId, id: "new-nic" });
  snapshot(after, docs([replacement]));

  const cable = { ...model("network-copper"), revision: "part-swap" };
  const need = { connection: "lan-a", capability: "network-plug" };
  const unrelated = { modelRef: "network-copper@1", quantity: 2 };
  const purchaseScene = { ...base, scenarios: base.scenarios.map(row => ({ ...row,
    purchases: [{ ownedInstanceId: "lan-a-wire", modelRef: "network-copper@1", need }, { instanceId: "lan-b-wire" }, unrelated],
  })) };
  const part = swap(purchaseScene, "lan-a-wire", cable).document;
  assert(part);
  assert.deepEqual(part.connections.find(row => row.id === "lan-a")?.parts, [{ instanceId: copy.replacementId, entry: "a", exit: "b" }]);
  assert.deepEqual(part.scenarios[0]?.purchases, [{ instanceId: copy.replacementId, need }, { instanceId: "lan-b-wire" }, unrelated]);
  snapshot(part, docs([cable]));
});

test("같은 수전 모델로 바꾸면 시나리오의 포트 목표가 새 실물을 참조하고 계속 달성된다", () => {
  const pd = model("network-pd");
  const explicit = { id: "pd-port", kind: "port" as const, workloads: ["poe-12"], instanceId: "pd", portId: "pd" };
  const any = { id: "any-input", kind: "port" as const, workloads: ["poe-12"], instanceId: "pd" };
  const unaffected = { ...explicit, id: "pse-port", instanceId: "pse", portId: "pse" };
  const before: SceneDocument = { ...base, scenarios: [{ ...base.scenarios[0]!, goals: [explicit, unaffected] },
    { id: "나머지 시나리오", members: ["poe-12"], goals: [any] }] };
  const { document: after, pending } = swapSlot(before, docs(), {
    originalId: "pd", replacementId: "pd-new", sceneId: "network-goal-swap", replacement: pd,
  });
  assert(after);
  assert.deepEqual(pending, []);
  const next = snapshot(after);
  assert.deepEqual(after.scenarios[0]?.goals, [{ ...explicit, instanceId: "pd-new" }, unaffected]);
  assert.deepEqual(after.scenarios[1]?.goals, [{ ...any, instanceId: "pd-new" }]);
  assert.deepEqual(next.result.goals.map(row => [row.id, row.verdict]), [["pd-port", "ok"], ["pse-port", "ok"], ["any-input", "ok"]]);
  assert.equal(before.scenarios[0]?.goals?.[0], explicit);
  assert.equal(before.scenarios[1]?.goals?.[0], any);
});

test("배선 밖의 목표 포트도 호환 위치가 모호하거나 없으면 선택을 요청한다", () => {
  const pd = model("network-pd"), port = pd.ports[0]!;
  const extraPort = (id: string) => ({ ...port, id, interfaces: [] });
  const original = { ...pd, ports: [port, extraPort("spare")] };
  const replacement = { ...pd, revision: "goal-port-choice", ports: [port, extraPort("left"), extraPort("right")] };
  const goal = { id: "spare-port", label: "장비의 별도 단자", kind: "port" as const, workloads: ["poe-12"], instanceId: "pd", portId: "spare" };
  const before: SceneDocument = { ...base, scenarios: [{ ...base.scenarios[0]!, goals: [goal] }] };

  const waiting = swap(before, "pd", replacement, [original]);
  assert.equal(waiting.document, null);
  assert.equal(waiting.pending.length, 1);
  const choice = waiting.pending[0]!;
  assert.deepEqual([choice.kind, choice.source, choice.uses, choice.options.map(row => row.id)],
    ["port", "spare", ["목표 장비의 별도 단자"], ["pd", "left", "right"]]);
  const selected = swap(before, "pd", replacement, [original], new Map([[choice.key, "right"]]));
  assert(selected.document);
  const saved = selected.document.scenarios[0]?.goals?.[0];
  assert.deepEqual(saved, { ...goal, instanceId: copy.replacementId, portId: "right" });
  assert.deepEqual(selected.document.connections.find(row => row.id === "poe")?.to, { instanceId: copy.replacementId, id: "pd" });
  snapshot(selected.document, docs([replacement]));

  const plug = model("network-copper").ports[0]!.connector;
  const incompatible = { ...original, ports: [port, { ...extraPort("spare"), connector: plug }] };
  const noMatch = swap(before, "pd", replacement, [incompatible]);
  assert.equal(noMatch.document, null);
  assert.deepEqual(noMatch.pending.map(row => [row.source, row.options]), [["spare", []]]);
});


test("교체 사본의 포트 목표는 새 실물에서 읽은 PoE 유형의 고정 세계를 합친 결과와 같다", () => {
  const replacement = structuredClone(model("network-pd"));
  replacement.revision = "goal-world-swap";
  const type = replacement.ports[0]!.interfaces.find(i => i.protocol === "PoE PD")!.params.poeType!;
  const wire = base.connections.find(row => row.id === "poe")!;
  const goal = { id: "poe-input", kind: "port" as const, workloads: ["poe-12"], instanceId: "pd", portId: wire.to.id };
  const before: SceneDocument = { ...base, connections: [wire], workloads: base.workloads.filter(w => w.id === "poe-12"),
    scenarios: [{ id: "poe", members: ["poe-12"], goals: [goal] }] };
  Object.assign(type, { value: null, confidence: "unknown" });
  const { document: after, pending } = swap(before, "pd", replacement);
  assert.deepEqual(pending, []);
  assert(after);
  assert.equal(snapshot(before).result.goals[0]!.verdict, "ok");
  const next = snapshot(after, docs([replacement]));
  const port = next.scene.ports[next.scene.goals![0]!.kind === "port" ? next.scene.goals![0]!.port! : -1]!;
  assert.equal(next.scene.items[port.item]!.id, copy.replacementId);
  assert.equal(port.id, goal.portId);
  const pd = next.scene.interfaces.findIndex(i => i.port === next.scene.ports.indexOf(port) && i.protocol === "PoE PD");
  const claim = next.scene.claims.findIndex(row => row.ownerKind === "interface" && row.owner === pd &&
    row.field === "poeType" && row.value === null);
  assert.ok(claim >= 0);
  const samples = next.scene.claims[claim]!.discrete!;
  assert.deepEqual(samples, [0, 1, 2, 3, 4]);
  assert.deepEqual(new Set(next.result.profileWorlds.filter(w => w.claim === claim).map(w => w.value)), new Set(samples));
  assert.ok(next.result.goalEvidence.some(e => e.claims.includes(claim)));
  assert.ok(next.scene.claimSources.some(s => s.claim === claim && next.scene.sources[s.source]!.id === "network-pd"));

  const verdicts = samples.map(value => {
    Object.assign(type, { value, confidence: "inferred" });
    return snapshot(after, docs([replacement])).result.goals[0]!.verdict;
  });
  assert.deepEqual(new Set(verdicts), new Set(["ok", "impossible"]));
  assert.equal(next.result.goals[0]!.verdict, "unknown");
  assert.equal(next.result.goals[0]!.truncated, false);
});
