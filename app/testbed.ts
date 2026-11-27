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
import type { InventoryItem, Library, Model, Port, SceneDocument } from "./document.ts";
import exampleRegistry from "../fixtures/example/connectors.json" with { type: "json" };
import { benchmark } from "./assessment-fixture.ts";
import { percentiles, phaseInputs } from "./assessment.profile.ts";
import { evaluateInWorker, loadAssessment } from "./assessment.ts";
import { mountCanvas } from "./canvas.ts";
import { resultView } from "./results.ts";
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
  initial: sceneFile.parse({
    ...altScene,
    scenarios: [...altScene.scenarios, { id: "hub-only", members: ["hub"] }],
    ...(mode === "limit" && { layout: { placements: [
      { instanceId: "host", x: 20, y: 170 },
      { instanceId: "monitor", x: 480, y: 260 },
    ], viewport: { cx: 550, cy: 300, zoom: 1 } } }),
  }),
  library: {
    models: [altHost, altMonitor, altCable].map(model => modelFile.parse(mode === "limit" && model.modelId === altHost.modelId
      ? { ...altHost, ports: altHost.ports.map(port => ({
        ...port, interfaces: port.interfaces.map(iface => iface.id === "video" ? {
          ...iface, params: { ...iface.params, pin: { ...iface.params.pin, value: null, confidence: "unknown" } },
        } : iface),
      })) } : model)),
    inventory: [], connectors: connectorsFile.parse(altConnectors),
  },
};
const editCase = { initial, library: { models: [testModel, peer, mismatch, cableModel], inventory, connectors } };
const fixture = mode === "performance" ? benchmark() : mode === "profile" || mode === "limit" ? profileCase
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
      phases: typeof profile;
      workerBarrier(): Promise<void>;
    };
  }
}

async function profile() {
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:72px 0 0 262px;background:#f2f6f6";
  document.body.append(host);
  try {
    const inputs = phaseInputs();
    const canvas = mountCanvas(host, inputs.library, { intent() {}, status() {} });
    const owner = {};
    const samples: { load: number; evaluate: number; variants: number; roundTrip: number; draw: number; paint: number }[] = [];
    for (let i = 0; i < 24; i++) {
      const loadStart = performance.now();
      const loaded = loadAssessment(inputs.initial, inputs.documents, null);
      if ("error" in loaded) throw new Error(loaded.error);
      const { scene } = loaded;
      const request = performance.now();
      const basic = await evaluateInWorker(owner, { kind: "primary", document: inputs.initial, documents: inputs.documents });
      const roundTrip = performance.now() - request;
      const variants = await evaluateInWorker(owner, { kind: "variants", document: inputs.initial, documents: inputs.documents, scenario: 0 });
      if (basic?.kind !== "primary" || variants?.kind !== "variants") throw new Error("단계별 평가 실패");
      const start = performance.now();
      const view = resultView(scene, basic.result, 0, "together");
      canvas.render(inputs.initial, view.wires);
      const draw = performance.now() - start;
      await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())));
      if (i >= 3) samples.push({ load: request - loadStart, evaluate: basic.elapsed, variants: variants.elapsed,
        roundTrip, draw, paint: performance.now() - start });
    }
    const stages = Object.fromEntries((["load", "evaluate", "variants", "roundTrip", "draw", "paint"] as const)
      .map(key => [key, percentiles(samples.map(s => s[key]))]));
    return { samples, stages };
  } finally { host.remove(); }
}

window.benchwire = {
  open(scene) { workbench = open(scene); },
  read: () => workbench.readDocument(),
  edit: scene => workbench.editScenario(scene),
  changes: () => count,
  scenario: id => workbench.setScenario(id),
  phases: profile,
  async workerBarrier() {
    const document = { sceneId: "측정 동기화", items: [], connections: [], sources: [], workloads: [], scenarios: [] };
    await evaluateInWorker({}, { kind: "primary", document, documents: workbench.documents });
  },
};
