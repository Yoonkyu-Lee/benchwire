// 로컬 API의 장면을 작업대에 열고 확정 편집을 ETag 순서대로 저장한다.
import "./style.css";
import { loadAssessment } from "./assessment.ts";
import { moveConnectionEnd, requiredMateCapabilities } from "./connection.ts";
import { addConnection, modelKey, place, type Library, type SceneDocument, type SceneIntent } from "./document.ts";
import { mountWorkbench } from "./workbench.ts";
import { mountHelp } from "./help.ts";
import { scenarioName } from "../scene/files.ts";

const root = document.querySelector<HTMLElement>("#app")!;
const notice = document.querySelector<HTMLElement>("#storage-status")!;
const message = notice.querySelector("span")!;
const reopen = notice.querySelector("button")!;
const picker = document.createElement("select");
picker.setAttribute("aria-label", "장면");

function status(text = "", canReopen = false) {
  message.textContent = text;
  const budgetStatus = root.querySelector<HTMLElement>("dialog[open] [data-scene-save-status]");
  if (budgetStatus) budgetStatus.textContent = text;
  reopen.hidden = !canReopen;
  notice.hidden = text === "";
}

async function fetchLocal(url: string, init?: RequestInit) {
  try { return await fetch(url, init); }
  catch (error) {
    if (error instanceof TypeError) return undefined;
    throw error;
  }
}

type Edit = { before: SceneDocument; after: SceneDocument; intent: SceneIntent; done?: (saved: boolean) => void };

function same(a: unknown, b: unknown) {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

const CONFLICT = Symbol("편집 충돌");

function mergeField<T>(before: T, wanted: T, latest: T): T | typeof CONFLICT {
  if (same(before, wanted) || same(wanted, latest)) return latest;
  return same(before, latest) ? wanted : CONFLICT;
}

function mergeFields<T>(before: ReadonlyMap<string, T>, wanted: ReadonlyMap<string, T>, latest: ReadonlyMap<string, T>) {
  const merged = new Map<string, T>();
  for (const key of new Set([...latest.keys(), ...wanted.keys(), ...before.keys()])) {
    const value = mergeField(before.get(key), wanted.get(key), latest.get(key));
    if (value === CONFLICT) return CONFLICT;
    if (value !== undefined) merged.set(key, value);
  }
  return merged;
}

function mergeRows<T extends { id: string }>(latest: T[], before: T[], wanted: T[],
  sourced: (row: T) => T, merge: (old: T, next: T, current: T) => T | typeof CONFLICT): T[] | undefined {
  if (before === wanted) return latest;
  let rows = latest;
  // 폼의 한 제출은 표마다 한 행을 바꾸거나 끝에 더한다.
  for (const [index, next] of wanted.entries()) {
    const old = before[index];
    if (old === next) continue;
    const row = sourced(next);
    const at = rows.findIndex(r => r.id === (old?.id ?? row.id));
    if (!old) {
      if (at < 0) rows = [...rows, row];
      else if (!same(rows[at], row)) return undefined;
      continue;
    }
    if (at < 0) {
      if (rows.some(current => same(current, row))) continue;
      return undefined;
    }
    const value = merge(sourced(old), row, rows[at]!);
    if (value === CONFLICT) return undefined;
    rows = rows.with(at, value);
  }
  return rows;
}

type Scenario = SceneDocument["scenarios"][number];
type Workload = SceneDocument["workloads"][number];
type Claim = Workload["request"][string];

function mergeScenario(before: Scenario, wanted: Scenario, latest: Scenario) {
  const name = mergeField(before.name, wanted.name, latest.name);
  const membersById = (s: Scenario) => new Map(s.members.map(m => [typeof m === "string" ? m : m.workload, m]));
  const members = mergeFields(membersById(before), membersById(wanted), membersById(latest));
  const budget = mergeField(before.budget, wanted.budget, latest.budget);
  const purchases = mergeField(before.purchases, wanted.purchases, latest.purchases);
  return name === CONFLICT || members === CONFLICT || budget === CONFLICT || purchases === CONFLICT ? CONFLICT
    : { id: latest.id, ...(name !== undefined && {name}), members: [...members.values()],
      ...(budget !== undefined && {budget}), ...(purchases && {purchases}) };
}

function mergeWorkload(before: Workload, wanted: Workload, latest: Workload) {
  if (latest.domain !== before.domain || latest.kind !== before.kind) return CONFLICT;
  const from = mergeField(before.from, wanted.from, latest.from);
  const to = mergeField(before.to, wanted.to, latest.to);
  const fields = (work: Workload) => new Map(Object.entries(work.request));
  const request = mergeFields(fields(before), fields(wanted), fields(latest));
  return from === CONFLICT || to === CONFLICT || request === CONFLICT ? CONFLICT
    : { ...latest, from, to, request: Object.fromEntries(request) };
}

function replayScenario(latest: SceneDocument, { before, after }: Edit) {
  const sources = [...latest.sources];
  const localSources = new Map(after.sources.map(s => [s.id, s]));
  const aliases = new Map<string, string>();
  function cite(claim: Claim): Claim {
    return { ...claim, sources: claim.sources.map(id => {
      const mapped = aliases.get(id);
      if (mapped !== undefined) return mapped;
      const local = localSources.get(id)!;
      const equivalent = sources.find(s => s.id === id && same(s, local))
        ?? sources.find(s => s.title === local.title && s.locator === local.locator && s.retrievedAt === local.retrievedAt);
      if (equivalent) { aliases.set(id, equivalent.id); return equivalent.id; }
      let target = id;
      for (let n = 2; sources.some(s => s.id === target); n++) target = id + "-" + n;
      sources.push({ ...local, id: target });
      aliases.set(id, target);
      return target;
    }) };
  }
  const workloads = mergeRows(latest.workloads, before.workloads, after.workloads, work => ({
    ...work, request: Object.fromEntries(Object.entries(work.request).map(([key, claim]) => [key, cite(claim)])),
  }), mergeWorkload);
  const scenarios = mergeRows(latest.scenarios, before.scenarios, after.scenarios, s => ({
    ...s, members: s.members.map(m => typeof m === "string" ? m : { ...m, priority: cite(m.priority) }),
  }), mergeScenario);
  return workloads && scenarios ? { ...latest, sources, workloads, scenarios } : undefined;
}

function replay(latest: SceneDocument, edit: Edit) {
  const { intent } = edit;
  switch (intent.kind) {
    case "place":
      return latest.items.some(item => item.instanceId === intent.instanceId)
        ? place(latest, intent.instanceId, intent.position) : undefined;
    case "add-item": {
      const current = latest.items.find(item => item.instanceId === intent.item.instanceId);
      if (current) return modelKey(current) === modelKey(intent.item) ? latest : undefined;
      return place({ ...latest, items: [...latest.items, intent.item] }, intent.item.instanceId, intent.position);
    }
    case "connect": {
      const part = edit.after.connections.at(-1)!.parts[0];
      const item = part && edit.after.items.find(item => item.instanceId === part.instanceId)!;
      return addConnection(latest, intent.from, intent.to, part && item ? { item, part } : undefined);
    }
    case "move-connection-end": {
      const before = edit.before.connections.find(row => row.id === intent.id);
      const saved = latest.connections.find(row => row.id === intent.id);
      if (!before || !saved || !same(before.parts, saved.parts)) return;
      if (same(saved[intent.end], intent.target)) return latest;
      if (!same(saved[intent.end], before[intent.end])) return;
      return moveConnectionEnd(latest, intent);
    }
    case "verify-measurement": {
      const { before, after } = edit;
      // 측정이 기대고 있는 배선·실물 상태가 변하면 값을 새 장면에 자동 적용하지 않는다.
      const sameTargets = same(before.items, latest.items) && same(before.connections, latest.connections)
        && same(before.personal, latest.personal);
      if (!sameTargets) return;
      const added = after.sources.filter(source => !before.sources.includes(source));
      if (added.some(source => latest.sources.some(row => row.id === source.id))) return;
      return { ...latest, sources: [...latest.sources, ...added], items: after.items,
        personal: after.personal, connections: after.connections };
    }
    case "edit-scenario": return replayScenario(latest, edit);
  }
}

function editName({ intent, before, after }: Edit) {
  switch (intent.kind) {
    case "place": return intent.instanceId + " 배치 이동";
    case "add-item": return intent.item.instanceId + " 실물 배치";
    case "connect": return `${intent.from.instanceId}/${intent.from.id} → ${intent.to.instanceId}/${intent.to.id} 연결`;
    case "move-connection-end": return intent.id + " 케이블 끝 이동";
    case "verify-measurement": return "검증값 · 실물 상태 편집";
    case "edit-scenario": {
      const changed = after.workloads.find((row, index) => row !== before.workloads[index]);
      return changed ? changed.id + " 작업 편집"
        : scenarioName(after.scenarios.find((row, index) => row !== before.scenarios[index])!) + " 시나리오 편집";
    }
  }
}

function confirmLeaving(event: BeforeUnloadEvent) {
  event.preventDefault();
  event.returnValue = true;
}

async function start() {
  const response = await fetchLocal("/api/library");
  if (!response?.ok) {
    status("라이브러리를 열 수 없습니다.");
    return;
  }
  const library = await response.json() as Library & {
    defaultSceneId: string; scenes: { id: string; title: string }[];
  };
  for (const { id, title } of library.scenes) picker.add(new Option(title, id));
  const help = mountHelp(fetchLocal);

  let saved: SceneDocument;
  let draft: SceneDocument;
  let etag: string;
  let workbench: ReturnType<typeof mountWorkbench>;
  let saving = false;
  let mustReopen = false;
  const edits: Edit[] = [];

  async function open(id: string) {
    root.inert = true;
    reopen.disabled = true;
    try {
      const result = await fetchLocal("/api/scenes/" + encodeURIComponent(id));
      const tag = result?.headers.get("ETag");
      if (!result?.ok || !tag) {
        if (saved) picker.value = saved.sceneId;
        status("장면을 열 수 없습니다.", Boolean(saved));
        return;
      }
      const scene = await result.json() as SceneDocument;
      workbench?.dispose();
      workbench = mountWorkbench(root, scene, library, { onChange: edited, onSaveCopy: saveCopy });
      draft = saved = scene;
      etag = tag;
      mustReopen = false;
      picker.value = id;
      root.querySelector(".scene-title h1")!.replaceWith(picker);
      root.querySelector(".stage")!.append(notice);
      root.querySelector(".view-controls")!.append(help.trigger);
      status();
    } finally {
      root.inert = false;
      reopen.disabled = false;
    }
  }

  async function saveCopy(document: SceneDocument) {
    const path = "/api/scenes/" + encodeURIComponent(document.sceneId);
    const result = await fetchLocal(path, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(document),
    });
    if (!result || result.status === 428) {
      const existing = await fetchLocal(path);
      if (!existing?.ok || !same(await existing.json(), document))
        throw new Error("사본 저장 결과를 확인하지 못했습니다.");
    } else if (result.status === 201) {
      const created = await result.json() as SceneDocument;
      if (created.sceneId !== document.sceneId) throw new Error("저장된 사본 ID가 요청과 다릅니다.");
    } else {
      const problem = await result.json() as { path?: string; message?: string };
      throw new Error([problem.path, problem.message].filter(Boolean).join(" · ") || "사본을 저장할 수 없습니다.");
    }
    if (!Array.from(picker.options).some(row => row.value === document.sceneId))
      picker.add(new Option(document.sceneId, document.sceneId));
  }

  function edited(after: SceneDocument, intent: SceneIntent) {
    if (mustReopen) { workbench.replaceDocument(saved); return Promise.resolve(false); }
    const edit: Edit = { before: draft, after, intent };
    const completion = intent.kind === "add-item" ? new Promise<boolean>(done => { edit.done = done; }) : undefined;
    edits.push(edit);
    draft = after;
    if (!saving) void save();
    return completion;
  }

  function rejectEdits() {
    const unsaved = edits.splice(0).map(edit => { edit.done?.(false); return editName(edit); });
    mustReopen = true;
    draft = saved;
    workbench.replaceDocument(saved);
    status(["저장 결과를 확인할 수 없습니다. 장면을 다시 열어 주세요.",
      unsaved.length ? "저장을 확인하지 못한 편집 · " + unsaved.join(", ") : "",
    ].filter(Boolean).join("\n"), true);
  }

  function reapply(discarded: string[]) {
    draft = saved;
    for (const edit of edits.splice(0)) {
      const next = replay(draft, edit);
      if (!next) { discarded.push(editName(edit)); edit.done?.(false); continue; }
      if (next === draft) { edit.done?.(true); continue; }
      const loaded = loadAssessment(next, workbench.documents, null);
      if ("error" in loaded) { discarded.push(editName(edit)); edit.done?.(false); continue; }
      const connection = edit.intent.kind === "connect" ? next.connections.at(-1)!.id
        : edit.intent.kind === "move-connection-end" ? edit.intent.id : undefined;
      if (connection && requiredMateCapabilities(loaded.scene, connection).length) {
        discarded.push(editName(edit));
        continue;
      }
      edits.push({ ...edit, before: draft, after: next });
      draft = next;
    }
    workbench.replaceDocument(draft);
  }

  async function save() {
    saving = true;
    picker.disabled = true;
    window.addEventListener("beforeunload", confirmLeaving);
    status("저장 중…");
    const discarded: string[] = [];
    const errors: { path: string; message: string }[] = [];
    try {
      while (edits.length) {
        const document = { ...edits[0]!.after, sceneId: saved.sceneId };
        const result = await fetchLocal("/api/scenes/" + encodeURIComponent(document.sceneId), {
          method: "PUT", headers: { "Content-Type": "application/json", "If-Match": etag }, body: JSON.stringify(document),
        });
        if (result?.status === 412) {
          const latest = await fetchLocal("/api/scenes/" + encodeURIComponent(document.sceneId));
          const tag = latest?.headers.get("ETag");
          if (!latest?.ok || !tag) { rejectEdits(); return; }
          const latestDocument = await latest.json() as SceneDocument;
          if (latestDocument.items.some(item => !workbench.documents.models.has(modelKey(item)))) {
            const refreshed = await fetchLocal("/api/library");
            if (!refreshed?.ok) { rejectEdits(); return; }
            const catalog = await refreshed.json() as Library;
            await workbench.finishGesture();
            workbench.refreshCatalog(catalog.models, catalog.inventory);
          } else await workbench.finishGesture();
          saved = latestDocument;
          etag = tag;
          reapply(discarded);
          continue;
        }
        if (result?.status === 422) {
          errors.push(await result.json() as { path: string; message: string });
          edits.shift()?.done?.(false);
          await workbench.finishGesture();
          reapply(discarded);
          continue;
        }
        const tag = result?.headers.get("ETag");
        if (!tag || (result?.status !== 201 && result?.status !== 204)) { rejectEdits(); return; }
        if (result.status === 201) {
          saved = await result.json() as SceneDocument;
          draft = workbench.adoptSceneId(saved.sceneId);
          picker.add(new Option(draft.sceneId, draft.sceneId));
          picker.value = draft.sceneId;
        } else saved = document;
        etag = tag;
        edits.shift()?.done?.(true);
      }
      const notices = errors.flatMap(({ path, message }) => workbench.showFieldError(path, message)
        ? [] : [[path, message].filter(Boolean).join(" — ")]);
      if (discarded.length) notices.unshift("다시 적용하지 못한 편집 · " + discarded.join(", "));
      status(notices.join("\n") || (errors.length ? "" : "저장됨"));
    } finally {
      window.removeEventListener("beforeunload", confirmLeaving);
      saving = false;
      picker.disabled = false;
    }
  }

  picker.addEventListener("change", () => { void open(picker.value); });
  reopen.addEventListener("click", () => { void open(saved.sceneId); });
  await open(library.defaultSceneId);
  if (root.contains(help.trigger)) void help.showOnFirstRun();
}

void start();
