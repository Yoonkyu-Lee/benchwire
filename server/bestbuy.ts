// 공식 Products API에서 고른 판매 상품의 견적을 72시간 동안 서버 메모리에 둔다.
import { z } from "zod";
import { LibraryError } from "./library.ts";
import type { PriceProvider, ProductRef, Quote } from "./prices.ts";

// https://developer.bestbuy.com/legal (Content의 임시 캐시는 최대 72시간)
export const BESTBUY_TTL = 72 * 60 * 60 * 1000;
const listing = z.object({sku:z.int().positive(),name:z.string().min(1),url:z.httpUrl().refine(value => {
  const u = URL.parse(value);
  return !!u && u.protocol === "https:" && !u.username && !u.password && !u.port && ["bestbuy.com","www.bestbuy.com"].includes(u.hostname);
})});
const offer = listing.extend({salePrice:z.number().nonnegative().multipleOf(0.01),onlineAvailability:z.boolean().nullable()});
type Transport = (url: URL) => Promise<Response>;
export interface BestBuyCandidate extends ProductRef {name:string;url:string;expiresAt:string}

export function openBestBuy(key: string | null, transport: Transport = url => fetch(url,{redirect:"error",cache:"no-store"}), now = Date.now) {
  const cache = new Map<string,{quote:Quote;timeout:NodeJS.Timeout}>();
  function remove(id: string) {
    const saved = cache.get(id);
    if (saved) clearTimeout(saved.timeout);
    cache.delete(id);
  }
  async function products(filter: string, fields: string) {
    if (!key) throw new LibraryError(403,"bestbuy","Best Buy 키가 필요합니다.");
    // https://bestbuyapis.github.io/api-documentation/#products-api (Products, Search, Showing Attributes)
    const url = new URL("https://api.bestbuy.com/v1/products("+filter+")");
    url.search = new URLSearchParams({format:"json",show:fields,pageSize:"12",apiKey:key}).toString();
    let response;
    try { response = await transport(url); }
    catch { throw new LibraryError(502,"bestbuy","Best Buy에 연결할 수 없습니다."); }
    if ([403,429].includes(response.status)) throw new LibraryError(429,"bestbuy","Best Buy 키 권한 또는 호출 한도를 확인하세요.");
    if (!response.ok) throw new LibraryError(502,"bestbuy","Best Buy 상품 조회에 실패했습니다.");
    try { return await response.json() as unknown; }
    catch { throw new LibraryError(502,"bestbuy","Best Buy 상품 응답을 읽을 수 없습니다."); }
  }
  return {
    enabled:!!key,
    quotes() {
      for (const [id,{quote}] of cache) if (Date.parse(quote.expiresAt!) <= now()) remove(id);
      return [...cache.values()].map(row => row.quote);
    },
    forModel(modelRef: string) {
      return {
        async search(query: string): Promise<BestBuyCandidate[]> {
          const words = query.normalize("NFKC").match(/[\p{L}\p{N}]+/gu);
          if (!words?.length || query.length > 160) throw new LibraryError(422,"query","검색할 상품명을 160자 이내로 입력하세요.");
          const body = await products(words.map(word => "search=" + encodeURIComponent(word)).join("&"),"sku,name,url");
          const data = z.object({products:z.array(listing)}).safeParse(body);
          if (!data.success) throw new LibraryError(502,"bestbuy","검색 응답의 상품 정보를 확인할 수 없습니다.");
          const expiresAt = new Date(now()+BESTBUY_TTL).toISOString();
          return data.data.products.map(p => ({seller:"Best Buy",productId:String(p.sku),saleUnit:1,name:p.name,url:p.url,expiresAt}));
        },
        async quote(ref: ProductRef) {
          if (!/^\d{1,16}$/.test(ref.productId) || !Number.isSafeInteger(ref.saleUnit) || ref.saleUnit < 1 || ref.seller !== "Best Buy")
            throw new LibraryError(422,"sku","선택한 Best Buy 상품과 판매 단위를 확인하세요.");
          const body = await products("sku="+ref.productId,"sku,name,url,salePrice,onlineAvailability");
          const data = z.object({products:z.array(offer)}).safeParse(body);
          if (!data.success) throw new LibraryError(502,"bestbuy","판매가 또는 재고 값을 확인할 수 없습니다.");
          const p = data.data.products.find(p => String(p.sku) === ref.productId);
          if (!p) throw new LibraryError(404,"sku","선택한 상품을 찾을 수 없습니다.");
          const cents = Math.round(p.salePrice*100);
          if (!Number.isSafeInteger(cents)) throw new LibraryError(502,"bestbuy","판매가의 센트 값을 확인할 수 없습니다.");
          const time = now();
          const quote: Quote = {seller:ref.seller,productId:ref.productId,saleUnit:ref.saleUnit,modelRef,provider:"bestbuy",name:p.name,source:"Best Buy Products API",
            currency:"USD",unitPriceCents:cents,stock:p.onlineAvailability === null ? "unknown" : p.onlineAvailability ? "in" : "out",
            url:p.url,retrievedAt:new Date(time).toISOString(),expiresAt:new Date(time+BESTBUY_TTL).toISOString()};
          const id = JSON.stringify([modelRef,ref.productId,ref.saleUnit]);
          remove(id);
          cache.set(id,{quote,timeout:setTimeout(() => remove(id),BESTBUY_TTL).unref()});
          return quote;
        },
      } satisfies PriceProvider;
    },
  };
}
