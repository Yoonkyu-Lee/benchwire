// 가상 영수증에서 행 합계·수량·비용 경계와 확인한 구매 기록의 재저장을 검사한다.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempDisposableSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import response from "../fixtures/receipt/response.json" with {type:"json"};
import { inspectLine, openReceipt } from "./receipt.ts";
import { openPrices } from "./prices.ts";
import { openLibrary } from "./library.ts";
import type { ResearchClient } from "./research.ts";

const image = {consent:true, type:"image/png", data:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jI1sAAAAASUVORK5CYII="};
test("영수증 한 장의 비용을 기록하고 두 개의 행 합계 30달러를 15달러 단가로만 읽는다",async t => {
  const scratch = mkdtempDisposableSync(join("work","receipt-"));
  t.after(() => scratch.remove());
  const dir = scratch.path;
  let calls = 0;
  const client: ResearchClient = {stream(params) {
    calls++;
    assert.equal(params.tools,undefined);
    return {finalMessage:async () => ({stop_reason:"end_turn",usage:{input_tokens:500,output_tokens:200},
      content:[{type:"text",text:JSON.stringify(response)}]} as Anthropic.Message)};
  }};
  const receipt = openReceipt(dir,client);
  await assert.rejects(openReceipt(dir,null).parse(image),/키/);
  await assert.rejects(receipt.parse({...image,consent:false}));
  await assert.rejects(receipt.parse({...image,type:"image/webp"}));
  assert.equal(calls,0);
  const result = await receipt.parse(image);
  assert.equal(result.rows[0]!.unitPriceCents,1500);
  assert.equal(result.rows[0]!.lineTotalCents,3000);
  assert.equal(result.rows[0]!.issues.length,0);
  assert.match(result.rows[1]!.issues.join(" "),/합계/);
  assert.match(result.rows[2]!.warnings.join(" "),/10/);
  assert.match(result.rows[2]!.issues.join(" "),/날짜/);
  assert.equal(calls,1);
  assert.ok(result.spentUsd > 0);
  const log = readFileSync(join(dir,"receipt-usage.jsonl"),"utf8");
  assert.match(log,/inputTokens/);
  assert.ok(!log.includes(image.data) && !log.includes("연습 케이블"));
  const book = openPrices(dir);
  const library = openLibrary(".",dir);
  const confirmed = {...result.rows[0]!,modelRef:"network-copper@1",kind:result.kind,importId:result.id+"-0",inventory:true};
  const original = book.saveObservation(confirmed,library);
  const again = book.saveObservation(confirmed,library);
  assert.deepEqual(original.items,again.items);
  assert.equal(original.items.length,2);
  assert.equal(book.book().quotes.length,0);
  assert.equal(book.book().observations!.length,1);
  assert.equal(book.book().observations![0]!.purchasedAt,"2026-01-15");
  assert.equal(book.book().observations![0]!.unitPriceCents,1500);
  assert.throws(()=>book.saveObservation({...confirmed,lineTotalCents:6000},library),/합계/);
  assert.equal(inspectLine({...response.rows[0]!,stock:"unknown",currency:"EUR"}).issues.length,1);
  const cart = book.saveObservation({...confirmed,kind:"cart",importId:result.id+"-1",stock:"in",inventory:true},library);
  assert.equal(cart.items[0]!.state,"candidate");
  assert.equal(cart.book.quotes[0]!.provider,"cart");
  assert.equal(cart.book.quotes[0]!.retrievedAt,"2026-01-15T00:00:00.000Z");
  assert.equal(cart.book.quotes[0]!.purchasedAt,undefined);
  const excessive:ResearchClient = {stream:() => ({finalMessage:async () => ({
    stop_reason:"end_turn",usage:{input_tokens:50000,output_tokens:200},content:[],
  } as unknown as Anthropic.Message)})};
  await assert.rejects(openReceipt(dir,excessive).parse(image),/상한에 도달/);
  assert.match(readFileSync(join(dir,"receipt-usage.jsonl"),"utf8"),/50000/);
});
