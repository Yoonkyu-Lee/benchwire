// 실제 작업대에서 편집과 대형 장면 입력을 재현할 합성 문서를 만든다.
import "./style.css";
import type { Connection, InventoryItem, Model, Port, SceneDocument } from "./document.ts";
import { mountWorkbench } from "./workbench.ts";

const source = { id: "ui", title: "화면 시험", locator: "fixture:ui", retrievedAt: "2026-11-27" };
const evidence = { value: true, confidence: "inferred", sources: [source.id] };
const connectorIds = ["rj45", "usb-c", "hdmi", "displayport"];
const connectors = { connectors: connectorIds.map(id => ({ id, glyph: id })) };
const testInterfaces = [{ domain: "network", protocol: "Ethernet" }, { domain: "network", protocol: "PoE PD" }];
const testPorts = Array.from({ length: 3 }, (_, i): Port => ({
  id: `p${i}`, label: `포트 ${i + 1}`, connector: { value: i === 2 ? "test-connector" : "rj45" },
  interfaces: testInterfaces,
  ...(i < 2 && { position: { face: "rear" as const, x: i === 0 ? 0.2 : 0.8, y: 0.5, confidence: "inferred" as const, sources: [source.id] } }),
}));
const testModel: Model = { modelId: "test-node", revision: "1", name: "시험 장치", kind: "device", ports: testPorts };
const cableModel: Model = { modelId: "test-cable", revision: "1", name: "시험 케이블", kind: "cable", ports: testPorts.slice(0, 2) };
const inventory = ["a", "b", "c", "d", "wire"].map((id, index): InventoryItem => ({
  instanceId: id, modelId: id === "wire" ? cableModel.modelId : testModel.modelId, revision: "1",
  alias: id === "wire" ? "시험 케이블" : `시험 장치 ${id.toUpperCase()}`, state: index === 3 ? "candidate" : "owned",
}));
const initial: SceneDocument = {
  sceneId: "편집 시험", items: inventory.slice(0, 3), connections: [], sources: [source],
  layout: { placements: [
    { instanceId: "a", x: 50, y: 50 }, { instanceId: "b", x: 440, y: 125 }, { instanceId: "c", x: 430, y: 390 },
  ], viewport: { cx: 400, cy: 285, zoom: 1 } },
};

declare global {
  interface Window {
    benchwire: {
      open(scene?: SceneDocument): void;
      read(): SceneDocument;
      changes(): number;
      tried(): string[];
    };
  }
}

const root = document.querySelector<HTMLElement>("#app")!;
const performanceMode = location.search === "?performance";
const testLibrary = { models: [testModel, cableModel], inventory, connectors };
let count = 0;
const tried: string[] = [];
function open(scene = initial) {
  count = 0;
  tried.length = 0;
  return mountWorkbench(root, scene, testLibrary, {
    onChange: () => { count++; },
    checkConnection(candidate, id) {
      const connection = candidate.connections.find(c => c.id === id)!;
      tried.push(id);
      return connection.from.instanceId === "a" && connection.to.instanceId === "c"
        ? { allowed: false, reason: "커넥터가 맞지 않습니다.", required: ["USB-C → DP 어댑터"] }
        : { allowed: true };
    },
  });
}

if (performanceMode) {
  const domains = ["display", "data", "network", "power"];
  const model: Model = {
    modelId: "performance-node", revision: "1", kind: "device", name: "측정 장치",
    ports: Array.from({ length: 8 }, (_, i): Port => ({
      id: `p${i}`, label: `포트 ${i + 1}`, connector: { value: connectorIds[Math.floor(i / 2)] },
      position: { face: i < 4 ? "front" : "rear", x: i % 2 ? 0.75 : 0.25, y: i % 4 < 2 ? 0.2 : 0.8,
        confidence: "inferred", sources: [source.id] },
      interfaces: [{ domain: domains[Math.floor(i / 2)]! }],
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
      parts: [{ instanceId: `cable-${id}`, entry: "p0", exit: "p1" }], evidence });
  }
  mountWorkbench(root, {
    sceneId: "성능 측정", sources: [source], connections,
    items: [...items, ...connections.map((_, i) => ({ instanceId: `cable-${i}`, modelId: cableModel.modelId, revision: "1" }))],
    layout: { placements: items.map((item, i) => ({ instanceId: item.instanceId, x: i % 5 * 260, y: Math.floor(i / 5) * 190 })),
      viewport: { cx: 620, cy: 710, zoom: 0.76 } },
  }, { models: [model, cableModel], inventory: [], connectors });
  // 근거 레이어를 맡은 조각이 합쳐지기 전에도 스파이크와 같은 입자 수로 측정한다.
  const ns = "http://www.w3.org/2000/svg";
  for (const [i, path] of document.querySelectorAll<SVGPathElement>(".wire-line").entries()) {
    path.id = `motion-path-${i}`;
    const particle = document.createElementNS(ns, "circle");
    particle.setAttribute("r", "3");
    particle.setAttribute("fill", "#315d66");
    particle.setAttribute("pointer-events", "none");
    const animation = document.createElementNS(ns, "animateMotion");
    animation.setAttribute("dur", `${1100 + i % 7 * 130}ms`);
    animation.setAttribute("begin", `-${i * 37}ms`);
    animation.setAttribute("repeatCount", "indefinite");
    const link = document.createElementNS(ns, "mpath");
    link.setAttribute("href", "#" + path.id);
    animation.append(link);
    particle.append(animation);
    path.parentElement!.append(particle);
  }
} else {
  let workbench = open();
  window.benchwire = {
    open(scene) { workbench = open(scene); },
    read: () => workbench.readDocument(),
    changes: () => count,
    tried: () => tried,
  };
}
