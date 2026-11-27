// PoE 전력과 이더넷 작업이 한 케이블을 공유하는 편집 예제를 만든다.
import connectors from "../fixtures/network/connectors.json" with { type: "json" };
import copper from "../fixtures/network/network-copper@1.json" with { type: "json" };
import host from "../fixtures/network/network-host@1.json" with { type: "json" };
import pd from "../fixtures/network/network-pd@1.json" with { type: "json" };
import pse from "../fixtures/network/network-pse@1.json" with { type: "json" };
import fixture from "../fixtures/network/scene.json" with { type: "json" };
import type { InventoryItem, Library, Model, SceneDocument } from "./document.ts";

const inventory: InventoryItem[] = [
  { instanceId: "pse", modelId: pse.modelId, revision: pse.revision, alias: "PoE 송전 장치", state: "owned" },
  { instanceId: "pd", modelId: pd.modelId, revision: pd.revision, alias: "PoE 수전 장치", state: "owned" },
  { instanceId: "poe-wire", modelId: copper.modelId, revision: copper.revision, alias: "이더넷 케이블", state: "owned" },
  { instanceId: "spare-wire", modelId: copper.modelId, revision: copper.revision, alias: "예비 이더넷 케이블", state: "owned" },
  { instanceId: "host-a", modelId: host.modelId, revision: host.revision, alias: "LAN 단말", state: "candidate" },
];

const models: Model[] = [
  { ...pse, kind: "device", ports: pse.ports.map(port => ({
    ...port, position: { face: "rear", x: 0.8, y: 0.5, confidence: "inferred", sources: [pse.sources[0]!.id] },
  })) },
  { ...pd, kind: "device", ports: pd.ports.map(port => ({
    ...port, position: { face: "rear", x: 0.2, y: 0.5, confidence: "inferred", sources: [pd.sources[0]!.id] },
  })) },
  { ...copper, kind: "cable" },
  { ...host, kind: "device" },
];

const workloads = fixture.workloads.filter(workload => workload.id === "poe-12" || workload.id === "poe-ethernet");
export const example = {
  sceneId: "poe-canvas",
  items: inventory.slice(0, 3),
  sources: fixture.sources,
  connections: fixture.connections.filter(connection => connection.id === "poe"),
  workloads,
  scenarios: [{ id: "poe", members: workloads.map(workload => workload.id) }],
  layout: { placements: [
    { instanceId: "pse", x: 40, y: 160 },
    { instanceId: "pd", x: 555, y: 225 },
  ] },
} satisfies SceneDocument & Pick<typeof fixture, "workloads" | "scenarios">;

export const exampleLibrary: Library = {
  inventory, models, connectors: connectors.connectors.map(connector => ({ ...connector, glyph: "rj45" })),
};
