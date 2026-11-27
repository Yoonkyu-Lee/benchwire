// SPEC 3.4의 복사 목표를 작업의 시작값으로 둔다.
export const storageDomainName = "저장";
const DEFAULT_COPY_MB_PER_SECOND = 800;

export const storagePresets = [{
  kind: "copy", name: "저장장치 복사",
  request: { throughput: { value: DEFAULT_COPY_MB_PER_SECOND, unit: "MB/s" } },
  labels: { throughput: "요청 처리량", viaInstance: "경유 실물 ID", viaNode: "경유 노드 ID" },
}];
