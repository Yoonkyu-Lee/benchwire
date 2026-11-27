// 루프백 HTTP에서 예제의 두 흐름, 저장의 재개와 충돌, 요청·파일 경계를 확인한다.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { request, type Server } from "node:http";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import type { z } from "zod";
import { plugins } from "../domains/registry.ts";
import { evaluate } from "../engine/evaluate.ts";
import type { sceneFile } from "../scene/files.ts";
import { loadSceneDocuments } from "../scene/load.ts";
import { startServer } from "./http.ts";
import type { openLibrary } from "./library.ts";
import { manualProvider, type PriceBook } from "./prices.ts";

type LibraryDocument = ReturnType<ReturnType<typeof openLibrary>["describe"]>;
type SceneDocument = z.input<typeof sceneFile>;

function workspace(t: TestContext) {
  const work = resolve("work");
  mkdirSync(work, { recursive: true });
  const dir = mkdtempSync(join(work, "server-test-"));
  const running = new Set<Server>();
  t.after(async () => {
    for (const server of running) await close(server);
    rmSync(dir, { recursive: true, force: true });
  });
  const dataDir = join(dir, "userdata");
  const buildDir = join(dir, "dist");

  async function close(server: Server) {
    await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done()));
    running.delete(server);
  }

  async function open() {
    const server = await startServer({ port: 0, dataDir, buildDir });
    running.add(server);
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    const get = (path: string) => fetch(origin + path);
    function put(path: string, body: unknown, tag?: string) {
      const headers = new Headers({ Origin: origin, "Content-Type": "application/json" });
      if (tag !== undefined) headers.set("If-Match", tag);
      return fetch(origin + path, { method: "PUT", headers, body: JSON.stringify(body) });
    }
    return { address, origin, get, put, close: () => close(server) };
  }

  return { dataDir, buildDir, open };
}

test("T9 수동 견적·우선순위는 재시작 뒤 유지되고 품절·묶음·판매처가 구별되며 잘못된 입력은 원본을 보존한다", async t => {
  const files = workspace(t);
  const first = await files.open();
  const q = {modelRef:"cable@1", seller:"첫째", productId:"SKU-1", unitPriceCents:2050, saleUnit:1,
    currency:"USD", stock:"in", retrievedAt:"2026-01-02T01:00:00Z", source:"매장 확인", provider:"manual"};
  const save = (quote:unknown) => first.put("/api/prices",quote);
  assert.equal((await first.get("/api/prices")).status,200);
  for (const row of [q,{...q,saleUnit:2},{...q,seller:"둘째"}]) assert.equal((await save(row)).status,200);
  assert.equal((await save({...q,stock:"out"})).status,200);
  assert.equal((await save({...q,retrievedAt:"2025-01-01T01:00:00Z"})).status,409);
  for (const fields of [{currency:"EUR"},{unitPriceCents:0.1},{saleUnit:0},{discountCents:3000},{url:"file:///hidden"},
    {retrievedAt:"어제"},{provider:"bestbuy"},{modelRef:"../escape@1"}])
    assert.equal((await save({...q,...fields})).status,422);
  assert.equal((await fetch(first.origin+"/api/prices",{method:"PUT",body:JSON.stringify(q)})).status,403);
  writeFileSync(join(files.dataDir,"settings.json"),JSON.stringify({language:"ko"}));
  assert.equal((await first.put("/api/prices/preferences",["둘째","첫째"])).status,200);
  assert.equal((await first.put("/api/prices/preferences",["둘째","둘째"])).status,422);
  await first.close();
  const app = await files.open();
  const book = await (await app.get("/api/prices")).json() as PriceBook;
  assert.deepEqual(book.preferredSellers,["둘째","첫째"]);
  assert.equal(book.quotes.length,3);
  assert.equal(book.quotes[0]!.stock,"out");
  const manual = manualProvider(book.quotes);
  const [bundle] = manual.search("sku-1").filter(q => q.saleUnit === 2);
  assert.ok(bundle);
  assert.equal(manual.quote(bundle)?.unitPriceCents,2050);
  assert.equal(JSON.parse(readFileSync(join(files.dataDir,"settings.json"),"utf8")).language,"ko");
});

test("처음 도움말만 기억하고 판매처 우선순위와 기존 설정을 함께 보존한다", async t => {
  const files = workspace(t);
  const app = await files.open();
  const path = "/api/settings/help";
  assert.deepEqual(await (await app.get(path)).json(), { helpDismissed: false });
  assert.equal((await app.put("/api/prices/preferences", ["판매처 A"])).status, 200);
  const file = join(files.dataDir, "settings.json");
  const read = () => JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...read(), language: "ko" }));

  for (const body of [{ helpDismissed: false }, { helpDismissed: true, preferredSellers: [] }])
    assert.equal((await app.put(path, body)).status, 422);
  assert.equal((await fetch(app.origin + path, { method: "PUT", body: '{"helpDismissed":true}' })).status, 403);
  assert.deepEqual(await (await app.get(path)).json(), { helpDismissed: false });
  for (let i = 0; i < 2; i++) assert.equal((await app.put(path, { helpDismissed: true })).status, 204);
  assert.deepEqual(read(), { language: "ko", preferredSellers: ["판매처 A"], helpDismissed: true });

  await app.close();
  const reopened = await files.open();
  assert.deepEqual(await (await reopened.get(path)).json(), { helpDismissed: true });
  assert.equal((await reopened.put("/api/prices/preferences", ["판매처 B"])).status, 200);
  assert.deepEqual(read(), { language: "ko", preferredSellers: ["판매처 B"], helpDismissed: true });
});

test("T9 장면 저장은 없는 실물·연결, 음수 상한, 분수 구매 수량을 필드 위치에서 거절한다", async t => {
  const app = await workspace(t).open();
  const doc = await (await app.get("/api/scenes/network")).json() as SceneDocument;
  for (const [field,value] of [["purchases",[{instanceId:"없는 실물"}]],["budget",-1],
    ["purchases",[{modelRef:"x@1",quantity:0.5}]],["purchases",[{instanceId:doc.items[0]!.instanceId,
      need:{connection:"없는 연결",capability:"결합"}}]]] as const) {
    const res = await app.put("/api/scenes/pricing",{...doc,sceneId:"pricing",
      scenarios:[{...doc.scenarios[0],[field]:value}]});
    assert.equal(res.status,422);
    assert.match((await res.json() as {path:string}).path,new RegExp("scenarios.0."+field));
  }
});

test("T7 새 라이브러리의 읽기 전용 예제에서 같은 케이블에 900 Mbps와 12 W가 흐르고 사본은 재시작 뒤에도 열린다", async t => {
  const files = workspace(t);
  const fixture = readFileSync("fixtures/example/scene.json", "utf8");
  const first = await files.open();
  const libraryResponse = await first.get("/api/library");
  assert.equal(libraryResponse.status, 200);
  const library = await libraryResponse.json() as LibraryDocument;
  assert.equal(library.defaultSceneId, "network");
  assert.deepEqual(library.scenes.map(({ id, example }) => [id, example]),
    [["network", true], ["t2-alt-mode", true], ["three-ports", true]]);
  const examples = await Promise.all(library.scenes.map(async ({ id }) => (await first.get("/api/scenes/" + id)).json() as Promise<SceneDocument>));
  for (const item of examples.flatMap(scene => scene.items)) {
    assert.match(item.alias!, /[가-힣]/);
    assert.deepEqual(library.inventory.find(row => row.instanceId === item.instanceId), { ...item, state: "owned" });
  }
  assert.equal(library.connectors.connectors.find(connector => connector.id === "network-socket")?.glyph, "rj45");
  const path = "/api/scenes/" + library.defaultSceneId;
  const exampleResponse = await first.get(path);
  assert.equal(exampleResponse.status, 200);
  const tag = exampleResponse.headers.get("etag")!;
  assert.ok(tag);
  const example = await exampleResponse.json() as SceneDocument;
  assert.deepEqual(example, JSON.parse(fixture));
  const models = new Map(library.models.map(model => [model.modelId + "@" + model.revision, model]));
  const scene = loadSceneDocuments(example, { models, connectors: library.connectors }, plugins);
  const result = evaluate(scene, plugins);
  const poe = scene.connections.findIndex(row => row.id === "poe");
  const rows = result.resourceUsage.filter(row => row.resourceKind === "link" && row.used && row.scenario === 0 &&
    result.linkResources[row.resource]?.connection === poe);
  assert.deepEqual(rows.map(row => [row.unit, row.used]).sort(), [["Mbps", 900], ["W", 12]]);
  assert.ok(rows.every(row => row.reasonRows.length > 0));

  const edited = { ...example, layout: { viewport: { cx: 10, cy: 20, zoom: 2 } } };
  assert.equal((await first.put(path, edited)).status, 428);
  const created = await first.put(path, edited, tag);
  assert.equal(created.status, 201);
  const copy = await created.json() as SceneDocument;
  const copyPath = created.headers.get("location")!;
  const copyTag = created.headers.get("etag");
  assert.equal(copyPath, "/api/scenes/" + copy.sceneId);
  assert.notEqual(copy.sceneId, example.sceneId);
  assert.deepEqual(copy, { ...edited, sceneId: copy.sceneId });
  assert.ok(copyTag && copyTag !== tag);
  assert.deepEqual(await (await first.get(path)).json(), example);
  assert.equal(readFileSync("fixtures/example/scene.json", "utf8"), fixture);

  await first.close();
  const reopened = await files.open();
  const choices = await (await reopened.get("/api/library")).json() as LibraryDocument;
  assert.equal(choices.defaultSceneId, copy.sceneId);
  assert.deepEqual(choices.scenes.map(({ id, example }) => [id, example]),
    [...library.scenes.map(({ id, example }) => [id, example]), [copy.sceneId, false]]);
  const saved = await reopened.get(copyPath);
  assert.deepEqual(await saved.json(), copy);
  assert.equal(saved.headers.get("etag"), copyTag);
});

test("T8 퀘스트 증거는 같은 출처의 짧은 메모와 제한된 이미지 한 장만 저장한다", async t => {
  const files = workspace(t);
  const server = await files.open();
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nm6kAAAAASUVORK5CYII=", "base64");
  function submit(body: FormData, origin = server.origin) {
    return fetch(server.origin + "/api/evidence", { method: "POST", headers: { Origin: origin }, body });
  }
  function photo(bytes: Uint8Array<ArrayBuffer>, type: string) {
    const body = new FormData();
    body.set("photo", new Blob([bytes], { type }), "filename.png");
    return body;
  }
  const valid = photo(Uint8Array.from(png), "image/png");
  valid.set("note", "측정 메모");
  assert.equal((await submit(valid, "http://localhost")).status, 403);
  assert.equal((await submit(photo(new TextEncoder().encode("<html>"), "image/png"))).status, 422);
  assert.equal((await submit(photo(new TextEncoder().encode("<svg/>"), "image/svg+xml"))).status, 415);
  assert.equal((await submit(photo(new Uint8Array(2 * 1024 * 1024 + 1), "image/png"))).status, 413);
  const duplicate = photo(Uint8Array.from(png), "image/png");
  duplicate.append("photo", duplicate.get("photo")!);
  assert.equal((await submit(duplicate)).status, 422);
  const saved = await submit(valid);
  assert.equal(saved.status, 201);
  const location = saved.headers.get("Location")!;
  assert.equal(location, (await submit(valid)).headers.get("Location"));
  const stored = await server.get(location);
  assert.equal(stored.headers.get("Content-Type"), "image/png");
  assert.deepEqual(Buffer.from(await stored.arrayBuffer()), png);
  const hash = location.split("/").at(-1)!;
  assert.deepEqual(readdirSync(join(files.dataDir, "evidence")).sort(), [hash, hash + ".txt"]);
  assert.equal(readFileSync(join(files.dataDir, "evidence", hash + ".txt"), "utf8"), "측정 메모");
});


test("T8 재시작 때 저장 중인 증거를 지키고 사용자가 고른 미사용 증거만 정리한다", async t => {
  const files = workspace(t);
  const server = await files.open();
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nm6kAAAAASUVORK5CYII=", "base64");
  async function attach(note: string) {
    const body = new FormData();
    body.set("note", note);
    body.set("photo", new Blob([Uint8Array.from(png)], { type: "image/png" }), "photo.png");
    const response = await fetch(server.origin + "/api/evidence", { method: "POST", headers: { Origin: server.origin }, body });
    assert.equal(response.status, 201);
    return response.headers.get("Location")!;
  }
  const kept = await attach("저장 성공");
  const orphan = await attach("장면 저장 실패");
  const example = await (await server.get("/api/scenes/network")).json() as SceneDocument;
  const source = (photo: string) => ({ id: "verification", title: "검증 퀘스트", retrievedAt: "2026-11-27",
    locator: "verification:" + new URLSearchParams({ photo }) });
  const scene = { ...example, sceneId: "evidence-kept", sources: [...example.sources, source(kept)] };
  const saved = await server.put("/api/scenes/evidence-kept", scene);
  assert.equal(saved.status, 201);
  const failed = await server.put("/api/scenes/evidence-kept", { ...scene, sources: [...example.sources, source(orphan)] }, '"expired"');
  assert.equal(failed.status, 412);
  const pending = await attach("장면 저장 전");
  const link = await attach("미리보기 후 참조");
  await server.close();
  const restarted = await files.open();
  assert.equal((await restarted.get(kept)).status, 200);
  assert.equal((await restarted.get(pending)).status, 200);
  assert.equal((await restarted.get(orphan)).status, 200);
  const ids = [orphan, link].map(path => path.split("/").at(-1)!);
  const listing = await restarted.get("/api/evidence/unused");
  assert.equal(listing.status, 200);
  const unused = await listing.json() as { id: string; note?: string }[];
  assert.deepEqual(unused.find(row => row.id === ids[0]), { id: ids[0], note: "장면 저장 실패", photo: true });
  assert(!unused.some(row => row.id === kept.split("/").at(-1)));
  const update = await restarted.put("/api/scenes/evidence-kept", { ...scene, sources: [...scene.sources,
    { ...source(pending), id: "pending" }, { ...source(link), id: "linked-later" }] }, saved.headers.get("ETag")!);
  assert.equal(update.status, 204);
  function clean(selected: string[], origin = restarted.origin) {
    return fetch(restarted.origin + "/api/evidence/unused", { method: "POST", headers: { Origin: origin,
      "Content-Type": "application/json" }, body: JSON.stringify({ ids: selected }) });
  }
  assert.equal((await clean(ids, "https://example.invalid")).status, 403);
  assert.equal((await clean(["../사진"])).status, 422);
  assert.equal((await clean(ids)).status, 204);
  assert.equal((await restarted.get(orphan)).status, 404);
  assert.equal((await restarted.get(link)).status, 200);
  assert.equal((await restarted.get(pending)).status, 200);
  const filesKept = [kept, link, pending].flatMap(path => {
    const id = path.split("/").at(-1)!;
    return [id, id + ".txt"];
  });
  assert.deepEqual(readdirSync(join(files.dataDir, "evidence")).sort(), filesKept.sort());
});

test("같은 ETag를 읽은 두 탭 중 한 저장만 성공하고 잘못된 장면은 원본을 보존한다", async t => {
  const files = workspace(t);
  const { get, put } = await files.open();
  const example = await (await get("/api/scenes/network")).json() as SceneDocument;
  const path = "/api/scenes/my-network";
  const draft = { ...example, sceneId: "my-network" };
  assert.equal((await get(path)).status, 404);
  assert.equal((await put(path, draft, '"unknown"')).status, 412);
  assert.equal((await put(path, draft)).status, 201);
  const [a, b] = await Promise.all([get(path), get(path)]);
  const oldTag = a.headers.get("etag")!;
  assert.equal(b.headers.get("etag"), oldTag);
  const candidates = [1, 2].map(cx => ({ ...draft, layout: { viewport: { cx, cy: 0, zoom: 1 } } }));
  const updates = await Promise.all(candidates.map(candidate => put(path, candidate, oldTag)));
  assert.deepEqual(updates.map(update => update.status).sort(), [204, 412]);
  const winner = updates.findIndex(update => update.status === 204);
  const newTag = updates[winner]!.headers.get("etag")!;
  assert.ok(newTag && newTag !== oldTag);

  const expected = candidates[winner]!;
  const malformed = { ...expected, layout: { placements: [{ instanceId: "missing", x: 0, y: 0 }] } };
  const rejected = await put(path, malformed, newTag);
  assert.equal(rejected.status, 422);
  assert.equal((await rejected.json() as { path: string }).path, "layout.placements.0.instanceId");
  const mismatched = await put(path, { ...expected, sceneId: "other" }, newTag);
  assert.equal(mismatched.status, 422);
  assert.equal((await mismatched.json() as { path: string }).path, "sceneId");
  const saved = await get(path);
  assert.equal(saved.headers.get("etag"), newTag);
  assert.deepEqual(await saved.json(), expected);
  assert.deepEqual(readdirSync(join(files.dataDir, "scenes")), ["scene-my-network.json"]);
});

test("장면 ID 순서와 관계없이 마지막으로 저장한 사용자 장면을 기본으로 연다", async t => {
  const files = workspace(t);
  const { get, put, close } = await files.open();
  const example = await (await get("/api/scenes/network")).json() as SceneDocument;
  const first = await put("/api/scenes/a-first", { ...example, sceneId: "a-first" });
  assert.equal(first.status, 201);
  utimesSync(join(files.dataDir, "scenes", "scene-a-first.json"), 1, 1);
  assert.equal((await put("/api/scenes/z-last", { ...example, sceneId: "z-last" })).status, 201);
  assert.equal((await (await get("/api/library")).json() as LibraryDocument).defaultSceneId, "z-last");
  utimesSync(join(files.dataDir, "scenes", "scene-z-last.json"), 2, 2);
  assert.equal((await put("/api/scenes/a-first", { ...example, sceneId: "a-first", layout: {} }, first.headers.get("ETag")!)).status, 204);
  await close();
  const restarted = await files.open();
  assert.equal((await (await restarted.get("/api/library")).json() as LibraryDocument).defaultSceneId, "a-first");
});

test("서버는 루프백에만 바인딩하고 외부 출처·호스트·경로 조각을 거절한다", async t => {
  const { address, origin, get, put } = await workspace(t).open();
  assert.equal(address.address, "127.0.0.1");
  const inventoryPath = "/api/inventory/owned-device";
  for (const foreign of ["https://example.invalid", origin + "0", "null", undefined]) {
    const headers = new Headers({ "Content-Type": "application/json" });
    if (foreign !== undefined) headers.set("Origin", foreign);
    const response = await fetch(origin + inventoryPath, { method: "PUT", headers, body: "{}" });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  }
  const preflight = await fetch(origin + inventoryPath, { method: "OPTIONS", headers: { Origin: "https://example.invalid" } });
  assert.equal(preflight.status, 404);
  assert.equal(preflight.headers.get("access-control-allow-origin"), null);
  assert.equal((await get("/api/scenes/a%2fb")).status, 400);
  assert.equal((await put("/api/scenes/a%5cb", {})).status, 400);
  const rawGet = (path: string, host: string) => new Promise<number | undefined>((done, fail) => {
    const req = request(origin, { path, headers: { Host: host } }, response => {
      response.resume();
      response.on("end", () => done(response.statusCode));
    });
    req.on("error", fail).end();
  });
  assert.equal(await rawGet("/api/scenes/../inventory.json", new URL(origin).host), 400);
  assert.equal(await rawGet("/api/library", "external.invalid"), 403);
});

test("인벤토리는 한 실물의 판본과 ID를 검증하고 잘못된 요청과 큰 본문을 거절한다", async t => {
  const files = workspace(t);
  const first = await files.open();
  const path = "/api/inventory/owned-device";
  const before = await (await first.get("/api/library")).json() as LibraryDocument;
  const { modelId, revision } = before.models[0]!;
  const item = { instanceId: "owned-device", modelId, revision, alias: "내 장치", state: "owned" };
  assert.equal((await first.put(path, item)).status, 201);
  for (const [body, field] of [
    [{ ...item, state: "unknown" }, "state"],
    [{ ...item, revision: "missing" }, "revision"],
    [{ ...item, instanceId: "other" }, "instanceId"],
  ]) {
    const invalid = await first.put(path, body);
    assert.equal(invalid.status, 422);
    assert.equal((await invalid.json() as { path: string }).path, field);
  }
  const conflict = await first.put(path, { ...item, alias: "다른 장치" });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json() as { path: string }).path, "instanceId");
  const rawPut = (body: string, contentType: string) => fetch(first.origin + path, {
    method: "PUT", headers: { Origin: first.origin, "Content-Type": contentType }, body,
  });
  assert.equal((await rawPut("{}", "text/plain")).status, 415);
  assert.equal((await rawPut("{", "application/json")).status, 422);
  assert.equal((await rawPut(" ".repeat(2 * 1024 * 1024 + 1), "application/json")).status, 413);
  await first.close();
  const reopened = await files.open();
  const library = await (await reopened.get("/api/library")).json() as LibraryDocument;
  assert.deepEqual(library.inventory, [...before.inventory, item]);
  assert.deepEqual(readdirSync(files.dataDir), ["inventory.json"]);
});

test("빌드가 없으면 404를 반환하고 빌드 디렉터리의 캔버스와 자산을 제공한다", async t => {
  const files = workspace(t);
  const { get } = await files.open();
  const empty = await get("/");
  assert.equal(empty.status, 404);
  mkdirSync(join(files.buildDir, "assets"), { recursive: true });
  writeFileSync(join(files.buildDir, "index.html"), '<script type="module" src="/assets/app.js"></script>');
  writeFileSync(join(files.buildDir, "assets", "app.js"), "export const app = true;");
  const index = await get("/");
  assert.match(index.headers.get("content-type")!, /^text\/html/);
  assert.match(await index.text(), /assets\/app\.js/);
  const asset = await get("/assets/app.js");
  assert.match(asset.headers.get("content-type")!, /javascript/);
  assert.equal(await asset.text(), "export const app = true;");
  assert.equal((await get("/package.json")).status, 404);
});

test("실물 재시도와 모델 재저장은 멱등이며 고정한 판본과 지역 참조를 지킨다", async t => {
  const files = workspace(t);
  const first = await files.open();
  const model = { ...JSON.parse(readFileSync("fixtures/power/receiver@1.json", "utf8")), modelId: "수동-수전", revision: "1" };
  const path = "/api/models/" + encodeURIComponent(model.modelId) + "/1";
  const bad = { ...model, ports: model.ports.map((port: { attachment: object }) => ({
    ...port, attachment: { ...port.attachment, value: "missing" },
  })) };
  const invalid = await first.put(path, bad);
  assert.equal(invalid.status, 422);
  assert.match((await invalid.json() as { path: string }).path, /ports\.0\.attachment/);
  assert.equal((await first.put(path, { ...model, revision: "2" })).status, 422);
  assert.equal((await first.put(path, model)).status, 201);
  assert.equal((await first.put(path, model)).status, 204);
  const conflict = await first.put(path, { ...model, name: "다른 이름" });
  assert.equal(conflict.status, 409);
  assert.match((await conflict.json() as { message: string }).message, /새 판본/);
  assert.equal((await first.put(path.replace(/1$/, "2"), { ...model, revision: "2" })).status, 201);

  const item = { instanceId: "manual-receiver", modelId: model.modelId, revision: model.revision, state: "owned" };
  const itemPath = "/api/inventory/" + item.instanceId;
  assert.equal((await first.put(itemPath, { ...item, revision: "missing" })).status, 422);
  const attempts = await Promise.all([first.put(itemPath, item), first.put(itemPath, item)]);
  assert.deepEqual(attempts.map(receipt => receipt.status).sort(), [201, 204]);
  await first.close();
  const restarted = await files.open();
  assert.equal((await restarted.put(path, model)).status, 204);
  assert.equal((await restarted.put(path, { ...model, name: "다른 이름" })).status, 409);
  const library = await (await restarted.get("/api/library")).json() as LibraryDocument;
  assert.deepEqual(library.models.filter(m => m.modelId === model.modelId).map(m => [m.name, m.revision]),
    [[model.name, "1"], [model.name, "2"]]);
  assert.equal(library.inventory.filter(i => i.instanceId === item.instanceId).length, 1);
});
