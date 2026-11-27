// 영속 키 순서로 단순 유향 경로를 열거하고, 상한에 잘린 후보 집합을 표시한다.
export interface Arc { from: number; to: number; key: string }
// 분기 수에 따라 단순 경로가 지수로 늘어난다. 상한을 넘으면 일부 후보로 성능을 확정하지 않는다.
export const MAX_PATHS = 64;

export function routes<T extends Arc>(arcs: readonly T[], from: number, to: number, limit = MAX_PATHS) {
  const outgoing = new Map<number, T[]>(), incoming = new Map<number, number[]>();
  for (const arc of [...arcs].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)) {
    const next = outgoing.get(arc.from), prev = incoming.get(arc.to);
    if (next) next.push(arc); else outgoing.set(arc.from, [arc]);
    if (prev) prev.push(arc.from); else incoming.set(arc.to, [arc.from]);
  }
  const found: T[][] = [], visited = new Set([from]), path: T[] = [];
  function choices(node: number) {
    const edges = (outgoing.get(node) ?? []).filter(e => !visited.has(e.to));
    if (edges.length < 2) return edges;
    // 갈림길에서는 이미 지난 노드를 제외하고도 끝점에 닿는 가지만 따라간다.
    const reachable = new Set([to]);
    for (const end of reachable) for (const prior of incoming.get(end) ?? [])
      if (!visited.has(prior)) reachable.add(prior);
    return edges.filter(e => reachable.has(e.to));
  }
  const stack = [{ node: from, choices: choices(from), next: 0 }];
  while (stack.length) {
    const frame = stack[stack.length - 1]!;
    if (frame.node === to) {
      if (found.length === limit) return { found, truncated: true };
      found.push([...path]);
    } else if (frame.next < frame.choices.length) {
      const edge = frame.choices[frame.next++]!;
      path.push(edge);
      visited.add(edge.to);
      stack.push({ node: edge.to, choices: choices(edge.to), next: 0 });
      continue;
    }
    visited.delete(frame.node);
    stack.pop();
    path.pop();
  }
  return { found, truncated: false };
}
