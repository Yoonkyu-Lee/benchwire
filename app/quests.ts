// 판정의 미확인 주장과 현재 연결을 검증하고 실물·배선의 측정으로 기록한다.
import { domains, type QuestTemplate } from "../domains/registry.ts";
import type { Claim } from "../engine/contract.ts";
import { measurementPrediction, measurementValueText, predictionText, recordMeasurement, sceneWithMeasurementContext,
  verificationLocator, verificationSource, type MeasurementTarget } from "../scene/measurement.ts";
import { connectionPorts } from "../engine/scene.ts";
import { scenarioName } from "../scene/files.ts";
import { claimInput, describe, field, showError, showFieldError, type JSONSchema } from "./field.ts";
import type { Connection, Item, SceneDocument } from "./document.ts";
import { interval, verdictText, type ResultView } from "./results.ts";

export { verificationSource };

type Personal = NonNullable<SceneDocument["personal"]>[number];
type Observation = NonNullable<Connection["observations"]>[number];
type Target = Pick<Personal, "instanceId" | "ownerKind" | "ownerId" | "domain" | "field">;
type Quest = {
  title: string; subject: string; instruction: string; template?: QuestTemplate | undefined;
  outcomes: Set<number>; impact: number; claim?: number; target?: Target;
  connection?: { row: number; domain: string; field: string; ports: Observation["ports"] };
  workload?: string | undefined; property?: JSONSchema | undefined;
};
type Save = (before: SceneDocument, next: SceneDocument, validateOnly?: boolean) => string | undefined;

const PHOTO_LIMIT = 2 * 1024 * 1024;
const PHOTO_TYPES = ["image/png", "image/jpeg", "image/webp"];
const CONTEXT_LIMIT = 120;
const NOTE_LIMIT = 280;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, submit = false) {
  const node = el("button", label);
  node.type = submit ? "submit" : "button";
  return node;
}

function textInput(form: HTMLElement, label: string, value = "", limit = CONTEXT_LIMIT) {
  const input = el("input");
  input.value = value;
  input.maxLength = limit;
  field(form, label, input);
  return input;
}

function contextField(form: HTMLElement, label: string, value: string | null | undefined,
  kind: "firmware" | "measurementCondition", unknown?: { label: string; whenUnset?: boolean }) {
  const firmware = kind === "firmware";
  const mode = el("select");
  mode.setAttribute("aria-label", label + " 상태");
  mode.append(new Option(firmware ? "버전 입력" : "조건 입력", "value"),
    new Option(firmware ? "펌웨어 없음" : "별도 조건 없음", "none"));
  if (unknown) mode.append(new Option(unknown.label, "unknown"));
  const input = textInput(form, label, value ?? "");
  input.parentElement!.classList.add("scenario-request");
  input.after(mode);
  const set = (current: string | null | undefined) => {
    mode.value = current === null ? "none" : current === undefined && unknown?.whenUnset ? "unknown" : "value";
    input.disabled = mode.value !== "value";
    input.value = current ?? "";
  };
  set(value);
  mode.onchange = () => { input.disabled = mode.value !== "value"; };
  return { set, input, mode, read: () => mode.value === "none" ? null : mode.value === "value" ? input.value.trim() || undefined : undefined };
}

function formStatus(form: HTMLFormElement) {
  const message = el("p");
  message.className = "scenario-error";
  message.setAttribute("role", "alert");
  const status = el("p");
  status.setAttribute("role", "status");
  status.className = "quest-status";
  form.append(message, status);
  return { message, status };
}

function itemName(view: ResultView, index: number) {
  const { scene } = view;
  const item = scene.items[index]!;
  return item.alias || scene.models[item.model]!.name;
}

function questPortName(view: ResultView, port: ResultView["scene"]["ports"][number]) {
  const label = port.label || port.id;
  const duplicate = view.scene.ports.some(other => other.item === port.item && other.id !== port.id && (other.label || other.id) === label);
  return duplicate ? label + " (" + port.id + ")" : label;
}

function measurementTarget(view: ResultView, c: Claim) {
  const { scene } = view;
  const registration = domains.find(({ plugin }) => plugin.id === c.domain);
  const iface = c.ownerKind === "interface" ? scene.interfaces[c.owner]! : undefined;
  const port = c.ownerKind === "port" ? scene.ports[c.owner]! : iface && scene.ports[iface.port]!;
  const resource = c.ownerKind === "resource" ? scene.resources[c.owner]! : undefined;
  const item = c.ownerKind === "item" ? c.owner : port?.item ?? resource?.item;
  if (item === undefined) return {};
  const ownerKind = iface ? "interface" : port ? "port" : resource ? "resource" : "item";
  const instanceId = scene.items[item]!.id;
  const target: Target = { instanceId, ownerKind, ownerId: iface?.id ?? port?.id ?? resource?.id ?? instanceId,
    domain: c.domain, field: c.field };
  const templates = c.domain ? registration?.quests : domains.flatMap(domain => domain.quests ?? []);
  const template = templates?.find(t => t.ownerKind === ownerKind && t.field === c.field && (!t.protocol || t.protocol === iface?.protocol));
  const plugin = registration?.plugin;
  const schema = iface ? plugin?.paramsFor?.(iface.protocol) ?? plugin?.params : plugin?.attributes;
  const shape = schema && describe(schema);
  const ids = c.field === "attachment" ? scene.nodes.filter(n => n.item === item).map(n => n.id) : scene.connectors.map(n => n.id);
  const property = resource ? { properties: { value: { type: c.field === "capacity" ? "number" : "string" } } } as JSONSchema
    : ownerKind === "port" && ids.length ? { properties: { value: { enum: ids } } }
    : shape?.properties?.[c.field] ?? shape?.additionalProperties;
  return {
    property: typeof property === "object" ? property : undefined,
    subject: [itemName(view, item), port ? questPortName(view, port) : resource?.id, iface?.protocol, c.condition].filter(Boolean).join(" · "),
    target, template,
  };
}

export function claimQuest(view: ResultView, row: number) {
  const claim=view.scene.claims[row]!, target=measurementTarget(view,claim);
  const work=claim.ownerKind==="workload" ? view.scene.workloads[claim.owner] : undefined;
  const priority = work && !claim.domain && claim.field === "priority";
  const scenario = priority ? view.scene.scenarios.find(s => s.id === claim.condition) : undefined;
  const connection=claim.ownerKind==="connection" ? view.scene.connections[claim.owner] : undefined;
  const plugin=(work || connection) && domains.find(d=>d.plugin.id===claim.domain)?.plugin;
  const schema=work ? plugin?.request : connection ? plugin?.observations : undefined;
  const shape=schema && describe(schema);
  const field=shape?.properties?.[claim.field] ?? shape?.additionalProperties;
  const property: JSONSchema | undefined = typeof field==="object" ? field : target.property;
  return {...target,property,title:target.template?.title ?? (priority ? "우선순위" : claim.field),
    subject:scenario ? scenarioName(scenario) + " · " + work!.id : target.subject ?? work?.id ?? connection?.id ?? "",workload:work?.id};
}

export function questName(q: ReturnType<typeof claimQuest>) {
  return [q.subject, q.template?.title ?? q.property?.title ?? q.title].filter(Boolean).join(" · ");
}

export function appendQuestInstructions(detail: HTMLElement, q: Pick<Quest, "template" | "instruction">) {
  if (!q.template) {
    detail.append(el("p", q.instruction));
    return;
  }
  const steps = el("ol");
  steps.append(...q.template.steps.map(step => el("li", step)));
  detail.append(steps, el("p", q.template.read));
}

function quests(view: ResultView, saved: SceneDocument) {
  const { scene, result } = view;
  const active = new Set([...view.workloads.map(w => w.row), ...[...view.negotiations.values()].flat()]);
  const grouped = new Map<number, Quest>();
  for (const q of result.quests) {
    if (!active.has(q.outcome)) continue;
    let quest = grouped.get(q.claim);
    if (!quest) {
      quest = { ...claimQuest(view,q.claim), claim:q.claim, instruction:q.instruction, impact:0, outcomes:new Set() };
      grouped.set(q.claim, quest);
    }
    quest.outcomes.add(q.outcome);
    quest.impact = Math.max(quest.impact, q.impact === "verdict" ? 2 : q.impact === "range" ? 1 : 0);
  }
  const observations: Quest[] = [];
  for (const [id, rows] of view.negotiations) {
    for (const { plugin, quests: templates } of domains) for (const template of templates ?? []) {
      const observation = template.observation;
      if (!observation) continue;
      const matching = rows.filter(row => {
        const o = result.outcomes[row]!;
        return o.domain === plugin.id && o.option !== undefined && (!observation.mode || o.mode === observation.mode);
      });
      if (!matching.length) continue;
      const row = result.outcomes[matching[0]!]!.subjectRow;
      const connection = saved.connections[row]!;
      const ends = [connection.from, connection.to].map(p => {
        const item = scene.items.findIndex(i => i.id === p.instanceId);
        const port = scene.ports.find(port => port.item === item && port.id === p.id);
        return itemName(view, item) + "/" + (port ? questPortName(view, port) : p.id);
      });
      const subject = `${id} · ${ends.join(" → ")}`;
      const affected = observation.mode ? view.workloads.filter(w => w.steps.some(s => {
        const option = result.options[s.option ?? -1];
        return s.row === row && option?.domain === plugin.id && option.mode === observation.mode;
      })).map(w => w.row) : [];
      const impact = observation.mode && matching.some(row => result.outcomes[row]!.verdict === "unknown") ? 2 : 0;
      const property = describe(observation.schema).properties![template.field];
      if (typeof property !== "object") continue;
      observations.push({ title: template.title, subject, instruction: "", template, outcomes: new Set([...matching, ...affected]),
        impact, connection: { row, domain: plugin.id, field: template.field, ports: connectionPorts(scene, row) }, property });
    }
  }
  return [...grouped.values(), ...observations].sort((a, b) => b.impact - a.impact || b.outcomes.size - a.outcomes.size);
}

async function attach(note: string, file?: File) {
  const body = new FormData();
  if (note) body.set("note", note);
  if (file) {
    if (!PHOTO_TYPES.includes(file.type)) throw new Error("사진은 PNG, JPEG, WebP 형식으로 첨부하세요.");
    if (file.size > PHOTO_LIMIT) throw new Error("사진은 2 MiB까지 첨부할 수 있습니다.");
    body.set("photo", file);
  }
  const response = await fetch("/api/evidence", { method: "POST", body });
  if (!response.ok) {
    const problem = await response.json() as { message: string };
    throw new Error(problem.message);
  }
  return response.headers.get("Location")!;
}

function card(view: ResultView, saved: SceneDocument, q: Quest, save: Save, editWorkload: (id: string) => void) {
  const detail = el("details");
  detail.className = "quest-card";
  const impact = q.impact === 2 ? "판정에 영향" : q.impact === 1 ? "범위에 영향" : "";
  const fieldName=!q.template && q.property?.title!==q.title ? q.property?.title : undefined;
  detail.append(el("summary", [q.title, q.subject, fieldName, impact].filter(Boolean).join(" · ")));
  appendQuestInstructions(detail, q);
  const works = el("ul");
  for (const w of view.workloads.filter(w => q.outcomes.has(w.row))) {
    const metrics = view.result.metrics.filter(m => m.outcome === w.row && (m.kind === "solo" || m.kind === "together"));
    const measures = view.result.measures.filter(m => m.outcome === w.row && m.run === view.run);
    const possible = view.result.possibleVerdicts.filter(v => v.outcome === w.row);
    const expected = [...metrics.map(m => `${m.kind === "solo" ? "단독" : "동시"} ${interval(m, m.unit)}`),
      ...measures.map(m => `${m.kind === "netCharge" ? "순충전" : m.kind} ${interval(m, m.unit)}`),
      ...possible.map(v => verdictText[v.verdict])];
    works.append(el("li", [w.id, ...expected].join(" · ")));
  }
  if (works.childElementCount) detail.append(el("p", "영향받는 작업과 예상 결과"), works);
  const claim = q.claim === undefined ? undefined : view.scene.claims[q.claim]!;
  const unitSchema = q.property?.properties?.unit;
  const unit = claim?.unit ?? (typeof unitSchema === "object" && typeof unitSchema.const === "string" ? unitSchema.const : "");
  const target: MeasurementTarget | undefined = q.connection
    ? { connection:q.connection.row, domain:q.connection.domain, field:q.connection.field }
    : q.target && { ...q.target, condition:claim!.condition };
  const expected = target ? predictionText(measurementPrediction(view.scene, target, unit, view.scenario, view.result)) : "";
  if (expected) detail.append(el("p", "입력값 예측 · " + expected));
  if (claim) {
    const candidates = el("ul");
    for (const row of view.scene.claimSources.filter(s => s.claim === q.claim)) {
      const candidate = row.candidate?.value ?? claim.value;
      if (candidate === null) continue;
      const src = view.scene.sources[row.source]!;
      const item = el("li", [measurementValueText(candidate, claim.unit), src.title].join(" · "));
      if (/^https?:\/\//i.test(src.locator)) {
        const link = el("a", "출처 열기");
        link.href = src.locator;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        item.append(" · ", link);
      } else if (!verificationSource(src.locator)) item.append(" · ", src.locator);
      candidates.append(item);
    }
    if (candidates.childElementCount) detail.append(candidates);
  }
  if (q.workload) {
    const change = button("작업 편집");
    change.onclick = () => editWorkload(q.workload!);
    detail.append(change);
    return detail;
  }
  if (!q.property || !target) return detail;

  const form = el("form");
  form.noValidate = true;
  const property = { ...q.property, title: q.template?.title ?? q.property.title ?? q.title };
  const read = claimInput(form, q.title, property, true, { value: null, unit }, "measurement", true).read;
  const ids = q.target ? [q.target.instanceId] : [...new Set(q.connection!.ports.map(p => p.instanceId))];
  const scopes = ids.map(id => {
    const item = saved.items.find(i => i.instanceId === id)!;
    const name = itemName(view, view.scene.items.findIndex(row => row.id === id));
    const firmware = q.target || item.firmware === undefined
      ? contextField(form, "현재 펌웨어 · " + name, item.firmware, "firmware", q.target ? { label: "모름" } : undefined) : undefined;
    if (q.target && firmware) {
      const hint = el("p", "현재 펌웨어가 기록되지 않은 동안 적용됩니다. 나중에 펌웨어를 기록하면 적용을 멈춥니다.");
      firmware.input.parentElement!.after(hint);
      const showHint = () => { hint.hidden = firmware.mode.value !== "unknown"; };
      firmware.mode.addEventListener("change", showHint);
      showHint();
    }
    const condition = q.target || item.measurementCondition === undefined
      ? contextField(form, q.target ? "측정 조건" : "측정 조건 · " + name, item.measurementCondition, "measurementCondition") : undefined;
    if (!firmware && !condition) form.append(el("p", `${name} · ${item.firmware ?? "펌웨어 없음"} · ${item.measurementCondition ?? "별도 조건 없음"}`));
    return { item, firmware, condition };
  });
  const environment = el("details");
  const extra = el("div");
  const os = textInput(extra, "운영체제");
  const driver = textInput(extra, "드라이버 버전");
  const note = textInput(extra, "메모", "", NOTE_LIMIT);
  const photo = el("input");
  photo.type = "file";
  photo.accept = PHOTO_TYPES.join(",");
  field(extra, "사진", photo);
  environment.append(el("summary", "환경 · 증거"), extra);
  form.append(environment);
  const submit = button("검증값 저장", true);
  form.append(submit);
  const { message, status } = formStatus(form);
  detail.append(form);
  form.onsubmit = async event => {
    event.preventDefault();
    if (submit.disabled) return;
    message.textContent = status.textContent = "";
    showFieldError(form, "measurement", "");
    const value = read();
    if (!value || value.value == null || typeof value.value === "number" && !Number.isFinite(value.value) || value.value === "") {
      showError(form, "measurement — 확인한 값을 입력하세요.");
      return;
    }
    if (q.connection && !q.template!.observation!.schema.safeParse({ [q.connection.field]: value }).success) {
      showError(form, "measurement — 안내에 나온 형식으로 측정값을 입력하세요.");
      return;
    }
    const current = new Map<string, Item>();
    for (const scope of scopes) {
      const { item, firmware, condition } = scope;
      const version = firmware ? firmware.read() : item.firmware;
      const measurementCondition = condition ? condition.read() : item.measurementCondition;
      const missingFirmware = version === undefined && firmware?.mode.value !== "unknown";
      if (missingFirmware || measurementCondition === undefined) {
        message.textContent = missingFirmware
          ? "현재 펌웨어 버전을 입력하거나 선택지에서 상태를 고르세요."
          : "측정 조건을 입력하거나 ‘별도 조건 없음’을 고르세요.";
        (missingFirmware ? firmware : condition)?.input.focus();
        return;
      }
      current.set(item.instanceId, item.firmware === version && item.measurementCondition === measurementCondition ? item
        : { ...item, firmware: version, measurementCondition });
    }
    const items = saved.items.map(i => current.get(i.instanceId) ?? i);
    const measurementConditions = [...new Set([...current.values()].map(i => i.measurementCondition ?? "별도 조건 없음"))];
    const memo = note.value.trim();
    const firmwareText = (value: Item["firmware"]) => value === undefined ? "모름" : value ?? "없음";
    const metadata = new URLSearchParams();
    for (const [key, value] of [
      ["os", os.value.trim()], ["driver", driver.value.trim()],
      ["firmware", q.target ? firmwareText(current.get(q.target.instanceId)!.firmware)
        : [...current.values()].map(i => itemName(view, view.scene.items.findIndex(row => row.id === i.instanceId)) +
          " " + firmwareText(i.firmware)).join(" / ")],
      ["condition", measurementConditions.join(" / ")],
      ["note", memo],
    ]) if (key && value) metadata.set(key, value);
    const source = { id: "verification-" + crypto.randomUUID(), title: "검증 퀘스트", locator: verificationLocator(metadata),
      retrievedAt: new Date().toISOString().slice(0, 10) };
    const scoped = items.every((item,i) => item === saved.items[i]) ? saved : {...saved,items};
    const prediction = measurementPrediction(sceneWithMeasurementContext(view.scene, scoped.items), target, value.unit, view.scenario);
    let next = recordMeasurement(scoped, target, value, source, "manual", prediction);
    if (next === saved) { status.textContent = "이미 같은 값이 저장되어 있습니다."; return; }
    const problem = save(saved, next, true);
    if (problem) {
      showError(form, problem.replace(/#personal\.\d+\.claim\.value(?= — )/, "#measurement"));
      return;
    }
    const file = photo.files?.[0];
    submit.disabled = true;
    try {
      if ((memo || file) && next.sources !== saved.sources) {
        const location = await attach(memo, file);
        next = { ...next, sources: next.sources.map(s => {
          if (s.id !== source.id) return s;
          const recorded = verificationSource(s.locator)!;
          recorded.set(file ? "photo" : "evidence", location);
          return { ...s, locator: verificationLocator(recorded) };
        }) };
      }
      const failure = save(saved, next);
      if (failure) showError(form, failure);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      message.textContent = error.message;
    } finally { submit.disabled = false; }
  };
  return detail;
}

function evidenceCleanup() {
  const details = el("details");
  details.className = "quest-card";
  const form = el("form");
  const rows = el("div");
  const status = el("p");
  status.setAttribute("role", "status");
  const remove = button("선택한 증거 지우기", true);
  remove.disabled = true;
  form.append(rows, remove, status);
  details.append(el("summary", "쓰지 않는 증거 정리"), form);
  const endpoint = "/api/evidence/unused";
  const selected = new Set<string>();
  let busy = false;
  async function update(ids?: string[]) {
    if (busy) return;
    busy = rows.inert = true;
    remove.disabled = true;
    status.textContent = ids ? "선택한 증거를 정리하는 중입니다." : "증거 목록을 불러오는 중입니다.";
    try {
      if (ids) {
        const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids }) });
        if (!response.ok) throw new Error((await response.json() as { message: string }).message);
      }
      const response = await fetch(endpoint);
      if (!response.ok) throw new Error((await response.json() as { message: string }).message);
      const list = await response.json() as { id: string; note: string; photo: boolean }[];
      selected.clear();
      rows.replaceChildren();
      for (const { id, note, photo } of list) {
        const item = el("p");
        const label = el("label");
        const choice = el("input");
        choice.type = "checkbox";
        choice.onchange = () => {
          if (choice.checked) selected.add(id);
          else selected.delete(id);
          remove.disabled = busy || !selected.size;
        };
        label.append(choice, " ", note || "첨부 사진 " + id.slice(0, 8));
        item.append(label);
        if (photo) {
          const link = el("a", "사진 보기");
          link.href = "/api/evidence/" + id;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          item.append(" · ", link);
        }
        rows.append(item);
      }
      status.textContent = list.length ? "지울 증거를 선택하세요." : "쓰지 않는 증거가 없습니다.";
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      busy = rows.inert = false;
      remove.disabled = !selected.size;
    }
  }
  details.ontoggle = () => { if (details.open) void update(); };
  form.onsubmit = event => {
    event.preventDefault();
    if (selected.size) void update([...selected]);
  };
  return details;
}

export function mountQuests(dialog: HTMLDialogElement, trigger: HTMLButtonElement, save: Save, editWorkload: (id: string) => void) {
  const heading = el("h2", "검증 퀘스트");
  const close = button("닫기");
  const header = el("header");
  header.append(heading, close);
  const body = el("div");
  body.className = "creator-body quest-body";
  dialog.classList.add("creator", "quest-dialog");
  dialog.setAttribute("aria-label", "검증 퀘스트");
  dialog.append(header, body);
  const cleanup = evidenceCleanup();
  close.onclick = () => dialog.close();
  let current: { view: ResultView; saved: SceneDocument };
  function open(claim?: number) {
    dialog.showModal();
    render(claim);
  }
  trigger.onclick = () => open();
  function render(claim?: number) {
    const { view, saved } = current;
    const entries = quests(view, saved);
    const opened = [...body.querySelectorAll<HTMLDetailsElement>("details.quest-card[open]")]
      .map(d => d.querySelector("summary")!.textContent);
    body.replaceChildren();
    const state = el("details");
    state.className = "quest-card";
    state.append(el("summary", "실물의 현재 펌웨어 · 측정 조건"));
    const form = el("form");
    const select = el("select");
    select.append(...saved.items.map((i, row) => new Option(itemName(view, row), i.instanceId)));
    field(form, "실물", select);
    const firmware = contextField(form, "현재 펌웨어", undefined, "firmware", { label: "미확인", whenUnset: true });
    const condition = contextField(form, "현재 측정 조건", undefined, "measurementCondition", { label: "미확인", whenUnset: true });
    form.append(button("실물 상태 적용", true));
    const { message } = formStatus(form);
    function showScope() {
      const item = saved.items.find(i => i.instanceId === select.value)!;
      firmware.set(item.firmware);
      condition.set(item.measurementCondition);
    }
    select.onchange = showScope;
    if (saved.items.length) showScope();
    form.onsubmit = event => {
      event.preventDefault();
      const item = saved.items.find(i => i.instanceId === select.value)!;
      const next = { ...item, firmware: firmware.read(), measurementCondition: condition.read() };
      if ((!firmware.input.disabled && next.firmware === undefined) || (!condition.input.disabled && next.measurementCondition === undefined)) {
        message.textContent = "입력할 값을 적거나 해당 없음 또는 미확인을 선택하세요.";
        return;
      }
      if (item.firmware === next.firmware && item.measurementCondition === next.measurementCondition) return;
      message.textContent = save(saved, { ...saved, items: saved.items.map(i => i === item ? next : i) }) ?? "";
    };
    state.append(form);
    if (saved.items.length) body.append(state);
    if (!entries.length) body.append(el("p", "현재 시나리오에 확인할 퀘스트가 없습니다."));
    let selected: HTMLDetailsElement | undefined;
    body.append(...entries.map(q => {
      const entry = card(view, saved, q, save, id => { dialog.close(); editWorkload(id); });
      entry.open = claim===undefined ? opened.includes(entry.querySelector("summary")!.textContent) : q.claim===claim;
      if (claim!==undefined && q.claim===claim) selected=entry;
      return entry;
    }), cleanup);
    selected?.querySelector("summary")!.focus();
  }
  function update(view: ResultView, saved: SceneDocument) {
    current = { view, saved };
    if (dialog.open) render();
  }
  return {update,open};
}
