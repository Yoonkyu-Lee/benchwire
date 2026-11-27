// 화면 시험과 성능 측정에 독립적인 임시 서버와 Edge 세션을 제공한다.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { basename, dirname, join, resolve } from "node:path";
import { after, before, type TestContext } from "node:test";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import { build } from "vite";
import { startServer } from "../server/http.ts";
import type { ResearchClient } from "../server/research.ts";
import { openBestBuy } from "../server/bestbuy.ts";

export const viewport = { width: 1440, height: 900 };

export function edgeSession({ firstRun = false } = {}) {
  const session = createEdgeSession(firstRun);
  before(session.open);
  after(session.close);
  return session;
}

export async function testEdgeSession(test: TestContext) {
  const session = createEdgeSession(false);
  test.after(session.close);
  await session.open();
  return session;
}

function createEdgeSession(firstRun: boolean) {
  const root = resolve("app");
  const work = resolve("work");
  const prefix = "edge-session-";
  let scratch: string | undefined;
  let browser: Browser;
  let server: Server | undefined;
  let base: string;

  async function openServer(researchClient: ResearchClient | null = null, bestBuy = openBestBuy(null)) {
    server = await startServer({ port: 0, dataDir: join(scratch!, "data"), buildDir: join(scratch!, "app"), researchClient, bestBuy });
    const address = server.address();
    assert(address && typeof address === "object");
    base = `http://127.0.0.1:${address.port}`;
  }

  async function closeServer() {
    const closing = server;
    server = undefined;
    if (closing) await new Promise<void>((done, fail) => closing.close(error => error ? fail(error) : done()));
  }

  async function open() {
    await mkdir(work, { recursive: true });
    scratch = await mkdtemp(join(work, prefix));
    if (!firstRun) {
      const data = join(scratch, "data");
      await mkdir(data);
      await writeFile(join(data, "settings.json"), JSON.stringify({ helpDismissed: true }));
    }
    await build({ root, logLevel: "error", build: { outDir: join(scratch, "app"),
      rolldownOptions: { input: [join(root, "index.html"), join(root, "testbed.html")] } } });
    await openServer();
    browser = await chromium.launch({ channel: "msedge", headless: true });
  }

  async function close() {
    await Promise.all([browser?.close(), closeServer()]);
    if (scratch) {
      assert.equal(dirname(scratch), work);
      assert(basename(scratch).startsWith(prefix));
      await rm(scratch, { recursive: true, force: true });
    }
  }

  async function navigate(page: Page, path: string) {
    await page.goto(base + path);
    await page.locator(".surface").waitFor();
    await waitForAssessment(page);
  }

  async function newPage(path: string, context?: BrowserContext) {
    const page = context ? await context.newPage() : await browser.newPage({ viewport, deviceScaleFactor: 1 });
    const errors: Error[] = [];
    page.on("pageerror", error => errors.push(error));
    await navigate(page, path);
    assert.deepEqual(errors, []);
    return { page, errors };
  }

  return { open, close, openServer, closeServer, navigate, newPage, get browser() { return browser; } };
}

export async function center(locator: Locator) {
  const box = await locator.boundingBox();
  assert(box);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

export async function waitForAssessment(page: Page) {
  await page.locator(".stage[data-assessing]").waitFor({ state: "hidden" });
}
