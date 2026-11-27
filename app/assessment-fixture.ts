// Node와 Edge에서 똑같은 50기기·400포트·100선 평가 입력을 만든다.
import copper from "../fixtures/network/network-copper@1.json" with { type: "json" };
import host from "../fixtures/network/network-host@1.json" with { type: "json" };
import registry from "../fixtures/network/connectors.json" with { type: "json" };
import { connectorsFile, modelFile } from "../scene/files.ts";
import type { Connection, Library, Model, Port, SceneDocument } from "./document.ts";

const source = { id: "ui", title: "화면 시험", locator: "fixture:ui", retrievedAt: "2026-11-27" };
const evidence = { value: true, confidence: "inferred" as const, sources: [source.id] };
const hostModel = modelFile.parse(host);
const hostPort = hostModel.ports[0]!;
const cableModel = modelFile.parse(copper);
const connectors = connectorsFile.parse(registry);

export function benchmark(): { initial: SceneDocument; library: Library } {
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
