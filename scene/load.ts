// 고정한 모델 판본을 실물별로 펼치고 저장 ID를 행 번호로 바꾼다. 입력 오류는 파일과 필드를 가리킨다.
import { connectionPorts } from "../engine/scene.ts";
import type { z } from "zod";
import type { Scene, Claim, DomainPlugin, InputSchema, MeasurementContext } from "../engine/contract.ts";
import { connectorsFile, modelFile, sceneFile, parseDocument, type Fact } from "./files.ts";

function fail(at: string, why: string): never { throw new Error(at + " — " + why); }

function unique<T>(map: Map<string, T>, id: string, value: T, at: string): T {
  if (map.has(id)) fail(at, "중복 ID: " + id);
  map.set(id, value);
  return value;
}
// 같은 수집 파일을 다시 가져오면 같은 측정과 출처는 한 번만 펼친다.
function readDistinct<T>(rows: T[], read: (value: T, index: number) => void) {
  const seen = new Set<string>();
  rows.forEach((row,i) => {
    // 인용 순서는 측정의 일부가 아니며, 오류 위치는 원본 배열의 번호를 따른다.
    const key = JSON.stringify(row,(field,value) => field === "sources" ? [...new Set<string>(value)].sort() : value);
    if (seen.has(key)) return;
    seen.add(key);
    read(row,i);
  });
}
function contextDifference(measured: MeasurementContext, current: MeasurementContext, requireKnown = false) {
  for (const field of ["firmware","measurementCondition"] as const) {
    const recorded = measured[field], now = current[field];
    if (recorded === now && (!requireKnown || recorded !== undefined)) continue;
    if (recorded === undefined || now === undefined)
      return field === "firmware" ? "unknownFirmware" : "unknownMeasurementCondition";
    return field;
  }
  return undefined;
}
function ref<T>(map: Map<string, T>, id: string, at: string): T {
  return map.get(id) ?? fail(at, "찾을 수 없는 참조: " + id);
}
function validateFields(schema: InputSchema, fields: Record<string, Pick<Fact, "value" | "unit">>, at: string, personalField?: string) {
  const result = schema.safeParse(fields);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    const path = personalField === undefined ? issue.path : issue.path[0] === personalField ? issue.path.slice(1) : [];
    fail([at, ...path].join("."), issue.message);
  }
}
// 후보는 본값과 같은 필드 경계를 통과하며 생략한 단위·조건은 본값에서 받는다.
function checkValues(fact: Fact, at: string, check: (sample: Pick<Fact, "value" | "unit">, where: string) => void) {
  check(fact, at);
  fact.conflicts?.forEach((c,i) => check({ value: c.value, unit: fact.unit }, at + ".conflicts." + i));
}
function interfaceSchema(plugin: DomainPlugin, protocol: string) {
  return plugin.paramsFor?.(protocol) ?? plugin.params;
}
type Model = z.infer<typeof modelFile>;
interface Local {
  item: number; nodes: Map<string, number>; ports: Map<string, number>; resources: Map<string, number>; interfaces: Map<string, number>;
}

export function loadSceneDocuments(document: unknown, library: { connectors: unknown; models: ReadonlyMap<string, unknown> },
  plugins: readonly DomainPlugin[], names = { scene: "scene.json", connectors: "connectors.json", model: (key: string) => key + ".json" }): Scene {
  const file = names.scene;
  const saved = parseDocument(sceneFile, document, file);
  const scene: Scene = {
    id: saved.sceneId, models: [], items: [], nodes: [], ports: [], interfaces: [], edges: [], resources: [], resourceUses: [],
    connectors: [], mates: [], connections: [], parts: [], workloads: [], scenarios: [], members: [],
    claims: [], sources: [], claimSources: [],
  };
  const domains = new Map<string, DomainPlugin>();
  plugins.forEach(p => unique(domains, p.id, p, file + "#plugins"));
  function sources(rows: Scene["sources"], at: string, repeated = false) {
    const index = new Map<string, number>();
    function add(s: Scene["sources"][number], i: number) {
      unique(index,s.id,scene.sources.push(s) - 1,at + ".sources." + i);
    }
    if (repeated) readDistinct(rows,add);
    else rows.forEach(add);
    return index;
  }
  const conflictGroups = new Map<Fact, number>();
  function claim(ownerKind: Claim["ownerKind"], owner: number, scope: Claim["scope"], domain: string, field: string,
    fact: Fact, citations: Map<string, number>, at: string) {
    const { value, unit, confidence, condition } = fact;
    const row = scene.claims.length, disputed = !!fact.conflicts?.length;
    const common = { id: JSON.stringify([domain, field, condition]), ownerKind, owner, scope, domain, field, unit, condition };
    if (disputed) {
      const group = conflictGroups.get(fact) ?? row;
      conflictGroups.set(fact, group);
      scene.claims.push({ ...common, value: null, confidence: "unknown", conflictGroup: group });
    } else scene.claims.push({ ...common, value, confidence, ...(fact.inferredFrom && { inferredFrom: fact.inferredFrom }) });
    const seen = new Set<string>();
    function cite(sample: Pick<Fact, "value" | "confidence" | "sources" | "inferredFrom">, where: string) {
      if ((scope === "model" || scope === "catalog") && sample.confidence === "user_verified")
        fail(where + ".confidence", "사용자 검증값은 장면에서 해당 실물에만 적용합니다");
      if (scope === "personal" && sample.confidence !== "user_verified")
        fail(where + ".confidence", "개인 주장에는 사용자 검증이 필요합니다");
      const candidate = disputed && sample.value !== null ? { value: sample.value, confidence: sample.confidence,
        ...(sample.inferredFrom && { inferredFrom: sample.inferredFrom }) } : undefined;
      sample.sources.forEach((id,i) => {
        const source = ref(citations, id, where + ".sources." + i);
        const key = JSON.stringify([source, candidate]);
        if (!seen.has(key)) scene.claimSources.push({ claim: row, source, ...(candidate && { candidate }) });
        seen.add(key);
      });
    }
    cite(fact, at);
    fact.conflicts?.forEach((c,i) => cite(c, at + ".conflicts." + i));
    return row;
  }
  function fields(ownerKind: Claim["ownerKind"], owner: number, scope: Claim["scope"], domain: string,
    values: Record<string, Fact>, schema: InputSchema, citations: Map<string, number>, at: string) {
    const base = Object.fromEntries(Object.entries(values).map(([key, f]) => [key, { value: f.value, unit: f.unit }]));
    validateFields(schema, base, at);
    for (const [key, fact] of Object.entries(values)) {
      const where = at + "." + key;
      fact.conflicts?.forEach((c,i) => validateFields(schema, { ...base, [key]: { value: c.value, unit: fact.unit } },
        where + ".conflicts." + i, key));
      claim(ownerKind, owner, scope, domain, key, fact, citations, where);
    }
  }

  const registry = parseDocument(connectorsFile, library.connectors, names.connectors);
  const catalogSources = sources(registry.sources, names.connectors + "#");
  const connectors = new Map<string, number>();
  registry.connectors.forEach((c, row) => {
    const at = names.connectors + "#connectors." + row;
    checkValues(c.endForm, at + ".endForm", (sample,where) => {
      if (sample.unit || c.endForm.condition || sample.value !== null && typeof sample.value !== "string")
        fail(where, "결합 형태는 문자열 또는 null입니다");
    });
    const endForm = claim("connector", row, "catalog", "", "endForm", c.endForm, catalogSources, at + ".endForm");
    unique(connectors, c.id, scene.connectors.push({ id: c.id, endForm }) - 1, at + ".id");
  });
  registry.mates.forEach((m, i) => {
    const at = names.connectors + "#mates." + i;
    const a = ref(connectors, m.a, at + ".a"), b = ref(connectors, m.b, at + ".b");
    if (scene.mates.some(pair => pair.a === a && pair.b === b || pair.a === b && pair.b === a)) fail(at, "중복 결합쌍");
    scene.mates.push({ a, b, evidence: claim("mate", i, "catalog", "", "mate", m.evidence, catalogSources, at + ".evidence") });
  });
  const sceneSources = sources(saved.sources,file + "#",true);
  const models = new Map<string, { row: number; model: Model; citations: Map<string, number> }>();
  const instances = new Map<string, Local>();

  function checkResource(field: string, fact: Fact, unit: string, at: string) {
    checkValues(fact, at, (sample,where) => {
      const valid = field === "capacity"
        ? sample.unit === unit && (sample.value === null || typeof sample.value === "number" && sample.value >= 0)
        : !sample.unit && (sample.value === null || typeof sample.value === "string");
      if (!valid) fail(where + (sample.unit !== (field === "capacity" ? unit : "") ? ".unit" : ".value"), "자원 " + field + "의 값 또는 단위가 맞지 않습니다");
    });
  }
  function referenceRow(fact: Fact, index: Map<string, number>, at: string) {
    let reference: number | null = null;
    checkValues(fact, at, (sample,where) => {
      if (sample.unit) fail(where + ".unit", "참조 ID에는 단위를 붙일 수 없습니다");
      if (sample.value !== null && typeof sample.value !== "string") fail(where + ".value", "지역 ID 또는 null이 필요합니다");
      if (sample.value !== null) reference = ref(index, sample.value, where + ".value");
    });
    return fact.conflicts?.length ? null : reference;
  }
  saved.items.forEach((instance, item) => {
    const { instanceId, modelId, revision, alias, state, firmware, measurementCondition } = instance;
    const instanceAt = file + "#items." + item;
    const key = modelId + "@" + revision;
    const modelPath = names.model(key);
    let pinned = models.get(key);
    if (!pinned) {
      if (!library.models.has(key)) fail(instanceAt + ".revision", "모델 판본을 찾을 수 없습니다: " + modelPath);
      const model = parseDocument(modelFile, library.models.get(key), modelPath);
      if (model.modelId !== modelId || model.revision !== revision) fail(instanceAt + ".revision", "요청과 파일 판본이 다릅니다: " + modelPath);
      const { kind, name, brand, category } = model;
      pinned = { model, row: scene.models.push({ id: modelId, revision, kind, name, brand, category }) - 1, citations: sources(model.sources, modelPath + "#") };
      models.set(key, pinned);
    }
    const { model, citations } = pinned;
    scene.items.push({ id: instanceId, model: pinned.row, alias, state, ...(firmware !== undefined && {firmware}), ...(measurementCondition !== undefined && {measurementCondition}) });
    const local = unique<Local>(instances, instanceId, { item, nodes: new Map(), ports: new Map(), resources: new Map(), interfaces: new Map() }, instanceAt + ".instanceId");
    const at = modelPath + "#";
    for (const [domain, values] of Object.entries(model.attributes))
      fields("item", item, "model", domain, values, ref(domains, domain, at + "attributes." + domain).attributes, citations, at + "attributes." + domain);
    model.nodes.forEach((n, i) => unique(local.nodes, n.id, scene.nodes.push({ ...n, item }) - 1, at + "nodes." + i + ".id"));
    model.ports.forEach((p, i) => {
      const pos = at + "ports." + i;
      p.position?.sources.forEach((id, j) => ref(citations, id, pos + ".position.sources." + j));
      const port = unique(local.ports, p.id, scene.ports.length, pos + ".id");
      if (p.connector.condition) fail(pos + ".connector.condition", "기본 커넥터에는 조건을 붙일 수 없습니다");
      if (p.attachment.condition) fail(pos + ".attachment.condition", "기본 배선에는 조건을 붙일 수 없습니다");
      scene.ports.push({ item, id: p.id, label: p.label, location: p.location });
      const connector = claim("port", port, "model", "", "connector", p.connector, citations, pos + ".connector");
      scene.claims[connector]!.connectorRow = referenceRow(p.connector, connectors, pos + ".connector");
      const attachment = claim("port", port, "model", "", "attachment", p.attachment, citations, pos + ".attachment");
      scene.claims[attachment]!.attachmentNode = referenceRow(p.attachment, local.nodes, pos + ".attachment");
      const signatures = new Map<string, number>();
      p.interfaces.forEach((iface, j) => {
        const where = pos + ".interfaces." + j;
        const { id, domain, protocol, role } = iface;
        const row = unique(local.interfaces, id, scene.interfaces.length, where + ".id");
        unique(signatures, JSON.stringify([domain, protocol, role]), row, where);
        const evidence = claim("interface", row, "model", "", "declaration", iface.evidence, citations, where + ".evidence");
        scene.interfaces.push({ id, domain, protocol, role, port, evidence });
        fields("interface", row, "model", domain, iface.params, interfaceSchema(ref(domains, domain, where + ".domain"), protocol), citations, where + ".params");
      });
    });
    model.resources.forEach((r, i) => {
      const where = at + "resources." + i;
      const { id, domain, kind, unit } = r;
      const { resourceUnits } = ref(domains, domain, where + ".domain");
      if (resourceUnits && !resourceUnits.includes(unit)) fail(where + ".unit", domain + " 자원 단위는 " + resourceUnits.join(", ") + "입니다");
      const row = unique(local.resources, id, scene.resources.length, where + ".id");
      for (const key of ["capacity", "policy"] as const) {
        checkResource(key, r[key], unit, where + "." + key);
        if (r[key].condition) fail(where + "." + key, "기본 자원에는 조건을 붙일 수 없습니다");
      }
      scene.resources.push({ item, id, domain, kind, unit });
      for (const field of ["capacity", "policy"] as const)
        claim("resource", row, "model", domain, field, r[field], citations, where + "." + field);
    });
    const edges = new Map<string, number>();
    model.edges.forEach((e, i) => {
      const where = at + "edges." + i;
      const edge = unique(edges, e.id, scene.edges.length, where + ".id");
      scene.edges.push({ item, id: e.id, from: ref(local.nodes, e.from, where + ".from"), to: ref(local.nodes, e.to, where + ".to"),
        evidence: claim("edge", edge, "model", "", "edge", e.evidence, citations, where + ".evidence") });
      const uses = new Map<string, number>();
      e.uses.forEach((u, j) => {
        const pos = where + ".uses." + j;
        const resource = unique(uses, u.resource, ref(local.resources, u.resource, pos + ".resource"), pos);
        scene.resourceUses.push({ edge, resource, evidence: claim("edge", edge, "model", "", "use:" + u.resource, u.evidence, citations, pos + ".evidence") });
      });
    });
  });
  const placed = new Set<string>();
  saved.layout?.placements?.forEach(({ instanceId }, i) => {
    const at = file + "#layout.placements." + i + ".instanceId";
    ref(instances, instanceId, at);
    if (placed.has(instanceId)) fail(at, "중복 배치: " + instanceId);
    placed.add(instanceId);
  });
  readDistinct(saved.personal,(p, i) => {
    const at = file + "#personal." + i;
    const local = ref(instances, p.instanceId, at + ".instanceId");
    const { ownerKind, domain, field } = p;
    let owner: number;
    if (ownerKind === "item") {
      if (p.ownerId !== p.instanceId) fail(at + ".ownerId", "실물 ID가 다릅니다");
      owner = local.item;
    } else {
      const map = ownerKind === "port" ? local.ports : ownerKind === "resource" ? local.resources : local.interfaces;
      owner = ref(map, p.ownerId, at + ".ownerId");
    }
    const candidates = scene.claims.filter(c => c.ownerKind === ownerKind && c.owner === owner && c.domain === domain && c.field === field);
    if (!candidates.some(c => c.scope === "model")) fail(at + ".field", "대상 모델에 없는 주장");
    if (candidates.some(c => c.scope === "personal" && c.condition === p.claim.condition && !contextDifference(c,p))) fail(at, "같은 조건에 중복된 개인 주장");
    const row = claim(ownerKind, owner, "personal", domain, field, p.claim, sceneSources, at + ".claim");
    const measured = scene.claims[row]!;
    const inactive = contextDifference(p,scene.items[local.item]!,p.firmware !== undefined || p.measurementCondition !== undefined);
    if (inactive) measured.inactive = inactive;
    if (p.firmware !== undefined) measured.firmware = p.firmware;
    if (p.measurementCondition !== undefined) measured.measurementCondition = p.measurementCondition;
    if (ownerKind === "resource") {
      const r = scene.resources[owner]!;
      checkResource(field, p.claim, r.unit, at + ".claim");
    } else if (ownerKind === "port") {
      if (field === "connector") measured.connectorRow = referenceRow(p.claim, connectors, at + ".claim");
      else measured.attachmentNode = referenceRow(p.claim, local.nodes, at + ".claim");
    } else {
      const plugin = ref(domains, domain, at + ".domain");
      const group = scene.claims.filter(c => c.ownerKind === ownerKind && c.owner === owner && c.domain === domain &&
        (c.scope !== "personal" || !contextDifference(c,p)) && !(ownerKind === "interface" && c.field === "declaration") &&
        (!c.condition || c.condition === p.claim.condition));
      const values = Object.fromEntries(group.map(c => [c.field, { value: c.value, unit: c.unit }]));
      const schema = ownerKind === "item" ? plugin.attributes : interfaceSchema(plugin, scene.interfaces[owner]!.protocol);
      checkValues(p.claim, at + ".claim", (sample,where) => validateFields(schema, { ...values, [field]: {value:sample.value,unit:sample.unit} }, where, field));
    }
  });
  function endpoint(r: { instanceId: string; id: string }, kind: "nodes" | "ports", at: string) {
    return ref(ref(instances, r.instanceId, at + ".instanceId")[kind], r.id, at + ".id");
  }
  const connectionIds = new Map<string, number>();
  const partItems = new Map<string, string>();
  const occupied = new Map<number, string>();
  function occupy(port: number, at: string) {
    const previous = occupied.get(port);
    if (previous !== undefined) fail(at, "이미 포트를 점유한 위치 " + previous);
    occupied.set(port, at);
    return port;
  }
  saved.connections.forEach((c, connection) => {
    const at = file + "#connections." + connection;
    unique(connectionIds, c.id, connection, at + ".id");
    scene.connections.push({ id: c.id, from: occupy(endpoint(c.from, "ports", at + ".from"), at + ".from"),
      to: occupy(endpoint(c.to, "ports", at + ".to"), at + ".to"),
      evidence: claim("connection", connection, "scene", "", "connection", c.evidence, sceneSources, at + ".evidence") });
    c.parts.forEach((p, order) => {
      const pos = at + ".parts." + order;
      const local = ref(instances, p.instanceId, pos + ".instanceId");
      const entry = ref(local.ports, p.entry, pos + ".entry"), exit = ref(local.ports, p.exit, pos + ".exit");
      occupy(entry, pos + ".entry");
      occupy(exit, pos + ".exit");
      const previous = partItems.get(p.instanceId);
      if (previous !== undefined) fail(pos + ".instanceId", "이미 부품을 사용한 위치 " + previous);
      partItems.set(p.instanceId, pos + ".instanceId");
      scene.parts.push({ connection, order, item: local.item, entry, exit });
    });
    if (c.observations?.length) {
      const ports = connectionPorts(scene,connection);
      const active = new Set<string>();
      readDistinct(c.observations,(observation,i) => {
        const where = at + ".observations." + i;
        const {domain,field,claim:fact} = observation;
        const plugin = ref(domains,domain,where + ".domain");
        if (plugin.observations) validateFields(plugin.observations,{ [field]:{value:fact.value,unit:fact.unit} },where + ".claim",field);
        const row = claim("connection",connection,"personal",domain,field,fact,sceneSources,where + ".claim");
        scene.claims[row]!.observedPorts = observation.ports;
        const changed = ports.length !== observation.ports.length || ports.some((p,j) =>
          p.instanceId !== observation.ports[j]!.instanceId || p.id !== observation.ports[j]!.id);
        const inactive = changed ? "wiring" : observation.ports.map((p,j) =>
          contextDifference(p,ports[j]!,true)).find(reason => reason !== undefined);
        if (inactive) scene.claims[row]!.inactive = inactive;
        else {
          const key = JSON.stringify([domain,field]);
          if (active.has(key)) fail(where, "같은 배선·조건에 중복된 연결 관측");
          active.add(key);
        }
      });
    }
  });
  const works = new Map<string, number>();
  saved.workloads.forEach((w, workload) => {
    const at = file + "#workloads." + workload;
    const { id, domain, kind } = w;
    unique(works, id, workload, at + ".id");
    scene.workloads.push({ id, domain, kind, from: endpoint(w.from, "nodes", at + ".from"), to: endpoint(w.to, "nodes", at + ".to") });
    fields("workload", workload, "scene", domain, w.request, ref(domains, domain, at + ".domain").request, sceneSources, at + ".request");
  });
  const scenarios = new Map<string, number>();
  saved.scenarios.forEach((s, scenario) => {
    const at = file + "#scenarios." + scenario;
    unique(scenarios, s.id, scenario, at + ".id");
    scene.scenarios.push({ id: s.id });
    const members = new Map<string, number>();
    s.members.forEach((entry, i) => {
      const pos = at + ".members." + i;
      const id = typeof entry === "string" ? entry : entry.workload;
      const position = typeof entry === "string" ? pos : pos + ".workload";
      const workload = unique(members, id, ref(works, id, position), position);
      if (typeof entry === "string") scene.members.push({ scenario, workload });
      else {
        const evidence = claim("workload", workload, "scene", "", "priority", { ...entry.priority, condition: s.id },
          sceneSources, pos + ".priority");
        const priority = scene.claims[evidence]!.value as number | null;
        scene.members.push({ scenario, workload, ...(priority === null ? {} : { priority }), evidence });
      }
    });
  });
  return scene;
}
