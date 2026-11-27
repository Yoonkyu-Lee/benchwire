// 제품 API 고정본으로 검색·선택·호출 한도와 메모리 견적의 정확한 만료 시각을 검사한다.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempDisposableSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openPrices } from "./prices.ts";
import fixture from "../fixtures/bestbuy/products.json" with {type:"json"};
import { openBestBuy, BESTBUY_TTL } from "./bestbuy.ts";

test("Best Buy의 사용자 선택 견적만 예산에 넣고 72시간 경계에서 버린다",async () => {
  let now = Date.UTC(2026,0,1);
  const urls:URL[] = [];
  const client = openBestBuy("fixture",async url => {urls.push(url); return Response.json(fixture);},() => now);
  const provider = client.forModel("demo@1");
  const found = await provider.search("demo cable");
  assert.match(decodeURIComponent(urls[0]!.pathname),/search=demo&search=cable/);
  assert.equal(found[0]!.productId,"9000001");
  assert.equal(client.quotes().length,0);
  const q = await provider.quote(found[0]!);
  assert.equal(q.unitPriceCents,1525);
  assert.equal(q.provider,"bestbuy");
  assert.match(urls[1]!.pathname,/sku=9000001/);
  now += BESTBUY_TTL - 1;
  assert.equal(client.quotes().length,1);
  now++;
  assert.equal(client.quotes().length,0);
  await assert.rejects(openBestBuy(null).forModel("demo@1").search("demo"),/키/);
  for (const status of [403,429]) await assert.rejects(openBestBuy("fixture",async () => new Response(null,{status})).forModel("demo@1").search("demo"),/호출 한도/);
});

test("Best Buy 견적을 적용한 뒤 수동 견적을 저장해도 API 콘텐츠는 디스크와 재시작한 가격 목록에 없다",async t => {
  const scratch = mkdtempDisposableSync(join("work","bestbuy-"));
  t.after(() => scratch.remove());
  const dir = scratch.path;
  const client = openBestBuy("fixture",async () => Response.json(fixture));
  const q = await client.forModel("demo@1").quote({seller:"Best Buy",productId:"9000001",saleUnit:1});
  const store = openPrices(dir,client);
  assert.equal(store.book().quotes.length,1);
  assert.throws(() => store.saveManual(q));
  store.saveManual({provider:"manual",source:"수동",modelRef:"demo@1",seller:"가상 매장",productId:"수동 상품",saleUnit:1,
    unitPriceCents:2300,currency:"USD",stock:"in",retrievedAt:"2026-11-25T00:00:00Z"});
  assert.doesNotMatch(readFileSync(join(dir,"prices.json"),"utf8"),/9000001|bestbuy|1525|연습용/);
  assert.deepEqual(openPrices(dir).book().quotes.map(row => row.provider),["manual"]);
});
