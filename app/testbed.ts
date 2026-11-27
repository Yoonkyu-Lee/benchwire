// Edge에서 실제 엔진과 편집 동작을 재현할 작은 장면과 50기기 장면을 연다.
import "./style.css";
import copper from "../fixtures/network/network-copper@1.json" with { type: "json" };
import host from "../fixtures/network/network-host@1.json" with { type: "json" };
import altConnectors from "../fixtures/t2/connectors.json" with { type: "json" };
import altScene from "../fixtures/t2/scene.json" with { type: "json" };
import altCable from "../fixtures/t2/t2-cable@1.json" with { type: "json" };
import altHost from "../fixtures/t2/t2-host@1.json" with { type: "json" };
import altMonitor from "../fixtures/t2/t2-monitor@1.json" with { type: "json" };
import { connectorsFile, modelFile, sceneFile } from "../scene/files.ts";
import type { Connection, InventoryItem, Library, Model, Port, SceneDocument } from "./document.ts";
import exampleRegistry from "../fixtures/example/connectors.json" with { type: "json" };
import { mountWorkbench } from "./workbench.ts";

const source = { id: "ui", title: "화면 시험", locator: "fixture:ui", retrievedAt: "2026-11-27" };
const evidence = { value: true, confidence: "inferred" as const, sources: [source.id] };
const hostModel = modelFile.parse(host);
const hostPort = hostModel.ports[0]!;
const makeCopper = () => modelFile.parse(copper);
const networkRegistry = connectorsFile.parse(exampleRegistry);
const connectors: Library["connectors"] = {
  ...networkRegistry, sources: [...networkRegistry.sources, source],
  connectors: [...networkRegistry.connectors, { id: "test-connector", endForm: { ...evidence, value: "receptacle" } }],
};

const testPorts = Array.from({ length: 3 }, (_, i): Port => ({
  ...hostPort, id: `p${i}`, label: `포트 ${i + 1}`,
  connector: { ...hostPort.connector, value: i === 2 ? "test-connector" : "network-socket" },
  interfaces: [{ ...hostPort.interfaces[0]!, id: `lan-${i}` }],
  ...(i < 2 && { position: { face: "rear" as const, x: i === 0 ? 0.2 : 0.8, y: 0.5, confidence: "inferred" as const, sources: [host.sources[0]!.id] } }),
}));
const testModel: Model = { ...hostModel, modelId: "test-node", name: "시험 장치", ports: testPorts };
const peer: Model = {
  ...testModel, modelId: "test-peer", ports: testPorts.map((p, i) => i === 1 ? { ...p, connector: { ...p.connector, value: "network-plug" } } : p),
};
const mismatch: Model = {
  ...testModel, modelId: "test-mismatch", ports: testPorts.map((p, i) => i === 0 ? { ...p, connector: { ...p.connector, value: "test-connector" } } : p),
};
const cableModel = makeCopper();
const names = [testModel, peer, mismatch, testModel, cableModel];
const inventory = ["a", "b", "c", "d", "wire"].map((id, index): InventoryItem => ({
  instanceId: id, modelId: names[index]!.modelId, revision: "1",
  alias: id === "wire" ? "시험 케이블" : `시험 장치 ${id.toUpperCase()}`, state: index === 3 ? "candidate" : "owned",
}));
const initial: SceneDocument = {
  sceneId: "편집 시험", items: inventory.slice(0, 3), connections: [], sources: [source], workloads: [], scenarios: [],
  layout: { placements: [
    { instanceId: "a", x: 50, y: 50 }, { instanceId: "b", x: 440, y: 125 }, { instanceId: "c", x: 430, y: 390 },
  ], viewport: { cx: 400, cy: 285, zoom: 1 } },
};

function benchmark(): { initial: SceneDocument; library: Library } {
  const model: Model = {
    ...hostModel, modelId: "performance-node", name: "측정 장치",
    nodes: Array.from({ length: 8 }, (_, i) => ({ id: "nic-" + i, kind: "junction", label: "포트 " + (i + 1) })),
    ports: Array.from({ length: 8 }, (_, i): Port => ({
      ...hostPort, id: `p${i}`, label: `포트 ${i + 1}`, interfaces: [{ ...hostPort.interfaces[0]!, id: `lan-${i}` }],
      attachment: { ...hostPort.attachment, value: "nic-" + i },
      position: { face: i < 4 ? "front" : "rear", x: i % 2 ? 0.75 : 0.25, y: i % 4 < 2 ? 0.2 : 0.8,
        confidence: "inferred", sources: [host.sources[0]!.id] },
    })),
  };
  const items = Array.from({ length: 50 }, (_, i) => ({
    instanceId: `grid-${i}`, modelId: model.modelId, revision: "1", alias: `장치 ${i + 1}`,
  }));
  const connections: Connection[] = [];
  for (let i = 0; i < items.length; i++) {
    const col = i % 5;
    const row = Math.floor(i / 5);
    if (col < 4) edge(i, i + 1, 0);
    if (row < 9) edge(i, i + 5, 2);
    if (row < 4 && col < 4 && i !== 0) edge(i, i + 6, 4);
  }
  function edge(from: number, to: number, pair: number) {
    const id = connections.length;
    connections.push({ id: `wire-${id}`, from: { instanceId: items[from]!.instanceId, id: `p${pair}` },
      to: { instanceId: items[to]!.instanceId, id: `p${pair + 1}` },
      parts: [{ instanceId: `cable-${id}`, entry: "a", exit: "b" }], evidence });
  }
  const workloads: SceneDocument["workloads"] = connections.filter((_, i) => i % 10 === 0).map((edge, i) => ({
    id: `traffic-${i}`, kind: "traffic", domain: "network",
    from: { ...edge.from, id: "nic-" + edge.from.id.slice(1) }, to: { ...edge.to, id: "nic-" + edge.to.id.slice(1) },
    request: { throughput: { ...evidence, value: 900, unit: "Mbps" } },
  }));
  return {
    initial: {
      sceneId: "성능 측정", sources: [source], connections, workloads,
      scenarios: [{ id: "together", members: workloads.map(w => w.id) }],
      items: [...items, ...connections.map((_, i) => ({ instanceId: `cable-${i}`, modelId: cableModel.modelId, revision: "1" }))],
      layout: { placements: items.map((item, i) => ({ instanceId: item.instanceId, x: i % 5 * 260, y: Math.floor(i / 5) * 190 })),
        viewport: { cx: 620, cy: 710, zoom: 0.76 } },
    },
    library: { models: [model, cableModel], inventory: [], connectors },
  };
}

const mode = location.search.slice(1);
async function serverExample(unknownLoss: boolean) {
  const response = await fetch("/api/library");
  const library = await response.json() as Library & { scenes: { id: string; example: boolean }[] };
  const example = library.scenes.find(scene => scene.example)!;
  const saved = await fetch("/api/scenes/" + example.id);
  const initial = sceneFile.parse(await saved.json());
  const models = unknownLoss ? library.models.map(model => model.modelId === copper.modelId ? modelFile.parse({
    ...model, attributes: { network: { ...model.attributes?.network, poeLoss: {
      ...model.attributes?.network?.poeLoss, value: null, confidence: "unknown",
    } } },
  }) : model) : library.models;
  return { initial, library: { ...library, models } };
}
const profileCase = {
  initial: sceneFile.parse({ ...altScene, scenarios: [...altScene.scenarios, { id: "hub-only", members: ["hub"] }] }),
  library: { models: [altHost, altMonitor, altCable].map(model => modelFile.parse(model)), inventory: [], connectors: connectorsFile.parse(altConnectors) },
};
const editCase = { initial, library: { models: [testModel, peer, mismatch, cableModel], inventory, connectors } };
const fixture = mode === "performance" ? benchmark() : mode === "profile" ? profileCase
  : mode === "example" || mode === "unknown" ? await serverExample(mode === "unknown") : editCase;
const root = document.querySelector<HTMLElement>("#app")!;
let count = 0;
function open(scene = fixture.initial) {
  count = 0;
  return mountWorkbench(root, scene, fixture.library, { onChange: () => { count++; } });
}
let workbench = open();

declare global {
  interface Window {
    benchwire: {
      open(scene?: SceneDocument): void;
      read(): SceneDocument;
      edit(scene: SceneDocument): boolean;
      changes(): number;
      scenario(id: string): boolean;
    };
  }
}

window.benchwire = {
  open(scene) { workbench = open(scene); },
  read: () => workbench.readDocument(),
  edit: scene => workbench.editScenario(scene),
  changes: () => count,
  scenario: id => workbench.setScenario(id),
};
