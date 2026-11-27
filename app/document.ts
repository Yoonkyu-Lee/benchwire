// 조작 화면이 읽는 저장 문서와 실제로 확정할 편집 의도를 정의한다.
export interface Point { x: number; y: number }
export interface Placement extends Point { instanceId: string }
export interface Viewport { cx: number; cy: number; zoom: number }
export interface Part { instanceId: string; entry: string; exit: string }
export interface PortRef { instanceId: string; id: string }
export interface Item { instanceId: string; modelId: string; revision: string; alias?: string; state?: string }
export interface InventoryItem extends Item { state: "owned" | "candidate" }
type Confidence = "official" | "review" | "community" | "user_verified" | "inferred" | "unknown";
export type Face = "front" | "rear" | "left" | "right" | "top" | "bottom";

export interface Port {
  id: string;
  label: string;
  connector: { value: unknown };
  interfaces: readonly { domain: string; protocol?: string }[];
  position?: Point & { face: Face; confidence: Confidence; sources: readonly string[] };
}
export interface Model {
  modelId: string;
  revision: string;
  name: string;
  kind: "device" | "cable" | "adapter";
  ports: readonly Port[];
}
export interface Library {
  inventory: readonly InventoryItem[];
  models: readonly Model[];
  connectors: readonly { id: string; glyph?: string }[];
}
export interface SceneDocument {
  sceneId: string;
  items: readonly Item[];
  connections: readonly Connection[];
  sources: readonly Source[];
  layout?: { placements?: readonly Placement[]; viewport?: Viewport };
}
interface Source { id: string; title: string; locator: string; retrievedAt: string }
export interface Connection {
  id: string;
  from: PortRef;
  to: PortRef;
  parts: readonly Part[];
  evidence: { value: boolean; confidence: string; sources: readonly string[] };
}
export type SceneIntent =
  | { kind: "place"; instanceId: string; position: Point }
  | { kind: "add-item"; item: InventoryItem; position: Point }
  | { kind: "connect"; from: PortRef; to: PortRef };

export function modelKey(item: Pick<Item, "modelId" | "revision">) {
  return JSON.stringify([item.modelId, item.revision]);
}

export function portKey(ref: PortRef) {
  return JSON.stringify([ref.instanceId, ref.id]);
}

export function place(scene: SceneDocument, instanceId: string, position: Point) {
  const placement = { instanceId, ...position };
  const placements = (scene.layout?.placements ?? []).filter(p => p.instanceId !== instanceId);
  return { ...scene, layout: { ...scene.layout, placements: [...placements, placement] } };
}

export function addConnection(scene: SceneDocument, from: PortRef, to: PortRef, cable?: { item: InventoryItem; part: Part }) {
  const locator = "canvas:placement";
  let source = scene.sources.find(s => s.locator === locator);
  let sources = scene.sources;
  if (!source) {
    source = { id: nextId("canvas", new Set(sources.map(s => s.id))), title: "캔버스에 놓은 연결",
      locator, retrievedAt: new Date().toISOString().slice(0, 10) };
    sources = [...sources, source];
  }
  const id = nextId("connection", new Set(scene.connections.map(c => c.id)));
  const connection = { id, from, to, parts: cable ? [cable.part] : [],
    evidence: { value: true, confidence: "inferred", sources: [source.id] } };
  const items = cable && !scene.items.some(i => i.instanceId === cable.item.instanceId) ? [...scene.items, cable.item] : scene.items;
  return { ...scene, sources, items, connections: [...scene.connections, connection] };
}

function nextId(prefix: string, used: ReadonlySet<string>) {
  let n = 1;
  while (used.has(prefix + "-" + n)) n++;
  return prefix + "-" + n;
}
