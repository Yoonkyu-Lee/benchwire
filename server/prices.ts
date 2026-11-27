// 판매 상품별 수동 견적과 판매처 우선순위를 검증해 로컬 JSON에 저장한다.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { productRef, revisionRef } from "../scene/files.ts";
import { LibraryError, writeAtomic } from "./library.ts";

const money = z.int().nonnegative();
const quoteFile = productRef.extend({
  modelRef: revisionRef, unitPriceCents: money, currency: z.literal("USD"),
  stock: z.enum(["in", "out", "unknown"]), retrievedAt: z.iso.datetime({ offset: true }),
  source: z.string().trim().min(1), provider: z.string().trim().min(1), url: z.httpUrl().optional(),
  coupon: z.string().trim().min(1).optional(), discountCents: money.optional(), purchasedAt: z.iso.date().optional(),
}).refine(q => (q.discountCents ?? 0) <= q.unitPriceCents, {path:["discountCents"], message:"적용 할인은 판매가 이하여야 합니다"});
const sellers = z.array(productRef.shape.seller).refine(values => new Set(values).size === values.length, "판매처가 중복됩니다");
const settingsFile = z.looseObject({ preferredSellers: sellers.default([]) });
export type Quote = z.infer<typeof quoteFile>;
export type ProductRef = z.infer<typeof productRef>;
export interface PriceProvider {
  search(query: string): ProductRef[] | Promise<ProductRef[]>;
  quote(ref: ProductRef): Quote | undefined | Promise<Quote | undefined>;
}
export interface PriceBook { quotes: Quote[]; preferredSellers: string[] }

export function manualProvider(rows: Quote[]) {
  const current = rows.filter(row => !row.purchasedAt);
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

export function openPrices(dir: string) {
  const pricePath = join(dir, "prices.json"), settingsPath = join(dir, "settings.json");
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
  const settings = () => read(settingsPath, settingsFile, { preferredSellers: [] });
  function validate<T>(schema: z.ZodType<T>, value: unknown) {
    const result = schema.safeParse(value);
    if (result.success) return result.data;
    const issue = result.error.issues[0]!;
    throw new LibraryError(422, issue.path.join("."), issue.message);
  }
  return {
    book(): PriceBook { return {quotes:manualProvider(rows()).search(""), preferredSellers:settings().preferredSellers}; },
    saveManual(body: unknown) {
      const next = validate(quoteFile, body);
      if (next.provider !== "manual" || next.purchasedAt)
        throw new LibraryError(422,"provider","수동 입력한 현재 견적이 필요합니다");
      const all = rows();
      const prior = manualProvider(all).quote(next);
      if (prior && Date.parse(prior.retrievedAt) > Date.parse(next.retrievedAt))
        throw new LibraryError(409,"retrievedAt","이 상품에 더 최근 견적이 있습니다");
      const updated = prior ? all.with(all.indexOf(prior), next) : [...all, next];
      writeAtomic(pricePath, JSON.stringify(updated, null, 2) + "\n");
    },
    prefer(body: unknown) {
      const preferredSellers = validate(sellers, body);
      writeAtomic(settingsPath, JSON.stringify({...settings(), preferredSellers}, null, 2) + "\n");
    },
  };
}
