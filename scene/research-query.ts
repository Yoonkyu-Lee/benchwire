// 조사 시작 전에 화면과 서버가 같은 공개 입력을 만든다.
export function researchQuery(input: string) {
  const value = input.trim();
  const url = URL.parse(value);
  if (url && ["http:", "https:"].includes(url.protocol)) {
    if (url.username || url.password) return "";
    url.search = "";
    url.hash = "";
    return url.href;
  }
  return value;
}
