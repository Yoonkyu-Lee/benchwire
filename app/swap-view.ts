// 슬롯 사본의 연결 위치를 확인하고 기술·비용을 비교한 뒤 별도 장면으로 저장한다.
import type { Snapshot } from "../engine/compare.ts";
import type { PriceBook } from "../server/prices.ts";
import { evaluateInWorker, loadAssessment, type Documents } from "./assessment.ts";
import { calculateBudget, compareBudgets } from "./budget.ts";
import { modelKey, type Model, type SceneDocument } from "./document.ts";
import { directionArrow, interval, verdictText } from "./results.ts";
import { compareSwap, swapSlot, type SwapChoice } from "./swap.ts";

const fields: Readonly<Record<string, string>> = {
  added: "추가", removed: "제거", verdict: "판정", mode: "모드", value: "값", range: "범위",
  bottleneck: "병목", assumption: "가정", quest: "검증 퀘스트", condition: "조건", need: "필요한 결합 형태",
};
const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
function money(cents: bigint) {
  const absolute = cents < 0n ? -cents : cents;
  return (cents < 0n ? "−" : "") + dollars.format(absolute / 100n) + "." + String(absolute % 100n).padStart(2, "0");
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = "") {
  const element = document.createElement(tag);
  element.textContent = text;
  return element;
}

async function snapshot(document: SceneDocument, documents: Documents): Promise<Snapshot> {
  const loaded = loadAssessment(document, documents, null);
  if ("error" in loaded) throw new Error(loaded.error);
  const reply = await evaluateInWorker({}, { kind: "primary", document, documents });
  if (reply?.kind !== "primary") throw new Error(reply?.kind === "error" ? reply.message : "비교할 판정을 읽을 수 없습니다.");
  return { scene: loaded.scene, result: reply.result };
}

function technicalValue(snapshot: Snapshot, row: number | null) {
  if (row === null) return "없음";
  const outcome = snapshot.result.outcomes[row]!;
  const metric = snapshot.result.metrics.find(metric => metric.outcome === row &&
    metric.kind === (outcome.subjectKind === "connection" ? "limit" : "together"));
  return [verdictText[outcome.verdict], outcome.label || outcome.mode, metric && interval(metric, metric.unit)].filter(Boolean).join(" · ");
}

async function prices() {
  const response = await fetch("/api/prices");
  if (!response.ok) return null;
  return await response.json() as PriceBook;
}

export function mountSwap(root: HTMLElement, documents: Documents, saveCopy: (document: SceneDocument) => Promise<void>) {
  const dialog = el("dialog");
  dialog.className = "creator swap-dialog";
  dialog.setAttribute("aria-label", "슬롯 교체");
  root.append(dialog);
  return (base: SceneDocument, originalId: string, replacement: Model, scenarioId: string | null) => {
    const sceneId = "swap-" + crypto.randomUUID();
    const replacementId = "item-" + crypto.randomUUID();
    const original = base.items.find(row => row.instanceId === originalId)!;
    const originalName = original.alias || documents.models.get(modelKey(original))!.name;
    const choices = new Map<string, string>();
    const shown = new Map<string, SwapChoice>();

    const top = el("header");
    const close = el("button", "닫기");
    top.append(el("h2", "슬롯 교체"), close);
    close.onclick = () => dialog.close();
    const body = el("div");
    body.className = "creator-body";
    const selection = el("section");
    const output = el("div");
    output.className = "swap-comparison";
    const controls = el("footer");
    const status = el("p");
    status.setAttribute("role", "status");
    const save = el("button", "사본 저장");
    controls.append(status, save);
    const heading = el("p", originalName + " → " + replacement.name + " · " + replacement.revision);
    if (scenarioId) heading.append(el("small", "시나리오 · " + scenarioId));
    body.append(heading, selection, output);
    dialog.replaceChildren(top, body, controls);
    dialog.showModal();

    const before = { ...base, scenarios: base.scenarios.filter(row => row.id === scenarioId) };
    let old: Promise<Snapshot> | undefined;
    let book: Promise<PriceBook | null> | undefined;
    let generation = 0;
    let ready: SceneDocument | undefined;
    let saving = false;
    dialog.oncancel = event => { if (saving) event.preventDefault(); };
    dialog.onclose = () => { generation++; };

    function renderSelection(pending: readonly SwapChoice[]) {
      for (const row of pending) shown.set(row.key, row);
      selection.replaceChildren();
      if (!shown.size) return;
      selection.append(el("h3", pending.length ? "연결 위치 선택 필요" : "선택한 연결 위치"));
      for (const row of shown.values()) {
        const field = el("label");
        const caption = (row.kind === "port" ? "포트 " : "내부 노드 ") + row.label + " · " + row.uses.join(", ");
        const select = el("select");
        select.append(new Option("선택", ""));
        for (const endpoint of row.options) select.append(new Option(endpoint.label === endpoint.id ? endpoint.label
          : endpoint.label + " (" + endpoint.id + ")", endpoint.id));
        select.value = choices.get(row.key) ?? "";
        select.disabled = !row.options.length;
        select.onchange = () => {
          if (select.value) choices.set(row.key, select.value);
          else choices.delete(row.key);
          void render();
        };
        field.append(el("span", caption), select);
        if (!row.options.length) field.append(el("span", "선택할 호환 위치가 없습니다."));
        selection.append(field);
      }
    }

    async function render() {
      const turn = ++generation;
      const focused = [...selection.querySelectorAll("select")].indexOf(document.activeElement as HTMLSelectElement);
      const { document: candidate, pending } = swapSlot(base, documents, { originalId, replacementId, sceneId, replacement, choices });
      ready = undefined;
      save.disabled = true;
      renderSelection(pending);
      if (focused >= 0) selection.querySelectorAll("select")[focused]?.focus({ preventScroll: true });
      output.replaceChildren();
      if (!candidate) {
        status.textContent = "연결과 작업의 위치를 고르면 비교할 수 있습니다.";
        return;
      }

      status.textContent = "비교 계산 중…";
      try {
        const newDocument = { ...candidate, scenarios: candidate.scenarios.filter(row => row.id === scenarioId) };
        const [a, b, offers] = await Promise.all([
          old ??= snapshot(before, documents), snapshot(newDocument, documents), book ??= prices().catch(() => null),
        ]);
        if (turn !== generation || !dialog.open || !dialog.isConnected) return;
        const changes = compareSwap(a, b, originalId, replacementId);
        const technical = el("section");
        technical.setAttribute("aria-label", "기술 차이");
        technical.append(el("h3", changes.length ? "기술 차이 " + changes.length + "건" : "기술 차이 없음"));
        for (const change of changes) {
          const current = change.after === null ? a : b;
          const outcome = current.result.outcomes[change.after ?? change.before!]!;
          const id = (outcome.subjectKind === "workload" ? current.scene.workloads : current.scene.connections)[outcome.subjectRow]!.id;
          technical.append(el("p", [id, directionArrow(outcome.direction)].filter(Boolean).join(" ") + " · " + change.changed.map(field => fields[field] ?? field).join(", ") +
            " · " + technicalValue(a, change.before) + " → " + technicalValue(b, change.after)));
        }
        const costs = el("section");
        costs.setAttribute("aria-label", "비용 차이");
        const left = before.scenarios[0], right = newDocument.scenarios[0];
        if (left && right && offers) {
          const oldBudget = calculateBudget(left, before.items, offers);
          const newBudget = calculateBudget(right, candidate.items, offers);
          const delta = compareBudgets(oldBudget, newBudget);
          const total = ({ subtotalCents, unknownCount }: typeof oldBudget) =>
            money(subtotalCents) + (unknownCount ? " + 가격 미확인 " + unknownCount + "개" : "");
          costs.append(el("h3", "비용 차이 " + (delta === null ? "미확인" : (delta > 0n ? "+" : "") + money(delta))),
            el("p", total(oldBudget) + " → " + total(newBudget)));
        } else costs.append(el("h3", "비용 차이 미확인"),
          el("p", left && right ? "견적을 읽을 수 없습니다." : "구매 목록을 비교할 시나리오가 없습니다."));
        output.replaceChildren(technical, costs);
        ready = candidate;
        save.disabled = false;
        status.textContent = "";
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        if (turn === generation && dialog.isConnected) status.textContent = error.message;
      }
    }

    save.onclick = async () => {
      if (!ready || saving) return;
      saving = true;
      save.disabled = close.disabled = selection.inert = true;
      let saved = false;
      status.textContent = "사본 저장 중…";
      try {
        await saveCopy(ready);
        saved = true;
        status.textContent = "사본을 저장했습니다.";
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        status.textContent = error.message;
      } finally {
        saving = false;
        close.disabled = false;
        save.disabled = selection.inert = saved;
      }
    };
    void render();
  };
}
