// 시나리오와 작업 초안을 그리고 로더를 통과한 편집만 작업대에 돌려준다.
import { domains, workloadKindName, workPresets, type DomainRegistration } from "../domains/registry.ts";
import { claimInput, describe, field, showError } from "./field.ts";
import { loadSceneDocuments } from "../scene/load.ts";
import { scenarioName } from "../scene/files.ts";
import type { Documents } from "./assessment.ts";
import { modelKey, type SceneDocument } from "./document.ts";

type Workload = SceneDocument["workloads"][number];
type Scenario = SceneDocument["scenarios"][number];
type Member = Scenario["members"][number];
type Fact = Workload["request"][string];
type Value = Fact["value"];
type State = { document: SceneDocument; scenarioId: string | null };
type Intent = { kind: "edit-scenario"; document: SceneDocument; scenarioId: string | null }
  | { kind: "select-scenario"; scenarioId: string };

// 로더는 전체 요청을 검증한다. 여기서는 프리셋이 속한 스키마의 가지에서 입력 칸을 정한다.
function describePresets(registrations: readonly DomainRegistration[]) {
  return workPresets(registrations).map(preset => {
    const json = describe(preset.schema);
    const shape = (json.anyOf ?? [json]).find(branch =>
      Object.keys(preset.request).every(key => Object.hasOwn(branch.properties ?? {}, key))
      && (branch.required ?? []).every(key => Object.hasOwn(preset.request, key)));
    if (!shape?.properties) throw new Error(`${preset.name} 작업의 요청 칸을 찾을 수 없습니다.`);
    return { ...preset, shape, fields: Object.keys(shape.properties) };
  });
}

function presetFor(presets: ReturnType<typeof describePresets>, workload: Workload) {
  const matches = presets.filter(preset => preset.domain === workload.domain
    && Object.keys(workload.request).every(key => preset.fields.includes(key)));
  return matches.find(preset => preset.kind === workload.kind) ?? matches[0];
}

function workloadName(workload: Workload) {
  return `${workloadKindName(workload.domain, workload.kind)} · ${workload.id}`;
}

function button(label: string, submit = false) {
  const node = document.createElement("button");
  node.type = submit ? "submit" : "button";
  node.textContent = label;
  return node;
}

function endpoint(form: HTMLElement, items: SceneDocument["items"], documents: Documents,
  label: string, initial: Workload["from"] | undefined, path: string) {
  const ends = items.flatMap(item => {
    const model = documents.models.get(modelKey(item))!;
    if (model.kind === "cable" || !model.nodes.length) return [];
    // 저장된 끝점은 노드이므로 같은 노드에 붙은 포트는 한 선택지에 표시한다.
    const ports = new Map<string, string[]>();
    for (const port of model.ports) {
      const node = port.attachment.value;
      if (typeof node === "string") ports.set(node, [...(ports.get(node) ?? []), port.label]);
    }
    return [{ item, caption: item.alias || model.name, nodes: model.nodes.map(node => ({
      id: node.id, label: ports.get(node.id)?.join(" / ") || `내부 · ${node.label}`,
    })) }];
  });
  const device = document.createElement("select");
  device.append(new Option("실물 선택", ""), ...ends.map(end => new Option(end.caption, end.item.instanceId)));
  device.value = initial?.instanceId ?? "";
  const port = document.createElement("select");
  function setPorts(id = "") {
    const end = ends.find(end => end.item.instanceId === device.value);
    port.replaceChildren(new Option("포트 또는 내부 노드 선택", ""),
      ...(end?.nodes.map(node => new Option(node.label, node.id)) ?? []));
    port.value = id;
    port.disabled = !end;
  }
  setPorts(initial?.id);
  device.addEventListener("change", () => setPorts());
  field(form, label + " 실물", device, path + ".instanceId");
  field(form, label + " 포트", port, path + ".id");
  return () => ({ instanceId: device.value, id: port.value });
}

function nextId(prefix: string, used: readonly string[]) {
  let index = 1;
  while (used.includes(prefix + "-" + index)) index++;
  return prefix + "-" + index;
}

function memberId(member: Member) {
  return typeof member === "string" ? member : member.workload;
}

export function mountScenario(root: HTMLElement, documents: Documents, act: (intent: Intent) => void,
  registrations: readonly DomainRegistration[] = domains) {
  const presets = describePresets(registrations);
  const plugins = registrations.map(({ plugin }) => plugin);
  root.innerHTML = `
    <div class="scenario-section">
      <div class="scenario-toolbar"><button type="button">새 시나리오</button></div>
      <form class="scenario-members" novalidate></form>
    </div>
    <div class="scenario-section">
      <div class="scenario-toolbar"><button type="button">새 작업</button></div>
      <form class="scenario-workload" novalidate></form>
    </div>`;
  const toolbar = root.querySelectorAll<HTMLElement>(".scenario-toolbar");
  const newScenario = toolbar[0]!.querySelector("button")!;
  const newWorkload = toolbar[1]!.querySelector("button")!;
  const scenarioSelect = document.createElement("select");
  const workloadSelect = document.createElement("select");
  field(toolbar[0]!, "현재 시나리오", scenarioSelect);
  field(toolbar[1]!, "작업", workloadSelect);
  const scenarioForm = root.querySelector<HTMLFormElement>(".scenario-members")!;
  const workloadForm = root.querySelector<HTMLFormElement>(".scenario-workload")!;
  let state: State;
  let selectedWorkload = "";
  let creatingScenario = false;
  let creatingWorkload = false;
  let scenarioDraft: (() => { name: string; members: Map<string, { enabled: boolean; priority: string }> }) | undefined;

  function validate(form: HTMLFormElement, scenarioId: string | null,
    changes: (before: SceneDocument, fact: (value: Value, unit: string) => Fact) => SceneDocument,
    accepted: () => void) {
    const before = state.document;
    let sources = before.sources;
    function fact(value: Value, unit: string): Fact {
      const locator = "canvas:scenario";
      const date = new Date().toISOString().slice(0, 10);
      let source = sources.find(source => source.locator === locator && source.retrievedAt === date);
      if (!source) {
        source = { id: nextId("scenario-form", sources.map(source => source.id)), title: "시나리오 편집 입력",
          locator, retrievedAt: date };
        sources = [...sources, source];
      }
      return { value, unit, confidence: value === null ? "unknown" : "inferred", sources: [source.id] };
    }
    form.querySelectorAll(".scenario-error").forEach(error => { error.textContent = ""; });
    const candidate = changes(before, fact);
    if (candidate === before) return;
    const next = { ...candidate, sources };
    try {
      loadSceneDocuments(next, documents, plugins);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      showError(form, error.message);
      return;
    }
    accepted();
    act({ kind: "edit-scenario", document: next, scenarioId });
  }

  function renderScenario(keepDraft = false) {
    const draft = keepDraft ? scenarioDraft?.() : undefined;
    scenarioDraft = undefined;
    const { document: saved, scenarioId } = state;
    const index = creatingScenario ? -1 : saved.scenarios.findIndex(scenario => scenario.id === scenarioId);
    const scenario = saved.scenarios[index];
    const savedName = scenario ? scenarioName(scenario) : "";
    const placeholder = new Option(saved.scenarios.length ? "시나리오 선택" : "시나리오 없음", "");
    placeholder.disabled = true;
    scenarioSelect.replaceChildren(placeholder,
      ...saved.scenarios.map(s => new Option(scenarioName(s), s.id)));
    scenarioSelect.value = scenario?.id ?? "";
    scenarioForm.replaceChildren();
    scenarioForm.onsubmit = null;
    if (!scenario && !creatingScenario) return;
    const path = "scenarios." + (index < 0 ? saved.scenarios.length : index);
    const name = document.createElement("input");
    name.value = draft?.name ?? savedName;
    field(scenarioForm, "시나리오 이름", name, path + ".name");
    if (saved.workloads.length) {
      const legend = document.createElement("p");
      legend.className = "scenario-hint";
      legend.textContent = "활성 작업 · 작은 우선순위가 먼저";
      scenarioForm.append(legend);
    }
    const members = new Map(scenario?.members.map(entry => [memberId(entry), entry]));
    const byId = new Map(saved.workloads.map(workload => [workload.id, workload]));
    const order = new Set([...members.keys(), ...byId.keys()]);
    const rows = [...order].map(id => {
      const workload = byId.get(id)!;
      const member = members.get(id);
      const row = document.createElement("div");
      row.className = "scenario-member";
      const enabled = document.createElement("input");
      enabled.type = "checkbox";
      const edited = draft?.members.get(id);
      enabled.checked = edited?.enabled ?? (member !== undefined);
      const priority = document.createElement("input");
      priority.type = "number";
      priority.step = "1";
      priority.value = edited?.priority ?? (typeof member === "object" ? String(member.priority.value) : "");
      priority.placeholder = "자동";
      priority.disabled = !enabled.checked;
      enabled.addEventListener("change", () => { priority.disabled = !enabled.checked; });
      field(row, workloadName(workload), enabled).classList.add("scenario-member-toggle");
      const rank = field(row, "", priority, path + ".members").querySelector<HTMLElement>(".scenario-error")!;
      priority.setAttribute("aria-label", `${workload.id} 우선순위`);
      scenarioForm.append(row);
      return { workload, member, enabled, priority, rank };
    });
    const error = document.createElement("p");
    error.className = "scenario-error";
    error.setAttribute("role", "alert");
    scenarioForm.append(button(creatingScenario ? "시나리오 만들기" : "시나리오 적용", true), error);
    scenarioDraft = () => ({ name: name.value, members: new Map(rows.map(row => [row.workload.id,
      { enabled: row.enabled.checked, priority: row.priority.value }])) });
    scenarioForm.onsubmit = event => {
      event.preventDefault();
      const id = scenario?.id ?? crypto.randomUUID();
      const label = name.value.trim();
      validate(scenarioForm, id, (before, fact) => {
        const members: Member[] = [];
        for (const { workload, member, enabled, priority, rank } of rows) {
          if (!enabled.checked) { rank.dataset.path = ""; continue; }
          rank.dataset.path = `${path}.members.${members.length}`;
          const value = priority.valueAsNumber;
          members.push(priority.value === "" && !priority.validity.badInput ? workload.id
            : typeof member === "object" && member.priority.value === value ? member
            : { workload: workload.id, priority: fact(value, "") });
        }
        if (scenario && label === savedName && members.length === scenario.members.length
          && members.every((member, i) => member === scenario.members[i])) return before;
        const next = { ...scenario, id, ...(label !== savedName || !scenario ? { name: label } : {}), members };
        const scenarios = index < 0 ? [...saved.scenarios, next] : saved.scenarios.with(index, next);
        return { ...before, scenarios };
      }, () => { creatingScenario = false; });
    };
  }

  function renderWorkload() {
    const saved = state.document;
    const index = saved.workloads.findIndex(workload => workload.id === selectedWorkload);
    const original = creatingWorkload ? undefined : saved.workloads[index];
    workloadSelect.replaceChildren(new Option("작업 선택", ""),
      ...saved.workloads.map(workload => new Option(workloadName(workload), workload.id)));
    workloadSelect.value = original?.id ?? "";
    workloadForm.replaceChildren();
    workloadForm.onsubmit = null;
    if (!original && !creatingWorkload) return;
    const list = document.createElement("select");
    if (!original) {
      list.append(new Option("프리셋 선택", ""), ...presets.map((preset, i) => new Option(preset.name, String(i))));
      field(workloadForm, "작업 프리셋", list);
    }
    const editor = document.createElement("div");
    editor.className = "scenario-editor";
    workloadForm.append(editor);
    function renderEditor(preset: typeof presets[number] | undefined) {
      editor.replaceChildren();
      workloadForm.onsubmit = null;
      if (!preset) return;
      const path = "workloads." + (original ? index : saved.workloads.length);
      const from = endpoint(editor, saved.items, documents, "출발", original?.from, path + ".from");
      const to = endpoint(editor, saved.items, documents, "도착", original?.to, path + ".to");
      const fields = Object.entries(preset.shape.properties!).map(([key, property]) => ({
        key, read: claimInput(editor, key, property, preset.shape.required?.includes(key) ?? false,
          original ? original.request[key] : preset.request[key], path + ".request." + key).read,
      }));
      const error = document.createElement("p");
      error.className = "scenario-error";
      error.setAttribute("role", "alert");
      editor.append(button(original ? "작업 적용" : "작업 만들기", true), error);
      workloadForm.onsubmit = event => {
        event.preventDefault();
        const id = original?.id ?? nextId(preset.kind, saved.workloads.map(workload => workload.id));
        const scenarioId = state.scenarioId;
        validate(workloadForm, scenarioId, (before, fact) => {
          const request = Object.fromEntries(fields.flatMap(({ key, read }) => {
            const draft = read();
            if (!draft) return [];
            const previous = original?.request[key];
            return [[key, previous && previous.value === draft.value && (previous.unit ?? "") === draft.unit
              ? previous : fact(draft.value, draft.unit)] as const];
          }));
          const next = { id, domain: original?.domain ?? preset.domain, kind: original?.kind ?? preset.kind, from: from(), to: to(), request };
          if (original && (["from", "to"] as const).every(end =>
            original[end].instanceId === next[end].instanceId && original[end].id === next[end].id)
            && Object.keys(request).length === Object.keys(original.request).length
            && Object.entries(request).every(([key, value]) => original.request[key] === value)) return before;
          const workloads = original ? saved.workloads.with(index, next) : [...saved.workloads, next];
          const scenarios = original ? before.scenarios : before.scenarios.map(scenario =>
            scenario.id === scenarioId ? { ...scenario, members: [...scenario.members, id] } : scenario);
          return { ...before, workloads, scenarios };
        }, () => { selectedWorkload = id; creatingWorkload = false; });
      };
    }
    if (original) renderEditor(presetFor(presets, original));
    else list.onchange = () => renderEditor(list.value === "" ? undefined : presets[Number(list.value)]);
  }

  newScenario.onclick = () => { creatingScenario = true; renderScenario(); scenarioForm.querySelector("input")?.focus(); };
  newWorkload.onclick = () => { creatingWorkload = true; renderWorkload(); workloadForm.querySelector("select")?.focus(); };
  scenarioSelect.onchange = () => {
    creatingScenario = false;
    const id = scenarioSelect.value;
    if (id === state.scenarioId) { renderScenario(); return; }
    act({ kind: "select-scenario", scenarioId: id });
  };
  workloadSelect.onchange = () => { selectedWorkload = workloadSelect.value; creatingWorkload = false; renderWorkload(); };
  return Object.assign((next: State) => {
    const previous = state;
    state = next;
    if (previous?.scenarioId !== next.scenarioId || previous?.document.scenarios !== next.document.scenarios
      || previous?.document.workloads !== next.document.workloads) {
      renderScenario(previous?.scenarioId === next.scenarioId && previous?.document.workloads !== next.document.workloads);
    }
    if (previous?.document.items !== next.document.items || previous?.document.workloads !== next.document.workloads) renderWorkload();
  }, { selectWorkload(id: string) {
    selectedWorkload = id;
    creatingWorkload = false;
    renderWorkload();
    workloadForm.querySelector<HTMLElement>("input, select")?.focus();
  } });
}
