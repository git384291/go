# 출시 설정 사전 점검 · 실서버 기본 비활성 스모크

## 1. 출시 설정 사전 점검 (`npm run preflight:launch`)
- **읽기 전용.** 네트워크 호출, DB 접속·쓰기, 계정·키 생성, 데이터 수집을 하지 않는다.
- 환경 변수의 **존재 여부와 허용 형식만** 판정한다. 값, URL 원문·쿼리, 토큰, 키, 비밀번호, 인증서 내용은 출력하지 않는다(시험 F1).
- `--strict`를 주면 `MISSING`·`INVALID`·`POLICY`가 하나라도 있을 때 exit 1이다. 기본은 결과만 표시한다(exit 0).
- 로컬 파일로 점검하려면 `npx tsx --env-file=.env.local scripts/preflight/run.ts`를 쓴다. 파일 내용은 출력하지 않는다.

| 상태 | 뜻 |
|---|---|
| OK | 형식 통과(실제 동작·소유권 검증 아님) |
| MISSING | 없음. 설정 위치와 필요한 권한을 함께 표시 |
| INVALID | 형식 오류 |
| POLICY | 승인 없이 열린 스위치 등 정책 위반 |
| OFF | 정책대로 꺼짐 |
| UNVERIFIABLE | 이 점검으로는 확인할 수 없음 |
| INFO | 참고(예: 로컬 가상 DB, 목적지 형식만 확인) |

**전체 통과의 의미:** 다음 항목을 **검증하지 않는다.**
- 실제 Supabase Auth 대시보드 설정(D3~D8)
- 풀러·CA 실제 연결과 `release_auditor` 실접속(D2·D9·D10)
- 개인정보 처리 적합성
- 광고 계정 인증·매체 자격·플랫폼 강제 예산 한도
- 목적지가 실제 총판 공식 경로인지

**현재 결과(이 저장소 기본 환경):**
- MISSING: 공식 주소, 광고·상담 목적지, 관리자 인증 필수값 4개, DB URL
- OFF: 접수·외부 상담·인증 스위치

**대표가 직접 입력해야 하는 값** — PR·채팅으로 보내지 않는다. 각 서비스의 보호된 설정 화면에서 직접 넣는다.

| 값 | 어디서 | 필요한 권한 |
|---|---|---|
| `PUBLIC_SITE_ORIGIN`, `SEARCH_INDEXING`, `LAUNCH_INTAKE_DESTINATION`, 인증·DB 환경 변수 | Vercel 프로젝트 → Settings → Environment Variables(환경별) | 그 프로젝트의 환경 변수를 수정할 수 있는 팀 멤버 |
| Supabase URL·공개 키 | Supabase 프로젝트 → Project Settings → API | 프로젝트 Owner 또는 Admin |
| DB 연결 정보·SSL 인증서 | Supabase 프로젝트 → Project Settings → Database | 프로젝트 Owner 또는 Admin |
| Auth 설정(가입 차단·MFA·세션·URL·JWT 키) | Supabase 프로젝트 → Authentication 설정 | 프로젝트 Owner 또는 Admin |

- 메뉴 이름은 서비스 변경으로 다를 수 있다.
- 서명 키 생성과 계정 생성은 아직 금지 상태다. 이 표는 위치 안내일 뿐 생성 지시가 아니다.
- 광고 계정과 총판 접수 경로는 현재 없다. 있다고 가정하지 않는다.

## 2. 실서버 기본 비활성 스모크 (`npm run test:server-smoke`, CI는 `test:preview` 뒤)

`npm run build` 결과로 `next start`를 **127.0.0.1에만** 띄워 실제 HTTP·RSC 응답을 검사한다. 결과는 `test-results/server-smoke/checks.txt`에 남는다. 정적 미리보기 결과 `test-results/screens/`와 따로 둔다.

**자식 서버 환경:**
- 넘기는 값: `PATH`, `NODE_ENV=production`, `PORT`, `HOSTNAME=127.0.0.1`, `NEXT_TELEMETRY_DISABLED`, 차단 사전 로드
- 상속하지 않는 값: DB, Supabase, 서명 키, 광고 값
- 그래서 인증·접수 스위치는 기본값(꺼짐)이다.

**외부 접속 차단:** `scripts/server-smoke/deny-network.mjs`(`NODE_OPTIONS=--import`)가 루프백 외 TCP·TLS·DNS를 막고 막은 횟수만 기록한다. 장치 자체를 N0로 확인하고, 서버가 외부로 나가려 한 횟수가 0인지 H8로 확인한다.

**시간 제한과 정리:** 준비 대기 30초, 전체 120초. 성공·실패·타임아웃 모두 SIGTERM → SIGKILL로 서버를 정리한다. 응답 본문과 환경 원문은 출력하지 않는다.

**검사 항목:**
- H1·H2: `/admin/progress` HTML·RSC 잠금, 스냅샷 문장 0개, no-store, X-Robots-Tag
- H3: `/api/admin/leads` 목록·상세 503 `ADMIN_AUTH_DISABLED`, no-store
- H4: `/admin` HTML·RSC 잠금, 가상 리드 0
- H5: `/admin/login` 미리보기
- H6: robots 전체 차단, sitemap 빈 목록
- H7: `/` noindex

**전제가 없을 때:** `next`나 `.next` 빌드가 없으면 **실패**한다. `CI=true`에서는 건너뛸 수 없다. 로컬에서 `FIDEON_ALLOW_SKIP_SERVER_SMOKE=1`일 때만 "미실행"으로 표시하고, 통과로 세지 않는다.

**한계:** 인증 **비활성** 경계만 검사한다. 인증이 켜진 실제 Supabase owner·비owner 접속 E2E가 아니다.
