// 장면 문서 편집을 확정하고 캔버스·인벤토리·외부 결합 판정기를 연결한다.
import { mountCanvas, type CanvasLibrary } from "./canvas.ts";
import { occupiedPorts, type ConnectionCheck } from "./connection.ts";
import { addConnection, modelKey, place, portKey, type InventoryItem, type SceneDocument, type SceneIntent } from "./document.ts";
import { INVENTORY_DRAG, mountInventory } from "./inventory.ts";
import { mountLayers } from "./layers.ts";
import { CARD_WIDTH } from "./layout.ts";

export function mountWorkbench(root: HTMLElement, initial: SceneDocument, library: CanvasLibrary, options: {
  title?: string;
  checkConnection?: ConnectionCheck;
  onChange?: (document: SceneDocument, intent: SceneIntent) => void;
  onSelectConnection?: (id: string) => void;
} = {}) {
  let scene = initial;
  let cable: InventoryItem | undefined;
  let checking = false;
  const models = new Map(library.models.map(model => [modelKey(model), model]));
  const stock = new Map(library.inventory.map(item => [item.instanceId, item]));
  root.innerHTML = `
    <header class="topbar">
      <div class="brand"><span class="brand-mark" aria-hidden="true"></span>benchwire</div>
      <div class="scene-title"><h1></h1><span class="scene-count"></span></div>
      <div class="layers" role="group" aria-label="영역 레이어"></div>
    </header>
    <div class="workspace">
      <aside class="inventory" aria-label="인벤토리"><h2>인벤토리</h2><div class="inventory-content"></div></aside>
      <main class="stage" aria-label="장면 작업 공간">
        <div class="viewport"></div>
        <div class="view-controls" role="group" aria-label="캔버스 보기">
          <button type="button" class="fit" title="전체 맞춤">전체 맞춤</button>
          <button type="button" class="zoom-out" aria-label="축소" title="축소">−</button>
          <button type="button" class="zoom-in" aria-label="확대" title="확대">+</button>
        </div>
        <div class="canvas-help">빈 곳 드래그로 이동 · 휠로 확대/축소 · 포트에서 포트로 연결</div>
        <div class="status" role="status"></div>
      </main>
    </div>`;
  root.querySelector("h1")!.textContent = options.title || scene.sceneId;
  const count = root.querySelector<HTMLElement>(".scene-count")!;
  const stage = root.querySelector<HTMLElement>(".viewport")!;
  const status = root.querySelector<HTMLElement>(".status")!;
  const setStatus = (text: string) => { status.textContent = text; };
  const canvas = mountCanvas(stage, library, { intent: edit, status: setStatus, selectConnection: options.onSelectConnection });
  const inventory = mountInventory(root.querySelector<HTMLElement>(".inventory-content")!, library, {
    add(item) {
      const center = canvas.center();
      edit({ kind: "add-item", item, position: { x: center.x - CARD_WIDTH / 2, y: center.y - 48 } });
    },
    cable(item) {
      cable = cable === item ? undefined : item;
      inventory(scene, cable?.instanceId);
      setStatus(cable ? `${cable.alias || models.get(modelKey(cable))!.name}에 연결할 두 포트를 선택하세요.` : "케이블 선택을 해제했습니다.");
    },
  });
  mountLayers(root.querySelector<HTMLElement>(".layers")!, canvas.setLayer);
  root.querySelector(".fit")!.addEventListener("click", canvas.fit);
  root.querySelector(".zoom-out")!.addEventListener("click", () => canvas.zoom(1 / 1.2));
  root.querySelector(".zoom-in")!.addEventListener("click", () => canvas.zoom(1.2));
  stage.addEventListener("dragover", event => {
    if (!event.dataTransfer?.types.includes(INVENTORY_DRAG)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  });
  stage.addEventListener("drop", event => {
    const item = stock.get(event.dataTransfer?.getData(INVENTORY_DRAG) ?? "");
    if (!item) return;
    event.preventDefault();
    edit({ kind: "add-item", item, position: canvas.fromClient({ x: event.clientX, y: event.clientY }) });
  });

  function render() {
    count.textContent = `실물 ${scene.items.length} · 연결 ${scene.connections.length}`;
    canvas.render(scene);
    inventory(scene, cable?.instanceId);
  }

  function commit(next: SceneDocument, intent: SceneIntent) {
    scene = next;
    render();
    options.onChange?.(scene, intent);
  }

  function edit(intent: SceneIntent) {
    if (intent.kind === "place") {
      commit(place(scene, intent.instanceId, intent.position), intent);
    } else if (intent.kind === "add-item") {
      if (scene.items.some(item => item.instanceId === intent.item.instanceId)) return;
      commit(place({ ...scene, items: [...scene.items, intent.item] }, intent.item.instanceId, intent.position), intent);
      setStatus("실물을 배치했습니다.");
    } else void connect(intent);
  }

  async function connect(intent: Extract<SceneIntent, { kind: "connect" }>) {
    const { from, to } = intent;
    if (checking) { setStatus("앞선 연결을 확인하고 있습니다."); return; }
    const occupied = occupiedPorts(scene);
    const selectedCable = cable;
    if (portKey(from) === portKey(to) || occupied.has(portKey(from)) || occupied.has(portKey(to))) return;
    if (selectedCable && [from.instanceId, to.instanceId].includes(selectedCable.instanceId)) {
      setStatus("선택한 케이블의 양 끝에 연결할 실물 포트를 고르세요.");
      return;
    }
    const [entry, exit] = selectedCable ? models.get(modelKey(selectedCable))!.ports : [];
    const before = scene;
    const candidate = addConnection(before, from, to, selectedCable && {
      item: selectedCable, part: { instanceId: selectedCable.instanceId, entry: entry!.id, exit: exit!.id },
    });
    if (options.checkConnection) {
      checking = true;
      const id = candidate.connections.at(-1)!.id;
      let decision;
      try { decision = await options.checkConnection(candidate, id); }
      catch { setStatus("결합 판정을 가져오지 못했습니다. 연결을 다시 시도하세요."); return; }
      finally { checking = false; }
      if (scene !== before) { setStatus("장면이 바뀌었습니다. 연결을 다시 시도하세요."); return; }
      if (!decision.allowed) {
        const needed = decision.required.length ? ` 필요한 결합 형태: ${decision.required.join(" · ")}.` : "";
        setStatus(decision.reason + needed);
        return;
      }
    }
    if (cable === selectedCable) cable = undefined;
    commit(candidate, intent);
    setStatus("연결을 배치했습니다.");
  }

  render();
  return {
    readDocument: () => scene,
    replaceDocument(document: SceneDocument) { scene = document; render(); },
  };
}
