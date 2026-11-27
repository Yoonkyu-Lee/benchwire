// 저장 스키마의 편집 문서 형과 캔버스 편집 의도를 정의한다.
import type { z } from "zod";
import type { connectorsFile, modelFile, sceneFile } from "../scene/files.ts";

export interface Point { x: number; y: number }
export type SceneDocument = z.input<typeof sceneFile>;
export type Item = SceneDocument["items"][number];
export type Connection = SceneDocument["connections"][number];
export type Part = Connection["parts"][number];
export type PortRef = Connection["from"];
export type InventoryItem = Item & { state: "owned" | "candidate" };
export type Model = z.input<typeof modelFile>;
export type Port = Model["ports"][number];
export type Face = NonNullable<Port["position"]>["face"];
export type Viewport = NonNullable<NonNullable<SceneDocument["layout"]>["viewport"]>;
export interface Library {
  inventory: readonly InventoryItem[];
  models: readonly Model[];
  connectors: z.input<typeof connectorsFile>;
}
export type SceneIntent =
  | { kind: "place"; instanceId: string; position: Point }
  | { kind: "add-item"; item: InventoryItem; position: Point }
  | { kind: "connect"; from: PortRef; to: PortRef }
  | { kind: "edit-scenario" };

export function modelKey(item: Pick<Item, "modelId" | "revision">) {
  return item.modelId + "@" + item.revision;
}

export function portKey(ref: PortRef) {
  return JSON.stringify([ref.instanceId, ref.id]);
}

export function place(scene: SceneDocument, instanceId: string, position: Point): SceneDocument {
  const placement = { instanceId, ...position };
  const placements = (scene.layout?.placements ?? []).filter(p => p.instanceId !== instanceId);
  return { ...scene, layout: { ...scene.layout, placements: [...placements, placement] } };
}

export function addConnection(scene: SceneDocument, from: PortRef, to: PortRef, cable?: { item: Item; part: Part }): SceneDocument {
  const locator = "canvas:placement";
  let source = scene.sources.find(s => s.locator === locator);
  let sources = scene.sources;
  if (!source) {
    source = { id: nextId("canvas", new Set(sources.map(s => s.id))), title: "캔버스에 놓은 연결",
      locator, retrievedAt: new Date().toISOString().slice(0, 10) };
    sources = [...sources, source];
  }
  const id = nextId("connection", new Set(scene.connections.map(c => c.id)));
  const connection: Connection = { id, from, to, parts: cable ? [cable.part] : [],
    evidence: { value: true, confidence: "inferred", sources: [source.id] } };
  const items = cable && !scene.items.some(i => i.instanceId === cable.item.instanceId) ? [...scene.items, cable.item] : scene.items;
  return { ...scene, sources, items, connections: [...scene.connections, connection] };
}

function nextId(prefix: string, used: ReadonlySet<string>) {
  let n = 1;
  while (used.has(prefix + "-" + n)) n++;
  return prefix + "-" + n;
}
