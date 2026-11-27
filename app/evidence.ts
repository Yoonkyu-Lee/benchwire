// 선택한 선·작업·자원의 근거 나무와 실제 출처를 펼친다.
import { evidenceRows } from "../engine/evidence.ts";
import type { Results, Run } from "../engine/results.ts";
import type { Variants } from "./assessment.ts";
import { interval, quantity, resourceName, verdictText, type ResultView, type Selection } from "./results.ts";

const stages = { physical: "물리", negotiate: "협상", path: "경로", allocate: "배분", judge: "판정" };
const confidence = { official: "공식", review: "리뷰", community: "커뮤니티", user_verified: "사용자 검증", inferred: "추정", unknown: "미확인" };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

function source(title: string, locator: string) {
  const row = el("li");
  if (/^https?:\/\//i.test(locator)) {
    const link = el("a", title);
    link.href = locator;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    row.append(link);
  } else {
    row.append(el("span", title), el("small", locator));
  }
  return row;
}

function appendClaimSources(row: HTMLElement, scene: ResultView["scene"], claim: number) {
  const citations = el("ul");
  citations.className = "citations";
  for (const link of scene.claimSources) if (link.claim === claim) {
    const s = scene.sources[link.source]!;
    citations.append(source(s.title, s.locator));
  }
  if (citations.childElementCount) row.append(citations);
}

function tree(view: ResultView, start: Parameters<typeof evidenceRows>[1]) {
  const { scene, result } = view;
  const root = el("ul");
  root.className = "reason-tree";
  const parents = [root];
  for (const entry of evidenceRows(result, start)) {
    const reason = result.reasons[entry.reason]!;
    const row = el("li");
    parents[entry.depth]!.append(row);
    if (entry.reference) {
      const reference = el("span", "↪ 재참조 · " + reason.rule);
      reference.className = "reason-reference";
      row.append(reference);
      continue;
    }
    const detail = el("details");
    detail.open = entry.depth === 0;
    detail.append(el("summary", `${stages[reason.stage]} · ${reason.rule}`));
    const inputs = result.reasonInputs.filter(input => input.reason === entry.reason);
    if (inputs.length) {
      const claims = el("ul");
      claims.className = "reason-inputs";
      for (const input of inputs) {
        const claim = scene.claims[input.claim]!;
        const value = claim.value === null ? "미확인" : String(claim.value);
        const claimRow = el("li", [claim.field, [value, claim.unit].filter(Boolean).join(" "), confidence[claim.confidence], claim.condition].filter(Boolean).join(" · "));
        appendClaimSources(claimRow, scene, input.claim);
        claims.append(claimRow);
      }
      detail.append(claims);
    }
    const specs = el("ul");
    specs.className = "citations specs";
    for (const link of result.reasonSpecs) if (link.reason === entry.reason) {
      const s = result.specSources[link.source];
      if (s) specs.append(source(s.title, s.locator));
    }
    if (specs.childElementCount) detail.append(specs);
    const children = el("ul");
    parents[entry.depth + 1] = children;
    detail.append(children);
    row.append(detail);
  }
  return root;
}

function list(root: HTMLElement, title: string, entries: readonly string[], className = "") {
  if (!entries.length) return;
  const ul = el("ul");
  ul.className = className;
  ul.append(...[...new Set(entries)].map(entry => el("li", entry)));
  root.append(el("h4", title), ul);
}

function outcomeNotes(root: HTMLElement, result: Results, rows: readonly number[], run: Run = "together") {
  const selected = new Set(rows);
  const possible = run === "solo" ? result.assessments.filter(row => row.run === "solo") : result.possibleVerdicts;
  list(root, "가능한 판정", possible.filter(row => selected.has(row.outcome)).map(row => verdictText[row.verdict]));
  list(root, "검증 퀘스트", result.quests.filter(row => selected.has(row.outcome)).map(row =>
    row.instruction + (row.impact === "verdict" ? " · 판정에 영향" : row.impact === "range" ? " · 범위에 영향" : "")), "quests");
  list(root, "필요한 결합 형태", result.needs.filter(row => selected.has(row.outcome)).map(row => row.requiredCapability));
}

function limitWitnesses(view: ResultView, outcome: number) {
  const metric = view.limits.get(outcome);
  if (!metric || metric.low === metric.high) return undefined;
  const { scene, result } = view;
  const bounds = el("dl");
  bounds.className = "limit-witnesses";
  for (const [label, limit, world] of [
    ["하한", metric.low, metric.lowWorld], ["상한", metric.high, metric.highWorld],
  ] as const) {
    if (world === undefined || limit === null) continue;
    const candidates = [
      ...result.profileWorlds.filter(v => v.world === world),
      ...result.wirings.filter(v => v.world === world).map(v => ({ claim: v.claim, value: scene.nodes[v.node]!.id })),
    ];
    if (!candidates.length) continue;
    const claims = el("ul");
    for (const { claim: index, value } of candidates) {
      const claim = scene.claims[index]!;
      const iface = claim.ownerKind === "interface" ? scene.interfaces[claim.owner] : undefined;
      const port = iface ? scene.ports[iface.port] : claim.ownerKind === "port" ? scene.ports[claim.owner] : undefined;
      const item = port ? scene.items[port.item] : claim.ownerKind === "item" ? scene.items[claim.owner] : undefined;
      const owner = [item?.alias || item?.id, port?.label, iface?.id].filter(Boolean).join(" / ");
      const fact = [owner, `${claim.field} = ${value}${claim.unit ? " " + claim.unit : ""}`, claim.condition].filter(Boolean).join(" · ");
      const row = el("li", fact);
      appendClaimSources(row, scene, index);
      claims.append(row);
    }
    const entry = el("dd");
    entry.append(claims);
    bounds.append(el("dt", `${label} ${quantity(limit, metric.unit)} · 후보값`), entry);
  }
  return bounds.childElementCount ? bounds : undefined;
}

function detail(root: HTMLElement, view: ResultView, selected: Selection) {
  const { scene, result } = view;
  if (selected.kind === "connection") {
    const rows = view.negotiations.get(selected.id);
    if (!rows?.length) return;
    root.append(el("h3", `연결 · ${selected.id}`));
    outcomeNotes(root, result, rows);
    const marks = view.wires.get(selected.id)!.filter(mark => mark.kind === "negotiation");
    rows.forEach((row, index) => {
      const negotiation = el("details");
      negotiation.className = "negotiation-evidence";
      negotiation.append(el("summary", marks[index]!.title), tree(view, { outcome: row }));
      root.append(negotiation);
      const witnesses = limitWitnesses(view, row);
      if (witnesses) root.append(witnesses);
    });
  } else if (selected.kind === "workload") {
    const workload = view.workloads.find(w => w.id === selected.id);
    if (!workload) return;
    const { row } = workload;
    const outcome = result.outcomes[row]!;
    root.append(el("h3", workload.name + " · " + workload.id), el("p", `${workload.verdict ? verdictText[workload.verdict] : "단독량"} · ${workload.summary}`));
    if (workload.measures.length) {
      const measures = workload.measures.map(m => `${m.kind === "netCharge" ? "순충전" : m.kind} ${interval(m, m.unit)}`);
      list(root, "충전 지표", [`전달 ${workload.summary}`, ...measures]);
    }
    const bindings = result.bindings.filter(b => b.scenario === outcome.scenario && b.workload === outcome.subjectRow && b.run === view.run);
    list(root, "병목 자원", bindings.map(b => resourceName(scene, result, b.resourceKind, b.resource)));
    outcomeNotes(root, result, [row], view.run);
    root.append(el("h4", "판정 근거"), tree(view, { outcome: row }));
  } else if (selected.kind === "resource") {
    const resource = view.resources[selected.row];
    if (!resource) return;
    const { used, capacity, unit, label } = resource;
    root.append(el("h3", label), el("p", `동시 사용 ${quantity(used, unit)} / 용량 ${quantity(capacity, unit)}${resource.basis === "assumed" ? " · 가정" : ""}`));
    const occupancy = el("meter");
    occupancy.setAttribute("aria-label", "자원 사용량");
    occupancy.max = capacity && capacity > 0 ? capacity : 1;
    occupancy.value = used ?? 0;
    occupancy.className = "resource-meter";
    if (capacity === null || used === null) {
      const unknown = el("div", "미확인");
      unknown.className = "resource-meter-unknown";
      root.append(unknown);
    } else root.append(occupancy);
    const bindings = result.bindings.filter(b => b.scenario === resource.scenario && b.resourceKind === resource.resourceKind &&
      b.resource === resource.resource && b.run === "together");
    list(root, "병목인 작업", bindings.map(b => scene.workloads[b.workload]!.id));
    const outcomes = new Set(resource.reasonRows.map(row => result.reasons[row]!.outcome));
    for (const b of bindings) {
      for (const w of view.workloads) if (result.outcomes[w.row]!.subjectRow === b.workload) outcomes.add(w.row);
    }
    outcomeNotes(root, result, [...outcomes]);
    root.append(el("h4", "배분 근거"), tree(view, { reasons: resource.reasonRows }));
  }
}

export function mountEvidence(root: HTMLElement, change: {
  run: (run: Run) => void; variant: (index: number) => void; loadVariants: () => Promise<Variants>;
}) {
  const heading = el("div");
  heading.className = "results-heading";
  const close = el("button", "닫기");
  close.type = "button";
  close.addEventListener("click", () => { root.hidden = true; });
  heading.append(el("h2", "결과 · 왜?"), close);
  const controls = el("div");
  controls.className = "results-controls";
  const run = el("select");
  run.setAttribute("aria-label", "표시할 성능");
  const together = el("option", "동시"), solo = el("option", "단독");
  together.value = "together"; solo.value = "solo";
  run.append(together, solo);
  run.addEventListener("change", () => change.run(run.value === "solo" ? "solo" : "together"));
  const alternatives = el("details");
  alternatives.append(el("summary", "다른 설정"));
  const choices = el("div");
  choices.className = "variant-options";
  alternatives.append(choices);
  alternatives.addEventListener("toggle", () => {
    const view = current;
    if (!alternatives.open || !view) return;
    choices.replaceChildren(el("p", "다른 설정을 계산 중입니다."));
    void change.loadVariants().then(results => {
      if (current?.scene !== view.scene || current?.scenario !== view.scenario) return;
      readyVariants = results;
      renderChoices(current, readyVariants, variant);
    }, (error: unknown) => {
      if (!(error instanceof Error)) throw error;
      if (current?.scene === view.scene && current.scenario === view.scenario)
        choices.replaceChildren(el("p", error.message));
    });
  });
  controls.append(run, alternatives);
  const content = el("div");
  const info = el("section");
  info.className = "selected-evidence";
  info.setAttribute("aria-label", "선택한 항목 근거");
  root.append(heading, controls, content, info);

  let current: ResultView | undefined;
  let selection: Selection | undefined;
  let variant = 0;
  let readyVariants: Variants = [];

  function renderChoices(view: ResultView, variants: Variants, index: number) {
    choices.replaceChildren();
    if (variants.length < 2) { choices.append(el("p", "확인된 대안이 없습니다.")); return; }
    variants.forEach(({ choices: entries, result }, i) => {
      const names = entries.map(c => `${view.scene.connections[c.connection]!.id} ${c.profile}`);
      const labels = result.outcomes.filter(o => o.subjectKind === "workload" && o.scenario === view.scenario).map(o => o.label);
      const name = [i === 0 ? "기본" : `대안 ${i}`, ...names, ...labels].join(" · ");
      const option = el("button", name);
      option.type = "button";
      option.setAttribute("aria-pressed", String(i === index));
      option.addEventListener("click", () => change.variant(i));
      choices.append(option);
    });
  }

  function show() {
    if (!current) return;
    content.replaceChildren();
    const view = current;
    const lists = [
      { name: "작업", rows: view.workloads.map(w => ({ text: `${w.name} · ${w.summary}`, key: { kind: "workload", id: w.id } as const })) },
      { name: "자원", rows: view.resources.map((r, row) => ({ text: `${r.label} · ${quantity(r.used, r.unit)} / ${quantity(r.capacity, r.unit)}`, key: { kind: "resource", row } as const })) },
    ];
    for (const list of lists) {
      if (!list.rows.length) continue;
      const group = el("details");
      group.className = "result-list";
      group.open = list.name === "작업" || selection?.kind === "resource";
      group.append(el("summary", `${list.name} ${list.rows.length}개`));
      for (const { text, key } of list.rows) {
        const button = el("button", text);
        button.type = "button";
        button.setAttribute("aria-pressed", String(key.kind === "workload" ? selection?.kind === key.kind && selection.id === key.id
          : selection?.kind === key.kind && selection.row === key.row));
        button.addEventListener("click", () => choose(key));
        group.append(button);
      }
      content.append(group);
    }
    info.replaceChildren();
    if (selection) detail(info, view, selection);
    if (!info.childElementCount) info.append(el("p", "선, 작업 또는 자원을 선택하세요."));
  }

  function choose(next: Selection) {
    selection = next;
    if (root.hidden && current) renderChoices(current, readyVariants, variant);
    root.hidden = false;
    show();
    root.scrollTop = Math.max(0, info.offsetTop - heading.offsetHeight);
  }

  return {
    toggle() {
      root.hidden = !root.hidden;
      if (!root.hidden && current) {
        renderChoices(current, readyVariants, variant);
        show();
      }
    },
    choose,
    render(view: ResultView | undefined, variants: Variants, index: number, preserveSelection: boolean) {
      if (!preserveSelection || selection?.kind === "resource") selection = undefined;
      if (!preserveSelection || current?.scene !== view?.scene || current?.scenario !== view?.scenario) alternatives.open = false;
      current = view;
      variant = index;
      readyVariants = variants;
      run.value = view?.run ?? "together";
      if (view && !root.hidden) {
        renderChoices(view, variants, index);
        show();
      }
    },
  };
}
