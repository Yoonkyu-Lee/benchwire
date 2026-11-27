// 확정된 작업의 흐름을 단위별 밀도와 방향으로 한 캔버스에 그린다.
import type { Direction } from "../engine/contract.ts";

export type Curve = readonly [number, number, number, number, number, number];
export interface FlowTrack { layer: string; direction: Direction; density: number; curve: () => Curve }
const MAX_PARTICLES = 96;
const PARTICLES_PER_FLOW = 6;
const DOT_RADIUS = 2.45;
const LOOP_MS = 1600;
// 120 Hz 환경에서도 60 Hz보다 자주 픽셀을 다시 그리지 않는다.
const DRAW_INTERVAL_MS = 15;

export function mountParticles(root: HTMLElement, camera: () => { x: number; y: number; zoom: number },
  covered: (x: number, y: number, padding: number) => boolean) {
  const layer = document.createElement("canvas");
  layer.className = "flow-particles";
  layer.setAttribute("aria-hidden", "true");
  layer.hidden = true;
  root.append(layer);
  const context = layer.getContext("2d");
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  const colors = new Map<string, string>();
  let reduced = false;
  let tracks: (FlowTrack & { count: number; color: string })[] = [];
  let frame: number | undefined;
  let last = -Infinity;

  function synchronize() {
    const active = Boolean(context && tracks.length && !reduced && !motion.matches);
    layer.hidden = !active;
    if (active) frame ??= requestAnimationFrame(draw);
    else if (frame !== undefined) {
      cancelAnimationFrame(frame);
      frame = undefined;
      last = -Infinity;
    }
  }

  function draw(now: number) {
    frame = undefined;
    if (!layer.isConnected || !context) return;
    frame = requestAnimationFrame(draw);
    if (now - last < DRAW_INTERVAL_MS) return;
    last = now;
    const width = root.clientWidth, height = root.clientHeight;
    if (layer.width !== width || layer.height !== height) { layer.width = width; layer.height = height; }
    context.clearRect(0, 0, width, height);
    const view = camera();
    const padding = DOT_RADIUS / view.zoom;
    context.strokeStyle = "#f3fffb";
    context.lineWidth = .8;
    for (const [i, track] of tracks.entries()) {
      const [ax, ay, c1, c2, bx, by] = track.curve();
      const phase = (now / LOOP_MS + i * 0.137) % 1;
      context.fillStyle = track.color;
      context.beginPath();
      for (let n = 0; n < track.count; n++) {
        const progress = (phase + n / track.count) % 1;
        const t = 0.08 + 0.84 * (track.direction === "reverse" ? 1 - progress : progress), k = 1 - t;
        const a = k * k * k, b = 3 * k * k * t, c = 3 * k * t * t, d = t * t * t;
        const wx = a * ax + b * c1 + c * c2 + d * bx, wy = (a + b) * ay + (c + d) * by;
        const x = view.x + view.zoom * wx, y = view.y + view.zoom * wy;
        if (x < -DOT_RADIUS || x > width + DOT_RADIUS || y < -DOT_RADIUS || y > height + DOT_RADIUS || covered(wx, wy, padding)) continue;
        context.moveTo(x + DOT_RADIUS, y);
        context.arc(x, y, DOT_RADIUS, 0, 2 * Math.PI);
      }
      context.stroke();
      context.fill();
    }
  }

  function setTracks(next: readonly FlowTrack[]) {
    const visible = next.slice(0, MAX_PARTICLES);
    const extra = visible.map(track => Math.ceil(track.density * PARTICLES_PER_FLOW) - 1);
    const total = extra.reduce((sum, count) => sum + count, 0);
    // 상한에 닿으면 모든 경로의 추가 입자 수를 같은 비율로 줄인다.
    const scale = total > 0 ? Math.min(1, (MAX_PARTICLES - visible.length) / total) : 0;
    tracks = visible.map((track, row) => {
      const count = 1 + Math.floor(extra[row]! * scale);
      if (!colors.has(track.layer))
        colors.set(track.layer, getComputedStyle(document.documentElement).getPropertyValue("--" + track.layer).trim() || "#466571");
      return { ...track, count, color: colors.get(track.layer)! };
    });
    layer.dataset.layers = [...new Set(tracks.map(row => row.layer))].join(" ");
    layer.dataset.count = String(tracks.reduce((sum, row) => sum + row.count, 0));
    synchronize();
  }

  motion.addEventListener("change", synchronize);
  return { setTracks, setReduced(value: boolean) { reduced = value; synchronize(); },
    dispose() { motion.removeEventListener("change", synchronize); if (frame !== undefined) cancelAnimationFrame(frame); } };
}
