// 장면 편집을 확정하고 캔버스·엔진 결과·근거 패널을 연결한다.
import type { Run } from "../engine/results.ts";
import { assessDocument, type Assessment, type Documents } from "./assessment.ts";
import { mountCanvas } from "./canvas.ts";
import { occupiedPorts, type ConnectionDecision } from "./connection.ts";
import { addConnection, modelKey, place, portKey, type InventoryItem, type Library, type SceneDocument, type SceneIntent } from "./document.ts";
import { mountEvidence } from "./evidence.ts";
import { INVENTORY_DRAG, mountInventory } from "./inventory.ts";
import { mountLayers } from "./layers.ts";
import { CARD_WIDTH } from "./layout.ts";
import { resultView, type ResultView } from "./results.ts";

export function mountWorkbench(root: HTMLElement, initial: SceneDocument, library: Library, options: {
  title?: string;
  scenarioId?: string;
  onChange?: (document: SceneDocument, intent: SceneIntent) => void;
  onSelectConnection?: (id: string) => void;
  onSelectScenario?: (id: string) => void;
} = {}) {
  let scene = initial;
  let cable: InventoryItem | undefined;
  let assessment: Assessment | undefined;
  let view: ResultView | undefined;

  let scenario: number | null = null;
  let variant = 0;
  let run: Run = "together";
  const models = new Map(library.models.map(model => [modelKey(model), model]));
  const documents: Documents = { connectors: library.connectors, models };
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
          <button type="button" class="results-toggle" aria-controls="results-panel">결과 · 근거</button>
        </div>
        <div class="canvas-help">빈 곳 드래그로 이동 · 휠로 확대/축소 · 포트에서 포트로 연결</div>
        <div class="status" role="status"></div>
        <div class="assessment-error" role="alert"></div>
        <aside id="results-panel" class="results-panel" aria-label="결과와 근거" hidden></aside>
      </main>
    </div>`;
  root.querySelector("h1")!.textContent = options.title || initial.sceneId;
  const count = root.querySelector<HTMLElement>(".scene-count")!;
  const stage = root.querySelector<HTMLElement>(".viewport")!;
  const status = root.querySelector<HTMLElement>(".status")!;
  const error = root.querySelector<HTMLElement>(".assessment-error")!;
  const setStatus = (text: string) => { status.textContent = text; };
  const panel = mountEvidence(root.querySelector<HTMLElement>(".results-panel")!, {
    run(next) { run = next; redrawResults(); },
    variant(index) { variant = index; redrawResults(); },
    loadVariants: () => assessment?.variants(scenario, true) ?? [],
  });
  const canvas = mountCanvas(stage, library, {
    intent: edit, status: setStatus,
    selectConnection(id) { panel.choose({ kind: "connection", id }); options.onSelectConnection?.(id); },
    selectWorkload(id) { panel.choose({ kind: "workload", id }); },
  });
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
  root.querySelector(".results-toggle")!.addEventListener("click", panel.toggle);
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
    canvas.render(scene, view?.wires);
    inventory(scene, cable?.instanceId);
  }

  function redrawResults(preserveSelection = true) {
    const variants = assessment?.variants(scenario) ?? [];
    if (assessment) view = resultView(assessment.scene, (variants[variant]?.result ?? assessment.primary), scenario, run);
    render();
    panel.render(view, variants, variant, preserveSelection);
  }

  function load(next: SceneDocument) {
    const loaded = assessDocument(next, documents, readScenario());
    if ("error" in loaded) { error.textContent = loaded.error; return undefined; }
    error.textContent = "";
    return loaded;
  }

  function use(loaded: Assessment) {
    assessment = loaded;
    scenario = loaded.scenario;

    variant = 0;
    redrawResults();
  }

  function commit(next: SceneDocument, intent: SceneIntent, prepared?: Assessment) {
    if (intent.kind === "place") {
      scene = next;
      render();
    } else {
      const loaded = prepared ?? load(next);
      if (!loaded) return false;
      scene = next;
      use(loaded);
    }
    options.onChange?.(scene, intent);
    return true;
  }

  function edit(intent: SceneIntent) {
    if (!assessment) return;
    if (intent.kind === "place") {
      commit(place(scene, intent.instanceId, intent.position), intent);
    } else if (intent.kind === "add-item") {
      if (scene.items.some(item => item.instanceId === intent.item.instanceId)) return;
      if (commit(place({ ...scene, items: [...scene.items, intent.item] }, intent.item.instanceId, intent.position), intent))
        setStatus("실물을 배치했습니다.");
    } else if (intent.kind === "connect") connect(intent);
  }

  function connect(intent: Extract<SceneIntent, { kind: "connect" }>) {
    const { from, to } = intent;
    const occupied = occupiedPorts(scene);
    if (portKey(from) === portKey(to) || occupied.has(portKey(from)) || occupied.has(portKey(to))) return;
    if (cable && [from.instanceId, to.instanceId].includes(cable.instanceId)) {
      setStatus("선택한 케이블의 양 끝에 연결할 실물 포트를 고르세요.");
      return;
    }
    const [entry, exit] = cable ? models.get(modelKey(cable))!.ports : [];
    const candidate = addConnection(scene, from, to, cable && {
      item: cable, part: { instanceId: cable.instanceId, entry: entry!.id, exit: exit!.id },
    });
    const loaded = load(candidate);
    if (!loaded) return;
    const decision = checkConnection(loaded, candidate.connections.at(-1)!.id);
    if (!decision.allowed) {
      setStatus(decision.reason + (decision.required.length ? " 필요한 결합 형태 " + decision.required.join(" · ") : ""));
      return;
    }
    cable = undefined;
    commit(candidate, intent, loaded);
    setStatus("연결을 배치했습니다.");
  }

  function readScenario() {
    return assessment ? scenario === null ? null : assessment.scene.scenarios[scenario]!.id : options.scenarioId ?? null;
  }

  const loaded = load(initial);
  if (loaded) use(loaded);
  return {
    documents,
    readDocument: () => scene,
    readScenario,
    setScenario(id: string) {
      const row = assessment?.scene.scenarios.findIndex(s => s.id === id);
      if (row === undefined || row < 0) return false;
      if (row !== scenario) {
        scenario = row;
        variant = 0;
        redrawResults(false);
        options.onSelectScenario?.(id);
      }
      return true;
    },
    replaceDocument(next: SceneDocument) {
      const loaded = load(next);
      if (!loaded) return false;
      scene = next;
      use(loaded);
      return true;
    },
    editScenario(next: SceneDocument) { return commit(next, { kind: "edit-scenario" }); },
  };
}

function checkConnection(assessment: Assessment, id: string): ConnectionDecision {
  const { primary: result, scene } = assessment;
  const connection = scene.connections.findIndex(c => c.id === id);
  const mismatches = new Set(result.physical.filter(p => p.connection === connection && p.kind === "mate" && p.verdict === "impossible")
    .map(p => p.required));
  if (!mismatches.size) return { allowed: true };
  const reported = result.needs.filter(n => {
    const o = result.outcomes[n.outcome]!;
    return o.subjectKind === "connection" && o.subjectRow === connection && mismatches.has(n.requiredCapability);
  }).map(n => n.requiredCapability);
  return { allowed: false, reason: "커넥터가 맞지 않습니다.", required: [...new Set([...reported, ...mismatches].filter(Boolean))] };
}
