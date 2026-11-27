# benchwire

범용 장비 연결 시뮬레이터. 가진 장비와 후보 장비를 캔버스에 놓고 이으면 무엇이 되고 안 되는지, 동시에 쓰면 어디가 병목인지, 무엇을 더 사야 하는지를 근거와 함께 보여 준다. 의도는 [SPEC.md](SPEC.md), 에이전트 작업 지침은 [AGENTS.md](AGENTS.md), 지금 할 일은 [남은일.md](남은일.md)에 있다.

## 실행

Node.js 26 LTS 이상이 필요하다.

```sh
npm ci
npm start
```

`npm start`는 캔버스를 `dist/app/`에 빌드하고 `http://127.0.0.1:3210/`을 기본 브라우저에서 연다. 설치 뒤에는 인터넷 없이 실행할 수 있다. 처음에는 한 케이블에서 PoE와 이더넷이 함께 흐르는 예제를 연다. 편집은 자동 저장되며 예제의 첫 편집은 `userdata/`에 사본을 만든다. 다시 시작하면 마지막으로 저장한 장면이 열린다.

```sh
npm run check   # 형 검사(tsc), 전체 시험(node --test), 게이트(tools/gate.ts)
npm run test:ui # 설치된 Edge에서 실제 서버와 화면 검증
npm run perf    # 조용한 상태에서 프레임·편집 지연 측정, 한도 초과 시 실패, work/에 JSON 저장
```

CLI에서 제품 영역 장면을 평가하거나 비교할 수 있다. 합성 `trial` 영역을 쓰는 데모는 전용 진입점에서 선택한다.

```sh
node cli/evaluate.ts fixtures/t2/scene.json --variants
node cli/compare.ts fixtures/t2/four-lanes.json fixtures/t2/two-lanes.json
node fixtures/demo.ts evaluate fixtures/three-flows.json
node fixtures/demo.ts compare fixtures/compare/before.json fixtures/compare/after.json
```

새 아이템의 **AI 조사**를 켜려면 저장소 루트의 `.env`에 `ANTHROPIC_API_KEY=발급받은_키`를 넣고 서버를 다시 시작한다. 조사 시작 버튼을 누르면 모델명 또는 공개 URL을 Claude API로 보낸다. 한 건의 상한은 US$5.00과 웹 검색 6회이며, 상한과 사용 비용을 생성기에 표시한다. 공개 자료와 사용량을 `userdata/research/`에 보관하고 30일 뒤 갱신 필요로 표시한다. 키 없이도 수동 생성기를 쓸 수 있다. [Claude 사용료](https://platform.claude.com/docs/en/about-claude/pricing) · [검색 도구 요금](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool)

## 의존성

새 의존성은 이 표에 까닭과 함께 넣는다. 게이트가 `package.json`과 대조한다.

| 이름 | 까닭 |
|---|---|
| `typescript` (dev) | 형 검사만 한다. 실행은 Node가 형을 지워서 한다 |
| `@types/node` (dev) | Node 내장 모듈의 형 |
| `zod` | 아이템·장면 파일과 영역별 입력을 로드할 때 검증한다 |
| `@anthropic-ai/sdk` | 로컬 서버에서 Claude의 공개 자료 조사와 구조화 출력을 요청한다 |
| `vite` (dev) | 브라우저 작업대를 개발 중에 띄우고 배포할 정적 파일을 빌드한다 |
| `playwright` (dev) | 설치된 Edge에서 캔버스 조작과 프레임 시간을 검증한다 |

## 기술 스택 (M0, 2026-11-26 승인)

사용자가 안 A, 평평한 개념 폴더, M3 전 캔버스 스파이크를 승인했다. 조사일은 모두 2026-11-26이고, 판 번호와 날짜는 링크한 페이지에서 확인했다.

정해 둔 갈림길: 성능이나 메모리 문제가 측정되면 엔진을 Rust로 옮기고 화면은 웹 프런트엔드로 따로 둔다. 엔진을 평평한 표와 순수 함수로 쓰는 것은 이 이전을 쉽게 하려는 것이기도 하다.

### 승인안: TypeScript 하나로 쓰는 로컬 웹앱

| 레이어 | 선택 | 까닭 |
|---|---|---|
| 런타임 | Node.js 26 LTS (이 노트북에 26.13.1) | 2026-10-28부터 Active LTS, 2029-04-30까지 지원. 형 지우기(type stripping)가 안정 기능으로 내장되어 빌드 없이 `.ts`를 바로 돌린다. 대신 enum · namespace · 매개변수 속성은 못 쓰고 import에 `.ts`를 붙인다. [Release 일정](https://github.com/nodejs/Release), [Node TypeScript](https://nodejs.org/api/typescript.html) |
| 언어 · 형 검사 | TypeScript 7 (`tsc --noEmit`만 씀) | 7.0은 Go 이식판으로 2026-07-08 GA. 실행은 Node가, 검사는 tsc가 맡는다. `erasableSyntaxOnly`로 Node가 못 지우는 문법을 막는다. [TS 7.0](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/), [TS 5.8 erasableSyntaxOnly](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-8.html) |
| 시험 | `node:test` (내장) | describe/it, mock, snapshot이 안정 기능이라 시험 도구 의존성이 없다. 범위 측정과 watch는 아직 실험 단계라 쓰지 않는다. [node:test](https://nodejs.org/api/test.html) |
| 판정 엔진 | 의존성 없는 순수 TS 모듈 | 같은 파일을 브라우저 · CLI · 시험이 그대로 읽는다. 파일 · 시계 · 네트워크는 호출자가 맡는다. |
| 자원 배분 | max-min 공정 분배 + 영역별 이산 규칙 | 아래 [배분 모델](#배분-모델) |
| 스키마 · 검증 | Zod 4 (첫 스키마를 쓸 때 들인다) | 한 스키마로 TS 형, 신뢰 경계 검증(아이템 파일, LLM 출력), JSON Schema(구조화 출력, 수동 생성기 폼)를 함께 낸다. `z.toJSONSchema`가 내장이다. [Zod JSON Schema](https://zod.dev/json-schema) |
| 저장 | 평범한 JSON 파일. 공용 데이터는 `catalog/`(커밋), 개인 데이터는 `userdata/`(커밋 안 함) | 로컬 우선이고 아무 도구로나 열리며 이력은 git이 맡는다. 값마다 출처 · 신뢰도 · 조회일이 붙고, 사용자 검증값은 그 사용자의 인스턴스에만 쓴다. SQLite는 검색이나 동시 쓰기가 실제로 필요해지면 비교한다. |
| 캔버스 화면 | 바닐라 DOM + SVG + Pointer Events (2026-11-27 스파이크로 정함) | 기기 50 · 포트 400 · 엣지 100 장면에서 React Flow 13과 나란히 쟀다(Edge, 세 번씩). 드래그 · 팬 · 줌 프레임 p95는 둘 다 8.4 ms로 같았고, 첫 렌더는 73 ms 대 158 ms, 번들은 gzip 7 KB 대 160 KB였다. React Flow가 줄여 준 직접 코드는 66줄(대부분 팬 · 줌)뿐이라 의존성을 들일 까닭이 없었다. 측정 원본은 지휘 작업 트리 `work/w-spike-canvas/`. |
| 로컬 서버 | `node:http` | 파일 저장과 키가 필요한 호출(LLM, 가격)을 브라우저 밖에서 맡는다. 프레임워크는 쓰지 않는다. |
| AI 조사 | Claude API (`@anthropic-ai/sdk` 1.14), 서버 도구 web search · web fetch, 구조화 출력 | 검색은 1,000회당 $10에 토큰 값이 붙고, fetch는 토큰 값만 든다. 구조화 출력과 인용은 한 호출에 함께 쓸 수 없어서 조사 호출과 추출 호출을 나누고, 출처 URL을 스키마 칸으로 받는다. 조사 1건마다 검색 횟수 상한(`max_uses`)을 두고 결과를 캐시한다. [Web search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool), [Web fetch](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool), [Structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs) |
| 가격 | provider 계약 하나, 수동 입력과 스크린샷 파싱을 먼저 | 아래 [가격 provider](#가격-provider) |
| Windows 수집기 | Windows PowerShell 5.1 대본. 모자란 곳만 `Add-Type` 인라인 C# | 설치 없이 돌고, 대본이 곧 '무엇을 하는지'라 동의 화면에 그대로 보인다. 결과는 JSON 파일로 내보내 앱이 가져온다. 아래 [수집기로 닿는 것](#수집기로-닿는-것) |
| 배포 | 로컬 웹앱 (Node가 루프백에서 화면을 낸다) | 혼자 쓰는 Windows 노트북이 대상이고, 수집기는 파일로 이어 붙이니 웹앱으로 충분하다. 설치형 요구가 생기면 Tauri 2나 Electron으로 감싼다(화면이 웹이라 길이 열려 있다). |

### 후보 비교

| 기준 | A. TS 로컬 웹앱 (승인) | B. Rust 엔진 + Tauri 2 데스크톱 | C. Python 엔진 + 웹 화면 |
|---|---|---|---|
| 요구 적합도 | 엔진이 브라우저에서 돌아 what-if가 즉시 다시 계산된다. 엔진 · 화면 · 서버가 한 언어 | 단일 실행 파일, 네이티브 수집기, 엄격한 수치형 | Python의 데이터 · LLM 생태계. 엔진이 브라우저에 못 가서 재계산마다 서버 왕복 |
| 구현 난이도 | 낮음 | 높음. Rust와 웹 두 언어, 브라우저 엔진은 WASM 경계 | 중간. Python과 TS 두 언어 |
| 생태계 · 유지보수 | Node 26 LTS, TS 7 GA, React Flow 활발(2026-11 릴리스) | Tauri 2.12 활발. [Tauri 릴리스](https://github.com/tauri-apps/tauri/releases). Rust용 공식 Anthropic SDK 없음(HTTP 직접 호출) | 성숙 |
| 성능 | 장면 규모(기기 50, 포트 400)에서 충분할 것으로 본다. 캔버스는 스파이크로 잰다 | 가장 좋음 | 보통. 왕복 지연이 붙음 |
| 개발 환경 편의 | 설치된 Node 하나로 시작, 엔진은 빌드 단계 없음 | MSVC Build Tools · WebView2 필요, 컴파일 루프가 길다. [Tauri 준비물](https://v2.tauri.app/start/prerequisites/) | 설치됨. 두 런타임 관리 |
| 확장성 | 영역 플러그인 = TS 모듈 하나 | 플러그인 = crate 추가와 재컴파일 | 플러그인 = Python 모듈 |
| 비용 | 무료. 외부 API만 유료 | 무료 | 무료 |

- B를 버린 까닭: 화면은 어차피 웹이라 두 번째 언어가 맡을 몫이 엔진과 수집기뿐이다. 수집기는 PowerShell과 `Add-Type`으로 대부분 닿고(아래 표), 엔진의 계산량은 작다. 두 언어와 WASM 경계를 지킬 까닭이 측정되지 않았다.
- C를 버린 까닭: 엔진이 브라우저에서 돌지 못해 캔버스의 즉시 재계산이 서버 왕복이 되고, 화면 때문에 TS가 여전히 필요해 두 언어가 된다.

### 배분 모델

- 연속 처리량(대역폭, MB/s)은 max-min 공정 분배(progressive filling)로 나눈다. 모든 활성 흐름을 함께 올리다가 수요 상한이나 자원 용량에 닿은 흐름을 고정하고 나머지를 계속 올린다. 예를 들어 실효 900 MB/s 허브에 수요가 100 · 800 · 800이면 100 · 400 · 400이 된다. 단순 3등분은 첫 SSD가 못 쓴 몫을 버린다. 계산이 결정적이고, 단계마다 어느 자원이 흐름을 묶었는지 남아 '왜?' 패널의 근거가 된다. [Le Boudec, progressive filling](https://leboudec.github.io/leboudec/latex/cc/LEB3132.pdf)
- 고정 요구(영상 스트림, Alt Mode 레인, PD 계약)는 영역 플러그인의 이산 규칙으로 먼저 예약하고 남은 용량을 위 방식으로 나눈다. 포트 조합표가 있는 충전기 정책은 전력 플러그인이 조합표를 평가한다.
- 분배 정책을 모르는 자원(대부분의 허브와 충전기)에서는 공정 분배 값을 추정으로 표시하고, 가능한 범위와 검증 퀘스트를 낸다. 총 처리량을 최대화하는 LP는 느린 흐름을 희생하고 이산 선택을 다루지 못해 버렸다.

### 가격 provider

| 후보 | 조건과 비용 | 판단 |
|---|---|---|
| 수동 입력 · 스크린샷 파싱 | 무료(파싱에 Claude 호출 비용) | 가장 먼저 만든다. 늘 동작하는 기본 |
| [Best Buy API](https://bestbuyapis.github.io/api-documentation/) | 키 발급(개인 발급 가능 여부는 미확인), 하루 50,000회 · 초당 5회, 데이터 보관 최대 72시간, 출처 표시와 로고 의무. [약관](https://developer.bestbuy.com/legal) | 첫 공식 API 후보. 72시간이 지난 견적은 버린다 |
| [Keepa API](https://keepa.com/api-docs/plans-tokens.html) (공식 MCP 서버 `https://keepa.com/mcp`) | 월 €49부터, 쓰지 않은 토큰은 60분 뒤 사라짐. [MCP 문서](https://keepa.com/api-docs/mcp.html) | Amazon 현재가와 이력. 유료라 승인 뒤에만 |
| [Amazon Creators API](https://affiliate-program.amazon.com/creatorsapi/docs/) | Associates 계정, 최근 30일 적격 판매 10건, 주 계정 소유자만 등록. PA-API 5.0은 이미 403을 돌려준다 | 새 앱은 조건을 못 채운다. 버림 |
| 스크래핑 MCP ([Playwright MCP](https://github.com/microsoft/playwright-mcp), [Bright Data MCP](https://github.com/brightdata/brightdata-mcp)) | 쇼핑몰 약관 위반 위험 | 선택 플러그인, 기본 비활성. 아래 [약관 위험](#외부-서비스와-약관) |

### 수집기로 닿는 것

이 노트북(Windows 11 26200, PowerShell 5.1, 관리자 아님)에서 실제로 불러 본 것을 표시했다.

| 항목 | 방법 | PowerShell 5.1 | 관리자 |
|---|---|---|---|
| 장치 나무(허브, 컨트롤러, PCIe 루트, USB4 라우터) | `Get-PnpDeviceProperty` `DEVPKEY_Device_Parent` · `_Children` · `_LocationPaths` ([문서](https://learn.microsoft.com/en-us/windows-hardware/drivers/install/devpkey-device-parent)) | 됨 (시험함) | 아니오 |
| PCIe 링크 세대 · 폭 | `DEVPKEY_PciDevice_CurrentLinkSpeed` · `_CurrentLinkWidth` | 됨 (시험함) | 아니오 |
| USB 협상 속도(5G까지, 10G · 20G 구분) | `IOCTL_USB_GET_NODE_CONNECTION_INFORMATION_EX_V2`, `IOCTL_USB_GET_NODE_CONNECTION_SUPERSPEEDPLUS_INFORMATION` ([문서](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/usbioctl/ni-usbioctl-ioctl_usb_get_node_connection_superspeedplus_information)) | `Add-Type` (시험함) | 아니오 |
| NIC 링크 속도 | `Get-NetAdapter` `LinkSpeed` ([문서](https://learn.microsoft.com/en-us/powershell/module/netadapter/get-netadapter)) | 됨 (시험함) | 아니오 |
| 화면 모드 · 커넥터 종류 · 출력 GPU · 비트 깊이 | `QueryDisplayConfig`, `DisplayConfigGetDeviceInfo` ([문서](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-querydisplayconfig)) | `Add-Type` (시험함) | 아니오(원격 세션에서는 거부) |
| EDID | `WmiMonitorDescriptorMethods.WmiGetMonitorRawEEdidV1Block` | 됨 (시험함) | 아니오 |
| 배터리 충방전 W | WinRT `BatteryReport.ChargeRateInMilliwatts`, `root\wmi` `BatteryStatus` | 됨 (이 기계는 배터리가 없어 값은 못 봄) | 아니오 |
| 디스크 벤치마크 | [DiskSpd 2.3](https://github.com/microsoft/diskspd) (MIT, 따로 내려받음), `-c`로 `%TEMP%`에 만든 새 파일에만 | 실행 파일 | 미확인 |

닿지 않는 것: DisplayPort 링크 속도와 레인 수는 공개 Windows API가 없고 NVIDIA NVAPI · AMD ADLX 같은 제조사 SDK에만 있다. USB4 터널 대역폭도 공개 API가 없다(ETW 이벤트에 링크 속도와 터널 유무만 있고 관리자 권한이 필요하다). 이런 값은 `unknown`으로 두고 검증 퀘스트로 보낸다. AppLocker나 WDAC가 걸린 기계에서는 `Add-Type`이 막혀 표의 '됨' 줄만 쓸 수 있다. [Language modes](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_language_modes?view=powershell-5.1)

### Windows 수집 파일 가져오기

1. 캔버스 인벤토리의 **수집기 → 실행 방법과 대본 전문**에서 읽을 항목과 출력 위치를 확인한다. 실행을 원하면 저장소 폴더에서 Windows PowerShell로 다음 명령을 실행한다.

   ```powershell
   powershell.exe -NoProfile -File .\collector\collect.ps1 -Out "$env:TEMP\benchwire-collect.json"
   ```

   `-Out`을 생략하면 같은 임시 경로를 쓴다. 출력에는 로컬 드라이브의 절대 `.json` 경로를 지정한다. 기존 파일을 보존하려면 다른 이름을 사용한다. Windows PowerShell 5.1의 `Add-Type`은 C#을 컴파일할 때 시스템 임시 파일을 만들고 컴파일러 프로세스를 실행한다. 정책이 Restricted이거나 AllSigned에서 서명 검사를 통과하지 못하면 장치 관리자와 고급 디스플레이 설정에서 값을 확인해 퀘스트에 입력한다.
2. **수집 JSON 가져오기**에서 파일을 고른다. 로컬 서버가 검증한 원본을 `userdata/collect/`에 보관한다. 이름·VID/PID·부모·위치 경로로 행을 찾아 장면의 실물과 포트를 직접 고른다. USB 부모와 출력 GPU의 내부 배선을 기록할 때는 측정된 부모 또는 GPU가 선택한 포트에 직접 붙은 내부 노드인지도 확인한다.
3. 수집 당시와 현재 배선이 같은지 확인한 뒤 끝점과 중간 부품의 펌웨어와 측정 조건을 입력한다. 실제로 적용할 항목이 없는 칸만 **해당 없음**을 고른다. **확인한 측정 적용**으로 장면에 저장한다. 예제는 개인 사본으로 열린다. 같은 파일을 다시 열면 여전히 같은 배선·조건인 맞춤을 보여 준다.

현재 NIC·USB·화면 모드는 연결 관측, 확인한 내부 부착점은 실물의 개인 주장이다. PCIe 링크 폭, EDID, 충방전 W 등은 원본에서 볼 수 있다. 배터리가 없거나 접근 권한이 부족한 행에는 수집하지 못한 이유가 남는다. 가상 예제는 `fixtures/collect/twin-adapters.json`이다.

### 되돌리기 어려운 결정

1. 엔진 언어(TypeScript). 성능이나 메모리 문제가 측정되면 Rust로 옮긴다(위 갈림길). 표와 계약이 언어 중립이면 옮기는 비용은 엔진과 플러그인 본문에 그친다.
2. 저장 파일의 영속 ID, 공용 모델과 개인 인스턴스의 경계, 값의 출처 기록 형식. 사용자 데이터가 쌓인 뒤에는 옮기는 작업이 든다.
3. 단위와 방향 약속(bps와 MB/s, 방향별 자원과 합산 자원)과 영역 플러그인 계약.
4. 배포 형태(로컬 웹앱). 데스크톱으로 감싸는 길은 열려 있지만, 수집기를 앱 안에서 직접 돌리게 되면 수집기를 다시 짠다.

캔버스는 스파이크로 바닐라 DOM + SVG를 골랐다. 화면 코드는 엔진과 분리돼 있어 나중에 라이브러리로 바꿔도 엔진은 그대로다.

### 스파이크

| 확인할 것 | 실험 | 통과 기준 | 언제 |
|---|---|---|---|
| 영속 ID와 모델 · 인스턴스 경계 | 같은 모델 SSD 두 대 중 한 대에만 실측값을 넣고 공용 데이터를 고친다 | 개인값이 한 대에만 적용되고, 이전 판정을 원래 근거로 재현 | M1 첫 시험 |
| 배분 모델 | T5 · T6 · T8을 손계산 fixture로 | 엔진 값이 손계산과 같고, 포트 순서를 섞어도 같음 | M1 |
| 캔버스 화면 | 기기 50 · 포트 400 · 엣지 100 장면을 React Flow와 바닐라 SVG로 | 드래그 중 p95 프레임 20ms 이하, 직접 쓴 줄 수, 손맛 | 끝남: 바닐라 SVG(2026-11-27) |
| 수집기 | 허브나 화면을 두 포트에 번갈아 꽂고 읽어 USBView · 설정 화면과 대조 | 일치한 칸만 승격 대상 | M5 전 |
| 조사 품질과 비용 | 리비전 둘이 같은 이름인 장비 하나를 조사 | 리비전 확인 질문, 출처 충돌 보존, 1건 비용 기록 | M4 전 |

## 외부 서비스와 약관

- 스크래핑 provider는 기본 비활성이다. 쇼핑몰 약관에 어긋날 수 있다(Amazon Conditions of Use는 가격 수집과 데이터 마이닝 도구를 금지한다). 켜는 사람이 그 위험을 진다.
- API 키는 커밋하지 않는 `.env`에만 두고 로컬 서버만 읽는다. 브라우저로 내려보내지 않는다.
- 돈이 드는 호출(LLM, Keepa 등)은 사용자 승인 뒤에만 연결한다.
