// 시나리오 목표를 편집하고 엔진의 판정·작업 근거와 구매 장부의 예산 상태를 보여준다.
import { plugins } from "../domains/registry.ts";
import { scenarioName } from "../scene/files.ts";
import type { PriceBook } from "../server/prices.ts";
import { calculateBudget } from "./budget.ts";
import type { SceneDocument } from "./document.ts";
import { interval, verdictText as workVerdict, type ResultView } from "./results.ts";
import { hasUnsteppedNumber } from "./field.ts";
import { claimQuest } from "./quests.ts";

type Scenario = SceneDocument["scenarios"][number];
type Goal = NonNullable<Scenario["goals"]>[number];
type State = { doc: SceneDocument; id: string | null; view: ResultView | undefined };
const verdictText = { ok:"✅ 달성", impossible:"❌ 미달", unknown:"❓ 미확인" };
const kinds = {metric:"수치 하한", workload:"작업 성립", scenario:"모든 작업 성립", port:"포트 하나로"};
const runs = {solo:"단독",together:"동시"};

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text = "") {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}

function button(text: string, click: () => void) {
  const b = element("button",text);
  b.type = "button"; b.onclick = click;
  return b;
}

function label(parent: HTMLElement, title: string, control: HTMLElement) {
  const l = element("label",title);
  control.setAttribute("aria-label",title);
  l.append(control); parent.append(l);
}

function measureChoices(view: ResultView, id: string) {
  const w = view.scene.workloads.findIndex(w => w.id === id);
  const units = new Set(view.result.demands.filter(d => d.workload === w && d.unit).map(d => d.unit));
  const plugin = plugins.find(p => p.id === view.scene.workloads[w]?.domain);
  return [...[...units].map(unit => ({kind:"delivery",label:"전달량",unit,domain:undefined})),
    ...(plugin?.goalMeasures ?? []).map(m => ({...m,domain:plugin!.id}))];
}

export function mountGoals(root: HTMLElement, state: () => State,
  edit: ((doc: SceneDocument, id: string) => boolean) | undefined, inspect: (id: string, run: "solo" | "together") => void,
  openQuest?: (claim:number)=>void) {
  const dialog = element("dialog");
  dialog.className = "creator goals-dialog";
  dialog.setAttribute("aria-label","목표 체크리스트");
  dialog.innerHTML = `<style>
    .goals-dialog {width:min(38rem,94vw);max-height:90dvh;overflow:auto;font-size:14px}
    .goals-dialog .creator-body {display:grid;gap:.8rem}
    .goals-dialog article {border-top:1px solid var(--line);padding:.65rem 0}
    .goals-dialog :is(h3,p,ul) {margin:.3rem 0}
    .goals-dialog button {margin-inline-end:.4rem;padding:.27rem .55rem;background:white;border:1px solid var(--line);border-radius:5px;color:inherit}
    .goals-dialog button:hover,.goals-dialog button:focus-visible {border-color:var(--accent)}
    .goals-dialog form:empty,.goals-dialog [role=alert]:empty {display:none}
    .goals-dialog form:not(:empty),.goals-dialog .fields {display:grid;gap:.6rem}
    .goals-dialog label {display:grid;gap:.2rem}
    .goals-dialog fieldset label {display:inline-flex;align-items:center;margin-right:.6rem}
    .goals-dialog :is(input:not([type=checkbox]),select) {padding:.35rem;min-width:0}
  </style><header><h2>목표 체크리스트</h2><button type="button">닫기</button></header>
  <div class="creator-body"><strong></strong><div class="goal-budget" aria-live="polite"></div><section></section><div class="actions"></div><form></form><p role="alert"></p></div>`;
  root.append(dialog);
  dialog.querySelector("header button")!.addEventListener("click",()=>dialog.close());
  const list = dialog.querySelector("section")!, form = dialog.querySelector("form")!;
  const error = dialog.querySelector<HTMLElement>("[role=alert]")!;
  const budgetRow = dialog.querySelector<HTMLElement>(".goal-budget")!;
  let scenarioId: string | null = null;
  let book: PriceBook | undefined, priceState: "idle" | "loading" | "error" = "idle";
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let opening = 0;

  function scenario() {
    const {doc,id} = state();
    return doc.scenarios.find(s => s.id === id);
  }
  function showBudget(s: Scenario) {
    clearTimeout(expiry);
    if (s.budget === undefined) { budgetRow.textContent = "상품 예산 상한 미설정"; return; }
    if (!book) {
      budgetRow.textContent = priceState === "error" ? "❓ 상품 예산 · 가격 장부를 읽지 못했습니다." : "상품 예산 확인 중…";
      if (priceState === "idle") {
        const token = opening;
        priceState = "loading";
        void fetch("/api/prices").then(async reply=>{
          if (!reply.ok) throw new Error(String(reply.status));
          return await reply.json() as PriceBook;
        }).then(value=>{if (token===opening) {book=value;refresh();}},
          ()=>{if (token===opening) {priceState="error";refresh();}});
      }
      return;
    }
    const {doc,view} = state();
    const b = calculateBudget(s,doc.items,book,view);
    const text = {within:"✅ 예산 이내",over:"❌ 예산 초과",unknown:"❓ 예산 충족 여부 미확인",unset:"상한 미설정"};
    budgetRow.textContent = text[b.limitStatus as keyof typeof text] + " · 상품 예산 $" + s.budget;
    const ends = b.lines.flatMap(l=>l.quote?.expiresAt ? [Date.parse(l.quote.expiresAt)] : []).filter(t=>t>Date.now());
    if (ends.length) expiry = setTimeout(refresh, Math.min(...ends)-Date.now());
  }
  function save(s: Scenario, goals: Goal[]) {
    const {doc} = state();
    if (!edit?.({...doc,scenarios:doc.scenarios.map(row => row.id === s.id ? {...row,goals} : row)},s.id)) {
      error.textContent = "목표를 저장할 수 없습니다. 선택한 작업과 지표를 확인하세요.";
      return;
    }
    form.replaceChildren(); error.textContent = ""; refresh();
  }
  function editor(original?: Goal) {
    const s = scenario(), view = state().view;
    if (!s || !view) return;
    form.replaceChildren(); error.textContent = "";
    const name = element("input"); name.required = true; name.value = original?.label ?? original?.id ?? "";
    label(form,"목표 이름",name);
    const kind = element("select");
    for (const [value,text] of Object.entries(kinds)) kind.add(new Option(text,value));
    kind.value = original?.kind ?? "metric"; label(form,"목표 종류",kind);
    const fields = element("div"); fields.className = "fields"; form.append(fields);
    function build() {
      fields.replaceChildren();
      let selected = original && "workloads" in original ? [...original.workloads] : [];
      const members = s!.members.map(m => typeof m === "string" ? m : m.workload);
      const work = element("select"), run = element("select"), measure = element("select");
      const minimum = element("input"), item = element("select"), port = element("select");
      let measures: ReturnType<typeof measureChoices> = [];
      function updateMeasures() {
        const previous = measures[measure.selectedIndex] ?? (original?.kind === "metric" ? {kind:original.metric,unit:original.unit,
          domain:original.metricDomain ?? (original.metric !== "delivery" ? view!.scene.workloads.find(w => w.id === original.workloads[0])?.domain : undefined)} : undefined);
        measures = selected.length ? measureChoices(view!,selected[0]!).filter(m =>
          selected.slice(1).every(id => measureChoices(view!,id).some(other => other.domain===m.domain && other.kind===m.kind && other.unit===m.unit))) : [];
        measure.replaceChildren(...measures.map((m,i)=>new Option(m.label + " (" + m.unit + ")",String(i))));
        const index = measures.findIndex(m=>m.kind === previous?.kind && m.unit === previous.unit && m.domain === previous.domain);
        if (index >= 0) measure.selectedIndex = index;
      }
      if (kind.value === "workload") {
        for (const id of members) work.add(new Option(id,id));
        if (original?.kind === "workload") work.value = original.workload;
        work.required = true; label(fields,"작업",work);
      } else if (kind.value === "metric" || kind.value === "port") {
        const box = element("fieldset"); box.append(element("legend","함께 확인할 작업"));
        for (const id of members) {
          const check = element("input"); check.type = "checkbox"; check.value = id; check.checked = selected.includes(id);
          label(box,id,check);
        }
        box.onchange = () => {
          selected = [...box.querySelectorAll<HTMLInputElement>(":checked")].map(c=>c.value);
          updateMeasures();
        };
        fields.append(box);
      }
      if (kind.value === "metric") {
        for (const [value,text] of Object.entries(runs)) run.add(new Option(text,value));
        run.value = original?.kind === "metric" ? original.run : "together";
        label(fields,"평가 시점",run);
        updateMeasures(); measure.required = true; label(fields,"지표와 단위",measure);
        minimum.type = "number"; minimum.step = "any"; minimum.required = true;
        minimum.value = original?.kind === "metric" ? String(original.minimum) : "";
        label(fields,"하한",minimum);
      } else if (kind.value === "port") {
        for (const it of state().doc.items) item.add(new Option(it.alias || it.instanceId,it.instanceId));
        if (original?.kind === "port") item.value = original.instanceId;
        function ports() {
          port.replaceChildren(new Option("어느 포트든 하나",""));
          for (const p of view!.scene.ports) if (view!.scene.items[p.item]!.id === item.value) port.add(new Option(p.label || p.id,p.id));
        }
        ports(); item.onchange = ports;
        if (original?.kind === "port") port.value = original.portId ?? "";
        label(fields,"기준 실물",item); label(fields,"포트",port);
      }
      form.onsubmit = ev => {
        ev.preventDefault();
        const current = scenario();
        if (!current || current.id !== s!.id) return;
        const base = {id:original?.id ?? crypto.randomUUID(),label:name.value.trim()};
        if (!base.label) {error.textContent="목표 이름을 입력하세요."; return;}
        let goal: Goal;
        if (kind.value === "scenario") goal = {...base,kind:"scenario"};
        else if (kind.value === "workload") goal = {...base,kind:"workload",workload:work.value};
        else {
          if (!selected.length) {error.textContent="작업을 하나 이상 선택하세요."; return;}
          if (kind.value === "port") goal = {...base,kind:"port",workloads:selected,instanceId:item.value,...(port.value && {portId:port.value})};
          else {
            const m = measures[measure.selectedIndex];
            if (!m) {error.textContent="선택한 작업에 공통인 지표가 없습니다."; return;}
            goal = {...base,kind:"metric",workloads:selected,run:run.value === "solo" ? "solo" : "together",metric:m.kind,
              ...(m.domain && {metricDomain:m.domain}),unit:m.unit,minimum:minimum.valueAsNumber};
          }
        }
        const rows = current.goals ?? [];
        save(current,original ? rows.map(g=>g.id===original.id ? goal : g) : [...rows,goal]);
      };
    }
    kind.onchange = build; build();
    const submit = element("button","목표 저장"); submit.type = "submit";
    form.append(submit,button("취소",()=>{form.replaceChildren();error.textContent="";}));
    name.focus();
  }
  function refresh() {
    if (!dialog.open) return;
    const s = scenario(), {view} = state();
    if (scenarioId !== s?.id) form.replaceChildren();
    scenarioId = s?.id ?? null;
    list.replaceChildren();
    dialog.querySelector("strong")!.textContent = s ? scenarioName(s) : "시나리오 없음";
    const actions = dialog.querySelector(".actions")!; actions.replaceChildren();
    if (!s) {budgetRow.textContent="";return;}
    showBudget(s);
    if (edit && view) actions.append(button("목표 추가",()=>editor()));
    if (!s.goals?.length) list.append(element("p","등록한 목표가 없습니다."));
    for (const g of s.goals ?? []) {
      const row = element("article");
      const result = view?.result, idx = result?.goals.findIndex(o=>o.scenario===view!.scenario && o.id===g.id) ?? -1;
      const outcome = result?.goals[idx];
      row.append(element("h3",g.label ?? g.id));
      const m = g.kind === "metric" && view ? measureChoices(view,g.workloads[0]!).find(m=>m.kind===g.metric && m.unit===g.unit) : undefined;
      const item = g.kind === "port" ? view?.scene.items.find(i=>i.id===g.instanceId) : undefined;
      const title = g.kind === "metric" ? runs[g.run] + " " + (m?.label ?? g.metric) + " ≥ " + g.minimum + " " + g.unit
        : g.kind === "port" ? (item?.alias || (item && view?.scene.models[item.model]?.name) || g.instanceId) + " · " +
          (g.portId ? "포트 " + g.portId : "어느 포트든 하나") : kinds[g.kind];
      row.append(element("p",(outcome ? verdictText[outcome.verdict] : "판정 중…") + " · " + title));
      if (outcome?.truncated && view) {
        const claimRow=(claim:number, cause:"limit"|"open")=>{
          const q=claimQuest(view,claim), name=[q.subject,q.template?.title ?? q.property?.title ?? q.title].filter(Boolean).join(" · ");
          const li=element("li",name);
          if (cause==="open") li.append(hasUnsteppedNumber(q.property)
            ? " 값은 규격 걸음이 없어 모든 값을 확인할 수 없습니다." : "의 가능한 값을 모두 확인할 수 없습니다.");
          if (openQuest) {
            const verify=button("확인 퀘스트 열기",()=>{dialog.close();openQuest(claim);});
            verify.setAttribute("aria-label",name+" 확인 퀘스트 열기");
            li.append(" ",verify);
          }
          return li;
        };
        if (outcome.limitClaims) {
          row.append(element("p","후보 조합 수가 검산 상한을 넘었습니다."));
          if (outcome.limitClaims.length) {
            const details=element("details"), claims=element("ul");
            details.append(element("summary","조합을 이루는 주장 "+outcome.limitClaims.length+"개"),claims);
            claims.append(...outcome.limitClaims.map(claim=>claimRow(claim,"limit")));
            row.append(details);
          }
        }
        if (outcome.openClaims?.length) {
          const claims=element("ul");
          claims.append(...outcome.openClaims.map(claim=>claimRow(claim,"open")));
          row.append(claims);
        }
        if (!outcome.limitClaims && !outcome.openClaims?.length)
          row.append(element("p","전달량이 범위로만 알려져 이 목표를 판정할 수 없습니다."));
      } else if (outcome?.combined) {
        const why = {ok:"모든 후보에서 지정한 작업이 함께 목표를 달성합니다.",
          impossible:"지정한 작업이 함께 목표를 달성하는 후보가 없습니다.",unknown:"후보에 따라 달라지거나 아직 확인할 값이 있습니다."};
        row.append(element("p",why[outcome.verdict]));
      }
      const checks = element("ul");
      const evidence = result?.goalEvidence.filter(e=>e.goal===idx) ?? [];
      if (outcome && !evidence.length) row.append(element("p","확인할 시나리오 작업이 없습니다."));
      for (const e of evidence) {
        const id = view!.scene.workloads[e.workload]?.id ?? String(e.workload);
        if (e.issue === "notMember") {checks.append(element("li",id + " · 시나리오에서 빠진 작업")); continue;}
        const technical = result!.outcomes[e.outcome];
        const info = g.kind === "metric" ? interval(e,g.unit) : g.kind !== "port" ? (technical ? workVerdict[technical.verdict] : "작업 결과 없음") :
          e.connections.map(c=>{
            const link = view!.scene.connections[c]!;
            const ports = e.portVisits?.filter(v => v.connection === c).map(v => view!.scene.ports[v.port]!.id) ?? [];
            return "포트 " + ports.join(" ↔ ") + " · 연결 " + link.id;
          }).join(" · ") || "확인된 연결 없음";
        const li = element("li",id + " · " + info + " ");
        li.append(button("작업 근거 · " + id,()=>{dialog.close();inspect(id,g.kind==="metric" ? g.run : "together");})); checks.append(li);
      }
      row.append(checks);
      if (outcome?.combined && view) {
        for (const w of result!.goalWitnesses.filter(w => w.goal === idx)) {
          const settings = w.assignments.map(a => view.scene.claims[a.claim]!.field + "=" + a.value).join(", ");
          const failure = view.scene.workloads[w.workload]!.id + (g.kind === "metric" && w.high !== null ? " ≤ " + w.high + " " + g.unit : "");
          row.append(element("p","미달 후보 " + (w.world+1) + " (" + settings + ") · " + failure));
        }
        const claims = new Set(evidence.flatMap(e=>e.claims));
        const sources = new Set(view.scene.claimSources.filter(s=>claims.has(s.claim)).map(s=>s.source));
        const details = element("details"); details.append(element("summary","후보 판정의 출처"));
        const refs = element("ul");
        for (const i of sources) {
          const s = view.scene.sources[i]!;
          refs.append(element("li",s.title + " · " + s.locator));
        }
        details.append(refs); if (sources.size) row.append(details);
      }
      if (edit) row.append(button("편집",()=>editor(g)),button("삭제",()=>save(s,s.goals!.filter(other=>other.id!==g.id))));
      list.append(row);
    }
  }
  function open() {
    ++opening;
    book=undefined; priceState="idle"; form.replaceChildren(); error.textContent="";
    dialog.showModal(); refresh();
  }
  const trigger = button("목표 체크리스트",open);
  dialog.onclose=()=>{++opening;clearTimeout(expiry);};
  root.querySelector(".view-controls")!.append(trigger);
  return {refresh,edit(id: string) {
    const goal = scenario()?.goals?.find(g => g.id === id);
    if (goal) {open(); editor(goal);}
  }};
}
