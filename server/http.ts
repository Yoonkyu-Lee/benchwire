// 루프백의 같은 출처에서 캔버스 빌드와 사용자 데이터 JSON API를 제공한다.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync, realpathSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { collect } from "./collect.ts";
import { evidence } from "./evidence.ts";
import { LibraryError, openLibrary, sceneIdPattern } from "./library.ts";
import { configuredResearchClient, openResearch } from "./research.ts";

const HOST = "127.0.0.1";
const PORT = 3210;
const ROOT = fileURLToPath(new URL("../", import.meta.url));
// 장면과 인벤토리 JSON 한 건이 서버 메모리를 차지할 수 있는 상한이다.
const JSON_LIMIT = 2 * 1024 * 1024;
const JSON_TYPE = "application/json; charset=utf-8";
const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2",
};

async function readJson(request: IncomingMessage, origin: string, limit = JSON_LIMIT): Promise<unknown> {
  if (request.headers.origin !== origin) throw new LibraryError(403, "Origin", "같은 출처에서만 저장할 수 있습니다");
  if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json")
    throw new LibraryError(415, "Content-Type", "application/json 본문이 필요합니다");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new LibraryError(413, "", `JSON 본문이 ${limit / 1024 / 1024} MiB를 넘습니다`);
    chunks.push(chunk);
  }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size))); }
  catch (error) {
    if (!(error instanceof SyntaxError || error instanceof TypeError)) throw error;
    throw new LibraryError(422, "", "JSON 문법 또는 UTF-8 인코딩이 올바르지 않습니다");
  }
}

function pathId(segment: string) {
  try { return decodeURIComponent(segment); }
  catch (error) {
    if (!(error instanceof URIError)) throw error;
    throw new LibraryError(400, "id", "주소의 ID를 읽을 수 없습니다");
  }
}

function staticFile(buildDir: string, path: string, response: ServerResponse): boolean {
  const asset = path === "/" ? "index.html" : path.slice(1);
  const segments = asset.split("/");
  const type = STATIC_TYPES[extname(asset)];
  if (!type || segments.some(segment => !/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/.test(segment))) return false;
  let content: Buffer;
  try {
    const root = realpathSync(buildDir);
    const file = realpathSync(join(root, ...segments));
    if (!file.startsWith(root + sep)) return false;
    content = readFileSync(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR" && code !== "EISDIR") throw error;
    return false;
  }
  response.writeHead(200, { "Content-Type": type });
  response.end(content);
  return true;
}

export async function startServer({ port = PORT, dataDir = join(ROOT, "userdata"), buildDir = join(ROOT, "dist", "app"),
  researchClient = configuredResearchClient(ROOT) } = {}) {
  const library = openLibrary(ROOT, dataDir);
  const research = openResearch(dataDir, library.describe().connectors, researchClient);
  async function handle(request: IncomingMessage, response: ServerResponse) {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cache-Control", "no-store");
    const host = `${HOST}:${request.socket.localPort}`;
    // 다른 호스트 이름으로 루프백에 도달한 브라우저 요청에도 개인 데이터를 내주지 않는다.
    if (request.headers.host !== host) throw new LibraryError(403, "Host", "서버의 루프백 주소로 접속해 주세요");
    const origin = "http://" + host;
    const path = request.url?.split("?", 1)[0] ?? "/";
    const method = request.method;
    if (path.startsWith("/api/evidence") && await evidence(request, response, dataDir, path, origin)) return;
    if (path === "/api/research" && (method === "GET" || method === "POST")) {
      const result = method === "GET" ? research.config : research.submit(await readJson(request, origin));
      response.writeHead(method === "GET" ? 200 : 202, { "Content-Type": JSON_TYPE }).end(JSON.stringify(result));
      return;
    }
    if (path.startsWith("/api/research/") && method === "GET") {
      const result = research.status(path.slice("/api/research/".length));
      response.writeHead(200, { "Content-Type": JSON_TYPE }).end(JSON.stringify(result));
      return;
    }
    if (path === "/api/library" && method === "GET") {
      response.writeHead(200, { "Content-Type": JSON_TYPE });
      response.end(JSON.stringify(library.describe()));
      return;
    }
    if (path === "/api/collect" && method === "POST") {
      const body = await readJson(request, origin, 16 * 1024 * 1024);
      const result = collect(dataDir, library, body, request.headers["if-match"]);
      response.writeHead(200, {"Content-Type":JSON_TYPE}).end(JSON.stringify(result));
      return;
    }
    const model = /^\/api\/models\/([^/]+)\/([^/]+)$/.exec(path);
    if (model && method === "PUT") {
      const created = library.saveModel(pathId(model[1]!), pathId(model[2]!), await readJson(request, origin));
      response.writeHead(created ? 201 : 204).end();
      return;
    }
    const inventory = /^\/api\/inventory\/([^/]+)$/.exec(path);
    if (inventory && method === "PUT") {
      const created = library.saveInventoryItem(pathId(inventory[1]!), await readJson(request, origin));
      response.writeHead(created ? 201 : 204).end();
      return;
    }
    if (path.startsWith("/api/scenes/")) {
      const id = path.slice("/api/scenes/".length);
      if (!sceneIdPattern.test(id)) throw new LibraryError(400, "id", "장면 ID는 소문자, 숫자, 밑줄, 붙임표로 입력해 주세요");
      if (method === "GET") {
        const scene = library.readScene(id);
        if (!scene) throw new LibraryError(404, "id", "장면을 찾을 수 없습니다");
        response.writeHead(200, { "Content-Type": JSON_TYPE, ETag: scene.etag }).end(scene.text);
        return;
      }
      if (method === "PUT") {
        const scene = library.saveScene(id, await readJson(request, origin), request.headers["if-match"]);
        if (scene.created) {
          response.writeHead(201, { "Content-Type": JSON_TYPE, ETag: scene.etag, Location: "/api/scenes/" + scene.id }).end(scene.text);
        } else response.writeHead(204, { ETag: scene.etag }).end();
        return;
      }
    }
    if (!path.startsWith("/api/") && (method === "GET" || method === "HEAD") && staticFile(buildDir, path, response)) return;
    throw new LibraryError(404, "", "요청한 페이지를 찾을 수 없습니다");
  }

  const server = createServer((request, response) => {
    void handle(request, response).catch(error => {
      if (!(error instanceof LibraryError)) console.error(error);
      const problem = error instanceof LibraryError ? error : new LibraryError(500, "", "서버에서 요청을 처리하지 못했습니다");
      response.writeHead(problem.status, { "Content-Type": JSON_TYPE }).end(JSON.stringify({ path: problem.path, message: problem.message }));
    });
  });
  server.listen(port, HOST);
  await once(server, "listening");
  return server;
}

if (import.meta.main) {
  await startServer();
  const url = `http://${HOST}:${PORT}/`;
  console.log("benchwire " + url);
  const windows = process.platform === "win32";
  const command = windows ? "cmd.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const browser = spawn(command, windows ? ["/d", "/c", "start", "", url] : [url], { stdio: "ignore", windowsHide: true });
  browser.on("error", () => console.log("기본 브라우저를 열 수 없습니다. 주소를 직접 열어 주세요."));
  browser.unref();
}
