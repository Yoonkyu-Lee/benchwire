// 저장소 약속을 기계로 확인하는 게이트. 글로 된 금지보다 이 검사가 먼저다(AGENTS.md).
// FAIL은 합치기를 막고 WARN은 보고에서 답한다. 검사는 같은 교정을 두 번 했을 때 더한다.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { posix } from "node:path";

export type Finding = { level: "FAIL" | "WARN"; path: string; line: number; message: string };

const SOURCE = /\.(ts|tsx|mjs|ps1)$/;
const BINARY = /\.(png|jpe?g|gif|ico|webp|woff2?)$/i;
// 개념이 아닌 모음 이름(AGENTS.md 평평한 배치).
const GRAB_BAGS = new Set(["common", "utils", "util", "helpers", "helper", "shared", "misc"]);
// 플러그인이 엔진에서 읽는 유일한 파일(SPEC 5.2, T10).
const CONTRACT = "engine/contract.ts";
// 플러그인도 엔진과 함께 브라우저에서 돈다. 가져올 수 있는 패키지는 이 목록뿐이다.
const DOMAIN_PACKAGES = new Set(["zod"]);
const EXCUSE = /\b(TODO|FIXME|HACK|XXX|for now|workaround)\b|일단|임시로|나중에/i;
// 키 모양. 이 파일이 스스로 걸리지 않게 나눠 쓴다.
const SECRET = new RegExp("sk-" + "ant-[A-Za-z0-9_-]{16,}");
const IMPORT = /\b(?:import|export)\s[^'";]*?\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

export function checkHeader(path: string, text: string): Finding[] {
  const first = text.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
  const ok = first.startsWith(path.endsWith(".ps1") ? "#" : "//");
  return ok ? [] : [{ level: "FAIL", path, line: 1, message: "파일은 역할을 적은 주석 한 줄로 시작한다" }];
}

export function checkName(path: string): Finding[] {
  const parts = path.split("/").map((p) => p.replace(/(\.test)?\.[a-z0-9]+$/i, "").toLowerCase());
  const bag = parts.find((p) => GRAB_BAGS.has(p));
  return bag === undefined ? [] : [{ level: "FAIL", path, line: 1, message: `'${bag}'는 개념이 아닌 모음 이름이다. 그것을 쓰는 개념의 모듈에 둔다` }];
}

export function checkImports(path: string, text: string): Finding[] {
  const out: Finding[] = [];
  const isTest = path.endsWith(".test.ts");
  const domain = /^domains\/([^/]+)\//.exec(path)?.[1];
  for (const m of text.matchAll(IMPORT)) {
    const spec = m[1] ?? m[2] ?? m[3] ?? "";
    const target = spec.startsWith(".") ? posix.join(posix.dirname(path), spec) : spec;
    const line = lineOf(text, m.index);
    // 엔진은 의존성 없이 브라우저 · CLI · 시험에서 같이 돈다. 플러그인 · 화면 · 서버 · node: 모듈 · 패키지를 모른다.
    if (path.startsWith("engine/") && !isTest && !target.startsWith("engine/"))
      out.push({ level: "FAIL", path, line, message: `엔진이 '${target}'를 가져온다. 엔진은 엔진 안의 파일만 읽는다` });
    if (domain !== undefined && spec.startsWith(".") && target !== CONTRACT && !target.startsWith(`domains/${domain}/`))
      out.push({ level: "FAIL", path, line, message: `영역 '${domain}'이 '${target}'를 가져온다. 플러그인은 ${CONTRACT}와 자기 폴더만 읽는다` });
    if (domain !== undefined && !isTest && !spec.startsWith(".") && !DOMAIN_PACKAGES.has(spec))
      out.push({ level: "FAIL", path, line, message: `영역 '${domain}'이 '${spec}'를 가져온다. 플러그인은 브라우저에서도 돌므로 ${[...DOMAIN_PACKAGES].join(", ")}만 가져온다` });
  }
  return out;
}

export function checkDeviceNames(path: string, text: string, names: readonly string[]): Finding[] {
  if (!/^(engine|domains)\//.test(path)) return [];
  const out: Finding[] = [];
  for (const name of names) {
    const m = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").exec(text);
    if (m) out.push({ level: "FAIL", path, line: lineOf(text, m.index), message: `카탈로그의 기기 이름 '${name}'이 코드에 있다. 기기 지식은 아이템 데이터로 둔다` });
  }
  return out;
}

type Manifest = { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

export function checkDependencies(pkg: Manifest, readme: string): Finding[] {
  const names = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
  return names
    .filter((n) => !readme.includes(`\`${n}\``))
    .map((n) => ({ level: "FAIL", path: "package.json", line: 1, message: `의존성 '${n}'의 까닭이 README.md 의존성 표에 없다` }));
}

// node --test에는 파일 제외가 없어 시험 경로를 개념 폴더로 나열한다. 새 폴더의 시험이 빠지지 않게 확인한다.
export function checkTestScript(script: string, files: readonly string[]): Finding[] {
  const glob = /"([^"]+\.test\.ts)"/.exec(script)?.[1];
  if (!glob) return [{ level: "FAIL", path: "package.json", line: 1, message: "test 스크립트에서 시험 파일 경로를 찾지 못했다" }];
  return files
    .filter((f) => f.endsWith(".test.ts") && !posix.matchesGlob(f, glob))
    .map((f) => ({ level: "FAIL", path: f, line: 1, message: `이 시험 파일은 npm test 경로(${glob})에 잡히지 않는다` }));
}

export function checkSecrets(path: string, text: string): Finding[] {
  if (/(^|\/)\.env(\.|$)/.test(path) && !path.endsWith(".env.example"))
    return [{ level: "FAIL", path, line: 1, message: ".env는 커밋하지 않는다" }];
  const m = SECRET.exec(text);
  return m ? [{ level: "FAIL", path, line: lineOf(text, m.index), message: "API 키 모양의 문자열이 있다" }] : [];
}

export function checkExcuses(path: string, text: string): Finding[] {
  const marker = path.endsWith(".ps1") ? "#" : "//";
  const out: Finding[] = [];
  text.split("\n").forEach((l, i) => {
    const at = l.trimStart().startsWith(marker) ? l.indexOf(marker) : l.indexOf(` ${marker}`);
    if (at >= 0 && EXCUSE.test(l.slice(at)))
      out.push({ level: "WARN", path, line: i + 1, message: "땜질을 변명하는 주석이다. 원인을 고치거나 알려진 한계로 파일 머리에 적는다" });
  });
  return out;
}

function catalogNames(files: readonly string[]): string[] {
  const names = new Set<string>();
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (v !== null && typeof v === "object")
      for (const [k, x] of Object.entries(v)) {
        if ((k === "brand" || k === "model") && typeof x === "string" && x.length >= 3) names.add(x);
        else visit(x);
      }
  };
  for (const f of files) if (f.startsWith("catalog/") && f.endsWith(".json")) visit(JSON.parse(readFileSync(f, "utf8")));
  return [...names];
}

if (import.meta.main) {
  const listed = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" });
  const files = listed.split("\0").filter((f) => f !== "" && existsSync(f));
  const names = catalogNames(files);
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  const findings = [...checkDependencies(manifest, readFileSync("README.md", "utf8")), ...checkTestScript(manifest.scripts.test, files)];
  for (const f of files) {
    if (BINARY.test(f)) continue;
    const text = readFileSync(f, "utf8");
    findings.push(...checkName(f), ...checkSecrets(f, text));
    if (SOURCE.test(f))
      findings.push(...checkHeader(f, text), ...checkImports(f, text), ...checkDeviceNames(f, text, names), ...checkExcuses(f, text));
  }
  for (const x of findings) console.log(`${x.level} ${x.path}:${x.line} ${x.message}`);
  const failed = findings.filter((x) => x.level === "FAIL").length;
  console.log(failed === 0 ? `gate: 통과 (파일 ${files.length}, 경고 ${findings.length})` : `gate: 실패 ${failed}`);
  process.exitCode = failed === 0 ? 0 : 1;
}
