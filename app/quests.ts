// 판정의 미확인 주장과 현재 연결을 검증하고 실물·배선의 측정으로 기록한다.
import { domains, type QuestTemplate } from "../domains/registry.ts";
import type { Claim, Value } from "../engine/contract.ts";
import { recordMeasurement, type MeasurementTarget } from "../scene/measurement.ts";
import { connectionPorts } from "../engine/scene.ts";
import { claimInput, describe, field, showError, type FieldValue, type JSONSchema } from "./field.ts";
import type { Connection, Item, SceneDocument } from "./document.ts";
import { interval, verdictText, type ResultView } from "./results.ts";

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

const SOURCE_SCHEME = "verification:";
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
  kind: "firmware" | "measurementCondition", allowUnknown = false) {
  const firmware = kind === "firmware";
  const mode = el("select");
  mode.setAttribute("aria-label", label + " 상태");
  mode.append(new Option(firmware ? "버전 입력" : "조건 입력", "value"),
    new Option(firmware ? "펌웨어 없음" : "별도 조건 없음", "none"));
  if (allowUnknown) mode.append(new Option("미확인", "unknown"));
  const input = textInput(form, label, value ?? "");
  input.parentElement!.classList.add("scenario-request");
  input.after(mode);
  const set = (current: string | null | undefined) => {
    mode.value = current === null ? "none" : current === undefined && allowUnknown ? "unknown" : "value";
    input.disabled = mode.value !== "value";
    input.value = current ?? "";
  };
  set(value);
  mode.onchange = () => { input.disabled = mode.value !== "value"; };
  return { set, input, read: () => mode.value === "none" ? null : mode.value === "value" ? input.value.trim() || undefined : undefined };
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
  return item.alias || item.id;
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
    subject: [itemName(view, item), port?.label ?? resource?.id, iface?.id, c.condition].filter(Boolean).join(" · "),
    target, template,
  };
}

function quests(view: ResultView, saved: SceneDocument) {
  const { scene, result } = view;
  const active = new Set([...view.workloads.map(w => w.row), ...[...view.negotiations.values()].flat()]);
  const grouped = new Map<number, Quest>();
  for (const q of result.quests) {
    if (!active.has(q.outcome)) continue;
    const claim = scene.claims[q.claim]!;
    let quest = grouped.get(q.claim);
    if (!quest) {
      const target = measurementTarget(view, claim);
      const workload = claim.ownerKind === "workload" ? scene.workloads[claim.owner]?.id : undefined;
      quest = { ...target, claim: q.claim, title: target.template?.title ?? claim.field,
        subject: target.subject ?? workload ?? "", workload, instruction: q.instruction, impact: 0, outcomes: new Set() };
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
        const item = saved.items.find(i => i.instanceId === p.instanceId)!;
        return (item.alias || item.instanceId) + "/" + p.id;
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

type Prediction = { values: Value[]; low?: number; high?: number; unit: string };

function prediction(view: ResultView, quest: Quest): Prediction {
  const { scene, result } = view;
  if (quest.claim !== undefined) {
    const claim = scene.claims[quest.claim]!;
    const values = scene.claimSources.flatMap(s => s.claim === quest.claim && s.candidate ? [s.candidate.value] : []);
    if (claim.value !== null) values.unshift(claim.value);
    return { values: [...new Set(values)], unit: claim.unit };
  }
  const unit = quest.property?.properties?.unit;
  const label = typeof unit === "object" && typeof unit.const === "string" ? unit.const : "";
  const convert = quest.template?.observation?.fromLimit;
  if (!convert) return { values: [], unit: label };
  if ([...quest.outcomes].some(row => result.options[result.outcomes[row]!.option ?? -1]?.observation !== undefined))
    return { values: [], unit: label };
  const limits = [...quest.outcomes].flatMap(row => {
    const option = result.options[result.outcomes[row]!.option ?? -1];
    const metric = view.limits.get(row);
    if (!option) return [];
    const low = metric ? metric.low : option.bounds?.low ?? option.limit;
    const high = metric ? metric.high : option.bounds?.high ?? option.limit;
    if (high === null || low === null) return [];
    return [{ low: convert(low), high: convert(high) }];
  });
  if (!limits.length || limits.some(p => p.high === undefined)) return { values: [], unit: label };
  if (limits.every(p => typeof p.low === "number" && typeof p.high === "number"))
    return { values: [], low: Math.min(...limits.map(p => p.low as number)), high: Math.max(...limits.map(p => p.high as number)), unit: label };
  const values = limits.every(p => p.low === p.high) ? [...new Set(limits.map(p => p.high!))] : [];
  return { values, unit: label };
}

function valueText(value: Value, unit: string) {
  return [value === true ? "예" : value === false ? "아니요" : value, unit].filter(part => part !== "" && part !== null).join(" ");
}

function comparison(p: Prediction, value?: FieldValue) {
  const expected = p.values.length ? p.values.map(v => valueText(v, p.unit)).join(" / ")
    : p.low !== undefined && p.high !== undefined ? interval({ low: p.low, high: p.high }, p.unit) : "";
  const differs = Boolean(expected && value && p.unit === value.unit && (p.values.length ? !p.values.includes(value.value)
    : typeof value.value === "number" && (value.value < p.low! || value.value > p.high!)));
  return { expected, differs };
}

export function verificationSource(locator: string) {
  return locator.startsWith(SOURCE_SCHEME) ? new URLSearchParams(locator.slice(SOURCE_SCHEME.length)) : undefined;
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
  detail.append(el("summary", [q.title, q.subject, impact].filter(Boolean).join(" · ")));
  if (q.template) {
    const steps = el("ol");
    steps.append(...q.template.steps.map(step => el("li", step)));
    detail.append(steps, el("p", q.template.read));
  } else detail.append(el("p", q.instruction));
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
  const predicted = prediction(view, q);
  const { expected } = comparison(predicted);
  if (expected) detail.append(el("p", "입력값 예측 · " + expected));
  if (q.claim !== undefined) {
    const candidates = el("ul");
    const claim = view.scene.claims[q.claim]!;
    for (const row of view.scene.claimSources.filter(s => s.claim === q.claim)) {
      const candidate = row.candidate?.value ?? claim.value;
      if (candidate === null) continue;
      const src = view.scene.sources[row.source]!;
      const item = el("li", [valueText(candidate, claim.unit), src.title].join(" · "));
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
  if (!q.property) return detail;

  const form = el("form");
  form.noValidate = true;
  const property = { ...q.property, title: q.template?.title ?? q.property.title ?? q.title };
  const read = claimInput(form, q.title, property, true, { value: null, unit: predicted.unit }, "measurement", true).read;
  const ids = q.target ? [q.target.instanceId] : [...new Set(q.connection!.ports.map(p => p.instanceId))];
  const scopes = ids.map(id => {
    const item = saved.items.find(i => i.instanceId === id)!;
    const name = item.alias || item.instanceId;
    const firmware = q.target || item.firmware === undefined
      ? contextField(form, "현재 펌웨어 · " + name, item.firmware, "firmware") : undefined;
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
      if (version === undefined || measurementCondition === undefined) {
        message.textContent = "현재 펌웨어와 측정 조건을 입력하거나 해당 없음으로 지정하세요.";
        (version === undefined ? firmware : condition)?.input.focus();
        return;
      }
      current.set(item.instanceId, item.firmware === version && item.measurementCondition === measurementCondition ? item
        : { ...item, firmware: version, measurementCondition });
    }
    const items = saved.items.map(i => current.get(i.instanceId) ?? i);
    const measurementConditions = [...new Set([...current.values()].map(i => i.measurementCondition ?? "별도 조건 없음"))];
    const settings = q.claim === undefined ? "" : view.scene.claims[q.claim]!.condition;
    const compare = comparison(predicted, value);
    const memo = note.value.trim();
    const metadata = new URLSearchParams();
    for (const [key, value] of [
      ["os", os.value.trim()], ["driver", driver.value.trim()],
      ["firmware", q.target ? current.get(q.target.instanceId)!.firmware ?? "없음"
        : [...current.values()].map(i => `${i.alias || i.instanceId} ${i.firmware ?? "없음"}`).join(" / ")],
      ["condition", measurementConditions.join(" / ")],
      ["note", memo], ["prediction", compare.expected], ["different", compare.differs ? "1" : ""],
    ]) if (key && value) metadata.set(key, value);
    const source = { id: "verification-" + crypto.randomUUID(), title: "검증 퀘스트", locator: SOURCE_SCHEME + metadata,
      retrievedAt: new Date().toISOString().slice(0, 10) };
    const target: MeasurementTarget = q.connection
      ? {connection:q.connection.row,domain:q.connection.domain,field:q.connection.field}
      : {...q.target!,condition:settings};
    const scoped = items.every((item,i) => item === saved.items[i]) ? saved : {...saved,items};
    const next = recordMeasurement(scoped,target,value,source,"manual");
    if (next === saved) { status.textContent = "이미 같은 값이 저장되어 있습니다."; return; }
    const problem = save(saved, next, true);
    if (problem) { showError(form, problem); return; }
    const file = photo.files?.[0];
    submit.disabled = true;
    try {
      if ((memo || file) && next.sources !== saved.sources) {
        metadata.set(file ? "photo" : "evidence", await attach(memo, file));
        source.locator = SOURCE_SCHEME + metadata;
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
  close.onclick = () => dialog.close();
  let current: { view: ResultView; saved: SceneDocument };
  trigger.onclick = () => {
    render();
    dialog.showModal();
  };
  function render() {
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
    select.append(...saved.items.map(i => new Option(i.alias || i.instanceId, i.instanceId)));
    field(form, "실물", select);
    const firmware = contextField(form, "현재 펌웨어", undefined, "firmware", true);
    const condition = contextField(form, "현재 측정 조건", undefined, "measurementCondition", true);
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
    body.append(...entries.map(q => {
      const entry = card(view, saved, q, save, id => { dialog.close(); editWorkload(id); });
      entry.open = opened.includes(entry.querySelector("summary")!.textContent);
      return entry;
    }));
  }
  return (view: ResultView, saved: SceneDocument) => {
    current = { view, saved };
    if (dialog.open) render();
  };
}
