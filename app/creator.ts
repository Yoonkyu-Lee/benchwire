// 수동 모델의 주장과 구조를 편집하고 검증된 모델을 저장 경로에 넘긴다.
import charger from "../catalog/templates/usb-c-charger.json" with { type: "json" };
import { domains, type DomainRegistration } from "../domains/registry.ts";
import { modelFile, parseDocument } from "../scene/files.ts";
import type { Documents } from "./assessment.ts";
import type { InventoryItem, Model, Port } from "./document.ts";
import { claimInput, describe, field, showError, type FieldValue, type JSONSchema } from "./field.ts";

type Claim = Port["connector"];
type Interface = Port["interfaces"][number];
type Resource = Model["resources"][number];
type NamedChoice = readonly [id: string, label: string];
type PortSeed = { name: string; connector: string; domain: string; protocol: string; role: string; unknownPrefixes: readonly string[] };
const trust = [["inferred", "추정"], ["official", "공식"], ["review", "리뷰"], ["community", "커뮤니티"]] as const;
const faces = [["front", "앞"], ["rear", "뒤"], ["left", "왼쪽"], ["right", "오른쪽"], ["top", "위"], ["bottom", "아래"]] as const;
const roleNames = new Map([["source", "송신·송전"], ["sink", "수신·수전"], ["bidirectional", "양방향"], ["cable", "케이블"]]);
const MAX_TEMPLATE_PORTS = 128;
const kinds = [["device", "기기"], ["cable", "케이블"], ["adapter", "어댑터"]] as const;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(name: string, type: "button" | "submit" = "button") {
  const node = el("button", name);
  node.type = type;
  return node;
}

function choices(select: HTMLSelectElement, entries: readonly NamedChoice[], value = select.value) {
  select.replaceChildren(...entries.map(([id, label]) => new Option(label, id)));
  select.value = value;
  if (select.selectedIndex < 0) select.selectedIndex = 0;
}

function select(root: HTMLElement, label: string, entries: readonly NamedChoice[], initial = "", path = "") {
  const control = el("select");
  choices(control, entries, initial);
  field(root, label, control, path);
  return control;
}

function input(root: HTMLElement, label: string, value = "", path = "", type = "text") {
  const control = el("input");
  control.type = type;
  control.value = value;
  field(root, label, control, path);
  return control;
}

function section(parent: HTMLElement, title: string) {
  const group = el("fieldset");
  group.append(el("legend", title));
  parent.append(group);
  return group;
}

function rows<T, S = undefined>(root: HTMLElement, name: string, make: (box: HTMLElement, number: number, seed?: S) => () => T,
  changed = () => {}) {
  const entries = new Map<HTMLElement, () => T>();
  const list = el("div");
  const addButton = button(name + " 추가");
  let ordinal = 0;
  root.append(list, addButton);

  function add(seed?: S) {
    const row = section(list, name + " " + ++ordinal);
    const read = make(row, ordinal, seed);
    const remove = button(name + " 삭제");
    row.append(remove);
    entries.set(row, read);
    remove.onclick = () => { entries.delete(row); row.remove(); changed(); };
    changed();
  }
  addButton.onclick = () => add();
  return {
    add, read: () => [...entries.values()].map(read => read()),
  };
}

function recordValue(schema: JSONSchema) {
  if (typeof schema.additionalProperties === "object") return schema.additionalProperties;
  return Object.values(schema.patternProperties ?? {}).find((row): row is JSONSchema => typeof row === "object");
}

export async function persistModel(model: Model, item: InventoryItem) {
  for (const [path, payload] of [
    ["/api/models/" + encodeURIComponent(model.modelId) + "/" + encodeURIComponent(model.revision), model],
    ["/api/inventory/" + encodeURIComponent(item.instanceId), item],
  ] as const) {
    const response = await fetch(path, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
      .catch((error: unknown) => {
        if (!(error instanceof TypeError)) throw error;
        throw new Error("저장 결과를 확인할 수 없습니다. 다시 시도하세요.");
      });
    if (!response.ok) {
      const { path, message } = await response.json() as { path: string; message: string };
      throw new Error(path ? `${path} — ${message}` : message);
    }
  }
}

export function mountCreator(dialog: HTMLDialogElement, documents: Documents, save: (model: Model, instanceId: string) => Promise<void>,
  registrations: readonly DomainRegistration[] = domains) {
  dialog.classList.add("creator", "scenario-panel");
  dialog.setAttribute("aria-label", "새 아이템");
  const form = el("form");
  form.noValidate = true;
  const header = el("header");
  const close = button("닫기");
  header.append(el("h2", "새 아이템"), close);
  close.onclick = () => dialog.close();
  const body = el("div");
  body.className = "creator-body";
  const footer = el("footer");
  const error = el("p");
  error.className = "scenario-error creator-error";
  error.setAttribute("role", "alert");
  const submit = button("저장하고 배치", "submit");
  footer.append(error, submit);
  form.append(header, body, footer);
  dialog.append(form);
  const template = section(body, "템플릿");
  const count = input(template, "충전기 포트 수", "", "", "number");
  count.min = "1"; count.max = String(MAX_TEMPLATE_PORTS); count.step = "1";
  const apply = button(charger.name + " 불러오기");
  template.append(apply);

  const identity = section(body, "모델");
  const kind = select(identity, "종류", kinds);
  const brand = input(identity, "브랜드", "", "brand");
  const name = input(identity, "모델 이름", "", "name");
  const category = input(identity, "카테고리", "", "category");
  const modelId = input(identity, "모델 ID", "item-" + crypto.randomUUID().slice(0, 8), "modelId");
  const revision = input(identity, "판본", "1", "revision");

  const provenance = section(body, "출처");
  const defaultSource = select(provenance, "기본 출처", [["", "선택"]]);
  const sources = rows(provenance, "출처", (row, n) => {
    const id = "source-" + n;
    const title = input(row, "제목", "", `sources.${n - 1}.title`);
    const locator = input(row, "주소", "", `sources.${n - 1}.locator`);
    const date = input(row, "조회일", new Date().toISOString().slice(0, 10), `sources.${n - 1}.retrievedAt`, "date");
    title.addEventListener("input", updateReferences);
    return () => ({ id, title: title.value, locator: locator.value, retrievedAt: date.value });
  }, updateReferences);

  const connectorChoices: NamedChoice[] = [["", "미확인"], ...documents.connectors.connectors.map(c =>
    [c.id, typeof c.endForm.value === "string" ? `${c.id} · ${c.endForm.value}` : c.id] as const)];
  const domainChoices: NamedChoice[] = registrations.map(r => [r.plugin.id, r.name]);
  const registered = new Map(registrations.map(r => [r.plugin.id, r]));
  const forInterfaces: NamedChoice[] = registrations.filter(r => r.interfaces.length).map(r => [r.plugin.id, r.name]);

  function sourcePicker(box: HTMLElement, label: string) {
    const pick = select(box, label + " 출처", [["", "기본 출처"]]);
    pick.dataset.ref = "source";
    return () => [pick.value || defaultSource.value].filter(Boolean);
  }

  function claimProof(box: HTMLElement, label: string) {
    const confidence = select(box, label + " 신뢰도", trust);
    const readSources = sourcePicker(box, label);
    return ({ value, unit }: FieldValue): Claim => ({
      value, unit, confidence: value === null ? "unknown" : confidence.value as Claim["confidence"], sources: readSources(),
    });
  }

  function factField(box: HTMLElement, key: string, schema: JSONSchema | boolean, required: boolean, unknown: boolean, path: string) {
    const label = typeof schema === "object" ? schema.title ?? key : key;
    const group = el("div");
    group.className = "creator-claim";
    box.append(group);
    const { read } = claimInput(group, key, schema, required, unknown ? { value: null } : undefined, path);
    const proof = claimProof(group, label);
    return () => { const value = read(); return value === undefined ? undefined : proof(value); };
  }

  function factFields(box: HTMLElement, schema: JSONSchema, unknownPrefixes: readonly string[], path: string) {
    const fields = Object.entries(schema.properties ?? {}).map(([key, property]) => {
      const required = schema.required?.includes(key) ?? false;
      return [key, factField(box, key, property, required,
        required || unknownPrefixes.some(prefix => key.startsWith(prefix)), path + "." + key)] as const;
    });
    return () => Object.fromEntries(fields.flatMap(([key, read]) => {
      const value = read();
      return value === undefined ? [] : [[key, value]];
    }));
  }

  function ref(box: HTMLElement, label: string, kind: "node" | "resource", blank: string) {
    const control = select(box, label, [["", blank]]);
    control.dataset.ref = kind;
    control.dataset.empty = blank;
    return control;
  }

  const ports = rows<Port, PortSeed>(section(body, "포트"), "포트", (row, n, seed) => {
    const id = input(row, "포트 ID", "port-" + n);
    const label = input(row, "포트 이름", seed ? seed.name + " " + n : "");
    const connector = select(row, "커넥터", connectorChoices, seed?.connector ?? "");
    const connectorProof = claimProof(row, "커넥터");
    const attachment = ref(row, "부착 노드", "node", "미확인");
    const attachmentProof = claimProof(row, "부착 노드");
    const position = section(row, "위치");
    const face = select(position, "면", [["", "미확인"], ...faces]);
    const coords = el("div");
    position.append(coords);
    const x = input(coords, "가로 위치 (0–1)", "", "", "number");
    const y = input(coords, "세로 위치 (0–1)", "", "", "number");
    const positionTrust = select(coords, "위치 신뢰도", trust);
    const positionSources = sourcePicker(coords, "위치");
    coords.hidden = true;
    face.onchange = () => { coords.hidden = face.value === ""; };

    const interfaces = rows<Interface, PortSeed>(section(row, "인터페이스"), "인터페이스", (box, j, initial) => {
      const ifaceId = input(box, "인터페이스 ID", `port-${n}-if-${j}`);
      const domain = select(box, "인터페이스 영역", forInterfaces, initial?.domain);
      const protocol = select(box, "프로토콜", []);
      const role = select(box, "역할", []);
      const declared = claimProof(box, "인터페이스 선언");
      const settings = el("details");
      const params = el("div");
      settings.append(el("summary", "인터페이스 값"), params);
      box.append(settings);
      let readParams: () => Interface["params"];
      function updateParams(initialRole = role.value, unknownPrefixes: readonly string[] = []) {
        const registration = registered.get(domain.value)!;
        const term = registration.interfaces.find(term => term.id === protocol.value)!;
        choices(role, term.roles.map(value => [value, roleNames.get(value) ?? value]), initialRole);
        params.replaceChildren();
        readParams = factFields(params, describe(registration.plugin.paramsFor?.(protocol.value) ?? registration.plugin.params),
          unknownPrefixes, `ports.${n - 1}.interfaces.${j - 1}.params`);
        updateReferences();
      }
      function updateProtocol(initialProtocol = protocol.value, initialRole = role.value, unknownPrefixes: readonly string[] = []) {
        const terms = registered.get(domain.value)!.interfaces;
        choices(protocol, terms.map(term => [term.id, term.name]), initialProtocol);
        updateParams(initialRole, unknownPrefixes);
      }
      domain.onchange = () => updateProtocol();
      protocol.onchange = () => updateParams();
      updateProtocol(initial?.protocol, initial?.role, initial?.unknownPrefixes);
      return () => ({ id: ifaceId.value, domain: domain.value, protocol: protocol.value, role: role.value,
        evidence: declared({ value: true, unit: "" }), params: readParams() });
    }, updateReferences);
    if (seed) interfaces.add(seed);

    return () => ({
      id: id.value, label: label.value,
      connector: connectorProof({ value: connector.value || null, unit: "" }),
      attachment: attachmentProof({ value: attachment.value || null, unit: "" }),
      ...(face.value && { position: { face: face.value as NonNullable<Port["position"]>["face"], x: x.valueAsNumber, y: y.valueAsNumber,
        confidence: positionTrust.value as NonNullable<Port["position"]>["confidence"], sources: positionSources() } }),
      interfaces: interfaces.read(),
    });
  }, updateReferences);

  const nodes = rows(section(body, "내부 노드"), "노드", (row, n) => {
    const id = input(row, "노드 ID", "node-" + n);
    const label = input(row, "노드 이름");
    const kind = input(row, "노드 종류", "junction");
    id.addEventListener("change", updateReferences);
    label.addEventListener("change", updateReferences);
    return () => ({ id: id.value, label: label.value, kind: kind.value });
  }, updateReferences);

  const edges = rows<Model["edges"][number]>(section(body, "내부 간선"), "간선", (row, n) => {
    const id = input(row, "간선 ID", "edge-" + n);
    const from = ref(row, "출발 노드", "node", "선택");
    const to = ref(row, "도착 노드", "node", "선택");
    const evidence = claimProof(row, "간선");
    const uses = rows(row, "사용 자원", box => {
      const resource = ref(box, "자원", "resource", "선택");
      const proof = claimProof(box, "자원 사용");
      return () => ({ resource: resource.value, evidence: proof({ value: true, unit: "" }) });
    }, updateReferences);
    return () => ({ id: id.value, from: from.value, to: to.value, evidence: evidence({ value: true, unit: "" }), uses: uses.read() });
  }, updateReferences);

  const resources = rows<Resource, typeof charger.resource>(section(body, "자원"), "자원", (row, n, seed) => {
    const id = input(row, "자원 ID", seed?.id ?? "resource-" + n);
    const kind = input(row, "자원 종류", seed?.kind ?? "");
    const domain = select(row, "자원 영역", domainChoices, seed?.domain);
    const unit = select(row, "자원 단위", []);
    const capacity = input(row, "용량", "", "", "number");
    capacity.min = "0"; capacity.step = "any";
    const capProof = claimProof(row, "용량");
    const policy = input(row, "분배 정책");
    const policyProof = claimProof(row, "분배 정책");
    function updateUnits(wanted = unit.value) {
      choices(unit, (registered.get(domain.value)?.plugin.resourceUnits ?? []).map(value => [value, value]), wanted);
    }
    updateUnits(seed?.unit);
    domain.onchange = () => updateUnits();
    id.addEventListener("change", updateReferences);
    return () => ({ id: id.value, kind: kind.value, domain: domain.value, unit: unit.value,
      capacity: capProof({ value: capacity.value ? capacity.valueAsNumber : null, unit: unit.value }),
      policy: policyProof({ value: policy.value || null, unit: "" }) });
  }, updateReferences);

  const attributeSection = section(body, "영역별 속성");
  const readAttributes = registrations.flatMap(({ plugin, name }) => {
    const schema = describe(plugin.attributes);
    const fixed = Object.keys(schema.properties ?? {});
    const entry = recordValue(schema);
    if (!fixed.length && !entry) return [];
    const group = el("details");
    group.append(el("summary", name));
    attributeSection.append(group);
    if (entry) {
      const records = rows(group, "속성", (row, n) => {
        const keySchema = schema.propertyNames;
        const key = input(row, typeof keySchema === "object" ? keySchema.title ?? "속성 키" : "속성 키");
        if (typeof keySchema === "object" && keySchema.pattern) {
          key.pattern = keySchema.pattern;
          key.placeholder = keySchema.description ?? "";
        }
        const value = factField(row, "값", entry, true, true, `attributes.${plugin.id}.${n - 1}`);
        return () => ({ key: key.value, value: value()! });
      }, updateReferences);
      return [() => {
        const facts: Record<string, Claim> = Object.create(null);
        for (const { key, value } of records.read()) {
          if (Object.hasOwn(facts, key)) throw new Error(`attributes.${plugin.id}.${key} — 속성 키가 겹칩니다.`);
          facts[key] = value;
        }
        return [plugin.id, facts] as const;
      }];
    }
    const read = factFields(group, schema, [], "attributes." + plugin.id);
    const enabled = select(group, "영역 속성", [["", "미선언"], ["known", "입력"]]);
    return [() => [plugin.id, enabled.value ? read() : {}] as const];
  });

  function updateReferences() {
    const sourceList = sources.read().map(row => [row.id, row.title || row.id] as const);
    const preferred = defaultSource.value || sourceList[0]?.[0];
    choices(defaultSource, [["", "선택"], ...sourceList], preferred);
    const nodeList = nodes.read().flatMap(row => row.id ? [[row.id, row.label || row.id] as const] : []);
    const resourceList = resources.read().flatMap(row => row.id ? [[row.id, row.id] as const] : []);
    for (const control of form.querySelectorAll<HTMLSelectElement>("select[data-ref]")) {
      const type = control.dataset.ref;
      const entries = type === "source" ? sourceList : type === "node" ? nodeList : resourceList;
      choices(control, [["", control.dataset.empty ?? "기본 출처"], ...entries]);
    }
  }

  sources.add();
  apply.onclick = () => {
    if (!count.checkValidity() || !Number.isInteger(count.valueAsNumber)) {
      error.textContent = `충전기 포트 수를 1–${MAX_TEMPLATE_PORTS} 사이 정수로 입력하세요.`;
      count.focus();
      return;
    }
    if (ports.read().length || nodes.read().length || edges.read().length || resources.read().length) {
      error.textContent = "템플릿은 구조가 비어 있을 때 불러올 수 있습니다.";
      return;
    }
    kind.value = charger.kind;
    if (!name.value) name.value = charger.name;
    if (!category.value) category.value = charger.category;
    for (let i = 0; i < count.valueAsNumber; i++) ports.add(charger.port);
    resources.add(charger.resource);
    error.textContent = "";
  };

  const instanceId = "item-" + crypto.randomUUID();
  form.onsubmit = async event => {
    event.preventDefault();
    if (submit.disabled) return;
    form.querySelectorAll(".scenario-error").forEach(row => { row.textContent = ""; });
    submit.disabled = close.disabled = body.inert = true;
    submit.textContent = "저장 중…";
    try {
      const attributes = Object.fromEntries(readAttributes.map(read => read()).filter(([, fields]) => Object.keys(fields).length));
      const model = parseDocument(modelFile, {
        modelId: modelId.value, revision: revision.value, kind: kind.value, name: name.value, brand: brand.value, category: category.value,
        sources: sources.read(), attributes, nodes: nodes.read(), ports: ports.read(), edges: edges.read(), resources: resources.read(),
      }, "model.json");
      await save(model, instanceId);
      dialog.close();
      dialog.replaceChildren();
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      showError(form, error.message);
    } finally {
      submit.disabled = close.disabled = body.inert = false;
      submit.textContent = "저장하고 배치";
    }
  };
  dialog.oncancel = event => { if (submit.disabled) event.preventDefault(); };
  return () => dialog.showModal();
}
