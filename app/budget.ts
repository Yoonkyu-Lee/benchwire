// 시나리오 구매 목록을 판매 단위로 합산하고 같은 미확인 구매를 상쇄해 가격 차이를 구한다.
import type { PriceBook, ProductRef, Quote } from "../server/prices.ts";
import type { ReceiptResult } from "../server/receipt.ts";
import type { BestBuyCandidate } from "../server/bestbuy.ts";
import { compare, type Snapshot } from "../engine/compare.ts";
import { scenarioName } from "../scene/files.ts";
import { evaluateInWorker, loadAssessment, type Documents } from "./assessment.ts";
import { modelKey, type InventoryItem, type Item, type Library, type SceneDocument } from "./document.ts";
import { renderGoalChanges } from "./goal-changes.ts";
import { directionArrow, interval, resultView, verdictText, type ResultView } from "./results.ts";

type Scenario = SceneDocument["scenarios"][number];
type Purchase = NonNullable<Scenario["purchases"]>[number];
interface BudgetLine {
  key: string; modelRef: string; product?: ProductRef | undefined; quantity: bigint; quote?: Quote | undefined;
  instances: string[]; skippedSellers: string[]; packs: bigint; cents: bigint | null; searchExceeded?: true;
}
const priceKey = (model: string, ref?: ProductRef) => JSON.stringify([model, ref?.seller, ref?.productId, ref?.saleUnit]);
const packPrice = (q: Quote) => BigInt(q.unitPriceCents) - BigInt(q.discountCents ?? 0);
const packCount = (units: bigint, q: Quote) => (units + BigInt(q.saleUnit) - 1n) / BigInt(q.saleUnit);

// 여러 판매 단위를 비교할 때 모델별 탐색의 상태 수 × 판매 단위 수를 제한한다.
const MAX_PACK_SEARCH_STEPS = 100_000n;
function leastCostPacks(units: bigint, offers: Quote[]) {
  const counts = offers.map(() => 0n);
  const prices = offers.map(packPrice);
  const distinct = new Map<bigint, number>();
  for (const [index, offer] of offers.entries()) {
    const size = BigInt(offer.saleUnit);
    const cover = size < units ? size : units;
    const prior = distinct.get(cover);
    if (prior === undefined || prices[index]! < prices[prior]!) distinct.set(cover, index);
  }
  if (distinct.size === 1) {
    const index = distinct.values().next().value!;
    counts[index] = packCount(units, offers[index]!);
    return counts;
  }
  // 무료 묶음 하나의 판매 단위를 반복하면 수량과 무관하게 최저 금액이다.
  const free = prices.indexOf(0n);
  if (free >= 0) { counts[free] = packCount(units, offers[free]!); return counts; }
  if (units * BigInt(distinct.size) > MAX_PACK_SEARCH_STEPS) return;

  const choices = [...distinct].map(([size,index]) => [Number(size),index] as const);
  const costs = [0n], selected: (typeof choices)[number][] = [];
  // 수요 이하의 상태만 두고, 더 큰 묶음은 남은 수요 전부를 채운다.
  for (let remaining = 1; remaining <= Number(units); remaining++) {
    for (const choice of choices) {
      const [size,index] = choice;
      const cost = costs[Math.max(0,remaining-size)]! + prices[index]!;
      if (costs[remaining] === undefined || cost < costs[remaining]!) {
        costs[remaining] = cost;
        selected[remaining] = choice;
      }
    }
  }
  for (let remaining = Number(units); remaining > 0;) {
    const [size,index] = selected[remaining]!;
    counts[index] = counts[index]! + 1n;
    remaining -= size;
  }
  return counts;
}

function centsFromDollars(text: string) {
  const value = /^(\d*)(?:\.(\d{1,2}))?$/.exec(text);
  if (!value || !(value[1] || value[2])) throw new Error("금액을 소수 둘째 자리까지 입력하세요.");
  const cents = BigInt(value[1] + (value[2] ?? "").padEnd(2,"0"));
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("안전하게 저장할 수 있는 금액을 넘었습니다.");
  return Number(cents);
}

function newLine(modelRef: string, product?: ProductRef): BudgetLine {
  return {key:priceKey(modelRef,product),modelRef,product,quantity:0n,instances:[],skippedSellers:[],packs:0n,cents:null};
}

type BudgetView = Pick<ResultView,"scenario" | "negotiations"> & {
  scene: Pick<ResultView["scene"],"scenarios"> & Partial<Pick<ResultView["scene"],"connections">>;
  result: Pick<ResultView["result"],"needs"|"needCases"|"incompleteNeeds"> & Partial<Pick<ResultView["result"],"searches">>;
};
export function calculateBudget(scenario: Scenario, items: readonly Item[], book: PriceBook, view: BudgetView | undefined) {
  const assessed = view && view.scenario !== null && view.scene.scenarios[view.scenario]?.id === scenario.id
    ? budgetRequirements(view,scenario) : undefined;
  const requirements = assessed?.requirements ?? [];
  const unassignedNeeds = assessed?.high ?? (assessed?.low || null);
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
    const line = grouped.get(key) ?? newLine(model,product);
    line.quantity += BigInt(quantity);
    if ("instanceId" in row) line.instances.push(row.instanceId);
    grouped.set(key,line);
  }
  const current = new Map<string, Quote>();
  for (const q of book.quotes) {
    if (q.purchasedAt || q.provider === "bestbuy" && !(Date.parse(q.expiresAt ?? "") > Date.now())) continue;
    const key = priceKey(q.modelRef,q);
    const previous = current.get(key);
    if (!previous || Date.parse(previous.retrievedAt) <= Date.parse(q.retrievedAt)) current.set(key,q);
  }
  const rank = (q: Quote) => {
    const index = book.preferredSellers.indexOf(q.seller);
    return index < 0 ? book.preferredSellers.length : index;
  };
  const quotesByModel = Map.groupBy(current.values(),q => q.modelRef);
  const lines = [];
  for (const [model, demands] of Map.groupBy(grouped.values(),line => line.modelRef)) {
    const offers = quotesByModel.get(model) ?? [];
    const stocked = offers.filter(q => q.stock === "in").sort((a,b) => rank(a)-rank(b)
      || a.seller.localeCompare(b.seller) || a.productId.localeCompare(b.productId) || a.saleUnit-b.saleUnit);
    const preferred = stocked.filter(q => rank(q) === rank(stocked[0]!));
    const skipped = book.preferredSellers.filter((seller,i) => (!stocked.length || i < rank(stocked[0]!))
      && offers.some(q => q.seller === seller && q.stock === "out") && !offers.some(q => q.seller === seller && q.stock !== "out"));
    const products = new Map<string,BudgetLine>();
    for (const line of demands) {
      if (!line.product) continue;
      const exact = current.get(line.key);
      if (exact?.stock === "in") {
        line.quote = exact;
        line.packs = packCount(line.quantity,exact);
      } else if (exact?.stock === "out" && book.preferredSellers.includes(exact.seller)) {
        line.skippedSellers = [exact.seller];
      }
      products.set(line.key,line);
    }
    const flexible = demands.find(line => !line.product);
    if (flexible) {
      const assign = (line: BudgetLine, capacity: bigint) => {
        const used = capacity < flexible.quantity ? capacity : flexible.quantity;
        line.quantity += used;
        flexible.quantity -= used;
        line.instances = line.instances.concat(flexible.instances.splice(0,Number(used)));
      };
      // 직접 고른 상품의 남는 낱개는 추가 주문 없이 같은 모델 수요를 채운다.
      for (const line of products.values()) if (line.quote)
        assign(line,line.packs * BigInt(line.quote.saleUnit) - line.quantity);
      if (flexible.quantity && preferred.length) {
        const counts = leastCostPacks(flexible.quantity,preferred);
        if (!counts) flexible.searchExceeded = true;
        else for (const [index,count] of counts.entries()) {
          if (!count) continue;
          const quote = preferred[index]!, key = priceKey(model,quote);
          const line = products.get(key) ?? newLine(model,quote);
          line.quote = quote;
          line.packs += count;
          line.skippedSellers = skipped;
          assign(line,count * BigInt(quote.saleUnit));
          products.set(key,line);
        }
      }
      if (flexible.quantity) {
        flexible.skippedSellers = skipped;
        products.set(flexible.key,flexible);
      }
    }
    lines.push(...products.values());
  }
  let subtotalCents = 0n, unpricedPurchases = 0n;
  for (const line of lines) {
    if (!line.quote) { unpricedPurchases += line.quantity; continue; }
    line.cents = line.packs * packPrice(line.quote);
    subtotalCents += line.cents;
  }
  const limitCents = scenario.budget === undefined ? null : BigInt(centsFromDollars(String(scenario.budget)));
  const unknownRange={low:unpricedPurchases+BigInt(assessed?.low ?? 0),high:assessed?.high==null ? null : unpricedPurchases+BigInt(assessed.high)};
  const unknownCount=unknownRange.high ?? unknownRange.low;
  const limitStatus = limitCents === null ? "unset" : subtotalCents > limitCents ? "over"
    : unknownRange.high === 0n ? "within" : "unknown";
  return { lines, owned, subtotalCents, unknownCount, unknownRange, requirements, unassignedNeeds, limitCents, limitStatus };
}

type Budget = ReturnType<typeof calculateBudget>;
export function unknownPrices({low,high}: Budget["unknownRange"]) {
  return "가격 미확인 " + low + (high===null ? "개 이상" : high===low ? "개" : "–"+high+"개");
}
export function compareBudgets(before: Budget, after: Budget) {
  if (before.unknownRange.high===null || after.unknownRange.high===null || before.unassignedNeeds !== 0 || after.unassignedNeeds !== 0) return null;
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
async function json<T>(path: string, body?: unknown, method = "PUT"): Promise<T> {
  const response = await fetch(path, body === undefined ? {} : {method,
    headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  if (!response.ok) throw new Error((await response.json()).message ?? "가격 정보를 읽을 수 없습니다.");
  return await response.json() as T;
}

function budgetRequirements(view: BudgetView, scenario: Scenario) {
  const known = [...view.negotiations].flatMap(([connection,outcomes]) => {
    const capabilities = new Set(view.result.needs.filter(n => outcomes.includes(n.outcome) && !n.conditional).map(n => n.requiredCapability));
    return [...capabilities].map(capability => ({connection,capability}));
  });
  const sets=view.result.needCases;
  const cases=sets ? Array.from({length:sets.size},()=>[] as typeof known) : [known];
  for (const {set,connection,capability} of sets?.members ?? []) {
    const id=view.scene.connections![connection]!.id;
    if (view.negotiations.has(id)) cases[set]!.push({connection:id,capability});
  }
  const union=new Map(cases.flat().map(n=>[JSON.stringify(n),n]));
  const requirements=[...union.values()].map(need=>({need,
    purchases:scenario.purchases?.filter(p=>p.need?.connection===need.connection && p.need.capability===need.capability) ?? [],
    conditional:cases.some(rows=>!rows.some(n=>n.connection===need.connection && n.capability===need.capability))}));
  const missing=new Set(requirements.filter(n=>!n.purchases.length).map(n=>JSON.stringify(n.need)));
  const counts=cases.map(rows=>rows.filter(n=>missing.has(JSON.stringify(n))).length);
  const incomplete=view.result.incompleteNeeds?.includes(view.scenario!) || view.result.searches?.some(s=>s.scenario===view.scenario && s.truncated);
  return {requirements,low:Math.min(...counts),high:incomplete ? null : Math.max(...counts)};
}

// 선택한 시나리오만 평가한다. 서로 다른 장면에서 고른 두 시나리오는 비교 키에서 같은 자리다.
async function comparisonSnapshot(doc: SceneDocument, scenario: Scenario, documents: Documents) {
  const selected = {...doc, scenarios:[scenario]};
  const loaded = loadAssessment(selected, documents, null);
  if ("error" in loaded) throw new Error(loaded.error);
  const reply = await evaluateInWorker({}, {kind:"primary",document:selected,documents});
  if (reply?.kind !== "primary") throw new Error(reply?.kind === "error" ? reply.message : "비교할 판정을 읽을 수 없습니다.");
  const view = resultView(loaded.scene,reply.result,loaded.scenario,"together");
  const snapshot: Snapshot = {scene:{...loaded.scene,scenarios:[{...loaded.scene.scenarios[0]!,id:"선택한 시나리오"}]},result:reply.result};
  return {snapshot,view};
}
function technicalValue(snapshot: Snapshot, row: number | null) {
  if (row === null) return "없음";
  const {result} = snapshot, o = result.outcomes[row]!;
  const m = result.metrics.find(m => m.outcome === row && m.kind === (o.subjectKind === "connection" ? "limit" : "together"));
  return [verdictText[o.verdict], o.label || o.mode, m && interval(m,m.unit)].filter(Boolean).join(" · ");
}

type BudgetState = {doc: SceneDocument; id: string | null; view: ResultView | undefined};
function receiptTable(area: HTMLElement, result: ReceiptResult, library: Library, save: (row: unknown) => Promise<void>) {
  const kind = document.createElement("select");
  kind.setAttribute("aria-label","문서 종류");
  kind.append(new Option("영수증","receipt"),new Option("장바구니","cart"));
  kind.value = result.kind;
  const scroll = el("div","");
  scroll.className = "receipt-table";
  const table = document.createElement("table");
  const head = table.createTHead().insertRow();
  for (const caption of ["상품 · 판매처","수량 · 금액","날짜 · 모델","확인"]) head.append(el("th",caption));
  const body = table.createTBody();
  scroll.append(table);
  area.replaceChildren(kind,scroll);
  for (const [index,row] of result.rows.entries()) {
    const tr = body.insertRow();
    const identity = tr.insertCell(), amounts = tr.insertCell(), match = tr.insertCell(), actions = tr.insertCell();
    function control(parent: HTMLElement, title: string, type: string, value: string) {
      const label = el("label",title), field = document.createElement("input");
      field.type = type; field.value = value;
      label.append(field); parent.append(label);
      return field;
    }
    const name = control(identity,"상품명","text",row.name ?? ""), seller = control(identity,"판매처","text",row.seller ?? "");
    const qty = control(amounts,"수량","number",row.quantity?.toString() ?? "");
    qty.min = "1"; qty.step = "1";
    const dollars = (cents: number | null) => cents === null ? "" : usd(cents).slice(1).replaceAll(",","");
    const total = control(amounts,"행 합계","number",dollars(row.lineTotalCents));
    const unit = control(amounts,"단가","number",dollars(row.unitPriceCents));
    total.step = unit.step = "0.01"; total.min = unit.min = "0";
    const currency = control(amounts,"통화","text",row.currency ?? "");
    const date = control(match,"구매일 또는 관측일","date",row.date ?? "");
    const model = document.createElement("select");
    model.setAttribute("aria-label","인벤토리 모델");
    const normalized = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu,"");
    const product = normalized(row.name ?? "");
    const ranked = library.models.map(m => {
      const score = Math.max(0,...[m.name,m.modelId].map(normalized).filter(word => word && product.includes(word)).map(word => word.length));
      return {m,score};
    }).sort((a,b) => b.score-a.score);
    model.add(new Option("모델 선택",""));
    for (const {m,score} of ranked) model.add(new Option((score ? "후보 · " : "")+m.name+" / "+modelKey(m),modelKey(m)));
    if (ranked[0]?.score && ranked[0].score !== ranked[1]?.score) model.selectedIndex = 1;
    match.append(model);
    const stock = document.createElement("select");
    stock.setAttribute("aria-label","관측일 재고");
    stock.append(new Option("재고 미확인","unknown"),new Option("구매 가능","in"),new Option("품절","out"));
    stock.value = row.stock; stock.hidden = kind.value !== "cart";
    kind.addEventListener("change",() => {stock.hidden = kind.value !== "cart";});
    match.append(stock);
    const inventory = control(actions,"인벤토리에도 추가","checkbox","");
    const button = el("button","확인한 행 저장");
    const notice = el("p",[...row.issues,...row.warnings].join(" · "));
    notice.className = "issue"; notice.setAttribute("role","status"); actions.append(button,notice);
    button.onclick = async () => {
      if (!model.value || !qty.checkValidity() || !total.checkValidity() || !unit.checkValidity()) {
        notice.textContent = "모델과 수량·센트 단위의 금액을 확인하세요."; return;
      }
      tr.inert = true;
      try {
        const receiptCents = (field: HTMLInputElement) => field.value === "" ? null : centsFromDollars(field.value);
        const entry = {kind:kind.value,importId:result.id+"-"+index,modelRef:model.value,inventory:inventory.checked,
          name:name.value.trim(),seller:seller.value.trim(),quantity:qty.valueAsNumber,lineTotalCents:receiptCents(total),
          unitPriceCents:receiptCents(unit),currency:currency.value.trim(),date:date.value,stock:stock.value};
        await save(entry);
        kind.disabled = true;
        for (const field of tr.querySelectorAll("input,select,button")) field.setAttribute("disabled","");
        notice.textContent = "저장됨 · "+entry.modelRef;
      } catch (error) { notice.textContent = error instanceof Error ? error.message : String(error); }
      finally { tr.inert = false; }
    };
  }
}
export function mountBudget(root: HTMLElement, library: Library, documents: Documents,
  state: () => BudgetState, edit: (next: SceneDocument, scenarioId: string) => boolean, inspectConnection: (id: string) => void,
  addInventory: (items: InventoryItem[]) => void) {
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
        .budget-dialog [hidden] {display:none}
        .budget-dialog .compare-result:empty,.budget-dialog [role=status]:empty {display:none}.budget-dialog [role=status] {color:#164c45}
        .budget-dialog .receipt-table {overflow:auto}.receipt-table table {border-collapse:collapse;text-align:left}
        .receipt-table :is(td,th) {padding:5px;vertical-align:top;border-bottom:1px solid #dae2df}.receipt-table input {width:8em}
        .receipt-table select {max-width:13em}.receipt-table .issue {color:#8d401e}.budget-dialog .branding img {max-width:94px;max-height:38px;vertical-align:middle}
      </style>
      <header><h2>구매 예산</h2><button type="button" class="dismiss">닫기</button></header>
      <div class="creator-body"><section class="totals" aria-live="polite"></section>
      <details><summary>구매 목록 편집</summary><ul class="purchases"></ul>
        <form class="add"><label>구매할 항목<select name="item" required></select></label>
        <label>구매 수량 (낱개)<input name="quantity" type="number" value="1" min="1" step="1" required></label>
        <label>관련 결합 형태<select name="need"></select></label><button>목록에 추가</button></form>
        <form class="cap"><label>상품 예산 상한 (USD)<input name="limit" type="number" min="0" step="0.01"></label><button>상한 저장</button></form>
      </details><div class="needs"></div>
      <details><summary>영수증 · 장바구니 가져오기</summary>
        <p class="receipt-config"></p><form class="receipt"><label>이미지 한 장<input name="photo" type="file" accept="image/png,image/jpeg,image/webp" required></label>
        <label><span><input name="consent" type="checkbox" required> 선택한 이미지를 Claude로 보내는 데 동의합니다.</span></label>
        <button>이미지 읽기</button></form><div class="review"></div><ul class="history"></ul>
      </details>
      <details class="bestbuy-panel"><summary>Best Buy 상품 검색</summary><p class="bestbuy-config"></p>
        <form class="search"><label>연결할 모델<select name="bbModel" required></select></label><label>검색할 상품명<input name="query" maxlength="160" required></label>
        <button>Best Buy 검색</button></form><form class="offer" hidden><label>검색된 상품<select name="sku" required></select></label>
        <label>판매 단위 (낱개 수)<input type="number" name="pack" min="1" step="1" value="1" required></label>
        <a class="listing" target="_blank" rel="noreferrer">상품 페이지</a><button>선택한 견적 사용</button></form></details>
      <div class="branding" hidden></div>
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
      </details><p role="status"></p><p role="status" data-scene-save-status></p></div>`;
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
    dialog.onclose = () => { refresh = undefined; clearTimeout(expiryTimer); document.removeEventListener("visibilitychange",expire); dialog.remove(); };
    let book: PriceBook | undefined;
    let choices: Purchase[] = [];
    let requirements: Budget["requirements"] = [];
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
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    let found: BestBuyCandidate[] = [];
    function branding() {
      const area = get(".branding");
      const visible = !!book?.providers?.bestbuy && (get<HTMLDetailsElement>(".bestbuy-panel").open || !!book.quotes.some(q => q.provider === "bestbuy"));
      area.hidden = !visible;
      if (visible && !area.childElementCount) {
        const link = el("a","");
        link.href = "https://developer.bestbuy.com"; link.target = "_blank"; link.rel = "noreferrer";
        const logo = document.createElement("img");
        logo.alt = "Best Buy Developer API"; logo.referrerPolicy = "no-referrer";
        logo.src = "https://developer.bestbuy.com/images/bestbuy-logo.png";
        link.append(logo); area.append(link," · Best Buy Products API");
      }
    }
    function scheduleExpiry() {
      clearTimeout(expiryTimer);
      const deadlines = [...found,...book?.quotes ?? []].flatMap(row => row.expiresAt ? [Date.parse(row.expiresAt)] : []);
      if (dialog.open && deadlines.length) expiryTimer = setTimeout(expire,Math.max(0,Math.min(...deadlines)-Date.now()));
    }
    function expire() {
      if (!book || !dialog.open) return;
      const quotes = book.quotes.filter(q => !q.expiresAt || Date.parse(q.expiresAt)>Date.now());
      if (found.some(p => Date.parse(p.expiresAt)<=Date.now())) showProducts([]);
      if (quotes.length !== book.quotes.length) {
        const compared = comparison.hasChildNodes();
        displayBook({...book,quotes});
        if (compared) comparison.textContent = "견적 만료 · 두 구성을 다시 비교하세요.";
      }
      scheduleExpiry();
    }
    document.addEventListener("visibilitychange",expire);
    get<HTMLDetailsElement>(".bestbuy-panel").ontoggle = branding;

    function quoteDetail(q: Quote) {
      const old = Date.now() - Date.parse(q.retrievedAt) >= STALE_DAYS * 86400000;
      const detail = el("small", [q.seller + " / " + q.productId, usd(q.unitPriceCents) + " / " + q.saleUnit + "개",
        q.stock === "in" ? "재고 있음" : q.stock === "out" ? "품절" : "재고 미확인", q.source,
        q.provider === "cart" ? q.retrievedAt.slice(0,10)+" 관측" : new Date(q.retrievedAt).toLocaleString("ko-KR"),
        old && "오래된 견적", q.coupon, q.discountCents && "적용 할인 " + usd(q.discountCents)].filter(Boolean).join(" · "));
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
      for (const q of book!.quotes) if (q.provider !== "bestbuy")
        add({modelRef:q.modelRef,product:{seller:q.seller,productId:q.productId,saleUnit:q.saleUnit},quantity:1},"상품 · " + productName(q));
      const retained = choices.findIndex(row => JSON.stringify(row) === previous);
      if (retained >= 0) picker.selectedIndex = retained;
      const quantity = input("quantity");
      const pick = () => { quantity.disabled = !("quantity" in (choices[picker.selectedIndex] ?? {})); };
      picker.onchange = pick;
      pick();
    }
    function showNeeds(rows: Budget["requirements"]) {
      const {doc} = state();
      const picker = select("need"), before = picker.value;
      const area = get(".needs");
      area.replaceChildren();
      requirements = rows;
      picker.replaceChildren(new Option("일반 구매",""));
      if (requirements.length) area.append(el("h3","필요한 결합 형태"));
      for (const {need,purchases,conditional} of requirements) {
        const label = need.connection + " · " + need.capability + (conditional ? " · 일부 후보에서만 필요" : "");
        picker.add(new Option(label,JSON.stringify(need)));
        const connection = doc.connections.find(c => c.id === need.connection)!;
        const endpoints = [connection.from,connection.to].map(p => p.instanceId + "/" + p.id).join(" ↔ ");
        const line = el("p",label + " (" + endpoints + ") · " + (purchases.length ? purchases.map(purchaseName).join(", ") : "해결 품목 미지정 · 추가 비용 미확인"));
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
    let comparisonScenarios: SceneDocument["scenarios"] | undefined;
    function render() {
      if (!book || !dialog.open) return;
      const {doc} = state(), scenario = chosen(), area = get(".totals");
      area.replaceChildren();
      for (const name of ["add","cap","compare"]) get<HTMLButtonElement>("."+name+" button").disabled = !scenario;
      if (!scenario) { area.append(el("p","예산을 작성할 시나리오를 먼저 만드세요.")); return; }
      const budget = calculateBudget(scenario,doc.items,book,state().view);
      showNeeds(budget.requirements);
      area.append(el("h3",scenarioName(scenario)),el("strong","확인된 상품 소계 " + usd(budget.subtotalCents)),
        el("p",unknownPrices(budget.unknownRange) + " · 세금과 배송비 미확인"));
      area.querySelector("strong")!.className = "budget-total";
      const remaining = budget.limitCents === null ? "상품 예산 상한 미설정" : budget.limitStatus === "over"
        ? "상품 예산 " + usd(budget.subtotalCents - budget.limitCents) + " 초과" : "상품 예산 " + usd(budget.limitCents) +
          (budget.limitStatus === "within" ? " 이내" : " · 충족 여부 미확인");
      area.append(el("p",remaining));
      if (budget.limitStatus === "over") area.lastElementChild!.className = "over";
      const list = el("ul","");
      for (const line of budget.lines) {
        const li = el("li",line.modelRef + " × " + line.quantity + " · " + (line.cents === null ? "가격 미확인" : usd(line.cents) + " (" + line.packs + "묶음)"));
        if (line.searchExceeded) li.append(" · 묶음 조합 계산 범위 초과");
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
      if (!sceneSelect.value && scenarioSelect.options.length && comparisonScenarios !== doc.scenarios) {
        selectScenarios(doc);
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
    }
    function displayBook(next: PriceBook) {
      if (!dialog.open) return;
      book = {...next,quotes:next.quotes.filter(q => !q.expiresAt || Date.parse(q.expiresAt)>Date.now())};
      invalidateComparison();
      get<HTMLTextAreaElement>("[name=sellers]").value = book.preferredSellers.join("\n");
      get(".quotes").replaceChildren(...book.quotes.map(q => {
        const li = el("li",q.modelRef + " · ");
        li.append(quoteDetail(q)); return li;
      }));
      const inventoryIds = new Set(library.inventory.map(i => i.instanceId));
      get(".history").replaceChildren(...(book.observations ?? []).map(q => {
        const item = el("li",[q.purchasedAt ? q.purchasedAt+" 구매" : q.retrievedAt.slice(0,10)+" 장바구니",q.seller,q.name+" × "+q.quantity,
          "행 합계 "+usd(q.lineTotalCents!),q.modelRef].join(" · "));
        if (q.quantity! <= (next.providers?.receipt.maxInventoryItems ?? 0)
          && Array.from({length:q.quantity!},(_,i) => q.provider+"-"+q.importId+"-"+(i+1)).some(id => !inventoryIds.has(id))) {
          const add = el("button","인벤토리에 추가");
          add.onclick = async () => {
            add.disabled = true;
            try {
              await confirmPurchase({kind:q.provider,importId:q.importId,modelRef:q.modelRef,name:q.name,seller:q.seller,
                quantity:q.quantity,unitPriceCents:q.unitPriceCents,lineTotalCents:q.lineTotalCents,currency:q.currency,
                date:q.purchasedAt ?? q.retrievedAt.slice(0,10),stock:q.stock,inventory:true});
            } catch (error) {report(error); add.disabled = false;}
          };
          item.append(add);
        }
        return item;
      }));
      const config = book.providers?.receipt;
      get(".receipt-config").textContent = config?.enabled
        ? "PNG · JPEG · WebP "+(config.imageBytes/1048576)+" MiB 이하. 한 장 최대 US$"+config.budgetUsd.toFixed(2)+"."
        : "ANTHROPIC_API_KEY를 설정하면 이미지를 읽을 수 있습니다.";
      get<HTMLFormElement>(".receipt").inert = !config?.enabled;
      get<HTMLButtonElement>(".receipt button").disabled = !config?.enabled;
      get(".bestbuy-config").textContent = book.providers?.bestbuy ? "미국 온라인 판매가 · USD" : "BESTBUY_API_KEY를 설정하면 상품을 검색할 수 있습니다.";
      get<HTMLFormElement>(".search").inert = !book.providers?.bestbuy;
      get<HTMLButtonElement>(".search button").disabled = !book.providers?.bestbuy;
      branding();
      scheduleExpiry();
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
      const need = requirements.find(row => JSON.stringify(row.need) === select("need").value)?.need;
      const row = {...selected,...("quantity" in selected && {quantity:input("quantity").valueAsNumber}),...(need && {need})};
      const rows = [...s.purchases ?? []];
      if (rows.some(p => JSON.stringify(p) === JSON.stringify(row)) && !("quantity" in row)) return;
      rows.push(row);
      updateScenario({...s,purchases:rows});
    });
    submit("cap",() => {
      const {budget:old, ...s} = chosen()!;
      const limit = text("limit");
      const cents = limit === "" ? undefined : centsFromDollars(limit);
      const budget = cents === undefined ? undefined : Number(limit);
      if (budget !== undefined && cents !== centsFromDollars(String(budget)))
        throw new Error("이 예산 상한을 센트 단위로 저장할 수 없습니다.");
      if (budget !== old) updateScenario({...s,...(budget !== undefined && {budget})});
    });
    submit("quote",async () => {
      const q: Quote = {modelRef:select("modelRef").value,seller:text("seller"),productId:text("productId"),
        unitPriceCents:centsFromDollars(text("price")),saleUnit:input("saleUnit").valueAsNumber,
        currency:"USD", stock:select("stock").value as Quote["stock"],retrievedAt:new Date(text("time")).toISOString(),
        source:text("source"),provider:"manual",...(text("url") && {url:text("url")}),...(text("coupon") && {coupon:text("coupon")}),
        ...(text("discount") && {discountCents:centsFromDollars(text("discount"))})};
      displayBook(await json<PriceBook>("/api/prices",q));
      status.textContent = "견적을 저장했습니다.";
    });
    submit("prefer",async () => {
      const sellers = get<HTMLTextAreaElement>("[name=sellers]").value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      displayBook(await json<PriceBook>("/api/prices/preferences",sellers));
      status.textContent = "판매처 우선순위를 저장했습니다.";
    });
    select("modelRef").replaceChildren(...library.models.map(m => new Option(m.name + " / " + modelKey(m),modelKey(m))));
    select("bbModel").replaceChildren(...library.models.map(m => new Option(m.name+" / "+modelKey(m),modelKey(m))));
    const photo = input("photo"), consent = input("consent");
    photo.onchange = () => {consent.checked = false; get(".review").replaceChildren();};
    async function confirmPurchase(row: unknown) {
      const saved = await json<{book:PriceBook;items:InventoryItem[]}>("/api/prices/confirm",row,"POST");
      if (!root.contains(open)) return;
      if (saved.items.length) addInventory(saved.items);
      displayBook(saved.book);
    }
    submit("receipt",async () => {
      const file = photo.files?.[0], config = book?.providers?.receipt;
      if (!file || !config?.enabled || !consent.checked || file.size > config.imageBytes ||
        !["image/png","image/jpeg","image/webp"].includes(file.type)) throw new Error("전송할 이미지의 형식·크기와 동의를 확인하세요.");
      const data = await new Promise<string>((resolve,reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]!);
        reader.onerror = () => reject(new Error("파일을 읽을 수 없습니다."));
        reader.readAsDataURL(file);
      });
      if (!dialog.open || !consent.checked || file !== photo.files?.[0]) return;
      consent.checked = false;
      status.textContent = "선택한 이미지에서 상품 행을 읽는 중…";
      const result = await json<ReceiptResult>("/api/prices/receipt",{consent:true,type:file.type,data},"POST");
      if (!dialog.open || file !== photo.files?.[0]) return;
      receiptTable(get(".review"),result,library,confirmPurchase);
      status.textContent = "이미지 읽기 비용 US$"+result.spentUsd.toFixed(4);
    });
    function showProducts(rows: BestBuyCandidate[]) {
      found = rows.filter(p => Date.parse(p.expiresAt)>Date.now());
      select("sku").replaceChildren(...found.map(p => new Option(p.name+" / "+p.productId,p.productId)));
      get(".offer").hidden = !found.length;
      linkListing();
      scheduleExpiry();
    }
    function linkListing() {
      const link = get<HTMLAnchorElement>(".listing");
      const entry = found.find(p => p.productId === select("sku").value);
      if (entry) link.href = entry.url;
      else link.removeAttribute("href");
    }
    select("sku").onchange = linkListing;
    submit("search",async () => {
      showProducts([]);
      const modelRef = select("bbModel").value;
      const rows = await json<BestBuyCandidate[]>("/api/prices/bestbuy",{action:"search",modelRef,query:text("query")},"POST");
      if (!dialog.open || select("bbModel").value !== modelRef) return;
      showProducts(rows);
      status.textContent = "검색된 상품 "+found.length+"개";
    });
    select("bbModel").onchange = () => showProducts([]);
    submit("offer",async () => {
      const chosen = found.find(p => p.productId === select("sku").value && Date.parse(p.expiresAt)>Date.now());
      if (!chosen) throw new Error("상품을 다시 검색하세요.");
      displayBook(await json<PriceBook>("/api/prices/bestbuy",{action:"quote",modelRef:select("bbModel").value,
        product:{seller:chosen.seller,productId:chosen.productId,saleUnit:input("pack").valueAsNumber}},"POST"));
      status.textContent = "선택한 모델에 Best Buy 견적을 적용했습니다.";
    });
    function selectScenarios(doc: SceneDocument) {
      const selected = scenarioSelect.value;
      comparisonScenarios = doc.scenarios;
      scenarioSelect.replaceChildren(...doc.scenarios.map(s => new Option(scenarioName(s),s.id)));
      const preferred = doc.scenarios.find(s => s.id === selected) ?? doc.scenarios.find(s => s.id === state().id);
      if (preferred) scenarioSelect.value = preferred.id;
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
      const [leftSide,rightSide] = await Promise.all([comparisonSnapshot(before,left,documents),
        comparisonSnapshot(after,right,sceneSelect.value ? otherDocuments : documents)]);
      expire();
      if (version !== comparisonVersion || !dialog.open) return;
      const a = calculateBudget(left,before.items,book!,leftSide.view);
      const b = calculateBudget(right,after.items,book!,rightSide.view);
      const old = leftSide.snapshot, next = rightSide.snapshot;
      comparison.replaceChildren(el("h3","가격 차이 " + difference(compareBudgets(a,b))),
        el("p",before.sceneId + " / " + scenarioName(left) + " → " + after.sceneId + " / " + scenarioName(right)));
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
        comparison.append(el("p",[id, directionArrow(o.direction)].filter(Boolean).join(" ") + " · " + d.changed.map(k => fields[k]).join(", ") + " · " +
          technicalValue(old,d.before) + " → " + technicalValue(next,d.after)));
      }
      const goals = renderGoalChanges(leftSide.view, rightSide.view, [...(left.goals ?? []), ...(right.goals ?? [])]);
      if (goals) comparison.append(goals);
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
