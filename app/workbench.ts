// 장면 편집을 확정하고 캔버스·엔진 결과·근거 패널을 연결한다.
import type { Results, Run } from "../engine/results.ts";
import { evaluateInWorker, loadAssessment, type Assessment, type Documents, type Variants } from "./assessment.ts";
import { mountCanvas } from "./canvas.ts";
import { cardMeasurements, type CardMeasurements } from "./cards.ts";
import { heatmap } from "./heatmap.ts";
import { mountBudget } from "./budget.ts";
import { mountCollector } from "./collector.ts";
import { mountCreator, persistModel } from "./creator.ts";
import { moveConnectionEnd, occupiedPorts, requiredMateCapabilities } from "./connection.ts";
import { addConnection, modelKey, place, portKey, type InventoryItem, type Library, type SceneDocument, type SceneIntent } from "./document.ts";
import { mountEvidence } from "./evidence.ts";
import { showFieldError } from "./field.ts";
import { mountGoals } from "./goals.ts";
import { INVENTORY_DRAG, MODEL_DRAG, mountInventory } from "./inventory.ts";
import { mountLayers } from "./layers.ts";
import { mountQuests } from "./quests.ts";
import { resultView, type ResultView } from "./results.ts";
import { mountScenario } from "./scenario.ts";
import { mountSwap } from "./swap-view.ts";

export function mountWorkbench(root: HTMLElement, initial: SceneDocument, library: Library, options: {
  title?: string;
  scenarioId?: string;
  onChange?: (document: SceneDocument, intent: SceneIntent) => void | Promise<boolean>;
  onSaveCopy?: (document: SceneDocument) => Promise<void>;
  onSelectConnection?: (id: string) => void;
  onSelectScenario?: (id: string) => void;
} = {}) {
  let scene = initial;
  let cable: InventoryItem | undefined;
  let assessment: Assessment | undefined;
  let evaluated: Assessment | undefined;
  let primary: Results | undefined;
  const alternatives = new Map<number, Variants>();
  let view: ResultView | undefined;
  let measured: CardMeasurements | undefined;
  let showHeat = false;
  const motionPreference = "benchwire:reduced-motion";
  let reducedMotion = localStorage.getItem(motionPreference) === "true";
  const arrivals = new Set<string>();

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
      <aside class="inventory" aria-label="인벤토리">
        <div class="inventory-heading"><h2>인벤토리</h2><button type="button" class="creator-open" hidden>새 아이템</button></div>
        <details class="scenario-panel" hidden><summary>시나리오 · 작업</summary><div></div></details>
        <div class="inventory-content"></div>
      </aside>
      <main class="stage" aria-label="장면 작업 공간">
        <div class="viewport"></div>
        <div class="view-controls" role="group" aria-label="캔버스 보기">
          <button type="button" class="fit" title="전체 맞춤">전체 맞춤</button>
          <button type="button" class="zoom-out" aria-label="축소" title="축소">−</button>
          <button type="button" class="zoom-in" aria-label="확대" title="확대">+</button>
          <button type="button" class="heat-toggle" aria-pressed="false">병목 히트맵</button>
          <button type="button" class="motion-toggle" aria-pressed="false">움직임 줄이기</button>
          <button type="button" class="results-toggle" aria-controls="results-panel">결과 · 근거</button>
          <button type="button" class="quests-open" hidden>검증 퀘스트</button>
        </div>
        <div class="canvas-help">빈 곳 끌기 · 휠로 확대/축소 · 포트를 끌어 연결하거나 케이블 끝 옮기기</div>
        <div class="status" role="status"></div>
        <div class="assessment-error" role="alert"></div>
        <div class="assessment-progress" aria-live="polite"></div>
        <aside id="results-panel" class="results-panel" aria-label="결과와 근거" hidden></aside>
      </main>
    </div>
    <dialog class="quest-dialog"></dialog>
    <dialog></dialog>`;
  root.querySelector("h1")!.textContent = options.title || initial.sceneId;
  const count = root.querySelector<HTMLElement>(".scene-count")!;
  const stage = root.querySelector<HTMLElement>(".viewport")!;
  const display = stage.parentElement!;
  const progress = root.querySelector<HTMLElement>(".assessment-progress")!;
  const status = root.querySelector<HTMLElement>(".status")!;
  const error = root.querySelector<HTMLElement>(".assessment-error")!;
  const setStatus = (text: string) => { status.textContent = text; };
  const scenarioPanel = root.querySelector<HTMLDetailsElement>(".scenario-panel")!;
  const renderScenario = mountScenario(scenarioPanel.querySelector("div")!, documents, intent => {
    if (intent.kind === "select-scenario") setScenario(intent.scenarioId);
    else if (intent.kind === "edit-goal") goalPanel.edit(intent.goalId);
    else editScenario(intent.document, intent.scenarioId);
  });
  const panel = mountEvidence(root.querySelector<HTMLElement>(".results-panel")!, {
    run(next) { run = next; redrawResults(); },
    variant(index) { variant = index; redrawResults(); },
    loadVariants,
  });
  const questTrigger = root.querySelector<HTMLButtonElement>(".quests-open")!;
  const questDialog = root.querySelector<HTMLDialogElement>(".quest-dialog")!;
  const questPanel = mountQuests(questDialog, questTrigger, (before, next, validateOnly) => {
    if (scene !== before || !root.contains(questDialog)) return "장면이 바뀌었습니다. 현재 퀘스트에서 다시 입력하세요.";
    const loaded = loadAssessment(next, documents, readScenario());
    if ("error" in loaded) return loaded.error;
    if (!validateOnly) commit(next, { kind: "verify-measurement" }, loaded);
    return undefined;
  }, id => {
    scenarioPanel.open = true;
    renderScenario.selectWorkload(id);
  });
  const inventoryRoot = root.querySelector<HTMLElement>(".inventory-content")!;
  const hiddenLayers = new Set<string>();
  const makeCanvas = () => mountCanvas(stage, library, {
    intent: edit, status: setStatus,
    selectConnection(id) { panel.choose({ kind: "connection", id }); options.onSelectConnection?.(id); },
    selectWorkload(id) { panel.choose({ kind: "workload", id }); },
    selectResource(row) { panel.choose({ kind: "resource", row }); },
  });
  const makeInventory = () => mountInventory(inventoryRoot, library, {
    add(item) {
      edit({ kind: "add-item", item, position: canvas.emptyPosition(models.get(modelKey(item))!) });
    },
    cable(item) {
      cable = cable === item ? undefined : item;
      inventory(scene, cable?.instanceId, measured);
      setStatus(cable ? `${cable.alias || models.get(modelKey(cable))!.name}에 연결할 두 포트를 선택하세요.` : "케이블 선택을 해제했습니다.");
    },
  });
  let canvas = makeCanvas();
  canvas.setReduced(reducedMotion);
  display.toggleAttribute("data-reduced-motion", reducedMotion);
  let inventory = makeInventory();

  function refreshCatalog(newModels: Library["models"], newItems: Library["inventory"]) {
    for (const model of newModels) models.set(modelKey(model), model);
    for (const item of newItems) stock.set(item.instanceId, item);
    library.models = [...models.values()];
    library.inventory = [...stock.values()];
    canvas.dispose();
    stage.replaceChildren();
    inventoryRoot.replaceChildren();
    canvas = makeCanvas();
    canvas.setReduced(reducedMotion);
    inventory = makeInventory();
    for (const layer of hiddenLayers) canvas.setLayer(layer, false);
  }
  const trigger = root.querySelector<HTMLButtonElement>(".creator-open")!;
  const dialog = root.querySelector<HTMLDialogElement>("dialog:not(.quest-dialog)")!;
  if (options.onChange) mountCollector(root, () => scene.sceneId);
  const renderBudget = options.onChange && mountBudget(root,library,documents,
    () => ({doc:scene,id:readScenario(),view:assessment === evaluated ? view : undefined}),editScenario,
    id => panel.choose({kind:"connection",id}),items => { refreshCatalog([],items); render(); });
  const goalPanel = mountGoals(root, () => ({ doc:scene, id:readScenario(), view:assessment === evaluated ? view : undefined }),
    options.onChange && editScenario, (id,nextRun) => {
      run = nextRun; redrawResults(); panel.choose({kind:"workload",id});
    }, options.onChange && questPanel.open);
  let openCreator: () => void;
  if (options.onChange) trigger.hidden = false;
  trigger.onclick = () => {
    if (!dialog.childElementCount) openCreator = mountCreator(dialog, documents, async (model, newId) => {
      const key = modelKey(model);
      const pending = "benchwire:pending-placement:" + key;
      const instanceId = sessionStorage.getItem(pending) ?? newId;
      const existing = stock.get(instanceId);
      const item: InventoryItem = existing ?? { instanceId, modelId: model.modelId, revision: model.revision, state: "owned" };
      const storedModel = existing ? models.get(key)! : model;
      if (scene.items.some(row => row.instanceId === instanceId)) {
        sessionStorage.removeItem(pending);
        return;
      }
      let position = canvas.emptyPosition(storedModel);
      const withModel = { ...documents, models: new Map(models).set(key, storedModel) };
      const draft = () => scene.items.some(row => row.instanceId === instanceId) ? scene
        : place({ ...scene, items: [...scene.items, item] }, instanceId, position);
      const before = scene;
      let next = draft();
      let loaded = loadAssessment(next, withModel, readScenario());
      if ("error" in loaded) throw new Error(loaded.error);
      sessionStorage.setItem(pending, instanceId);
      if (!existing) await persistModel(model, item);
      if (!root.contains(dialog)) return;
      if (scene !== before) {
        position = canvas.emptyPosition(storedModel);
        next = draft();
        loaded = loadAssessment(next, withModel, readScenario());
        if ("error" in loaded) throw new Error(loaded.error);
      }
      if (!existing) refreshCatalog([storedModel], [item]);
      if (await commit(next, { kind: "add-item", item, position }, loaded) === false)
        throw new Error("실물은 저장했습니다. 장면을 다시 열고 배치를 재시도하세요.");
      sessionStorage.removeItem(pending);
    });
    openCreator();
  };
  mountLayers(root.querySelector<HTMLElement>(".layers")!, (layer, visible) => {
    if (visible) hiddenLayers.delete(layer);
    else hiddenLayers.add(layer);
    canvas.setLayer(layer, visible);
  });
  root.querySelector(".fit")!.addEventListener("click", () => canvas.fit());
  root.querySelector(".zoom-out")!.addEventListener("click", () => canvas.zoom(1 / 1.2));
  root.querySelector(".zoom-in")!.addEventListener("click", () => canvas.zoom(1.2));
  root.querySelector(".results-toggle")!.addEventListener("click", panel.toggle);
  const heatToggle = root.querySelector<HTMLButtonElement>(".heat-toggle")!;
  heatToggle.onclick = () => {
    showHeat = !showHeat;
    heatToggle.setAttribute("aria-pressed", String(showHeat));
    render();
  };
  const motionToggle = root.querySelector<HTMLButtonElement>(".motion-toggle")!;
  motionToggle.setAttribute("aria-pressed", String(reducedMotion));
  motionToggle.onclick = () => {
    reducedMotion = !reducedMotion;
    localStorage.setItem(motionPreference, String(reducedMotion));
    motionToggle.setAttribute("aria-pressed", String(reducedMotion));
    display.toggleAttribute("data-reduced-motion", reducedMotion);
    canvas.setReduced(reducedMotion);
  };
  const compareSlot = options.onSaveCopy && mountSwap(root, documents, options.onSaveCopy);
  function dropTarget(target: EventTarget | null) {
    return target instanceof Element ? target.closest<SVGGElement>("[data-instance]")?.dataset.instance : undefined;
  }
  stage.addEventListener("dragover", event => {
    const transfer = event.dataTransfer;
    if (!transfer || !(transfer.types.includes(INVENTORY_DRAG) ||
      compareSlot && dropTarget(event.target) && transfer.types.includes(MODEL_DRAG))) return;
    event.preventDefault();
    transfer.dropEffect = "copy";
  });
  stage.addEventListener("drop", event => {
    const transfer = event.dataTransfer;
    const item = stock.get(transfer?.getData(INVENTORY_DRAG) ?? "");
    const target = dropTarget(event.target);
    const replacement = models.get(item ? modelKey(item) : transfer?.getData(MODEL_DRAG) ?? "");
    if (target && replacement && compareSlot) {
      event.preventDefault();
      if (item?.instanceId !== target) compareSlot(scene, target, replacement, readScenario());
    } else if (item) {
      event.preventDefault();
      edit({ kind: "add-item", item, position: canvas.fromClient({ x: event.clientX, y: event.clientY }) });
    }
  });

  function render(flash?: ReadonlySet<string>) {
    count.textContent = `실물 ${scene.items.length} · 연결 ${scene.connections.length}`;
    const current = assessment === evaluated ? view : undefined;
    canvas.render(scene, { assessed: current?.wires, measured, heat: showHeat && current ? heatmap(current) : undefined, arrivals: flash });
    inventory(scene, cable?.instanceId, measured);
    updateScenario();
  }

  function updateScenario() {
    if (assessment) {
      scenarioPanel.hidden = false;
      renderScenario({ document: scene, scenarioId: readScenario() });
    }
  }

  function redrawResults(preserveSelection = true) {
    if (!assessment || assessment !== evaluated || !primary) return;
    const variants = scenario === null ? [] : alternatives.get(scenario) ?? [];
    view = resultView(assessment.scene, variants[variant]?.result ?? primary, scenario, run);
    render(arrivals);
    arrivals.clear();
    panel.render(view, variants, variant, preserveSelection);
    questTrigger.hidden = !options.onChange;
    if (options.onChange) questPanel.update(view, scene);
    renderBudget?.();
    goalPanel.refresh();
  }

  async function loadVariants() {
    const loaded = assessment, row = scenario;
    if (!loaded || loaded !== evaluated || row === null) return [];
    const cached = alternatives.get(row);
    if (cached) return cached;
    const reply = await evaluateInWorker(root, { kind: "variants", document: scene, documents, scenario: row });
    if (!reply || assessment !== loaded || !root.contains(display)) return [];
    if (reply.kind === "error") throw new Error(reply.message);
    if (reply.kind !== "variants") return [];
    alternatives.set(row, reply.results);
    return reply.results;
  }

  function load(next: SceneDocument, scenarioId = readScenario()) {
    const loaded = loadAssessment(next, documents, scenarioId);
    if ("error" in loaded) { error.textContent = loaded.error; return undefined; }
    error.textContent = "";
    return loaded;
  }

  function use(loaded: Assessment, geometryChanged = true) {
    assessment = loaded;
    measured = scene.personal?.length ? cardMeasurements(loaded.scene) : undefined;
    scenario = loaded.scenario;
    variant = 0;
    alternatives.clear();
    display.setAttribute("data-assessing", "");
    progress.textContent = "판정 계산 중…";
    if (geometryChanged) render();
    else updateScenario();
    void evaluateInWorker(root, { kind: "primary", document: scene, documents }).then(reply => {
      if (!reply || assessment !== loaded || !root.contains(display)) return;
      canvas.afterGesture(() => {
        if (assessment !== loaded || !root.contains(display)) return;
        if (reply.kind === "primary") {
          primary = reply.result;
          evaluated = loaded;
          redrawResults();
        } else if (reply.kind === "error") {
          error.textContent = reply.message;
        }
        display.removeAttribute("data-assessing");
        progress.textContent = "";
      });
    });
  }

  function updateDocument(next: SceneDocument) {
    scene = next;
    if (view && assessment === evaluated && options.onChange) questPanel.update(view, scene);
  }

  function commit(next: SceneDocument, intent: SceneIntent, prepared?: Assessment) {
    if (intent.kind === "place") {
      updateDocument(next);
      render();
    } else {
      const loaded = prepared ?? load(next);
      if (!loaded) return false;
      scene = next;
      use(loaded, intent.kind !== "edit-scenario");
    }
    return options.onChange?.(scene, intent) ?? true;
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
    else if (intent.kind === "move-connection-end") {
      const candidate = moveConnectionEnd(scene, intent);
      if (candidate) validateConnection(candidate, intent, intent.id);
    }
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
    validateConnection(candidate, intent, candidate.connections.at(-1)!.id);
  }

  function validateConnection(candidate: SceneDocument, intent: Extract<SceneIntent, { kind: "connect" | "move-connection-end" }>, id: string) {
    const loaded = load(candidate);
    if (!loaded) return;
    const required = requiredMateCapabilities(loaded.scene, id);
    if (required.length) {
      setStatus("커넥터가 맞지 않습니다. 필요한 결합 형태 " + required.join(" · "));
      return;
    }
    if (intent.kind === "connect") {
      cable = undefined;
      arrivals.add(id);
    }
    commit(candidate, intent, loaded);
    setStatus(intent.kind === "connect" ? "연결을 배치했습니다." : "케이블 끝을 옮겼습니다.");
  }

  function readScenario() {
    return assessment ? scenario === null ? null : assessment.scene.scenarios[scenario]!.id : options.scenarioId ?? null;
  }

  function setScenario(id: string) {
    const row = assessment?.scene.scenarios.findIndex(s => s.id === id);
    if (row === undefined || row < 0) return false;
    if (row !== scenario) {
      scenario = row;
      variant = 0;
      if (assessment === evaluated) redrawResults(false);
      else updateScenario();
      options.onSelectScenario?.(id);
    }
    return true;
  }

  function editScenario(next: SceneDocument, scenarioId = readScenario()) {
    const loaded = load(next, scenarioId);
    return loaded ? commit(next, { kind: "edit-scenario" }, loaded) !== false : false;
  }

  const loaded = load(initial);
  if (loaded) use(loaded);
  return {
    documents,
    dispose: () => canvas.dispose(),
    readDocument: () => scene,
    readScenario,
    setScenario,
    adoptSceneId(sceneId: string) {
      if (assessment) assessment.scene.id = sceneId;
      updateDocument({ ...scene, sceneId });
      return scene;
    },
    replaceDocument(next: SceneDocument) {
      const loaded = load(next);
      if (!loaded) return false;
      scene = next;
      use(loaded);
      return true;
    },
    editScenario,
    finishGesture: () => new Promise<void>(resolve => canvas.afterGesture(resolve)),
    refreshCatalog,
    showFieldError(path: string, message: string) {
      if (!showFieldError(scenarioPanel, path, message)) return false;
      scenarioPanel.open = true;
      return true;
    },
  };
}
