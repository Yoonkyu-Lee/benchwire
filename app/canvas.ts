// SVG 카드와 배선을 그리며 포인터·키보드 조작을 장면 편집 의도로 내보낸다.
import { occupiedPorts } from "./connection.ts";
import { modelKey, portKey, type Library, type Model, type Point, type Port, type PortRef, type SceneDocument, type SceneIntent, type Viewport } from "./document.ts";
import { wireLayers, type Layer } from "./layers.ts";
import type { WireMark } from "./results.ts";
import { cardRows, type CardMeasurements } from "./cards.ts";
import type { HeatMark } from "./heatmap.ts";
import { cardLayout, CARD_STAT_ROW, CARD_WIDTH, type PortLayout } from "./layout.ts";
import { mountParticles, type Curve, type FlowTrack } from "./particles.ts";

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

function portConflicts(port: Port, sources: Model["sources"]) {
  const fields = [
    ["커넥터", port.connector], ["부착 노드", port.attachment],
    ...port.interfaces.flatMap(iface => Object.entries(iface.params).map(([name, fact]) => [iface.protocol + " " + name, fact] as const)),
  ] as const;
  return fields.flatMap(([name, fact]) => {
    if (!fact.conflicts?.length) return [];
    return [fact, ...fact.conflicts].map(candidate => {
      const sourcesText = candidate.sources.map(id => sources.find(source => source.id === id)?.title ?? id).join(", ");
      const value = [String(candidate.value), fact.unit].filter(Boolean).join(" ");
      return [name, value, sourcesText].join(" · ");
    });
  });
}

interface Card { position: Point; element: SVGGElement; height: number; wires: Wire[] }
interface Socket { card: Card; layout: PortLayout; ref: PortRef; element: SVGGElement }
interface Wire { from: Socket; to: Socket; lines: SVGPathElement[]; labels: SVGTextElement[]; caption: SVGGElement; curves: Curve[]; tracks: FlowTrack[] }
interface WireEnd { id: string; end: "from" | "to"; fixed: Socket }
interface CanvasMarks {
  assessed?: ReadonlyMap<string, readonly WireMark[]> | undefined;
  measured?: CardMeasurements | undefined;
  heat?: ReadonlyMap<string, readonly HeatMark[]> | undefined;
  arrivals?: ReadonlySet<string> | undefined;
}
type Gesture = { pointer: number; start: Point } & (
  | { kind: "pan"; origin: Point }
  | { kind: "move"; instanceId: string; card: Card; origin: Point }
  | { kind: "connect"; source: Socket }
  | { kind: "rewire"; endpoint: WireEnd; source: Socket }
);

const MIN_ZOOM = 0.14;
const MAX_ZOOM = 2.6;
const DRAG_DISTANCE = 3;
const WIRE_LABEL_ZOOM = 1;
const WIRE_ARROWS = ["→", "↘", "↓", "↙", "←", "↖", "↑", "↗"];


export function mountCanvas(root: HTMLElement, library: Library,
  actions: { intent: (intent: SceneIntent) => void; status: (text: string) => void; selectConnection?: (id: string) => void;
    selectWorkload?: (id: string) => void; selectResource?: (row: number) => void }) {
  const surface = svg("svg", { class: "surface", "aria-label": "장면 캔버스", tabindex: "0" });
  const world = svg("g", { class: "world" });
  const wireLayer = svg("g", { class: "wires" });
  const cardLayer = svg("g", { class: "cards" });
  const preview = svg("path", { class: "connection-preview" });
  world.append(wireLayer, cardLayer, preview);
  surface.append(world);
  root.append(surface);

  const models = new Map(library.models.map(m => [modelKey(m), m]));
  const connectors = new Map(library.connectors.connectors.map(c => [c.id, c.glyph]));
  const cards = new Map<string, Card>();
  const sockets = new Map<string, Socket>();
  const wires = new Map<string, Wire>();
  const ends = new Map<Socket, WireEnd>();
  const hidden = new Set<Layer>();
  let occupied = new Set<string>();
  let camera = { x: 0, y: 0, zoom: 1 };
  const particles = mountParticles(root, () => camera, (x, y, padding) => {
    for (const { position, height } of cards.values()) {
      if (x + padding >= position.x && x - padding <= position.x + CARD_WIDTH &&
          y + padding >= position.y && y - padding <= position.y + height) return true;
    }
    return false;
  });
  let cameraFrame: number | undefined;
  let gesture: Gesture | undefined;
  const afterPointer: (() => void)[] = [];
  let selected: Socket | undefined;
  let selectedEnd: WireEnd | undefined;
  let highlighted: string | undefined;
  let drawn = false;

  function cameraTransform() {
    if (cameraFrame !== undefined) cancelAnimationFrame(cameraFrame);
    cameraFrame = undefined;
    world.setAttribute("transform", `translate(${camera.x} ${camera.y}) scale(${camera.zoom})`);
    surface.classList.toggle("compact-wires", camera.zoom < WIRE_LABEL_ZOOM);
  }

  function scheduleCamera() {
    cameraFrame ??= requestAnimationFrame(cameraTransform);
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

  function zoom(factor: number, anchor = center(), defer = false) {
    const current = toWorld(anchor);
    const scale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, camera.zoom * factor));
    camera = { x: anchor.x - current.x * scale, y: anchor.y - current.y * scale, zoom: scale };
    if (defer) scheduleCamera();
    else cameraTransform();
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

  function emptyPosition(model: Model): Point {
    const height = cardLayout(model, cardRows(model).length).height;
    const inset = 16, controls = 54, gap = 16;
    const min = toWorld({ x: inset, y: controls });
    const edge = toWorld({ x: surface.clientWidth - inset, y: surface.clientHeight - inset });
    const max = { x: edge.x - CARD_WIDTH, y: edge.y - height };
    const middle = toWorld(center());
    const preferred = { x: Math.max(min.x, Math.min(max.x, middle.x - CARD_WIDTH / 2)),
      y: Math.max(min.y, Math.min(max.y, middle.y - height / 2)) };
    const visible = [...cards.values()].filter(({ position: p, height: h }) =>
      p.x + CARD_WIDTH + gap > min.x && p.x - gap < edge.x && p.y + h + gap > min.y && p.y - gap < edge.y);
    const free = ({ x, y }: Point) => visible.every(({ position: p, height: h }) =>
      x + CARD_WIDTH + gap <= p.x || p.x + CARD_WIDTH + gap <= x || y + height + gap <= p.y || p.y + h + gap <= y);
    if (min.x <= max.x && min.y <= max.y) {
      if (free(preferred)) return preferred;
      const xs = new Set([min.x, max.x, preferred.x]);
      const ys = new Set([min.y, max.y, preferred.y]);
      for (const { position: p, height: h } of visible) {
        for (const x of [p.x - CARD_WIDTH - gap, p.x + CARD_WIDTH + gap]) if (x >= min.x && x <= max.x) xs.add(x);
        for (const y of [p.y - height - gap, p.y + h + gap]) if (y >= min.y && y <= max.y) ys.add(y);
      }
      let next: Point | undefined, distance = Infinity;
      for (const x of xs) for (const y of ys) {
        const delta = (x - preferred.x) ** 2 + (y - preferred.y) ** 2;
        if (delta < distance && free({ x, y })) { next = { x, y }; distance = delta; }
      }
      if (next) return next;
    }
    // 현재 뷰가 가득 차면 카드 오른쪽 빈 자리가 보이도록 뷰를 옮긴다.
    const x = Math.max(preferred.x, ...Array.from(cards.values(), ({ position }) => position.x + CARD_WIDTH + gap));
    const y = preferred.y;
    const scale = Math.min(camera.zoom, (surface.clientWidth - 2 * inset) / CARD_WIDTH,
      (surface.clientHeight - controls - inset) / height);
    lookAt({ cx: x + CARD_WIDTH / 2, cy: y + height / 2 - (controls - inset) / (2 * Math.max(MIN_ZOOM, scale)),
      zoom: Math.max(MIN_ZOOM, scale) });
    return { x, y };
  }

  function coords(socket: Socket) {
    return { x: socket.card.position.x + socket.layout.x, y: socket.card.position.y + socket.layout.y };
  }

  function curve(a: Point, b: Point, offset = 0): Curve {
    const swing = Math.min(100, Math.max(20, Math.abs(b.x - a.x) / 2)) * (b.x >= a.x ? 1 : -1);
    return [a.x, a.y + offset, a.x + swing, b.x - swing, b.x, b.y + offset];
  }

  function path([ax, ay, c1, c2, bx, by]: Curve) {
    return `M${ax},${ay} C${c1},${ay} ${c2},${by} ${bx},${by}`;
  }

  function paintWire(wire: Wire) {
    const a = coords(wire.from), b = coords(wire.to);
    const octant = Math.round(Math.atan2(b.y - a.y, b.x - a.x) / (Math.PI / 4));
    wire.lines.forEach((line, i) => {
      const geometry = curve(a, b, (i - (wire.lines.length - 1) / 2) * 5);
      wire.curves[i] = geometry;
      line.setAttribute("d", path(geometry));
      const direction = line.dataset.direction;
      const arrow = direction ? WIRE_ARROWS[(octant + (direction === "reverse" ? 4 : 0) + 8) % 8] + " " : "";
      const prefix = wire.labels[i]?.firstChild;
      if (prefix && prefix.textContent !== arrow) prefix.textContent = arrow;
    });
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
    selectedEnd = undefined;
    selected?.element.setAttribute("aria-pressed", "true");
  }

  function render(scene: SceneDocument, { assessed, measured, heat, arrivals }: CanvasMarks = {}) {
    const focused = socketAt(document.activeElement);
    const selectedKey = selected && portKey(selected.ref);
    gesture = undefined;
    surface.classList.remove("panning");
    preview.removeAttribute("d");
    mark(undefined);
    cards.clear();
    sockets.clear();
    wires.clear();
    ends.clear();
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
      const stats = cardRows(model, measured?.get(item.instanceId));
      const layout = cardLayout(model, stats.length);
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
      stats.forEach((stat, row) => {
        const y = 58 + row * CARD_STAT_ROW;
        const group = svg("g", { class: "card-stat", "data-confidence": stat.confidence });
        const hint = svg("title");
        hint.textContent = stat.title;
        const text = stat.label + " " + stat.value;
        const count = stat.conflict ? 13 : 19;
        const badgeX = stat.conflict ? 129 : 146;
        group.append(hint, label(text.length > count ? text.slice(0, count - 1) + "…" : text, 16, y, "device-stat"),
          svg("rect", { class: "confidence-badge", x: badgeX, y: y - 10, width: 49, height: 13, rx: 4 }),
          label(stat.badge, badgeX + 24.5, y, "badge-caption"));
        if (stat.conflict) {
          group.append(svg("rect", { class: "conflict-badge", x: 181, y: y - 10, width: 26, height: 13, rx: 4 }),
            label("충돌", 194, y, "badge-caption"));
        }
        body.append(group);
      });
      if (heat) addHeat(body, heat.get(item.instanceId) ?? []);
      for (const face of layout.panels) {
        body.append(svg("rect", { class: "port-face", "data-face": face.face, x: face.x, y: face.y, width: face.width, height: face.height, rx: 5 }),
          label(face.label, face.x, face.y + face.height + 13, "face-name"));
      }
      if (layout.listY !== null) body.append(svg("path", { class: "port-divider", d: `M14 ${layout.listY - 12}h184` }));
      for (const p of layout.ports) {
        const ref = { instanceId: item.instanceId, id: p.port.id };
        const key = portKey(ref);
        const connector = p.port.connector.conflicts?.length ? "결합 형태 출처 충돌"
          : typeof p.port.connector.value === "string" ? p.port.connector.value : "결합 형태 미확인";
        const glyph = connectors.get(connector);
        const socket = svg("g", { class: "port", "data-port": p.port.id, "data-item": item.instanceId,
          "data-face": p.port.position?.face ?? "list",
          role: "button", tabindex: "0", transform: `translate(${p.x} ${p.y})`,
          "aria-label": `${name} ${p.port.label} (${connector})`, "aria-disabled": String(occupied.has(key)) });
        const tooltip = svg("title");
        tooltip.textContent = [`${p.port.label} · ${connector}`, ...portConflicts(p.port, model.sources)].join("\n");
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
      const marks = assessed?.get(edge.id) ?? [];
      const domains = marks.length ? marks.map(mark => mark.layer) : wireLayers(from.layout.port, to.layout.port);
      const lines = (domains.length ? domains : ["unclassified"] as const).map((layer, i) => {
        const line = svg("path", { class: "wire-line", "data-layer": layer });
        if (layer !== "unclassified") line.classList.toggle("layer-hidden", hidden.has(layer));
        const mark = marks[i];
        if (mark) {
          line.dataset.resultKind = mark.kind;
          line.dataset.direction = mark.direction ?? "";
          line.dataset.unit = mark.unit;
          if (mark.verdict) {
            line.dataset.verdict = mark.verdict;
            if (mark.layer !== "unclassified" && arrivals?.has(edge.id)) line.classList.add("wire-arrival");
          }
          else if (mark.kind === "negotiation") line.classList.add("wire-capability");
          if (mark.pool) line.dataset.pool = mark.pool;
          if (mark.width !== undefined) line.style.setProperty("--flow-width", String(mark.width));
          if (mark.dashed) line.classList.add("range-wire");
          if (mark.workload) line.dataset.workload = mark.workload;
          const title = svg("title");
          title.textContent = mark.kind === "negotiation" && !mark.verdict ? mark.text : mark.title;
          line.append(title);
        }
        return line;
      });
      const name = edge.parts.map(p => {
        const item = byItem.get(p.instanceId);
        return item && (item.alias || models.get(modelKey(item))?.name) || p.instanceId;
      }).join(" · ");
      group.setAttribute("role", "button");
      group.setAttribute("tabindex", "0");
      group.setAttribute("aria-label", "연결 " + (name || edge.id));
      const caption = svg("g", { class: "wire-caption", "aria-hidden": "true" });
      const labels = marks.map((mark, index) => {
        const text = label(mark.text, 0, -(marks.length - index) * 15, "wire-result");
        text.prepend(svg("tspan"));
        if (mark.verdict) text.dataset.verdict = mark.verdict;
        else if (mark.kind === "negotiation") text.classList.add("wire-capability");
        if (mark.workload) text.dataset.workload = mark.workload;
        return text;
      });
      if (name) caption.append(label(name, 0, 0, "wire-name"));
      caption.append(...labels);
      group.append(...lines, caption);
      wireLayer.append(group);
      const wire: Wire = { from, to, lines, labels, caption, curves: [], tracks: [] };
      marks.forEach((mark, index) => {
        if (mark.density && mark.direction) wire.tracks.push({
          density: mark.density, direction: mark.direction, layer: mark.layer, curve: () => wire.curves[index]!,
        });
      });
      wires.set(edge.id, wire);
      if (edge.parts.length) {
        ends.set(from, { id: edge.id, end: "from", fixed: to });
        ends.set(to, { id: edge.id, end: "to", fixed: from });
        for (const socket of [from, to]) {
          socket.element.classList.add("rewire-port");
          socket.element.setAttribute("aria-keyshortcuts", "Shift+Enter");
          socket.element.querySelector("title")!.textContent += "\n케이블 끝 옮기기 · 끌기 또는 Shift+Enter";
        }
      }
      from.card.wires.push(wire);
      if (to.card !== from.card) to.card.wires.push(wire);
      paintWire(wire);
      updateCaption(wire);
    }
    refreshTracks();
    if (!drawn) {
      drawn = true;
      if (scene.layout?.viewport) lookAt(scene.layout.viewport);
      else fit();
    }
    if (selectedKey && !occupied.has(selectedKey)) mark(sockets.get(selectedKey));
    if (focused) sockets.get(portKey(focused.ref))?.element.focus({ preventScroll: true });
  }

  function addHeat(body: SVGGElement, marks: readonly HeatMark[]) {
    const width = (CARD_WIDTH - 24) / marks.length;
    marks.forEach(({ row, label: title, caption, usage, bottleneck }, index) => {
      const mark = svg("g", { class: "heat-mark", "data-heat-resource": row, "data-usage": usage === null ? "unknown" : usage,
        "data-bottleneck": String(bottleneck), role: "button", tabindex: "0", "aria-label": title });
      const hint = svg("title");
      hint.textContent = title;
      const x = 12 + width * index;
      const stripe = svg("rect", { x, y: 3, width: width - 3, height: 10, rx: 3 });
      if (usage !== null) stripe.style.fill = `hsl(${(1 - Math.min(1, Math.max(0, usage))) * 118} 67% 43%)`;
      mark.append(hint, stripe, label(caption, x + (width - 3) / 2, 11, "heat-caption"));
      body.append(mark);
    });
  }

  function refreshTracks() {
    particles.setTracks([...wires.values()].flatMap(wire => wire.tracks.filter(track => !hidden.has(track.layer))));
  }

  function updateCaption(wire: Wire) {
    const inactive = wire.lines.every(line => line.classList.contains("layer-hidden"));
    wire.caption.classList.toggle("layer-hidden", inactive);
    wire.caption.parentElement?.setAttribute("tabindex", inactive ? "-1" : "0");
    for (const [index, text] of wire.labels.entries()) {
      text.classList.toggle("layer-hidden", wire.lines[index]!.classList.contains("layer-hidden"));
    }
  }

  function setLayer(layer: Layer, visible: boolean) {
    if (visible) hidden.delete(layer);
    else hidden.add(layer);
    for (const wire of wires.values()) {
      for (const line of wire.lines) if (line.dataset.layer === layer) line.classList.toggle("layer-hidden", !visible);
      updateCaption(wire);
    }
    refreshTracks();
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

  function rewire(endpoint: WireEnd, source: Socket, target: Socket) {
    if (source !== target && beginPort(target)) actions.intent({
      kind: "move-connection-end", id: endpoint.id, end: endpoint.end, target: target.ref,
    });
  }

  function afterGesture(draw: () => void) {
    if (gesture) afterPointer.push(draw);
    else draw();
  }

  function finishGesture() {
    for (const draw of afterPointer.splice(0)) draw();
  }

  function cancel() {
    if (gesture?.kind === "move") move(gesture.card, gesture.origin);
    if (gesture?.kind === "pan") {
      camera = { ...gesture.origin, zoom: camera.zoom };
      surface.classList.remove("panning");
      cameraTransform();
    }
    gesture = undefined;
    mark(undefined);
    preview.removeAttribute("d");
    finishGesture();
  }

  function highlight(group: SVGGElement) {
    highlighted = group.dataset.connection!;
    for (const child of wireLayer.children) child.classList.toggle("highlighted", child === group);
    actions.selectConnection?.(highlighted);
  }

  surface.addEventListener("pointerdown", event => {
    if (event.button !== 0 || gesture || !(event.target instanceof Element)) return;
    const start = { x: event.clientX, y: event.clientY };
    const resource = event.target.closest<SVGGElement>("[data-heat-resource]");
    if (resource) { actions.selectResource?.(Number(resource.dataset.heatResource)); return; }
    const socket = socketAt(event.target);
    const connection = event.target.closest<SVGGElement>("[data-connection]");
    const id = event.target.closest<SVGGElement>("[data-instance]")?.dataset.instance;
    const state = { pointer: event.pointerId, start };
    mark(undefined);
    if (socket) {
      socket.element.focus({ preventScroll: true });
      const endpoint = ends.get(socket);
      if (endpoint) gesture = { ...state, kind: "rewire", endpoint, source: socket };
      else if (beginPort(socket)) gesture = { ...state, kind: "connect", source: socket };
      else return;
    } else if (connection) {
      const workload = event.target.closest<SVGElement>("[data-workload]")?.dataset.workload;
      if (workload) actions.selectWorkload?.(workload);
      else highlight(connection);
      return;
    } else if (id) {
      const card = cards.get(id)!;
      gesture = { ...state, kind: "move", instanceId: id, card, origin: card.position };
    } else {
      gesture = { ...state, kind: "pan", origin: { x: camera.x, y: camera.y } };
      surface.classList.add("panning");
    }
    surface.setPointerCapture(event.pointerId);
  });

  surface.addEventListener("pointermove", event => {
    if (!gesture || event.pointerId !== gesture.pointer) return;
    const p = { x: event.clientX, y: event.clientY };
    const dx = p.x - gesture.start.x, dy = p.y - gesture.start.y;
    if (gesture.kind === "connect" || gesture.kind === "rewire") {
      const fixed = gesture.kind === "connect" ? gesture.source : gesture.endpoint.fixed;
      preview.setAttribute("d", path(curve(coords(fixed), toWorld(local(p)))));
    } else if (gesture.kind === "move") move(gesture.card, { x: gesture.origin.x + dx / camera.zoom, y: gesture.origin.y + dy / camera.zoom });
    else { camera.x = gesture.origin.x + dx; camera.y = gesture.origin.y + dy; scheduleCamera(); }
  });

  surface.addEventListener("pointerup", event => {
    const active = gesture;
    if (!active || event.pointerId !== active.pointer) return;
    gesture = undefined;
    preview.removeAttribute("d");
    if (active.kind === "pan") {
      surface.classList.remove("panning");
      cameraTransform();
    } else if (active.kind === "connect") {
      const target = socketAt(document.elementFromPoint(event.clientX, event.clientY));
      if (target) connect(active.source, target);
    } else if (active.kind === "rewire") {
      if (Math.hypot(event.clientX - active.start.x, event.clientY - active.start.y) > DRAG_DISTANCE) {
        const target = socketAt(document.elementFromPoint(event.clientX, event.clientY));
        if (target) rewire(active.endpoint, active.source, target);
      } else beginPort(active.source);
    } else if (active.kind === "move") {
      const dx = event.clientX - active.start.x, dy = event.clientY - active.start.y;
      if (Math.hypot(dx, dy) > DRAG_DISTANCE)
        actions.intent({ kind: "place", instanceId: active.instanceId,
          position: { x: active.origin.x + dx / camera.zoom, y: active.origin.y + dy / camera.zoom } });
      else move(active.card, active.origin);
    }
    finishGesture();
  });

  surface.addEventListener("lostpointercapture", event => {
    if (gesture?.pointer === event.pointerId) cancel();
  });

  surface.addEventListener("wheel", event => {
    event.preventDefault();
    if (gesture) return;
    const delta = event.deltaY * (event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? surface.clientHeight : 1);
    zoom(2 ** (-delta * 0.002), local({ x: event.clientX, y: event.clientY }), true);
  }, { passive: false });

  surface.addEventListener("keydown", event => {
    if (event.key === "Escape" && (selected || gesture)) {
      cancel();
      actions.status("연결 선택을 취소했습니다.");
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") return;
    const resource = event.target instanceof Element ? event.target.closest<SVGGElement>("[data-heat-resource]") : null;
    if (resource) { event.preventDefault(); actions.selectResource?.(Number(resource.dataset.heatResource)); return; }
    const wire = event.target instanceof Element ? event.target.closest<SVGGElement>("[data-connection]") : null;
    if (wire) { event.preventDefault(); highlight(wire); return; }
    const target = socketAt(event.target);
    if (!target) return;
    event.preventDefault();
    if (selected) {
      const from = selected, endpoint = selectedEnd;
      mark(undefined);
      if (endpoint) rewire(endpoint, from, target);
      else connect(from, target);
    } else if (event.shiftKey && ends.has(target)) {
      mark(target);
      selectedEnd = ends.get(target);
      actions.status("케이블을 옮길 포트에서 Enter 또는 Space를 누르세요.");
    } else if (beginPort(target)) {
      mark(target);
      actions.status("연결할 반대편 포트에서 Enter 또는 Space를 누르세요.");
    }
  });
  return { render, setLayer, zoom, fit, afterGesture, setReduced: particles.setReduced,
    dispose() { particles.dispose(); if (cameraFrame !== undefined) cancelAnimationFrame(cameraFrame); },
    fromClient: (point: Point) => toWorld(local(point)), emptyPosition };
}
