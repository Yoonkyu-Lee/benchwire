// Edge에서 프레임 간격과 편집부터 판정 표시까지의 시간을 재고 한도를 검사한다.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { Page } from "playwright";
import { center, edgeSession, viewport } from "./edge-session.ts";

const edge = edgeSession();
const { newPage } = edge;
const FRAME_P95_LIMIT = 20;
const MAIN_TASK_LIMIT = 50;

type Motion = "drag" | "pan" | "zoom";
const duration = 2000;

async function measure(page: Page, motion: Motion) {
  await edge.navigate(page, "/testbed.html?performance");
  const cardTitle = page.locator('[data-instance="grid-12"] .device-name');
  await cardTitle.waitFor();
  assert.equal(await page.locator(".device").count(), 50);
  assert.equal(await page.locator(".port").count(), 400);
  assert.equal(await page.locator(".wire").count(), 100);
  assert.equal(await page.locator('.wire-line[data-result-kind="negotiation"]').count(), 200);
  const target = motion === "drag" ? await center(cardTitle)
    : motion === "pan" ? { x: 288, y: 134 } : { x: 848, y: 432 };
  const carrier = motion === "drag" ? page.locator('[data-instance="grid-12"]') : page.locator(".world");
  const before = await carrier.getAttribute("transform");
  await page.mouse.move(target.x, target.y);
  if (motion !== "zoom") await page.mouse.down();
  await page.waitForTimeout(350);
  const frameTimes = page.evaluate(ms => new Promise<number[]>(done => {
    const samples: number[] = [];
    requestAnimationFrame(start => {
      let last = start;
      function sample(now: number) {
        samples.push(now - last);
        last = now;
        if (now - start < ms) requestAnimationFrame(sample);
        else done(samples);
      }
      requestAnimationFrame(sample);
    });
  }), duration);
  const start = performance.now();
  const steps = motion === "zoom" ? 80 : 120;
  for (let i = 0; i < steps; i++) {
    const delay = start + i * duration / steps - performance.now();
    if (delay > 0) await sleep(delay);
    if (motion === "zoom") await page.mouse.wheel(0, i % 12 < 7 ? -8 : 8);
    else await page.mouse.move(target.x + 105 * i / steps, target.y + Math.sin(i / 12) * 38 + 35 * i / steps);
  }
  const times = (await frameTimes).sort((a, b) => a - b);
  if (motion !== "zoom") await page.mouse.up();
  assert.notEqual(await carrier.getAttribute("transform"), before, motion);
  const quantile = (q: number) => Number(times[Math.ceil(q * times.length) - 1]!.toFixed(2));
  return { motion, samples: times.length, inputs: steps, p50: quantile(0.5), p95: quantile(0.95), max: quantile(1) };
}

test("50기기·400포트·100선 장면의 드래그·팬·줌 프레임 p95가 20 ms 이하다", { timeout: 60_000 }, async context => {
  const page = await edge.browser.newPage({ viewport, deviceScaleFactor: 1 });
  try {
    const samples = [];
    for (let trial = 1; trial <= 3; trial++) {
      for (const motion of ["drag", "pan", "zoom"] as const) samples.push({ trial, ...await measure(page, motion) });
    }
    const stats = { browser: edge.browser.version(), viewport, duration, frameP95Limit: FRAME_P95_LIMIT, samples };
    await writeFile("work/m3-perf-frames.json", JSON.stringify(stats, null, 2));
    for (const sample of samples) {
      context.diagnostic(JSON.stringify(sample));
      assert(sample.p95 <= FRAME_P95_LIMIT, `${sample.motion} ${sample.trial}: p95 ${sample.p95} ms`);
    }
  } finally { await page.close(); }
});

test("예제와 50기기 정적 빌드에서 의미 편집부터 새 판정이 그려지는 시간을 기록한다", { timeout: 60_000 }, async context => {
  const measurements = [];
  for (const [mode, id, expected] of [["example", "poe-ethernet", 2], ["performance", "traffic-3", 50]] as const) {
    const { page, errors } = await newPage("/testbed.html?" + mode);
    try {
      assert.equal(await page.locator(".device").count(), expected);
      if (mode === "performance") {
        assert.equal(await page.locator(".port").count(), 400);
        assert.equal(await page.locator(".wire").count(), 100);
        assert.equal(await page.locator('.wire-line[data-result-kind="negotiation"]').count(), 200);
      }
      await page.getByRole("button", { name: "결과 · 근거" }).click();
      const { samples, longTasks } = await page.evaluate(async id => {
        const samples: number[] = [];
        const longTasks: number[] = [];
        const observer = new PerformanceObserver(list => longTasks.push(...list.getEntries().map(entry => entry.duration)));
        observer.observe({ type: "longtask" });
        for (let i = 0; i < 23; i++) {
          const throughput = i % 2 ? 840 : 860;
          const scene = window.benchwire.read();
          const workloads = scene.workloads.map(w => w.id !== id ? w : { ...w, request: { ...w.request,
            throughput: { ...w.request.throughput!, value: throughput },
          } });
          const start = performance.now();
          if (!window.benchwire.edit({ ...scene, workloads })) throw new Error("편집 실패");
          const stage = document.querySelector(".stage")!;
          if (stage.hasAttribute("data-assessing")) await new Promise<void>(done => {
            const changes = new MutationObserver(() => {
              if (stage.hasAttribute("data-assessing")) return;
              changes.disconnect();
              done();
            });
            changes.observe(stage, { attributes: true, attributeFilter: ["data-assessing"] });
          });
          await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
          const elapsed = performance.now() - start;
          const mark = document.querySelector(`.wire-result[data-workload="${id}"]`);
          const amount = `${throughput} Mbps`;
          const list = document.querySelectorAll(".results-panel .result-list[open] button");
          if (!mark?.textContent?.includes(amount) || ![...list].some(option => option.textContent?.includes(amount)))
            throw new Error("새 배분량 미표시");
          if (i >= 2) samples.push(elapsed);
        }
        longTasks.push(...observer.takeRecords().map(entry => entry.duration));
        observer.disconnect();
        return { samples: samples.map(ms => Number(ms.toFixed(2))), longTasks };
      }, id);
      const sorted = [...samples].sort((a, b) => a - b);
      const percentile = (q: number) => sorted[Math.ceil(q * sorted.length) - 1]!;
      const stat = { mode, samples, longTasks, p50: percentile(0.5), p95: percentile(0.95), max: percentile(1) };
      context.diagnostic(JSON.stringify(stat));
      measurements.push(stat);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  }
  const stats = { browser: edge.browser.version(), viewport, mainTaskLimit: MAIN_TASK_LIMIT, measurements };
  await writeFile("work/m3-perf-total.json", JSON.stringify(stats, null, 2));
  for (const sample of measurements)
    assert(sample.longTasks.every(task => task <= MAIN_TASK_LIMIT), `${sample.mode}: ${JSON.stringify(sample.longTasks)} ms`);
});

test("50기기 장면의 단계별 Edge 시간을 기록한다", { timeout: 60_000 }, async context => {
  const { page, errors } = await newPage("/testbed.html?performance");
  try {
    const measured = await page.evaluate(() => window.benchwire.phases());
    await writeFile("work/m3-perf-edge.json", JSON.stringify({ browser: edge.browser.version(), ...measured }, null, 2));
    context.diagnostic(JSON.stringify(measured.stages));
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
