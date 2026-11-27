# Cloud Run 운영 준비 (바른365 · Google Cloud 프로젝트 `baruntongsin`)

> 상태: **준비 코드만**. 실제 배포·비밀 입력·비용 발생은 사용자·코사장 명시 승인 뒤에만 한다. Vercel 설정은 건드리지 않는다(보류).

## 1. 운영 판별 (src/server/env/deployEnv.ts)
| 함수 | 참이 되는 조건 | 쓰는 곳 |
|---|---|---|
| `isProduction` | `APP_ENV=production` 또는 `VERCEL_ENV=production` 또는 `K_SERVICE` 있음 (하나라도 → 운영, 충돌 시 운영 우선) | 모의 AI 차단, Gemini 무료 등급 차단, 관리자 인증 자동 차단 |
| `isLiveProduction` | 위 + `VERCEL_ENV`가 preview/development 아님 | 실접수(live) 열기, 검색 노출 열기 |
| `isHostedDeploy` | 운영 또는 `VERCEL=1`/`VERCEL_ENV` 있음 | 로컬 전용 기능(가상 DB 접수·관리자 가상 화면·Turnstile 시험 주소) 차단 |

원칙: **닫는 판정은 넓게, 여는 판정은 좁게.** Cloud Run은 `K_SERVICE`를 자동으로 넣으므로 설정을 빠뜨려도 운영으로 닫힌다.

## 2. 이미지
- `Dockerfile`: Next standalone(`NEXT_OUTPUT=standalone`일 때만), 비루트(uid 10001), `PORT=8080`, `HOSTNAME=0.0.0.0`.
- `.dockerignore`: `.env*`(예시 제외), `.git`, 키 파일, 로컬 산출물 제외. 이미지에 비밀 없음.
- 상태 확인: `GET /api/healthz` → `{"ok":true}` (DB·외부 호출·환경 값 노출 없음). Cloud Run 시작·활성 검사 경로로 사용.

## 3. 실행 환경 변수 (값은 Secret Manager, 저장소·이미지에 넣지 않음)
`APP_ENV=production`, `PUBLIC_HOSTNAME=bareun365.com`, `PUBLIC_SITE_ORIGIN=https://bareun365.com`, `DATABASE_URL`(app_server), `SUPABASE_DB_CA_CERT`,
`TURNSTILE_SECRET_KEY`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY`(빌드 시 공개 값), 서명·PII 키. 필수 목록·검사: `npm run preflight:launch`(scripts/preflight).
`TURNSTILE_VERIFY_URL_TEST`·`CONSULT_AI_MODEL=mock`·`CONSULT_AI_PROVIDER=gemini-free`는 운영에 두지 않는다(코드가 운영에서 무시·차단).

## 4. 미완료 (승인·근거 필요)
- 🔴 **고객 IP(횟수 제한)**: Cloud Run의 `X-Forwarded-For` 신뢰 위치에 대한 Google 공식 문서 근거를 확보하지 못함.
  지금은 Cloud Run 등 Vercel 밖 호스팅에서 요청 헤더를 믿지 않고 `0.0.0.0`(공용 버킷)으로 닫는다 → 횟수 제한이 전체 공용으로 걸린다.
  근거 확보 또는 외부 HTTPS 부하분산기(Cloud Armor) 구성 결정 뒤 별도 PR로 연다.
- 🔴 실제 배포(Cloud Run 서비스 생성·도메인 연결·Secret Manager 입력), Turnstile 실키 검증, 실DB 연결 — 모두 승인 필요.
