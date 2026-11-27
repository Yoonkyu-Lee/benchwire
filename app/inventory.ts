// 보유·후보 실물을 고르고 캔버스에 놓거나 다음 연결의 케이블로 선택한다.
import { modelKey, type InventoryItem, type Library, type SceneDocument } from "./document.ts";

export const INVENTORY_DRAG = "application/x-benchwire-item";
const tabs = { owned: "보유", candidate: "후보", recommended: "추천" } as const;
type Tab = keyof typeof tabs;

export function mountInventory(root: HTMLElement, library: Library, actions: {
  add: (item: InventoryItem) => void;
  cable: (item: InventoryItem) => void;
}) {
  const bar = document.createElement("div");
  bar.className = "inventory-tabs";
  bar.setAttribute("role", "group");
  bar.setAttribute("aria-label", "인벤토리 분류");
  const list = document.createElement("div");
  list.className = "inventory-list";
  root.append(bar, list);

  const models = new Map(library.models.map(model => [modelKey(model), model]));
  const buttons = new Map<Tab, HTMLButtonElement>();
  let tab: Tab = "owned";
  let placed = new Set<string>();
  let used = new Set<string>();
  let selectedCable: string | undefined;
  for (const [key, title] of Object.entries(tabs) as [Tab, string][]) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = title;
    button.addEventListener("click", () => { tab = key; show(); });
    buttons.set(key, button);
    bar.append(button);
  }

  function show() {
    for (const [key, button] of buttons) button.setAttribute("aria-pressed", String(tab === key));
    const focus = list.contains(document.activeElement) ? document.activeElement as HTMLButtonElement : null;
    const rows = document.createDocumentFragment();
    if (tab === "recommended") {
      const message = document.createElement("p");
      message.className = "inventory-empty";
      message.textContent = "표시할 추천 장비가 없습니다.";
      rows.append(message);
    } else for (const item of library.inventory) {
      if (item.state !== tab) continue;
      const model = models.get(modelKey(item));
      if (!model) continue;
      const row = document.createElement("article");
      row.dataset.inventory = item.instanceId;
      row.className = "inventory-item";
      const isPlaced = placed.has(item.instanceId);
      const isUsed = used.has(item.instanceId);
      row.draggable = !isPlaced;
      row.addEventListener("dragstart", event => {
        if (!event.dataTransfer || isPlaced) { event.preventDefault(); return; }
        event.dataTransfer.effectAllowed = "copy";
        event.dataTransfer.setData(INVENTORY_DRAG, item.instanceId);
      });
      const name = document.createElement("strong");
      name.textContent = item.alias || model.name;
      const detail = document.createElement("span");
      detail.className = "inventory-detail";
      detail.textContent = [model.kind === "cable" ? "케이블" : model.kind === "adapter" ? "어댑터" : `포트 ${model.ports.length}개`,
        isUsed ? "연결됨" : isPlaced ? "배치됨" : ""].filter(Boolean).join(" · ");
      row.append(name, detail);
      const controls = document.createElement("div");
      controls.className = "inventory-actions";
      if (!isPlaced) {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.action = "place";
        button.textContent = "캔버스에 놓기";
        button.addEventListener("click", () => actions.add(item));
        controls.append(button);
      }
      if (model.kind === "cable" && model.ports.length === 2 && !isUsed) {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.action = "cable";
        button.textContent = "연결에 사용";
        button.setAttribute("aria-pressed", String(selectedCable === item.instanceId));
        button.addEventListener("click", () => actions.cable(item));
        controls.append(button);
      }
      if (controls.childElementCount) row.append(controls);
      rows.append(row);
    }
    if (!rows.childElementCount) {
      const message = document.createElement("p");
      message.className = "inventory-empty";
      message.textContent = "등록된 실물이 없습니다.";
      rows.append(message);
    }
    list.replaceChildren(rows);
    if (focus) {
      const id = focus.closest<HTMLElement>("[data-inventory]")?.dataset.inventory;
      const row = Array.from(list.children).find(el => (el as HTMLElement).dataset.inventory === id);
      const next = row && Array.from(row.querySelectorAll("button")).find(button => button.dataset.action === focus.dataset.action);
      (next || buttons.get(tab))?.focus({ preventScroll: true });
    }
  }

  return (scene: SceneDocument, cableId?: string) => {
    selectedCable = cableId;
    placed = new Set(scene.items.map(i => i.instanceId));
    used = new Set(scene.connections.flatMap(c => [c.from.instanceId, c.to.instanceId, ...c.parts.map(p => p.instanceId)]));
    show();
  };
}
