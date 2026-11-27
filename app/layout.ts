// 카드 크기와 기기 면별 포트 좌표를 계산한다.
import type { Face, Model, Point, Port } from "./document.ts";

export const CARD_WIDTH = 212;
const CARD_HEADER = 53;
const FACE_WIDTH = 81;
const FACE_HEIGHT = 39;
const FACE_GAP = 37;
const faceNames: Record<Face, string> = { front: "앞", rear: "뒤", left: "왼쪽", right: "오른쪽", top: "위", bottom: "아래" };
const faces = Object.keys(faceNames) as Face[];

export interface FaceLayout extends Point { label: string; face: Face; width: number; height: number }
export interface PortLayout extends Point { port: Port }
export function cardLayout(model: Model) {
  const known = model.ports.filter(p => p.position !== undefined);
  const unknown = model.ports.filter(p => !known.includes(p));
  const panels = faces.filter(face => known.some(p => p.position!.face === face)).map((face, i): FaceLayout => ({
    face, label: faceNames[face], x: 16 + (i % 2) * 99, y: CARD_HEADER + Math.floor(i / 2) * (FACE_HEIGHT + FACE_GAP),
    width: FACE_WIDTH, height: FACE_HEIGHT,
  }));
  const ports: PortLayout[] = known.map(port => {
    const p = port.position!, panel = panels.find(f => f.face === p.face)!;
    return { port, x: panel.x + p.x * panel.width, y: panel.y + p.y * panel.height };
  });
  const listY = panels.length ? panels.at(-1)!.y + FACE_HEIGHT + 35 : CARD_HEADER + 12;
  unknown.forEach((port, i) => ports.push({
    port, x: 22 + i % 7 * 28, y: listY + Math.floor(i / 7) * 28,
  }));
  const height = unknown.length ? listY + Math.floor((unknown.length - 1) / 7) * 28 + 25
    : panels.length ? listY - 17 : CARD_HEADER + 14;
  return { height, panels, ports, listY: unknown.length ? listY : null };
}
