// 판매 상품별 수동 견적과 판매처 우선순위를 검증해 로컬 JSON에 저장한다.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { productRef, revisionRef } from "../scene/files.ts";
import { LibraryError, writeAtomic, type openLibrary } from "./library.ts";
import { confirmedLine, inspectLine, MAX_INVENTORY_ITEMS, type openReceipt } from "./receipt.ts";
import type { openBestBuy } from "./bestbuy.ts";
import { openSettings, preferredSellers } from "./settings.ts";

const money = z.int().nonnegative();
const quoteFile = productRef.extend({
  modelRef: revisionRef, unitPriceCents: money, currency: z.literal("USD"),
  stock: z.enum(["in", "out", "unknown"]), retrievedAt: z.iso.datetime({ offset: true }),
  source: z.string().trim().min(1), provider: z.string().trim().min(1), url: z.httpUrl().optional(),
  coupon: z.string().trim().min(1).optional(), discountCents: money.optional(), purchasedAt: z.iso.date().optional(),
  importId:z.string().optional(), name:z.string().optional(), quantity:z.int().positive().optional(), lineTotalCents:money.optional(),
}).refine(q => (q.discountCents ?? 0) <= q.unitPriceCents, {path:["discountCents"], message:"적용 할인은 판매가 이하여야 합니다"});
export type Quote = z.infer<typeof quoteFile> & {expiresAt?:string};
export type ProductRef = z.infer<typeof productRef>;
export interface PriceProvider {
  search(query: string): ProductRef[] | Promise<ProductRef[]>;
  quote(ref: ProductRef): Quote | undefined | Promise<Quote | undefined>;
}
export interface PriceBook { quotes: Quote[]; preferredSellers: string[]; observations?:Quote[];
  providers?:{receipt:ReturnType<typeof openReceipt>["config"];bestbuy:boolean} }

export function manualProvider(rows: Quote[]) {
  const latest = new Map<string,Quote>();
  for (const q of rows) {
    if (q.purchasedAt) continue;
    const key = JSON.stringify([q.modelRef,q.seller,q.productId,q.saleUnit]);
    const previous = latest.get(key);
    if (!previous || Date.parse(previous.retrievedAt) <= Date.parse(q.retrievedAt)) latest.set(key,q);
  }
  const current = [...latest.values()];
  return {
    search(query: string) {
      const term = query.trim().toLowerCase();
      return current.filter(q => [q.modelRef, q.seller, q.productId].some(value => value.toLowerCase().includes(term)));
    },
    quote(ref: ProductRef) {
      return current.find(q => q.seller === ref.seller && q.productId === ref.productId && q.saleUnit === ref.saleUnit);
    },
  } satisfies PriceProvider;
}

export function openPrices(dir: string, bestBuy?: ReturnType<typeof openBestBuy>, receipt?: ReturnType<typeof openReceipt>) {
  const pricePath = join(dir, "prices.json");
  const settings = openSettings(dir);
  function read<T>(file: string, schema: z.ZodType<T>, fallback: T): T {
    let text: string;
    try { text = readFileSync(file,"utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
      throw error;
    }
    return schema.parse(JSON.parse(text));
  }
  const rows = () => read(pricePath, z.array(quoteFile), []);

  return {
    book(): PriceBook {
      const all = rows();
      return {quotes:[...manualProvider(all).search(""),...bestBuy?.quotes() ?? []],preferredSellers:settings.read().preferredSellers,
        observations:all.filter(q => q.importId),...(receipt && {providers:{receipt:receipt.config,bestbuy:!!bestBuy?.enabled}})};
    },
    async bestBuy(body: unknown, library: ReturnType<typeof openLibrary>) {
      if (!bestBuy?.enabled) throw new LibraryError(403,"bestbuy","Best Buy 키가 필요합니다.");
      const action = validate(z.discriminatedUnion("action",[
        z.strictObject({action:z.literal("search"),modelRef:revisionRef,query:z.string()}),
        z.strictObject({action:z.literal("quote"),modelRef:revisionRef,product:productRef}),
      ]),body);
      checkModel(library,action.modelRef);
      const provider = bestBuy.forModel(action.modelRef);
      if (action.action === "search") return provider.search(action.query);
      await provider.quote(action.product);
      return this.book();
    },
    saveObservation(body: unknown, library: ReturnType<typeof openLibrary>) {
      const raw = validate(confirmedLine,body), checked = inspectLine(raw);
      if (checked.issues.length) throw new LibraryError(422,"row",checked.issues.join(" · "));
      const model = checkModel(library,raw.modelRef);
      const quantity = raw.quantity!;
      // 실물을 한 번에 만드는 수만 제한한다. 큰 수량의 견적도 단독으로 저장할 수 있다.
      if (raw.inventory && quantity > MAX_INVENTORY_ITEMS)
        throw new LibraryError(422,"quantity",`한 행에서 인벤토리에 추가할 수 있는 실물은 ${MAX_INVENTORY_ITEMS}개입니다.`);
      const all = rows(), prior = all.find(q => q.importId === raw.importId);
      const q = validate(quoteFile,{modelRef:raw.modelRef,seller:raw.seller,productId:raw.name,name:raw.name,saleUnit:1,quantity,
        lineTotalCents:raw.lineTotalCents,importId:raw.importId,unitPriceCents:checked.unitPriceCents,currency:"USD",provider:raw.kind,
        stock:raw.kind === "cart" ? raw.stock : "unknown",source:raw.kind === "cart" ? "사용자가 확인한 장바구니" : "사용자가 확인한 영수증",
        retrievedAt:raw.kind === "cart" ? raw.date+"T00:00:00.000Z" : prior?.retrievedAt ?? new Date().toISOString(),
        ...(raw.kind === "receipt" && {purchasedAt:raw.date})});
      if (prior && JSON.stringify(prior) !== JSON.stringify(q)) throw new LibraryError(409,"row","이 이미지 행은 다른 값으로 이미 저장했습니다.");
      const state = raw.kind === "receipt" ? "owned" as const : "candidate" as const;
      const items = Array.from({length:raw.inventory ? quantity : 0},(_,i) => ({
        instanceId:raw.kind+"-"+raw.importId+"-"+(i+1),modelId:model.modelId,revision:model.revision,alias:q.name!,state,
      }));
      // 가격 기록 뒤에 실패해도 같은 행 번호로 남은 실물을 이어서 추가할 수 있다.
      if (!prior) writeAtomic(pricePath,JSON.stringify([...all,q],null,2)+"\n");
      for (const item of items) library.saveInventoryItem(item.instanceId,item);
      return {book:this.book(),items};
    },
    saveManual(body: unknown) {
      const next = validate(quoteFile, body);
      if (next.provider !== "manual" || next.purchasedAt || next.importId || next.lineTotalCents !== undefined || next.quantity !== undefined)
        throw new LibraryError(422,"provider","수동 입력한 현재 견적이 필요합니다");
      const all = rows();
      const prior = manualProvider(all.filter(q => q.provider === "manual" && q.modelRef === next.modelRef)).quote(next);
      if (prior && Date.parse(prior.retrievedAt) > Date.parse(next.retrievedAt))
        throw new LibraryError(409,"retrievedAt","이 상품에 더 최근 견적이 있습니다");
      const updated = prior ? all.with(all.indexOf(prior), next) : [...all, next];
      writeAtomic(pricePath, JSON.stringify(updated, null, 2) + "\n");
    },
    prefer(body: unknown) {
      settings.prefer(validate(preferredSellers, body));
    },
  };
}

function checkModel(library: ReturnType<typeof openLibrary>, key: string) {
  const model = library.describe().models.find(m => m.modelId+"@"+m.revision === key);
  if (!model) throw new LibraryError(422,"modelRef","인벤토리 모델 판본을 선택하세요.");
  return model;
}
function validate<T>(schema: z.ZodType<T>, value: unknown) {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0]!;
  throw new LibraryError(422,issue.path.join("."),issue.message);
}
