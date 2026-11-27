// 수동 모델의 주장과 구조를 편집하고 검증된 모델을 저장 경로에 넘긴다.
import charger from "../catalog/templates/usb-c-charger.json" with { type: "json" };
import { domains, type DomainRegistration } from "../domains/registry.ts";
import { modelFile, parseDocument } from "../scene/files.ts";
import { researchQuery } from "../scene/research-query.ts";
import type { ResearchConfig, ResearchStatus } from "../server/research.ts";
import type { Documents } from "./assessment.ts";
import { modelKey, type InventoryItem, type Model, type Port } from "./document.ts";
import { claimInput, describe, field, showError, type FieldValue, type JSONSchema } from "./field.ts";

type Claim = Port["connector"];
type Interface = Port["interfaces"][number];
type Resource = Model["resources"][number];
type Node = Model["nodes"][number];
type Edge = Model["edges"][number];
type Source = Model["sources"][number];
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
    clear() { entries.clear(); list.replaceChildren(); ordinal = 0; },
  };
}

function recordValue(schema: JSONSchema) {
  if (typeof schema.additionalProperties === "object") return schema.additionalProperties;
  return Object.values(schema.patternProperties ?? {}).find((row): row is JSONSchema => typeof row === "object");
}

const researchPhase: Record<ResearchStatus["phase"], string> = {
  identifying: "판본 식별 중…", choosing: "조사할 판본을 선택하세요.", researching: "공개 출처 조사 중…",
  normalizing: "출처와 초안 검증 중…", complete: "조사 완료", stopped: "조사 중단",
};
const researchStop: Record<NonNullable<ResearchStatus["stop"]>, string> = {
  budget: "다음 호출은 남은 예산으로 시작할 수 없습니다.",
  refusal: "조사 요청이 거절됐습니다.",
  incomplete: "응답이 중간에 종료됐습니다.",
  unidentified: "제품명과 판본을 함께 확인할 수 있는 자료를 찾지 못했습니다.",
  unverified: "초안에 쓸 수 있는 인용을 찾지 못했습니다.",
  provider: "Claude API 응답을 받지 못했습니다.",
  interrupted: "조사가 중단됐습니다.",
};

async function researchJson<T>(path: string, payload?: object): Promise<T> {
  const response = await fetch(path, payload && {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(((await response.json()) as { message: string }).message);
  return response.json() as Promise<T>;
}

function mountResearch(root: HTMLElement, fillDraft: (model: Model) => void) {
  const model = input(root, "모델명 또는 공개 URL");
  model.maxLength = 250;
  const price = el("p");
  const notice = el("p", "조사를 시작하면 입력한 모델명 또는 공개 URL을 Claude로 보냅니다.");
  const preview = el("output");
  preview.setAttribute("aria-label", "Claude로 보낼 입력");
  const start = button("조사 시작");
  const refresh = button("조사 갱신");
  const status = el("p");
  status.setAttribute("role", "status");
  const details = el("div");
  root.append(notice, preview, price, start, refresh, status, details);
  start.disabled = model.disabled = true;
  refresh.hidden = true;
  let enabled = false;
  let running = false;
  let update: ReturnType<typeof setTimeout> | undefined;

  function render(result: ResearchStatus) {
    const pending = result.phase === "identifying" || result.phase === "researching" || result.phase === "normalizing";
    status.textContent = [researchPhase[result.phase], result.stop && researchStop[result.stop],
      result.stale && "갱신 필요", pending ? "" : `사용 비용 US$${result.spentUsd.toFixed(4)} · 검색 ${result.searches}회`]
      .filter(Boolean).join(" ");
    refresh.hidden = !result.stale;
    details.replaceChildren();
    if (pending) return true;
    const sources = new Map(result.sources.map(source => [source.id, source]));
    function citation(id: string) {
      const source = sources.get(id);
      if (!source) return el("span", id);
      const link = el("a", source.title);
      link.href = source.locator;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      return link;
    }
    if (result.phase === "choosing") {
      result.candidates.forEach((candidate, index) => {
        const line = el("p");
        const pick = button(candidate.name + " · " + candidate.revision);
        pick.disabled = result.stale;
        pick.onclick = () => begin({ action: "select", id: result.id, retrievedAt: result.retrievedAt, index });
        line.append(pick);
        if (candidate.year !== null) line.append(" · " + candidate.year + "년형");
        for (const id of candidate.sourceIds) line.append(" ", citation(id));
        details.append(line);
      });
    }
    if (result.draft) {
      const draft = result.draft;
      const use = button("조사 초안 불러오기");
      const { proposals } = draft;
      const claims = new Map<string, (typeof proposals.claims)[number]>();
      const attachments = new Map<string, Claim>();
      const edges: (() => Edge | undefined)[] = [];
      use.onclick = () => {
        const model: Model = structuredClone(draft.model);
        for (const { target, id, domain, field, claim } of claims.values()) {
          const chosen = { ...claim, confidence: "inferred" as const };
          if (target === "item") {
            const attributes = model.attributes ??= {};
            attributes[domain] = { ...attributes[domain], [field]: chosen };
          } else if (target === "interface") {
            const iface = model.ports.flatMap(port => port.interfaces).find(row => row.id === id)!;
            iface.params = { ...iface.params, [field]: chosen };
          } else if (target === "port") model.ports.find(port => port.id === id)!.connector = chosen;
          else model.resources.find(resource => resource.id === id)![field === "capacity" ? "capacity" : "policy"] = chosen;
        }
        for (const port of model.ports) port.attachment = attachments.get(port.id) ?? port.attachment;
        model.edges.push(...edges.flatMap(read => read() ?? []));
        fillDraft(model);
      };
      details.append(el("p", "초안을 불러오면 생성기의 입력이 바뀝니다. 내용을 확인한 뒤 저장하세요."), use);
      if (proposals.claims.length || proposals.attachments.length || proposals.edges.length) {
        const review = section(details, "AI 제안");
        review.append(el("p", "인용문을 읽고 확인한 값과 배선을 선택한 뒤 초안을 불러오세요. 선택한 값은 추정으로 들어갑니다."));
        function approve(box: HTMLElement, title: string, quote: string, proof: Claim) {
          const checkbox = el("input");
          checkbox.type = "checkbox";
          field(box, title, checkbox);
          box.append(el("blockquote", quote), ...proof.sources.map(citation));
          return checkbox;
        }
        const byField = new Map<string, HTMLInputElement[]>();
        for (const proposal of proposals.claims) {
          const { target, id, domain, field, label, claim, quote, reason } = proposal;
          const key = JSON.stringify([target, id, domain, field]);
          const row = el("div");
          const value = [String(claim.value), claim.unit].filter(Boolean).join(" ");
          const control = approve(row, `${label} · ${value}`, quote, claim);
          row.append(el("p", reason));
          review.append(row);
          const related = byField.get(key) ?? [];
          related.push(control);
          byField.set(key, related);
          control.onchange = () => {
            if (!control.checked) { claims.delete(key); return; }
            for (const other of related) if (other !== control) other.checked = false;
            claims.set(key, proposal);
          };
        }
        const byPort = new Map<string, HTMLInputElement[]>();
        const nodeLabel = (id: string) => draft.model.nodes.find(node => node.id === id)?.label ?? id;
        for (const { port, attachment, quote } of proposals.attachments) {
          const label = draft.model.ports.find(row => row.id === port)?.label ?? port;
          const checkbox = approve(review, `부착 · ${label} → ${nodeLabel(String(attachment.value))}`, quote, attachment);
          const related = byPort.get(port) ?? [];
          related.push(checkbox);
          byPort.set(port, related);
          checkbox.onchange = () => {
            if (!checkbox.checked) { attachments.delete(port); return; }
            for (const other of related) if (other !== checkbox) other.checked = false;
            attachments.set(port, attachment);
          };
        }
        for (const { quote, uses, ...edge } of proposals.edges) {
          const accepted = approve(review, `간선 · ${nodeLabel(edge.from)} → ${nodeLabel(edge.to)}`, quote, edge.evidence);
          const resources = uses.map(({ quote, ...claim }) => {
            const control = approve(review, "자원 사용 · " + claim.resource, quote, claim.evidence);
            control.disabled = true;
            return { claim, control };
          });
          accepted.onchange = () => {
            for (const { control } of resources) {
              control.disabled = !accepted.checked;
              if (control.disabled) control.checked = false;
            }
          };
          edges.push(() => accepted.checked ? { ...edge, uses: resources.filter(row => row.control.checked).map(row => row.claim) } : undefined);
        }
      }
      if (draft.omissions.length) {
        const list = el("ul");
        for (const omission of draft.omissions) {
          const row = el("li", omission.field);
          row.append(el("blockquote", omission.quote), citation(omission.source));
          list.append(row);
        }
        details.append(el("p", "완전한 목록에서 제외된 항목"), list);
      }
      if (draft.conflicts.length) {
        const conflicts = el("ul");
        for (const conflict of draft.conflicts) {
          const row = el("li", conflict.field + (conflict.condition ? " · " + conflict.condition : ""));
          for (const value of conflict.values) {
            row.append(" · " + [String(value.value), value.unit].filter(Boolean).join(" ") +
              " (" + (trust.find(([id]) => id === value.confidence)?.[1] ?? value.confidence) + ")");
            for (const id of value.sources) row.append(" ", citation(id));
          }
          conflicts.append(row);
        }
        details.append(el("p", "출처 충돌"), conflicts);
      }
      if (draft.discarded.length) {
        const dropped = el("details");
        const list = el("ul");
        for (const message of draft.discarded) list.append(el("li", message));
        dropped.append(el("summary", `버린 필드 ${draft.discarded.length}개`), list);
        details.append(dropped);
      }
    }
    if (sources.size) {
      const evidence = el("details");
      const list = el("ul");
      for (const [id, source] of sources) {
        const row = el("li");
        row.append(citation(id), " · " + source.retrievedAt);
        list.append(row);
      }
      evidence.append(el("summary", `검색·열람 출처 ${sources.size}개`), list);
      details.append(evidence);
    }
    return false;
  }

  function controls() {
    model.disabled = !enabled || running;
    start.disabled = !enabled || running || !researchQuery(model.value);
    refresh.disabled = running;
  }

  async function receive(response: Promise<ResearchStatus>) {
    try {
      const result = await response;
      if (render(result)) {
        update = setTimeout(() => void receive(researchJson("/api/research/" + result.id)), 600);
        return;
      }
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : "조사 상태를 확인하지 못했습니다.";
    }
    running = false;
    controls();
  }

  function begin(payload: object) {
    if (!enabled || running) return;
    clearTimeout(update);
    running = true;
    status.textContent = "조사 요청 중…";
    details.replaceChildren();
    controls();
    void receive(researchJson("/api/research", payload));
  }

  start.onclick = () => begin({ action: "start", query: researchQuery(model.value) });
  refresh.onclick = () => begin({ action: "start", query: researchQuery(model.value), refresh: true });
  model.oninput = () => {
    preview.textContent = researchQuery(model.value);
    refresh.hidden = true;
    controls();
  };
  model.onkeydown = event => {
    if (event.key !== "Enter" || event.isComposing) return;
    event.preventDefault();
    start.click();
  };
  void researchJson<ResearchConfig>("/api/research").then(config => {
    enabled = config.enabled;
    price.textContent = `조사 1건 상한 US$${config.budgetUsd.toFixed(2)} · 웹 검색 최대 ${config.maxSearches}회 · 갱신 기준 ${config.cacheDays}일`;
    if (!enabled) status.textContent = "서버 .env에 ANTHROPIC_API_KEY를 넣으면 켜집니다.";
    controls();
  }).catch(() => { status.textContent = "조사 설정을 불러오지 못했습니다."; });
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

function duplicateModel(model: Model): Model {
  const provenance = { confidence: "inferred", inferredFrom: modelKey(model) } as const;
  function fact(claim: Claim): Claim {
    if (claim.value === null) return claim;
    return { ...claim, ...provenance,
      ...(claim.conflicts && { conflicts: claim.conflicts.map(candidate => ({ ...candidate, ...provenance })) }) };
  }
  function fields(values: Record<string, Claim>) {
    return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, fact(value)]));
  }
  return {
    ...model, modelId: "item-" + crypto.randomUUID().slice(0, 8), revision: "1", name: model.name + " 복제",
    attributes: Object.fromEntries(Object.entries(model.attributes ?? {}).map(([domain, values]) => [domain, fields(values)])),
    ports: model.ports.map(port => ({
      ...port, connector: fact(port.connector), attachment: fact(port.attachment),
      ...(port.position && { position: { ...port.position, ...provenance } }),
      interfaces: port.interfaces.map(iface => ({ ...iface, evidence: fact(iface.evidence), params: fields(iface.params) })),
    })),
    edges: model.edges.map(edge => ({
      ...edge, evidence: fact(edge.evidence), uses: edge.uses.map(use => ({ ...use, evidence: fact(use.evidence) })),
    })),
    resources: model.resources.map(resource => ({ ...resource, capacity: fact(resource.capacity), policy: fact(resource.policy) })),
  };
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
  const research = section(body, "AI 조사");
  const copySection = section(body, "기존 모델에서 시작");
  const toCopy = select(copySection, "복제할 모델 판본", [["", "선택"], ...Array.from(documents.models, ([key, model]) =>
    [key, `${model.name} · ${key}`] as const)]);
  const copy = button("모델 복제");
  copy.disabled = true;
  copySection.append(copy);
  toCopy.onchange = () => { copy.disabled = !toCopy.value; };
  copy.onclick = () => {
    const original = documents.models.get(toCopy.value);
    if (original) fillDraft(duplicateModel(original));
  };
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
  const sourceIds = new Set<string>();
  const sources = rows<Source, Source>(provenance, "출처", (row, n, seed) => {
    let id = seed?.id ?? "manual-source-" + n;
    if (!seed && sourceIds.has(id)) id += "-" + crypto.randomUUID();
    sourceIds.add(id);
    const title = input(row, "제목", seed?.title ?? "", `sources.${n - 1}.title`);
    const locator = input(row, "주소", seed?.locator ?? "", `sources.${n - 1}.locator`);
    const date = input(row, "조회일", seed?.retrievedAt ?? new Date().toISOString().slice(0, 10), `sources.${n - 1}.retrievedAt`, "date");
    title.addEventListener("input", updateReferences);
    return () => ({ id, title: title.value, locator: locator.value, retrievedAt: date.value });
  }, updateReferences);

  const connectorChoices: NamedChoice[] = [["", "미확인"], ...documents.connectors.connectors.map(c =>
    [c.id, typeof c.endForm.value === "string" ? `${c.id} · ${c.endForm.value}` : c.id] as const)];
  const domainChoices: NamedChoice[] = registrations.map(r => [r.plugin.id, r.name]);
  const registered = new Map(registrations.map(r => [r.plugin.id, r]));
  const forInterfaces: NamedChoice[] = registrations.filter(r => r.interfaces.length).map(r => [r.plugin.id, r.name]);

  function sourcePicker(box: HTMLElement, label: string, initial: readonly string[] = []) {
    const pick = select(box, label + " 출처", [["", "기본 출처"]]);
    pick.dataset.sources = JSON.stringify(initial);
    refreshSourceChoices(pick, sources.read(), initial[0] ?? "");
    return () => {
      const selected = pick.value;
      const available = new Set(sources.read().map(row => row.id));
      return (selected && selected === initial[0] ? initial : [selected || defaultSource.value]).filter(id => available.has(id));
    };
  }

  function refreshSourceChoices(control: HTMLSelectElement, available: readonly Source[], selected = control.value) {
    const initial: string[] = JSON.parse(control.dataset.sources ?? "[]");
    const entries = available.map(row => [row.id, row.title || row.id] as const);
    if (initial.length && selected === initial[0]) {
      const labels = available.filter(row => initial.includes(row.id)).map(row => row.title || row.id);
      const at = entries.findIndex(([id]) => id === selected);
      const inherited = [selected, labels.join(" · ") || "출처 없음"] as const;
      if (at < 0) entries.unshift(inherited);
      else entries[at] = inherited;
    } else if (selected && !entries.some(([id]) => id === selected)) entries.unshift([selected, "출처 없음"]);
    const blank = control === defaultSource ? "선택"
      : available.some(row => row.id === defaultSource.value) ? "기본 출처" : "출처 없음";
    choices(control, [["", blank], ...entries], selected);
  }

  function claimProof(box: HTMLElement, label: string, seed?: Claim) {
    const confidence = select(box, label + " 신뢰도", trust, seed?.confidence);
    const readSources = sourcePicker(box, label, seed?.sources);
    return ({ value, unit }: FieldValue): Claim => {
      const rank = value === null ? "unknown" : confidence.value as Claim["confidence"];
      const selected = readSources();
      const sameValue = seed && value === seed.value && unit === (seed.unit ?? "") && rank === seed.confidence;
      const claim = { value, unit, confidence: rank, sources: selected, ...(seed?.condition && { condition: seed.condition }) };
      if (!sameValue) return claim;
      const available = new Set(sources.read().map(row => row.id));
      const conflicts = seed.conflicts?.map(candidate => ({ ...candidate, sources: candidate.sources.filter(id => available.has(id)) }));
      return { ...seed, sources: selected, ...(conflicts && { conflicts }) };
    };
  }

  function factField(box: HTMLElement, key: string, schema: JSONSchema | boolean, required: boolean, unknown: boolean, path: string, seed?: Claim) {
    const label = typeof schema === "object" ? schema.title ?? key : key;
    const group = el("div");
    group.className = "creator-claim";
    box.append(group);
    const { read } = claimInput(group, key, schema, required, seed ?? (unknown ? { value: null } : undefined), path);
    const proof = claimProof(group, label, seed);
    return () => { const value = read(); return value === undefined ? undefined : proof(value); };
  }

  function factFields(box: HTMLElement, schema: JSONSchema, unknownPrefixes: readonly string[], path: string, seed?: Record<string, Claim>) {
    const fields = Object.entries(schema.properties ?? {}).map(([key, property]) => {
      const required = schema.required?.includes(key) ?? false;
      return [key, factField(box, key, property, required,
        required || unknownPrefixes.some(prefix => key.startsWith(prefix)), path + "." + key, seed?.[key])] as const;
    });
    return () => Object.fromEntries(fields.flatMap(([key, read]) => {
      const value = read();
      return value === undefined ? [] : [[key, value]];
    }));
  }

  function ref(box: HTMLElement, label: string, kind: "node" | "resource", blank: string, initial = "") {
    const control = select(box, label, initial ? [["", blank], [initial, initial]] : [["", blank]], initial);
    control.dataset.ref = kind;
    control.dataset.empty = blank;
    return control;
  }

  const ports = rows<Port, Port | PortSeed>(section(body, "포트"), "포트", (row, n, seed) => {
    const initial = seed && "interfaces" in seed ? seed : undefined;
    const template = seed && "name" in seed ? seed : undefined;
    const id = input(row, "포트 ID", initial?.id ?? "port-" + n);
    const label = input(row, "포트 이름", initial?.label ?? (template ? template.name + " " + n : ""));
    const connector = select(row, "커넥터", connectorChoices, String(initial?.connector.value ?? template?.connector ?? ""));
    const connectorProof = claimProof(row, "커넥터", initial?.connector);
    const attachment = ref(row, "부착 노드", "node", "미확인", String(initial?.attachment.value ?? ""));
    const attachmentProof = claimProof(row, "부착 노드", initial?.attachment);
    const position = section(row, "위치");
    const face = select(position, "면", [["", "미확인"], ...faces], initial?.position?.face);
    const coords = el("div");
    position.append(coords);
    const x = input(coords, "가로 위치 (0–1)", initial?.position ? String(initial.position.x) : "", "", "number");
    const y = input(coords, "세로 위치 (0–1)", initial?.position ? String(initial.position.y) : "", "", "number");
    const positionTrust = select(coords, "위치 신뢰도", trust, initial?.position?.confidence);
    const positionSources = sourcePicker(coords, "위치", initial?.position?.sources);
    coords.hidden = face.value === "";
    face.onchange = () => { coords.hidden = face.value === ""; };

    const interfaces = rows<Interface, Interface | PortSeed>(section(row, "인터페이스"), "인터페이스", (box, j, initial) => {
      const saved = initial && "params" in initial ? initial : undefined;
      const ifaceId = input(box, "인터페이스 ID", saved?.id ?? `port-${n}-if-${j}`);
      const domain = select(box, "인터페이스 영역", forInterfaces, initial?.domain);
      const protocol = select(box, "프로토콜", []);
      const role = select(box, "역할", []);
      const declared = claimProof(box, "인터페이스 선언", saved?.evidence);
      const settings = el("details");
      const params = el("div");
      settings.append(el("summary", "인터페이스 값"), params);
      box.append(settings);
      let readParams: () => Interface["params"];
      function updateParams(initialRole = role.value, unknownPrefixes: readonly string[] = [], values?: Interface["params"]) {
        const registration = registered.get(domain.value)!;
        const term = registration.interfaces.find(term => term.id === protocol.value)!;
        choices(role, term.roles.map(value => [value, roleNames.get(value) ?? value]), initialRole);
        params.replaceChildren();
        readParams = factFields(params, describe(registration.plugin.paramsFor?.(protocol.value) ?? registration.plugin.params),
          unknownPrefixes, `ports.${n - 1}.interfaces.${j - 1}.params`, values);
        updateReferences();
      }
      function updateProtocol(initialProtocol = protocol.value, initialRole = role.value, unknownPrefixes: readonly string[] = [], values?: Interface["params"]) {
        const terms = registered.get(domain.value)!.interfaces;
        choices(protocol, terms.map(term => [term.id, term.name]), initialProtocol);
        updateParams(initialRole, unknownPrefixes, values);
      }
      domain.onchange = () => updateProtocol();
      protocol.onchange = () => updateParams();
      updateProtocol(initial?.protocol, initial?.role, initial && "unknownPrefixes" in initial ? initial.unknownPrefixes : [], saved?.params);
      return () => ({ id: ifaceId.value, domain: domain.value, protocol: protocol.value, role: role.value,
        evidence: declared({ value: true, unit: "" }), params: readParams() });
    }, updateReferences);
    if (template) interfaces.add(template);
    initial?.interfaces.forEach(interfaces.add);

    return () => {
      const position: Port["position"] = face.value ? {
        face: face.value as NonNullable<Port["position"]>["face"], x: x.valueAsNumber, y: y.valueAsNumber,
        confidence: positionTrust.value as NonNullable<Port["position"]>["confidence"], sources: positionSources(),
      } : undefined;
      const original = initial?.position;
      if (position && original?.inferredFrom && position.face === original.face && position.x === original.x &&
        position.y === original.y && position.confidence === original.confidence &&
        position.sources.length === original.sources.length && position.sources.every((id, i) => id === original.sources[i]))
        position.inferredFrom = original.inferredFrom;
      return {
        id: id.value, label: label.value, ...(initial?.location && { location: initial.location }),
        connector: connectorProof({ value: connector.value || null, unit: "" }),
        attachment: attachmentProof({ value: attachment.value || null, unit: "" }),
        ...(position && { position }),
        interfaces: interfaces.read(),
      };
    };
  }, updateReferences);

  const nodes = rows<Node, Node>(section(body, "내부 노드"), "노드", (row, n, seed) => {
    const id = input(row, "노드 ID", seed?.id ?? "node-" + n);
    const label = input(row, "노드 이름", seed?.label);
    const kind = input(row, "노드 종류", seed?.kind ?? "junction");
    id.addEventListener("change", updateReferences);
    label.addEventListener("change", updateReferences);
    return () => ({ id: id.value, label: label.value, kind: kind.value });
  }, updateReferences);

  const edges = rows<Edge, Edge>(section(body, "내부 간선"), "간선", (row, n, seed) => {
    const id = input(row, "간선 ID", seed?.id ?? "edge-" + n);
    const from = ref(row, "출발 노드", "node", "선택", seed?.from);
    const to = ref(row, "도착 노드", "node", "선택", seed?.to);
    const evidence = claimProof(row, "간선", seed?.evidence);
    type Use = Edge["uses"][number];
    const uses = rows<Use, Use>(row, "사용 자원", (box, _, initial) => {
      const resource = ref(box, "자원", "resource", "선택", initial?.resource);
      const proof = claimProof(box, "자원 사용", initial?.evidence);
      return () => ({ resource: resource.value, evidence: proof({ value: true, unit: "" }) });
    }, updateReferences);
    seed?.uses.forEach(uses.add);
    return () => ({ id: id.value, from: from.value, to: to.value, evidence: evidence({ value: true, unit: "" }), uses: uses.read() });
  }, updateReferences);

  const resources = rows<Resource, Resource | typeof charger.resource>(section(body, "자원"), "자원", (row, n, seed) => {
    const initial = seed && "capacity" in seed ? seed : undefined;
    const id = input(row, "자원 ID", seed?.id ?? "resource-" + n);
    const kind = input(row, "자원 종류", seed?.kind ?? "");
    const domain = select(row, "자원 영역", domainChoices, seed?.domain);
    const unit = select(row, "자원 단위", []);
    const capacity = input(row, "용량", String(initial?.capacity.value ?? ""), "", "number");
    capacity.min = "0"; capacity.step = "any";
    const capProof = claimProof(row, "용량", initial?.capacity);
    const policy = input(row, "분배 정책", String(initial?.policy.value ?? ""));
    const policyProof = claimProof(row, "분배 정책", initial?.policy);
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
  const attributeForms = registrations.flatMap(({ plugin, name }) => {
    const schema = describe(plugin.attributes);
    const fixed = Object.keys(schema.properties ?? {});
    const entry = recordValue(schema);
    if (!fixed.length && !entry) return [];
    const group = el("details");
    group.append(el("summary", name));
    attributeSection.append(group);
    if (entry) {
      type Attribute = { key: string; value: Claim };
      const records = rows<Attribute, Attribute>(group, "속성", (row, n, seed) => {
        const keySchema = schema.propertyNames;
        const key = input(row, typeof keySchema === "object" ? keySchema.title ?? "속성 키" : "속성 키", seed?.key);
        if (typeof keySchema === "object" && keySchema.pattern) {
          key.pattern = keySchema.pattern;
          key.placeholder = keySchema.description ?? "";
        }
        const value = factField(row, "값", entry, true, true, `attributes.${plugin.id}.${n - 1}`, seed?.value);
        return () => ({ key: key.value, value: value()! });
      }, updateReferences);
      return [{
        id: plugin.id,
        load(fields: Record<string, Claim>) {
          records.clear();
          for (const [key, value] of Object.entries(fields)) records.add({ key, value });
        },
        read() {
          const facts: Record<string, Claim> = Object.create(null);
          for (const { key, value } of records.read()) {
            if (Object.hasOwn(facts, key)) throw new Error(`attributes.${plugin.id}.${key} — 속성 키가 겹칩니다.`);
            facts[key] = value;
          }
          return facts;
        },
      }];
    }
    const enabled = select(group, "영역 속성", [["", "미선언"], ["known", "입력"]]);
    const fields = el("div");
    group.append(fields);
    let read = factFields(fields, schema, [], "attributes." + plugin.id);
    return [{
      id: plugin.id,
      load(values: Record<string, Claim>) {
        fields.replaceChildren();
        enabled.value = Object.keys(values).length ? "known" : "";
        read = factFields(fields, schema, [], "attributes." + plugin.id, values);
      },
      read: () => enabled.value ? read() : {},
    }];
  });

  function updateReferences() {
    const available = sources.read();
    refreshSourceChoices(defaultSource, available, defaultSource.value || available[0]?.id || "");
    for (const control of form.querySelectorAll<HTMLSelectElement>("select[data-sources]"))
      refreshSourceChoices(control, available);
    const nodeList = nodes.read().flatMap(row => row.id ? [[row.id, row.label || row.id] as const] : []);
    const resourceList = resources.read().flatMap(row => row.id ? [[row.id, row.id] as const] : []);
    for (const control of form.querySelectorAll<HTMLSelectElement>("select[data-ref]")) {
      const type = control.dataset.ref;
      const entries = type === "node" ? nodeList : resourceList;
      choices(control, [["", control.dataset.empty ?? "선택"], ...entries]);
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

  function fillDraft(model: Model) {
    for (const rows of [ports, nodes, edges, resources, sources]) rows.clear();
    sourceIds.clear();
    defaultSource.value = "";
    kind.value = model.kind;
    brand.value = model.brand;
    name.value = model.name;
    category.value = model.category;
    modelId.value = model.modelId;
    revision.value = model.revision;
    model.sources.forEach(sources.add);
    model.nodes.forEach(nodes.add);
    model.resources.forEach(resources.add);
    model.ports.forEach(ports.add);
    model.edges.forEach(edges.add);
    for (const fields of attributeForms) fields.load(model.attributes?.[fields.id] ?? {});
    updateReferences();
    error.textContent = "";
    identity.scrollIntoView({ block: "start" });
    name.focus({ preventScroll: true });
  }

  mountResearch(research, fillDraft);

  const instanceId = "item-" + crypto.randomUUID();
  form.onsubmit = async event => {
    event.preventDefault();
    if (submit.disabled) return;
    form.querySelectorAll(".scenario-error").forEach(row => { row.textContent = ""; });
    submit.disabled = close.disabled = body.inert = true;
    submit.textContent = "저장 중…";
    try {
      const attributes = Object.fromEntries(attributeForms.map(fields => [fields.id, fields.read()] as const).filter(([, facts]) => Object.keys(facts).length));
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
