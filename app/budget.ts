// 시나리오 구매 목록을 판매 단위로 합산하고 같은 미확인 구매를 상쇄해 가격 차이를 구한다.
import type { PriceBook, ProductRef, Quote } from "../server/prices.ts";
import { compare, type Snapshot } from "../engine/compare.ts";
import { evaluateInWorker, loadAssessment, type Documents } from "./assessment.ts";
import { modelKey, type Item, type Library, type SceneDocument } from "./document.ts";
import { interval, verdictText, type ResultView } from "./results.ts";

type Scenario = SceneDocument["scenarios"][number];
type Purchase = NonNullable<Scenario["purchases"]>[number];
interface BudgetLine {
  key: string; modelRef: string; product?: ProductRef | undefined; quantity: bigint; quote?: Quote | undefined;
  instances: string[]; skippedSellers: string[]; packs: bigint; cents: bigint | null;
}
const priceKey = (model: string, ref?: ProductRef) => JSON.stringify([model, ref?.seller, ref?.productId, ref?.saleUnit]);
const packPrice = (q: Quote) => BigInt(q.unitPriceCents) - BigInt(q.discountCents ?? 0);
const packCount = (units: bigint, q: Quote) => (units + BigInt(q.saleUnit) - 1n) / BigInt(q.saleUnit);
function dollarsToCents(amount: number) {
  const [dollars, fraction = ""] = String(amount).split(".");
  return BigInt(dollars!) * 100n + BigInt(fraction.padEnd(2,"0"));
}

export function calculateBudget(scenario: Scenario, items: readonly Item[], book: PriceBook) {
  const grouped = new Map<string, BudgetLine>();
  const owned: string[] = [];
  const seen = new Set<string>();
  for (const row of scenario.purchases ?? []) {
    let model: string, quantity: number, product: ProductRef | undefined;
    if ("instanceId" in row || "ownedInstanceId" in row) {
      const id = "instanceId" in row ? row.instanceId : row.ownedInstanceId;
      if (seen.has(id)) continue;
      seen.add(id);
      const item = items.find(i => i.instanceId === id);
      if ("ownedInstanceId" in row || item!.state === "owned") { owned.push(id); continue; }
      model = modelKey(item!);
      quantity = 1;
    } else {
      model = row.modelRef;
      quantity = row.quantity;
      product = row.product;
    }
    const key = priceKey(model, product);
    const line = grouped.get(key) ?? {key, modelRef:model, product, quantity:0n, instances:[], skippedSellers:[], packs:0n, cents:null};
    line.quantity += BigInt(quantity);
    if ("instanceId" in row) line.instances.push(row.instanceId);
    grouped.set(key,line);
  }
  const current = new Map<string, Quote>();
  for (const q of book.quotes) {
    if (q.purchasedAt) continue;
    const key = priceKey(q.modelRef,q);
    const previous = current.get(key);
    if (!previous || Date.parse(previous.retrievedAt) <= Date.parse(q.retrievedAt)) current.set(key,q);
  }
  const rank = (q: Quote) => {
    const index = book.preferredSellers.indexOf(q.seller);
    return index < 0 ? book.preferredSellers.length : index;
  };
  const ordered = new Map<string, BudgetLine>();
  for (const line of grouped.values()) {
    const offers = [...current.values()].filter(q => q.modelRef === line.modelRef &&
      (!line.product || priceKey(q.modelRef,q) === line.key));
    const cost = (q: Quote) => packCount(line.quantity, q) * packPrice(q);
    const chosen = offers.filter(q => q.stock === "in").sort((a,b) => rank(a) - rank(b) || Number(cost(a) - cost(b))
      || a.seller.localeCompare(b.seller) || a.productId.localeCompare(b.productId))[0];
    line.skippedSellers = book.preferredSellers.filter((seller, i) => (!chosen || i < rank(chosen))
      && offers.some(q => q.seller === seller && q.stock === "out") && !offers.some(q => q.seller === seller && q.stock !== "out"));
    line.quote = chosen;
    const key = chosen ? priceKey(line.modelRef, chosen) : line.key;
    const prior = ordered.get(key);
    if (prior) {
      prior.quantity += line.quantity;
      prior.instances.push(...line.instances);
      prior.skippedSellers = [...new Set([...prior.skippedSellers, ...line.skippedSellers])];
    } else ordered.set(key,line);
  }
  const lines = [...ordered.values()];
  let subtotalCents = 0n, unknownCount = 0n;
  for (const line of lines) {
    if (!line.quote) { unknownCount += line.quantity; continue; }
    line.packs = packCount(line.quantity,line.quote);
    line.cents = line.packs * packPrice(line.quote);
    subtotalCents += line.cents;
  }
  const limitCents = scenario.budget === undefined ? null : dollarsToCents(scenario.budget);
  const limitStatus = limitCents === null ? "unset" : subtotalCents > limitCents ? "over" : unknownCount ? "unknown" : "within";
  return { lines, owned, subtotalCents, unknownCount, limitCents, limitStatus };
}

type Budget = ReturnType<typeof calculateBudget>;
export function compareBudgets(before: Budget, after: Budget) {
  const unknown = new Map<string, bigint>();
  for (const line of before.lines) if (line.cents === null) unknown.set(line.key, line.quantity);
  for (const line of after.lines) if (line.cents === null) unknown.set(line.key, (unknown.get(line.key) ?? 0n) - line.quantity);
  if ([...unknown.values()].some(quantity => quantity !== 0n)) return null;
  return after.subtotalCents - before.subtotalCents;
}

// 수동 견적은 조회 후 30일이 지나면 오래된 값으로 표시한다.
const STALE_DAYS = 30;
const money = new Intl.NumberFormat("en-US", {style:"currency",currency:"USD",minimumFractionDigits:0,maximumFractionDigits:0});
function usd(cents: bigint | number) {
  const amount = BigInt(cents);
  return money.format(amount / 100n) + "." + String(amount % 100n).padStart(2,"0");
}
const difference = (cents: bigint | null) => cents === null ? "미확인" :
  cents < 0n ? "−" + usd(-cents) : (cents > 0n ? "+" : "") + usd(cents);
function el<K extends keyof HTMLElementTagNameMap>(tag: K, text: string) {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}
function purchaseName(row: Purchase) {
  if ("instanceId" in row) return row.instanceId;
  if ("ownedInstanceId" in row) return "보유 · " + row.ownedInstanceId;
  return (row.product ? productName(row.product) : row.modelRef) + " × " + row.quantity;
}
function productName(ref: ProductRef) {
  return ref.seller + " / " + ref.productId + (ref.saleUnit > 1 ? " (" + ref.saleUnit + "개 묶음)" : "");
}
async function json<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, body === undefined ? {} : {method:"PUT",
    headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  if (!response.ok) throw new Error((await response.json()).message ?? "가격 정보를 읽을 수 없습니다.");
  return await response.json() as T;
}

// 선택한 시나리오만 평가한다. 서로 다른 장면에서 고른 두 시나리오는 비교 키에서 같은 자리다.
async function comparisonSnapshot(doc: SceneDocument, scenario: Scenario, documents: Documents): Promise<Snapshot> {
  const selected = {...doc, scenarios:[{...scenario,id:"선택한 시나리오"}]};
  const loaded = loadAssessment(selected, documents, null);
  if ("error" in loaded) throw new Error(loaded.error);
  const reply = await evaluateInWorker({}, {kind:"primary",document:selected,documents});
  if (reply?.kind !== "primary") throw new Error(reply?.kind === "error" ? reply.message : "비교할 판정을 읽을 수 없습니다.");
  return {scene:loaded.scene,result:reply.result};
}
function technicalValue(snapshot: Snapshot, row: number | null) {
  if (row === null) return "없음";
  const {result} = snapshot, o = result.outcomes[row]!;
  const m = result.metrics.find(m => m.outcome === row && m.kind === (o.subjectKind === "connection" ? "limit" : "together"));
  return [verdictText[o.verdict], o.label || o.mode, m && interval(m,m.unit)].filter(Boolean).join(" · ");
}

type BudgetState = {doc: SceneDocument; id: string | null; view: ResultView | undefined};
export function mountBudget(root: HTMLElement, library: Library, documents: Documents,
  state: () => BudgetState, edit: (next: SceneDocument, scenarioId: string) => boolean, inspectConnection: (id: string) => void) {
  const open = el("button","구매 예산");
  open.type = "button";
  root.querySelector(".view-controls")!.append(open);
  let refresh: (() => void) | undefined;
  open.onclick = () => {
    const dialog = document.createElement("dialog");
    dialog.className = "creator budget-dialog";
    dialog.setAttribute("aria-label","구매 예산");
    dialog.innerHTML = `
      <style>
        .budget-dialog {font-size:14px;line-height:1.5;width:min(48rem,96vw);max-height:90dvh;overflow:auto}
        .budget-dialog .creator-body {gap:8px}.budget-dialog h3,.budget-dialog p,.budget-dialog ul {margin:3px 0}
        .budget-dialog .budget-total {font-size:1.35rem;color:#184f48}.budget-dialog .over {color:#993c22}
        .budget-dialog label {display:grid;gap:2px;font-size:12px}.budget-dialog input,.budget-dialog select,.budget-dialog button {font:inherit;max-width:100%;min-width:0;padding:5px}
        .budget-dialog form {display:flex;gap:8px;flex-wrap:wrap;align-items:end;margin:8px 0}.budget-dialog form label {flex:1 1 135px}
        .budget-dialog ul {padding-left:1.3rem}.budget-dialog li {margin:4px 0;overflow-wrap:anywhere}.budget-dialog li button {margin-left:.5rem}
        .budget-dialog .old {color:#566663}.budget-dialog .budget-note {color:#46625c}.budget-dialog .compare-result {border-top:1px solid #cdd9d5;padding-top:6px}
        .budget-dialog .compare-result:empty,.budget-dialog [role=status]:empty {display:none}.budget-dialog [role=status] {color:#164c45}
      </style>
      <header><h2>구매 예산</h2><button type="button" class="dismiss">닫기</button></header>
      <div class="creator-body"><section class="totals" aria-live="polite"></section>
      <details><summary>구매 목록 편집</summary><ul class="purchases"></ul>
        <form class="add"><label>구매할 항목<select name="item" required></select></label>
        <label>구매 수량 (낱개)<input name="quantity" type="number" value="1" min="1" step="1" required></label>
        <label>관련 결합 형태<select name="need"></select></label><button>목록에 추가</button></form>
        <form class="cap"><label>상품 예산 상한 (USD)<input name="limit" type="number" min="0" step="0.01"></label><button>상한 저장</button></form>
      </details><div class="needs"></div>
      <details><summary>수동 견적 입력</summary>
        <form class="quote"><label>견적 모델<select name="modelRef" required></select></label>
        <label>판매처<input name="seller" required></label><label>상품 번호<input name="productId" required></label>
        <label>판매 단가 (USD)<input name="price" type="number" min="0" step="0.01" required></label>
        <label>한 묶음의 개수<input name="saleUnit" type="number" min="1" step="1" value="1" required></label>
        <label>재고<select name="stock"><option value="in">재고 있음</option><option value="out">품절</option><option value="unknown">미확인</option></select></label>
        <label>조회 시각<input name="time" type="datetime-local" required></label><label>출처<input name="source" value="사용자 수동 입력" required></label>
        <label>상품 URL<input name="url" type="url"></label><label>쿠폰 조건<input name="coupon"></label>
        <label>묶음당 확인된 할인 (USD)<input name="discount" type="number" min="0" step="0.01"></label>
        <button>견적 저장</button></form><ul class="quotes"></ul>
      </details>
      <details><summary>판매처 우선순위</summary><form class="prefer"><label>판매처 (한 줄에 하나씩, 위에서부터 우선)<textarea name="sellers" rows="3"></textarea></label><button>우선순위 저장</button></form></details>
      <details class="comparison"><summary>로드아웃 비교</summary>
        <form class="compare"><label>비교할 장면<select name="scene"></select></label>
        <label>비교할 시나리오<select name="scenario" required></select></label><button>두 구성 비교</button></form>
        <div class="compare-result" aria-live="polite"></div>
      </details><p role="status"></p></div>`;
    const get = <T extends HTMLElement = HTMLElement>(selector: string) => dialog.querySelector<T>(selector)!;
    const status = get("[role=status]");
    const select = (name: string) => get<HTMLSelectElement>(`select[name="${name}"]`);
    const input = (name: string) => get<HTMLInputElement>(`input[name="${name}"]`);
    const text = (name: string) => input(name).value.trim();
    const report = (error: unknown) => { status.textContent = error instanceof Error ? error.message : String(error); };
    const now = new Date();
    input("time").value = new Date(now.getTime() - now.getTimezoneOffset()*60000).toISOString().slice(0,16);
    get(".dismiss").onclick = () => dialog.close();
    root.append(dialog);
    dialog.showModal();
    dialog.onclose = () => { refresh = undefined; dialog.remove(); };
    let book: PriceBook | undefined;
    let choices: Purchase[] = [];
    let requirements: NonNullable<Purchase["need"]>[] = [];
    const chosen = () => {
      const {doc,id} = state();
      return doc.scenarios.find(s => s.id === id);
    };
    const sceneSelect = select("scene"), scenarioSelect = select("scenario");
    let otherDoc: SceneDocument | undefined;
    let otherDocuments = documents;
    let comparisonVersion = 0;
    const comparison = get(".compare-result");
    function invalidateComparison() { comparisonVersion++; comparison.replaceChildren(); }

    function quoteDetail(q: Quote) {
      const old = Date.now() - Date.parse(q.retrievedAt) >= STALE_DAYS * 86400000;
      const detail = el("small", [q.seller + " / " + q.productId, usd(q.unitPriceCents) + " / " + q.saleUnit + "개",
        q.stock === "in" ? "재고 있음" : q.stock === "out" ? "품절" : "재고 미확인", q.source,
        new Date(q.retrievedAt).toLocaleString("ko-KR"), old && "오래된 견적", q.coupon, q.discountCents && "적용 할인 " + usd(q.discountCents)].filter(Boolean).join(" · "));
      if (old) detail.className = "old";
      if (q.url) {
        const link = el("a","상품 링크");
        link.href = q.url; link.target = "_blank"; link.rel = "noreferrer";
        detail.append(" · ",link);
      }
      return detail;
    }
    function updateScenario(row: Scenario) {
      const {doc,id} = state();
      const index = doc.scenarios.findIndex(s => s.id === id);
      if (index < 0 || row.id !== id || !edit({...doc,scenarios:doc.scenarios.with(index,row)},row.id))
        throw new Error("시나리오에 예산을 적용할 수 없습니다.");
      render();
    }
    function optionRows() {
      const {doc} = state(), picker = select("item");
      const previous = JSON.stringify(choices[picker.selectedIndex]);
      choices = [];
      picker.replaceChildren();
      function add(row: Purchase, label: string) {
        picker.add(new Option(label,String(choices.length)));
        choices.push(row);
      }
      for (const i of doc.items) add({instanceId:i.instanceId}, (i.state === "owned" ? "보유" : "실물") + " · " + (i.alias || i.instanceId) + " / " + i.instanceId);
      for (const i of library.inventory) if (i.state === "owned" && !doc.items.some(item => item.instanceId === i.instanceId))
        add({ownedInstanceId:i.instanceId,modelRef:modelKey(i)},"보유 · " + (i.alias || i.instanceId) + " / " + i.instanceId);
      for (const model of library.models) add({modelRef:modelKey(model),quantity:1},"모델 · " + model.name + " / " + modelKey(model));
      for (const q of book!.quotes) add({modelRef:q.modelRef,product:{seller:q.seller,productId:q.productId,saleUnit:q.saleUnit},quantity:1},"상품 · " + productName(q));
      const retained = choices.findIndex(row => JSON.stringify(row) === previous);
      if (retained >= 0) picker.selectedIndex = retained;
      const quantity = input("quantity");
      const pick = () => { quantity.disabled = !("quantity" in (choices[picker.selectedIndex] ?? {})); };
      picker.onchange = pick;
      pick();
    }
    function showNeeds(scenario: Scenario) {
      const {view,id,doc} = state();
      const picker = select("need"), before = picker.value;
      const area = get(".needs");
      area.replaceChildren();
      requirements = [];
      if (view && view.scenario !== null && view.scene.scenarios[view.scenario]?.id === id) {
        for (const [connection,outcomes] of view.negotiations) {
          const capabilities = new Set(view.result.needs.filter(n => outcomes.includes(n.outcome)).map(n => n.requiredCapability));
          for (const capability of capabilities) requirements.push({connection,capability});
        }
      }
      picker.replaceChildren(new Option("일반 구매",""));
      if (requirements.length) area.append(el("h3","필요한 결합 형태"));
      for (const need of requirements) {
        const label = need.connection + " · " + need.capability;
        picker.add(new Option(label,JSON.stringify(need)));
        const selected = scenario.purchases?.filter(p => p.need?.connection === need.connection && p.need.capability === need.capability);
        const connection = doc.connections.find(c => c.id === need.connection)!;
        const endpoints = [connection.from,connection.to].map(p => p.instanceId + "/" + p.id).join(" ↔ ");
        const line = el("p",label + " (" + endpoints + ") · " + (selected?.length ? selected.map(purchaseName).join(", ") : "해결 품목 미지정 · 추가 비용 미확인"));
        const choose = el("button","품목 지정");
        choose.onclick = () => {
          get(".purchases").closest("details")!.open = true;
          picker.value = JSON.stringify(need);
          select("item").focus();
        };
        const evidence = el("button","연결 근거");
        evidence.onclick = () => { dialog.close(); inspectConnection(need.connection); };
        line.append(" ",choose," ",evidence);
        area.append(line);
      }
      if ([...picker.options].some(o => o.value === before)) picker.value = before;
    }
    let lastScenario: Scenario | undefined;
    function render() {
      if (!book || !dialog.open) return;
      const {doc} = state(), scenario = chosen(), area = get(".totals");
      area.replaceChildren();
      for (const name of ["add","cap","compare"]) get<HTMLButtonElement>("."+name+" button").disabled = !scenario;
      if (!scenario) { area.append(el("p","예산을 작성할 시나리오를 먼저 만드세요.")); return; }
      const budget = calculateBudget(scenario,doc.items,book);
      area.append(el("h3",scenario.id),el("strong","확인된 상품 소계 " + usd(budget.subtotalCents)),
        el("p","가격 미확인 " + budget.unknownCount + "개 · 세금과 배송비 미확인"));
      area.querySelector("strong")!.className = "budget-total";
      const remaining = budget.limitCents === null ? "상품 예산 상한 미설정" : budget.limitStatus === "over"
        ? "상품 예산 " + usd(budget.subtotalCents - budget.limitCents) + " 초과" : "상품 예산 " + usd(budget.limitCents) +
          (budget.limitStatus === "within" ? " 이내" : " · 충족 여부 미확인");
      area.append(el("p",remaining));
      if (budget.limitStatus === "over") area.lastElementChild!.className = "over";
      const list = el("ul","");
      for (const line of budget.lines) {
        const li = el("li",line.modelRef + " × " + line.quantity + " · " + (line.cents === null ? "가격 미확인" : usd(line.cents) + " (" + line.packs + "묶음)"));
        if (line.instances.length) li.append(" · " + line.instances.join(", "));
        if (line.skippedSellers.length) li.append(" · " + line.skippedSellers.join(", ") + " 품절");
        if (line.quote) li.append(el("br",""),quoteDetail(line.quote));
        list.append(li);
      }
      for (const id of budget.owned) list.append(el("li",id + " · 보유 " + usd(0)));
      area.append(list);
      if (lastScenario !== scenario) {
        input("limit").value = scenario.budget?.toString() ?? "";
        lastScenario = scenario;
        invalidateComparison();
      }
      const purchases = get(".purchases");
      purchases.replaceChildren();
      for (const [i,row] of (scenario.purchases ?? []).entries()) {
        const li = el("li",purchaseName(row));
        const remove = el("button","삭제");
        remove.onclick = () => updateScenario({...scenario,purchases:scenario.purchases!.filter((_,j) => i !== j)});
        li.append(remove);
        purchases.append(li);
      }
      optionRows();
      showNeeds(scenario);
    }
    function displayBook(next: PriceBook) {
      book = next;
      invalidateComparison();
      get<HTMLTextAreaElement>("[name=sellers]").value = book.preferredSellers.join("\n");
      get(".quotes").replaceChildren(...book.quotes.map(q => {
        const li = el("li",q.modelRef + " · ");
        li.append(quoteDetail(q)); return li;
      }));
      render();
    }
    function submit(name: string, action: () => void | Promise<void>) {
      const form = get<HTMLFormElement>("form."+name);
      form.onsubmit = async event => {
        event.preventDefault();
        const button = form.querySelector("button")!;
        if (button.disabled) return;
        button.disabled = true;
        status.textContent = "";
        try { await action(); } catch (error) { report(error); }
        finally { button.disabled = false; }
      };
    }
    submit("add",() => {
      const s = chosen()!, selected = choices[select("item").selectedIndex]!;
      const need = requirements.find(n => JSON.stringify(n) === select("need").value);
      const row = {...selected,...("quantity" in selected && {quantity:input("quantity").valueAsNumber}),...(need && {need})};
      const rows = [...s.purchases ?? []];
      if (rows.some(p => JSON.stringify(p) === JSON.stringify(row)) && !("quantity" in row)) return;
      rows.push(row);
      updateScenario({...s,purchases:rows});
    });
    submit("cap",() => {
      const {budget:old, ...s} = chosen()!;
      const limit = text("limit");
      if ((limit ? Number(limit) : undefined) !== old) updateScenario({...s,...(limit && {budget:Number(limit)})});
    });
    submit("quote",async () => {
      const q: Quote = {modelRef:select("modelRef").value,seller:text("seller"),productId:text("productId"),
        unitPriceCents:Math.round(input("price").valueAsNumber*100),saleUnit:input("saleUnit").valueAsNumber,
        currency:"USD", stock:select("stock").value as Quote["stock"],retrievedAt:new Date(text("time")).toISOString(),
        source:text("source"),provider:"manual",...(text("url") && {url:text("url")}),...(text("coupon") && {coupon:text("coupon")}),
        ...(text("discount") && {discountCents:Math.round(input("discount").valueAsNumber*100)})};
      displayBook(await json<PriceBook>("/api/prices",q));
      status.textContent = "견적을 저장했습니다.";
    });
    submit("prefer",async () => {
      const sellers = get<HTMLTextAreaElement>("[name=sellers]").value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      displayBook(await json<PriceBook>("/api/prices/preferences",sellers));
      status.textContent = "판매처 우선순위를 저장했습니다.";
    });
    select("modelRef").replaceChildren(...library.models.map(m => new Option(m.name + " / " + modelKey(m),modelKey(m))));
    function selectScenarios(doc: SceneDocument) {
      scenarioSelect.replaceChildren(...doc.scenarios.map(s => new Option(s.id)));
      if (doc.scenarios.some(s => s.id === state().id)) scenarioSelect.value = state().id!;
    }
    async function loadOther() {
      invalidateComparison();
      otherDoc = undefined;
      const id = sceneSelect.value;
      scenarioSelect.replaceChildren();
      if (!id) { selectScenarios(state().doc); return; }
      const doc = await json<SceneDocument>("/api/scenes/" + encodeURIComponent(id));
      if (sceneSelect.value !== id) return;
      otherDoc = doc;
      selectScenarios(doc);
    }
    sceneSelect.onchange = () => { void loadOther().catch(report); };
    scenarioSelect.onchange = invalidateComparison;
    get<HTMLDetailsElement>(".comparison").ontoggle = async event => {
      if (!(event.currentTarget as HTMLDetailsElement).open || sceneSelect.options.length) return;
      try {
        const index = await json<Library & {scenes:{id:string;title:string}[]}>("/api/library");
        otherDocuments = {connectors:index.connectors,models:new Map(index.models.map(m => [modelKey(m),m]))};
        sceneSelect.replaceChildren(new Option("현재 작업대",""),...index.scenes.map(s => new Option(s.title || s.id,s.id)));
        await loadOther();
      } catch (error) { report(error); }
    };
    submit("compare",async () => {
      const before = state().doc, left = chosen()!, after = sceneSelect.value ? otherDoc : before;
      const right = after?.scenarios.find(s => s.id === scenarioSelect.value);
      if (!after || !right) throw new Error("비교할 시나리오를 고르세요.");
      const version = ++comparisonVersion;
      const a = calculateBudget(left,before.items,book!), b = calculateBudget(right,after.items,book!);
      const [old,next] = await Promise.all([comparisonSnapshot(before,left,documents),
        comparisonSnapshot(after,right,sceneSelect.value ? otherDocuments : documents)]);
      if (version !== comparisonVersion || !dialog.open) return;
      comparison.replaceChildren(el("h3","가격 차이 " + difference(compareBudgets(a,b))),
        el("p",before.sceneId + " / " + left.id + " → " + after.sceneId + " / " + right.id));
      const byProduct = new Map<string,{label:string;before?:BudgetLine;after?:BudgetLine}>();
      for (const [side,budget] of [["before",a],["after",b]] as const) for (const line of budget.lines) {
        const product = line.quote ?? line.product;
        const key = priceKey(line.modelRef,product);
        const row = byProduct.get(key) ?? {label:line.modelRef + (product ? " · " + productName(product) : "")};
        row[side] = line;
        byProduct.set(key,row);
      }
      function describe(line?: BudgetLine) {
        if (!line) return "0개 · " + usd(0);
        return [line.quantity + "개",line.cents === null ? "미확인" : usd(line.cents),...line.instances.toSorted()].join(" · ");
      }
      for (const row of byProduct.values()) {
        const left = describe(row.before), right = describe(row.after);
        if (left !== right || row.before?.cents === null) comparison.append(el("p",row.label + " · " + left + " → " + right));
      }
      const changes = compare(old,next);
      comparison.append(el("h3",changes.length ? "기술 차이 " + changes.length + "건" : "기술 차이 없음"));
      const fields: Record<string,string> = {added:"추가",removed:"제거",verdict:"판정",mode:"모드",value:"값",range:"범위",
        bottleneck:"병목",assumption:"가정",quest:"검증 퀘스트",condition:"조건",need:"필요한 결합 형태"};
      for (const d of changes) {
        const snapshot = d.after === null ? old : next, o = snapshot.result.outcomes[d.after ?? d.before!]!;
        const id = (o.subjectKind === "workload" ? snapshot.scene.workloads : snapshot.scene.connections)[o.subjectRow]!.id;
        comparison.append(el("p",id + " · " + d.changed.map(k => fields[k]).join(", ") + " · " +
          technicalValue(old,d.before) + " → " + technicalValue(next,d.after)));
      }
    });
    refresh = render;
    const body = get(".creator-body");
    body.inert = true;
    status.textContent = "견적을 읽는 중…";
    void json<PriceBook>("/api/prices").then(data => {
      displayBook(data); body.inert = false; status.textContent = "";
    }).catch(report);
  };
  return () => refresh?.();
}
