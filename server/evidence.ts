// 검증 메모·사진을 내용 해시로 저장하고 허용한 이미지 형식으로만 읽어 준다.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { sceneFile } from "../scene/files.ts";
import { LibraryError, writeAtomic } from "./library.ts";

const LIMIT = 2 * 1024 * 1024;
const NOTE_LIMIT = 280;
// 메모와 멀티파트 경계에 허용하는 여유다.
const BODY_LIMIT = LIMIT + 4096;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const JPEG = Buffer.from([255, 216, 255]);
const FORMATS = ["image/png", "image/jpeg", "image/webp"];

function imageType(bytes: Buffer) {
  if (bytes.length >= 45 && bytes.subarray(0, 8).equals(PNG) && bytes.readUInt32BE(8) === 13
    && bytes.toString("ascii", 12, 16) === "IHDR" && bytes.toString("ascii", bytes.length - 8, bytes.length - 4) === "IEND") return "image/png";
  if (bytes.length >= 5 && bytes.subarray(0, 3).equals(JPEG) && bytes.at(-2) === 255 && bytes.at(-1) === 217) return "image/jpeg";
  if (bytes.length >= 16 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP"
    && bytes.readUInt32LE(4) + 8 === bytes.length && ["VP8 ", "VP8L", "VP8X"].includes(bytes.toString("ascii", 12, 16))) return "image/webp";
  return undefined;
}

export function removeUnlinkedEvidence(dataDir: string, savedScenes: readonly string[]) {
  const root = join(dataDir, "evidence");
  let files;
  try { files = readdirSync(root, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const linked = new Set<string>();
  for (const text of savedScenes) {
    let json: unknown;
    try { json = JSON.parse(text); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return;
    }
    const parsed = sceneFile.safeParse(json);
    // 읽을 수 없는 장면이 있으면 그 장면의 첨부도 보존한다.
    if (!parsed.success) return;
    for (const { locator } of parsed.data.sources) {
      if (!locator.startsWith("verification:")) continue;
      const params = new URLSearchParams(locator.slice("verification:".length));
      for (const key of ["photo", "evidence"]) {
        const id = /^\/api\/evidence\/([a-f0-9]{64})$/.exec(params.get(key) ?? "")?.[1];
        if (id) linked.add(id);
      }
    }
  }
  for (const file of files) {
    const id = /^([a-f0-9]{64})(?:\.txt)?$/.exec(file.name)?.[1];
    if (file.isFile() && id && !linked.has(id)) unlinkSync(join(root, file.name));
  }
}

export async function evidence(request: IncomingMessage, response: ServerResponse, dataDir: string, path: string, origin: string) {
  const root = join(dataDir, "evidence");
  if (path === "/api/evidence" && request.method === "POST") {
    if (request.headers.origin !== origin) throw new LibraryError(403, "Origin", "같은 출처에서만 저장할 수 있습니다");
    const type = request.headers["content-type"];
    if (!type?.startsWith("multipart/form-data;")) throw new LibraryError(415, "증거", "멀티파트 양식으로 증거를 첨부하세요");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > BODY_LIMIT) throw new LibraryError(413, "사진", "사진은 2 MiB까지 첨부할 수 있습니다");
      chunks.push(chunk);
    }
    const upload = new Request(origin + path, { method: "POST", headers: { "Content-Type": type }, body: Buffer.concat(chunks, size) });
    let fields: Awaited<ReturnType<Request["formData"]>>;
    try { fields = await upload.formData(); }
    catch (error) {
      if (!(error instanceof TypeError)) throw error;
      throw new LibraryError(422, "증거", "첨부 양식을 읽을 수 없습니다");
    }
    const note = fields.get("note") ?? "";
    const photo = fields.get("photo");
    if (typeof note !== "string" || note.length > NOTE_LIMIT) throw new LibraryError(422, "메모", "메모는 280자까지 입력하세요");
    if ([...fields.keys()].some(key => key !== "note" && key !== "photo") ||
      fields.getAll("note").length > 1 || fields.getAll("photo").length > 1 || (!note && photo === null))
      throw new LibraryError(422, "증거", "짧은 메모와 사진 한 장을 첨부할 수 있습니다");
    if (typeof photo === "string" || photo && !FORMATS.includes(photo.type))
      throw new LibraryError(415, "사진", "PNG, JPEG, WebP 사진을 첨부하세요");
    if (photo && photo.size > LIMIT) throw new LibraryError(413, "사진", "사진은 2 MiB까지 첨부할 수 있습니다");
    const bytes = photo && Buffer.from(await photo.arrayBuffer());
    if (photo && (!bytes || imageType(bytes) !== photo.type))
      throw new LibraryError(422, "사진", "선택한 파일의 이미지 형식을 확인할 수 없습니다");
    const id = createHash("sha256").update(JSON.stringify(note)).update(bytes ?? "").digest("hex");
    for (const [file, content] of [[id + ".txt", note], [id, bytes]] as const) {
      if (!content) continue;
      try { writeAtomic(join(root, file), content, true); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    response.writeHead(201, { Location: "/api/evidence/" + id }).end();
    return true;
  }
  const id = /^\/api\/evidence\/([a-f0-9]{64})$/.exec(path)?.[1];
  if (id && request.method === "GET") {
    const file = join(root, id);
    let bytes: Buffer | undefined;
    try {
      const stat = lstatSync(file);
      if (stat.isFile() && stat.size <= LIMIT) bytes = readFileSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const type = bytes && imageType(bytes);
    if (!type) throw new LibraryError(404, "사진", "첨부 사진을 찾을 수 없습니다");
    response.writeHead(200, { "Content-Type": type, "Content-Security-Policy": "default-src 'none'; sandbox" }).end(bytes);
    return true;
  }
  return false;
}
