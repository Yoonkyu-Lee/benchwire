// SVG 카드와 배선을 그리며 포인터·키보드 조작을 장면 편집 의도로 내보낸다.
import { occupiedPorts } from "./connection.ts";
import { modelKey, portKey, type Library, type Point, type PortRef, type SceneDocument, type SceneIntent, type Viewport } from "./document.ts";
import { wireLayers, type Layer } from "./layers.ts";
import { cardLayout, CARD_WIDTH, type PortLayout } from "./layout.ts";

const SVG = "http://www.w3.org/2000/svg";
const glyphs = new Map([
  ["usb-c", "M-8-4h16a4 4 0 0 1 0 8H-8a4 4 0 0 1 0-8z"],
  ["displayport", "M-8-5h16v7l-4 3H-8z"],
  ["hdmi", "M-8-5h16v6l-4 4h-8l-4-4z"],
  ["rj45", "M-8-5h16v10H3V2h-6v3h-5z"],
  ["barrel", "M0-6a6 6 0 1 0 0 12a6 6 0 1 0 0-12z M-1 0h2"],
]);
const neutral = "M0-6l7 6-7 6-7-6z";

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, number | string> = {}) {
  const el = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, String(value));
  return el;
}

function label(value: string, x: number, y: number, style: string) {
  const text = svg("text", { x, y, class: style });
  text.textContent = value;
  return text;
}

interface Card { position: Point; element: SVGGElement; height: number; wires: Wire[] }
interface Socket { card: Card; layout: PortLayout; ref: PortRef; element: SVGGElement }
interface Wire { from: Socket; to: Socket; lines: SVGPathElement[]; caption: SVGGElement }
type Gesture = { pointer: number; start: Point } & (
  | { kind: "pan"; origin: Point }
  | { kind: "move"; instanceId: string; card: Card; origin: Point }
  | { kind: "connect"; source: Socket }
);

const MIN_ZOOM = 0.14;
const MAX_ZOOM = 2.6;
const DRAG_DISTANCE = 3;


export function mountCanvas(root: HTMLElement, library: Library,
  actions: { intent: (intent: SceneIntent) => void; status: (text: string) => void; selectConnection?: ((id: string) => void) | undefined }) {
  const surface = svg("svg", { class: "surface", "aria-label": "장면 캔버스", tabindex: "0" });
  const world = svg("g", { class: "world" });
  const wireLayer = svg("g", { class: "wires" });
  const cardLayer = svg("g", { class: "cards" });
  const preview = svg("path", { class: "connection-preview" });
  world.append(wireLayer, cardLayer, preview);
  surface.append(world);
  root.append(surface);

  const models = new Map(library.models.map(m => [modelKey(m), m]));
  const connectors = new Map(library.connectors.map(c => [c.id, c.glyph]));
  const cards = new Map<string, Card>();
  const sockets = new Map<string, Socket>();
  const wires = new Map<string, Wire>();
  const hidden = new Set<Layer>();
  let occupied = new Set<string>();
  let camera = { x: 0, y: 0, zoom: 1 };
  let gesture: Gesture | undefined;
  let selected: Socket | undefined;
  let highlighted: string | undefined;
  let drawn = false;

  function cameraTransform() {
    world.setAttribute("transform", `translate(${camera.x} ${camera.y}) scale(${camera.zoom})`);
    surface.style.setProperty("--grid-size", `${24 * camera.zoom}px`);
    surface.style.setProperty("--grid-x", `${camera.x}px`);
    surface.style.setProperty("--grid-y", `${camera.y}px`);
  }

  function local(client: Point): Point {
    const rect = surface.getBoundingClientRect();
    return { x: client.x - rect.left, y: client.y - rect.top };
  }

  function toWorld(point: Point): Point {
    return { x: (point.x - camera.x) / camera.zoom, y: (point.y - camera.y) / camera.zoom };
  }

  function center() {
    return { x: surface.clientWidth / 2, y: surface.clientHeight / 2 };
  }

  function zoom(factor: number, anchor = center()) {
    const current = toWorld(anchor);
    const scale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, camera.zoom * factor));
    camera = { x: anchor.x - current.x * scale, y: anchor.y - current.y * scale, zoom: scale };
    cameraTransform();
  }

  function lookAt(v: Viewport) {
    const size = center();
    camera = { x: size.x - v.cx * v.zoom, y: size.y - v.cy * v.zoom, zoom: v.zoom };
    cameraTransform();
  }

  function fit() {
    if (!cards.size) { lookAt({ cx: 0, cy: 0, zoom: 1 }); return; }
    const positions = [...cards.values()];
    const left = Math.min(...positions.map(c => c.position.x));
    const top = Math.min(...positions.map(c => c.position.y));
    const right = Math.max(...positions.map(c => c.position.x + CARD_WIDTH));
    const bottom = Math.max(...positions.map(c => c.position.y + c.height));
    const zoom = Math.max(MIN_ZOOM, Math.min(1, (surface.clientWidth - 90) / (right - left), (surface.clientHeight - 90) / (bottom - top)));
    lookAt({ cx: (left + right) / 2, cy: (top + bottom) / 2, zoom });
  }

  function coords(socket: Socket) {
    return { x: socket.card.position.x + socket.layout.x, y: socket.card.position.y + socket.layout.y };
  }

  function curve(from: Point, to: Point, offset = 0) {
    const a = { x: from.x, y: from.y + offset }, b = { x: to.x, y: to.y + offset };
    const swing = Math.min(100, Math.max(20, Math.abs(b.x - a.x) / 2));
    const sign = b.x >= a.x ? 1 : -1;
    return `M${a.x},${a.y} C${a.x + swing * sign},${a.y} ${b.x - swing * sign},${b.y} ${b.x},${b.y}`;
  }

  function paintWire(wire: Wire) {
    const a = coords(wire.from), b = coords(wire.to);
    wire.lines.forEach((line, i) => line.setAttribute("d", curve(a, b, (i - (wire.lines.length - 1) / 2) * 5)));
    const [left, right] = a.x <= b.x ? [wire.from.card, wire.to.card] : [wire.to.card, wire.from.card];
    const [top, bottom] = a.y <= b.y ? [wire.from.card, wire.to.card] : [wire.to.card, wire.from.card];
    const rightEdge = left.position.x + CARD_WIDTH;
    const lowerEdge = top.position.y + top.height;
    const x = rightEdge < right.position.x ? (rightEdge + right.position.x) / 2 : (a.x + b.x) / 2;
    const y = lowerEdge < bottom.position.y ? (lowerEdge + bottom.position.y) / 2 : (a.y + b.y) / 2 - 20;
    wire.caption.setAttribute("transform", `translate(${x} ${y})`);
  }

  function move(card: Card, position: Point) {
    card.position = position;
    card.element.setAttribute("transform", `translate(${position.x} ${position.y})`);
    card.wires.forEach(paintWire);
  }

  function mark(socket: Socket | undefined) {
    selected?.element.removeAttribute("aria-pressed");
    selected = socket;
    selected?.element.setAttribute("aria-pressed", "true");
  }

  function render(scene: SceneDocument) {
    const focused = socketAt(document.activeElement);
    gesture = undefined;
    preview.removeAttribute("d");
    mark(undefined);
    cards.clear();
    sockets.clear();
    wires.clear();
    wireLayer.replaceChildren();
    cardLayer.replaceChildren();
    occupied = occupiedPorts(scene);
    const byItem = new Map(scene.items.map(i => [i.instanceId, i]));
    const placements = new Map(scene.layout?.placements?.map(p => [p.instanceId, p]));
    const parts = new Set(scene.connections.flatMap(c => c.parts.map(p => p.instanceId)));
    const items = [...scene.items].sort((a, b) => a.instanceId === b.instanceId ? 0 : a.instanceId < b.instanceId ? -1 : 1);

    let index = 0;
    let rowY = 0;
    let rowHeight = 0;
    for (const item of items) {
      const model = models.get(modelKey(item));
      if (!model || model.kind === "cable" && parts.has(item.instanceId) &&
          model.ports.every(p => occupied.has(portKey({ instanceId: item.instanceId, id: p.id })))) continue;
      const layout = cardLayout(model);
      const column = index++ % 5;
      if (column === 0 && index > 1) {
        rowY += rowHeight + 72;
        rowHeight = 0;
      }
      rowHeight = Math.max(rowHeight, layout.height);
      const body = svg("g", { class: "device", "data-instance": item.instanceId });
      const card = { element: body, height: layout.height, wires: [], position: { x: 0, y: 0 } };
      const name = item.alias || model.name;
      const fullName = svg("title");
      fullName.textContent = name;
      body.append(fullName, svg("rect", { class: "device-body", width: CARD_WIDTH, height: layout.height, rx: 12 }),
        label(name.length > 15 ? name.slice(0, 14) + "…" : name, 16, 27, "device-name"),
        label(model.kind === "cable" ? "케이블" : model.kind === "adapter" ? "어댑터" : `포트 ${model.ports.length}개`, 16, 43, "device-meta"));
      for (const face of layout.panels) {
        body.append(svg("rect", { class: "port-face", "data-face": face.face, x: face.x, y: face.y, width: face.width, height: face.height, rx: 5 }),
          label(face.label, face.x, face.y + face.height + 13, "face-name"));
      }
      if (layout.listY !== null) body.append(svg("path", { class: "port-divider", d: `M14 ${layout.listY - 12}h184` }));
      for (const p of layout.ports) {
        const ref = { instanceId: item.instanceId, id: p.port.id };
        const key = portKey(ref);
        const connector = typeof p.port.connector.value === "string" ? p.port.connector.value : "결합 형태 미확인";
        const glyph = connectors.get(connector);
        const socket = svg("g", { class: "port", "data-port": p.port.id, "data-item": item.instanceId,
          "data-face": p.port.position?.confidence !== "unknown" ? p.port.position?.face ?? "list" : "list",
          role: "button", tabindex: "0", transform: `translate(${p.x} ${p.y})`,
          "aria-label": `${name} ${p.port.label} (${connector})`, "aria-disabled": String(occupied.has(key)) });
        const tooltip = svg("title");
        tooltip.textContent = `${p.port.label} · ${connector}`;
        socket.append(tooltip, svg("rect", { class: "port-hit", x: -11, y: -11, width: 22, height: 22, rx: 5 }),
          svg("path", { class: "port-glyph", "data-glyph": glyph && glyphs.has(glyph) ? glyph : "neutral",
            d: glyphs.get(glyph ?? "") ?? neutral }));
        body.append(socket);
        sockets.set(key, { card, layout: p, ref, element: socket });
      }
      cards.set(item.instanceId, card);
      cardLayer.append(body);
      move(card, placements.get(item.instanceId) ?? { x: column * (CARD_WIDTH + 80), y: rowY });
    }

    for (const edge of scene.connections) {
      const from = sockets.get(portKey(edge.from)), to = sockets.get(portKey(edge.to));
      if (!from || !to) continue;
      const group = svg("g", { class: "wire", "data-connection": edge.id });
      if (edge.id === highlighted) group.classList.add("highlighted");
      const domains = wireLayers(from.layout.port, to.layout.port);
      const lines = (domains.length ? domains : ["unclassified"] as const).map(layer => {
        const line = svg("path", { class: "wire-line", "data-layer": layer });
        if (layer !== "unclassified") line.classList.toggle("layer-hidden", hidden.has(layer));
        return line;
      });
      const name = edge.parts.map(p => {
        const item = byItem.get(p.instanceId);
        return item && (item.alias || models.get(modelKey(item))?.name) || p.instanceId;
      }).join(" · ");
      const caption = svg("g", { class: "wire-caption", "aria-hidden": "true" });
      if (name) caption.append(label(name, 0, 0, "wire-name"));
      group.append(...lines, caption);
      wireLayer.append(group);
      const wire = { from, to, lines, caption };
      wires.set(edge.id, wire);
      from.card.wires.push(wire);
      if (to.card !== from.card) to.card.wires.push(wire);
      paintWire(wire);
      updateCaption(wire);
    }
    if (!drawn) {
      drawn = true;
      if (scene.layout?.viewport) lookAt(scene.layout.viewport);
      else fit();
    }
    if (focused) sockets.get(portKey(focused.ref))?.element.focus({ preventScroll: true });
  }

  function updateCaption(wire: Wire) {
    wire.caption.classList.toggle("layer-hidden", wire.lines.every(line => line.classList.contains("layer-hidden")));
  }

  function setLayer(layer: Layer, visible: boolean) {
    if (visible) hidden.delete(layer);
    else hidden.add(layer);
    for (const wire of wires.values()) {
      for (const line of wire.lines) if (line.dataset.layer === layer) line.classList.toggle("layer-hidden", !visible);
      updateCaption(wire);
    }
  }

  function socketAt(target: EventTarget | null) {
    if (!(target instanceof Element)) return undefined;
    const port = target.closest<SVGGElement>("[data-port]");
    return port ? sockets.get(portKey({ instanceId: port.dataset.item!, id: port.dataset.port! })) : undefined;
  }

  function beginPort(socket: Socket) {
    if (occupied.has(portKey(socket.ref))) {
      actions.status("이미 연결된 포트입니다.");
      return false;
    }
    return true;
  }

  function connect(a: Socket, b: Socket) {
    if (a === b) { actions.status("연결할 다른 포트를 선택하세요."); return; }
    if (beginPort(b)) actions.intent({ kind: "connect", from: a.ref, to: b.ref });
  }

  function cancel() {
    if (gesture?.kind === "move") move(gesture.card, gesture.origin);
    if (gesture?.kind === "pan") { camera = { ...gesture.origin, zoom: camera.zoom }; cameraTransform(); }
    gesture = undefined;
    mark(undefined);
    preview.removeAttribute("d");
  }

  function highlight(group: SVGGElement) {
    highlighted = group.dataset.connection!;
    for (const child of wireLayer.children) child.classList.toggle("highlighted", child === group);
    actions.selectConnection?.(highlighted);
  }

  surface.addEventListener("pointerdown", event => {
    if (event.button !== 0 || gesture || !(event.target instanceof Element)) return;
    const start = local({ x: event.clientX, y: event.clientY });
    const socket = socketAt(event.target);
    const connection = event.target.closest<SVGGElement>("[data-connection]");
    const id = event.target.closest<SVGGElement>("[data-instance]")?.dataset.instance;
    const state = { pointer: event.pointerId, start };
    mark(undefined);
    if (socket) {
      socket.element.focus({ preventScroll: true });
      if (!beginPort(socket)) return;
      gesture = { ...state, kind: "connect", source: socket };
    } else if (connection) {
      highlight(connection);
      return;
    } else if (id) {
      const card = cards.get(id)!;
      gesture = { ...state, kind: "move", instanceId: id, card, origin: card.position };
    } else {
      gesture = { ...state, kind: "pan", origin: { x: camera.x, y: camera.y } };
    }
    surface.setPointerCapture(event.pointerId);
  });

  surface.addEventListener("pointermove", event => {
    if (!gesture || event.pointerId !== gesture.pointer) return;
    const p = local({ x: event.clientX, y: event.clientY });
    const dx = p.x - gesture.start.x, dy = p.y - gesture.start.y;
    if (gesture.kind === "connect") preview.setAttribute("d", curve(coords(gesture.source), toWorld(p)));
    else if (gesture.kind === "move") move(gesture.card, { x: gesture.origin.x + dx / camera.zoom, y: gesture.origin.y + dy / camera.zoom });
    else { camera.x = gesture.origin.x + dx; camera.y = gesture.origin.y + dy; cameraTransform(); }
  });

  surface.addEventListener("pointerup", event => {
    const active = gesture;
    if (!active || event.pointerId !== active.pointer) return;
    gesture = undefined;
    preview.removeAttribute("d");
    if (active.kind === "connect") {
      const target = socketAt(document.elementFromPoint(event.clientX, event.clientY));
      if (target) connect(active.source, target);
    } else if (active.kind === "move") {
      const p = local({ x: event.clientX, y: event.clientY });
      const dx = p.x - active.start.x, dy = p.y - active.start.y;
      if (Math.hypot(dx, dy) > DRAG_DISTANCE)
        actions.intent({ kind: "place", instanceId: active.instanceId,
          position: { x: active.origin.x + dx / camera.zoom, y: active.origin.y + dy / camera.zoom } });
      else move(active.card, active.origin);
    }
  });

  surface.addEventListener("lostpointercapture", event => {
    if (gesture?.pointer === event.pointerId) cancel();
  });

  surface.addEventListener("wheel", event => {
    event.preventDefault();
    if (gesture) return;
    const delta = event.deltaY * (event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? surface.clientHeight : 1);
    zoom(2 ** (-delta * 0.002), local({ x: event.clientX, y: event.clientY }));
  }, { passive: false });

  surface.addEventListener("keydown", event => {
    if (event.key === "Escape" && (selected || gesture)) {
      cancel();
      actions.status("연결 선택을 취소했습니다.");
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") return;
    const target = socketAt(event.target);
    if (!target) return;
    event.preventDefault();
    if (selected) {
      const from = selected;
      mark(undefined);
      connect(from, target);
    } else if (beginPort(target)) {
      mark(target);
      actions.status("연결할 반대편 포트에서 Enter 또는 Space를 누르세요.");
    }
  });
  return { render, setLayer, zoom, fit, fromClient: (point: Point) => toWorld(local(point)), center: () => toWorld(center()) };
}
