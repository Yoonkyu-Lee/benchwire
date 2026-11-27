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
  for (const foreign of ["https://example.invalid", origin + "0", "null", undefined]) {
    const headers = new Headers({ "Content-Type": "application/json" });
    if (foreign !== undefined) headers.set("Origin", foreign);
    const response = await fetch(origin + "/api/inventory", { method: "PUT", headers, body: "[]" });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  }
  const preflight = await fetch(origin + "/api/inventory", { method: "OPTIONS", headers: { Origin: "https://example.invalid" } });
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

test("인벤토리는 판본과 실물 ID를 검증한 뒤 저장하며 잘못된 요청과 큰 본문을 거절한다", async t => {
  const files = workspace(t);
  const first = await files.open();
  const path = "/api/inventory";
  const { models } = await (await first.get("/api/library")).json() as LibraryDocument;
  const { modelId, revision } = models[0]!;
  const item = { instanceId: "owned-device", modelId, revision, alias: "내 장치", state: "owned" };
  assert.equal((await first.put(path, [item])).status, 204);
  for (const [body, field] of [
    [[{ ...item, state: "unknown" }], "0.state"],
    [[{ ...item, revision: "missing" }], "0.revision"],
    [[item, item], "1.instanceId"],
  ]) {
    const invalid = await first.put(path, body);
    assert.equal(invalid.status, 422);
    assert.equal((await invalid.json() as { path: string }).path, field);
  }
  const rawPut = (body: string, contentType: string) => fetch(first.origin + path, {
    method: "PUT", headers: { Origin: first.origin, "Content-Type": contentType }, body,
  });
  assert.equal((await rawPut("[]", "text/plain")).status, 415);
  assert.equal((await rawPut("[", "application/json")).status, 422);
  assert.equal((await rawPut(" ".repeat(2 * 1024 * 1024 + 1), "application/json")).status, 413);
  await first.close();
  const reopened = await files.open();
  const library = await (await reopened.get("/api/library")).json() as LibraryDocument;
  assert.deepEqual(library.inventory, [item]);
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
