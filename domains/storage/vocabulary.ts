// 저장 영역 이름과 SPEC 3.4의 복사 목표를 작업 시작값으로 둔다.
export const storageDomainName = "저장";
const DEFAULT_COPY_MB_PER_SECOND = 800;

export const storagePresets = [{
  kind: "copy", name: "저장장치 복사",
  request: { throughput: { value: DEFAULT_COPY_MB_PER_SECOND, unit: "MB/s" } },
}];

export const storageCardStats = [
  { scope: "resource", field: "capacity", label: "저장 처리량" },
] as const;
