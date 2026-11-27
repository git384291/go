# FIDEON PM PHASE 1 대응 보고서 — 상품 비활성화 구조

- 기준 저장소 / 커밋: `git384291/go` / `184925d`
- 작업 브랜치: `phase1-product-scope` (로컬 전용, push·PR 없음)
- 범위: PHASE 1 지시 1~10항. 2단계(정책 관리·CRM·AI·광고) 미착수.

## ① 변경 파일 목록

| 구분 | 파일 | 내용 |
|---|---|---|
| 신규 | `src/content/catalog.ts` | 상품 상태의 유일한 기준(코드). 인터넷+TV만 active, 나머지 reserved |
| 신규 | `db/migrations/0004_product_scope.sql` | 상품 상태 테이블, 2인 승인 기록 테이블, 보호 트리거, `api.create_lead` 교체(상품 확인 1단계 추가) |
| 신규 | `db/tests/40_product_scope.sql` | DB 시험 46건(PS1~PS46) |
| 신규 | `tests/unit/catalog.test.ts` | 단위 시험 10건(G1~G10) |
| 신규 | `scripts/preview/next-navigation-stub.cjs` | Next.js 미설치 환경의 미리보기 전용 404 대체 모듈 |
| 신규 | `docs/REPORT-PHASE1.md`, `test-results/phase1/*` | 이 보고서, 시험 기록·화면 캡처 (최종 검수 보완에서 저장소에서 제외 — 같은 결과물은 CI artifact `test-results`와 Mac `verify-results/`에 남음) |
| 수정 | `src/content/products.ts` | `ACTIVE_PRODUCTS`, `isActiveSlug` 추가(상품 문구 3종 모두 보존) |
| 수정 | `src/app/page.tsx`, `src/components/Site.tsx`, `src/app/layout.tsx` | 홈·메뉴·푸터·검색 설명에서 예약 상품 제거 |
| 수정 | `src/components/ProductPage.tsx` | 예약 상품이면 `notFound()` → 404 |
| 수정 | `src/app/consult/page.tsx`, `src/components/ConsultForm.tsx`, `src/app/globals.css` | 상담 대상 인터넷+TV 고정, 주소 `?interest=` 무시 |
| 수정 | `src/server/leads/intake.ts`, `src/app/api/leads/route.ts` | 예약 상품 `PRODUCT_NOT_ACTIVE`(403) 차단 |
| 수정 | `scripts/db-test.sh`, `scripts/sign-parity.ts`, `scripts/preview/*`, `tests/e2e/mobile-real.ts` | 새 시험 연결, 기대값 변경(예약 상세 404) |
| 무수정 | `db/migrations/0001~0003`, `zz_grants.sql`, `db/audit/*`, CI 3종, 보안 헤더 | 변경 없음(git diff로 확인) |

## ② 구현 내용

**상품 상태**

| 상품 키 | 상태 | 비고 |
|---|---|---|
| internet_tv | active | 유일한 운영 상품 |
| internet_phone | reserved | 기존 화면 보존, 404 |
| cctv_security | reserved | 기존 화면 보존, 404 |
| internet_only / other | reserved | 상담 대상 고정으로 비노출 |
| mobile (휴대폰) | reserved | 설계(키)만. 화면·접수 경로 없음 |
| 동판 | — | 정의 미확정으로 키 생성 보류 |

**3중 차단**
1. 화면: 홈·메뉴·푸터는 `ACTIVE_PRODUCTS`만 표시. 예약 상세 주소는 404. 상담 폼은 인터넷+TV 고정이며, 브라우저로 내려가는 폼 코드에는 예약 상품 이름·값이 없음(서버가 활성 상품만 넘김).
2. 서버: `/api/leads`가 외부 확인(Turnstile) 호출 **전에** 예약 상품을 403으로 거부. `buildCreateLeadArgs`도 다시 거부.
3. DB: `api.create_lead`가 `core.product_catalog`에서 active인지 확인. 아니면 `FP001`(PRODUCT_NOT_ACTIVE).

**코드·DB 불일치 차단**: 서버(코드)와 DB가 각각 검사하므로 한쪽만 예약이어도 접수 불가. 기준값은 단위 시험 G8이 0004 파일과 대조해, 다르면 시험 실패.

**활성화 승인 구조(DB)**
- 예약 → 활성 전환에는 **사용자 승인(owner 역할) + PM 승인(reviewer 역할)** 두 건이 모두 필요.
- 승인 기록은 서버 서명 키로 만든 **승인 전용 서명**(상품·승인 종류·승인자·세션에 묶임)이 있어야만 저장됨. 승인자 ID만 적어 넣으면 거부(DB 관리자 계정으로 직접 넣어도 거부).
- 승인자는 유효한 본인 세션(12시간 이내, 폐기 안 됨)과 활성 계정이어야 함. 승인 시각은 DB가 정함.
- 승인은 7일 유효, 1회용(활성화에 쓰이면 소진). 승인 후 승인자가 비활성화되면 무효.
- 승인 기록·상품 행은 수정·삭제·TRUNCATE 불가. 활성 상태로 새 행 추가 불가. 예약으로 되돌리기(안전 방향)는 승인 없이 가능.
- 이번 단계에서는 승인·활성화를 호출하는 앱 API를 만들지 않음(앱 역할은 접근 불가).

## ③ 테스트 실행 명령 및 결과 (로컬 가상 DB, 2026-11-14)

| 명령 | 결과 | 변경 전(184925d) |
|---|---|---|
| `npx tsc -p tsconfig.core.json` | 통과 | 통과 |
| `npx tsx --test tests/unit/*.test.ts` | **35/35 통과** | 25/25 |
| `bash scripts/db-test.sh` | **132/132 통과** | 85/85 |
| `npm run test:preview` (미리보기 + 노출 검사) | 통과 | 통과 |
| e2e 스크립트 타입 검사 | 통과 | — |

- 기존 시험(단위 25, DB 85: 권한 점검·동시성·서명 일치·개인정보 보호)은 전부 그대로 통과.
- 시험이 실제로 잡아내는지 확인(일부러 고장 낸 뒤 원복): DB 기준값 불일치 → G8 실패, 0002 함수 본문 변경 → G9 실패, 메뉴에 CCTV 링크 하드코딩 → 미리보기 실패, 코드에서만 CCTV 활성화 → 실행 즉시 실패, 폼 코드에 예약 상품 목록 추가 → G10 실패.

**이 환경에서 실행하지 못한 것**(Next.js·ESLint·React 타입 미설치, 네트워크 차단): `npm run typecheck`(전체), `npm run lint`, `npm run build`, 실제 브라우저 e2e(`tests/e2e/mobile-real.ts`). → Mac에서 실행 필요.

## ④ 기존 기능 영향

- 삭제한 기능 없음. 집전화·CCTV 화면 파일, 상품 문구, 기존 마이그레이션 그대로.
- 옮긴 것 1건: `ConsultForm`의 선택지 목록(5개)은 브라우저 코드에서 빼고, 같은 값·이름을 `catalog.ts`(서버 쪽)에 보존. 이에 따라 `ConsultForm` 입력값이 `defaultInterest` → `options`, `kakaoUrl`로 바뀜(사용처: 상담 페이지 1곳).
- `sign-parity.ts` 예시 상품을 cctv → internet_tv로 변경(서명 일치 시험 목적은 동일), 우회 시험 S6 추가.
- 상담 수집 비활성(`NEXT_PUBLIC_LEAD_FORM_ENABLED`, `LEAD_INTAKE_MODE`, DB `lead_form`), 관리자 화면 운영 잠금, 보안 헤더는 그대로.
- 기존 DB 데이터의 `internet_phone`/`cctv_security` 리드는 그대로 보관·조회 가능(신규 접수만 차단).
- 배포 순서 영향 없음: 코드만 먼저 / DB만 먼저 어느 쪽이든 예약 상품은 차단됨.

## ⑤ 보안 및 비활성화 검증 결과

| 확인 항목 | 결과 |
|---|---|
| 홈·메뉴·푸터·상담 화면에 예약 상품 흔적 | 없음(미리보기 자동 검사) |
| `/products/internet-phone`, `/products/cctv-security` | 404 |
| 상담 화면 상품 | 인터넷+TV 고정(선택란 없음) |
| 예약 상품 서버 접수 | `PRODUCT_NOT_ACTIVE` 거부(외부 API 호출 전) |
| 정상 서명된 예약 상품 요청(서버 검사 우회 가정) | DB가 `FP001` 거부 (PS3~7, S6) |
| 공개·관리자 역할의 상품 상태 조회·변경 | 불가 (PS9~11) |
| 서명 없는 / 위조 / 다른 상품용 / 역할 불일치 / 비활성·만료·폐기 세션 승인 | 모두 거부 (PS14~21) |
| 승인 1건만, 7일 경과, 승인자 비활성화, 소진된 승인 재사용 | 활성화 거부 (PS25, 31, 32, 41) |
| 승인 기록·상품 행 수정·삭제·TRUNCATE | 거부 (PS26~29, 42~45) |
| 배포 전 권한 점검(release_auditor) | 새 테이블 포함 위반 0건 |
| 실제 고객정보 수집·운영 배포 | 계속 비활성 / 미실시 |

## ⑥ 남은 위험과 PM 확인 사항

**남은 위험**
1. 전체 타입 검사·ESLint·Next 빌드·실제 브라우저 e2e는 이 환경에서 못 돌림 → Mac에서 확인 필요(아래 명령).
2. DB 최고 관리자(슈퍼유저)는 트리거를 끄거나 서명 키를 읽을 수 있어 승인 구조를 우회할 수 있음. → 운영 DB 관리자 계정 접근 통제 필요. 배포 전 권한 점검에 "보호 트리거 켜짐 여부" 검사를 추가하는 것을 다음 단계에 제안(권한 점검 파일 수정이 필요해 이번엔 보류).
3. `package-lock.json` 없음(OI-001) — `npm ci` 불가 문제는 그대로.
4. 관리자 화면 가상 데이터에 CCTV·집전화 예시가 남아 있음(내부·운영 잠금 상태, 고객 비노출).

**PM 확인 요청**
1. "인터넷만", "잘 모르겠어요"도 예약(접수 차단)으로 처리했습니다. 맞는지 확인 부탁드립니다.
2. PM 승인은 DB의 `reviewer` 역할 계정으로 기록됩니다. 실제로 이 계정을 누가 운영할지 정해야 합니다(사용자 승인 = `owner` 계정).
3. 동판 정의(상품 생성 보류 중).
4. 위험 2번의 권한 점검 보강을 다음 단계에 포함할지.

**Mac에서 확인할 명령**
```
git checkout phase1-product-scope   # 또는 패치 적용: git am 0001-*.patch
npm install
npm test                 # 타입 검사 + lint + 단위 + DB + 미리보기
npm run build
npm run start -- -p 3100 &  npx tsx tests/e2e/mobile-real.ts http://127.0.0.1:3100 test-results/phase1/e2e
```

---

# PHASE 1 보완 보고 (PM 검수 1차 지적 대응)

- 제출 커밋 c3b01a6 → 보완 커밋(로컬, push·PR 없음). 범위: 검수 지적 1~6항. PHASE 2 미착수.

## ① 실제 변경 파일

| 구분 | 파일 | 내용 |
|---|---|---|
| 신규 | `db/migrations/0005_product_scope_hardening.sql` | 승인 서명 1회용(지문 고유 인덱스), 미소진 승인 1건 제한, 동시성 잠금. 0004 보호 함수 2개 교체 |
| 신규 | `db/tests/45_product_scope_hardening.sql` | 재사용 방지 시험 PH1~PH14 |
| 신규 | `src/content/channels.ts` | 외부 상담 채널 사용 여부 코드 상수(`false`) |
| 수정 | `db/audit/catalog_audit.sql` | 배포 전 점검 V10(보호 트리거 켜짐), V11(상담 함수 상품 확인), V12(고유 인덱스) |
| 수정 | `scripts/db-test.sh` | 동시성 시험 K1~K4, 점검 감지 시험 X7~X11, 45번 파일 연결 |
| 수정 | `db/tests/40_product_scope.sql` | 시험 도구에 서명 유효시간 인자 추가(재승인 시 새 서명 발급). 시험 항목·기대값은 그대로 |
| 수정 | `src/components/Site.tsx`, `ConsultForm.tsx`, `src/app/consult/page.tsx`, `globals.css` | 카카오톡 버튼·안내·문구 비표시 |
| 수정 | `scripts/preview/render.tsx`, `tests/e2e/mobile-real.ts`, `tests/unit/catalog.test.ts` | 외부 상담 연결 노출 검사, G11 |
| 수정 | `scripts/verify-mac.sh` | 화면 미리보기 단계 추가 |
| 무수정 | `0001~0004`, `zz_grants.sql`, CI, 보안 헤더 | 변경 없음 |

## ② 추가 테스트 결과

**1항 서명 재사용** — 보완 전 재현: 같은 승인 서명 2개를 5분 안에 재사용해 승인 행 5건 저장, 예약으로 되돌린 상품 **재활성화 성공(취약점 확인)**. 보완 후 같은 재현: 재사용 3건 모두 `APPROVAL_PROOF_REUSED`, 재활성화 거부, 예약 유지.
PH1~PH14 통과: 즉시 재사용·소진 후 재사용 거부, 지문만 보관(서명 원문 미저장), 지문 변경 불가, 같은 칸 중복 대기 거부, 고유 인덱스 2개 존재. 이 시험은 상품을 활성화하지 않음.

**2항 동시성** — K1 같은 서명 동시 5건 → 1건만 기록·4건 재사용 거부 / K2 같은 승인 칸에 다른 서명 동시 5건 → 미소진 1건 / K3 동시 활성화 5건 → 활성화 기록 1건·승인 모두 소진 / K4 소진된 승인으로 동시 재활성화 3건 → 모두 거부.
※ K3은 가상 시험 DB에서만 '중복 활성화 방지'를 확인하고 즉시 예약으로 되돌리며, 종료 시 활성 상품이 인터넷+TV뿐인지 확인함. 운영 DB·운영 코드와 무관.

**3항 배포 전 점검** — X7 꺼진 상품 보호 트리거, X8 꺼진 승인 보호 트리거, X9 복제 전용으로 바꾼 트리거, X10 지운 1회용 인덱스, X11 상품 확인이 빠진 옛 상담 함수 → 모두 감지. 원복 후 위반 0건.

**4항 카카오톡** — 하단 고정 버튼·상담 안내·실패 문구에서 외부 채널 연결 제거. 환경변수를 설정해도 켜지지 않음. 일부러 켜면 G11·미리보기 검사 실패 확인 후 원복.

## ③ 전체 테스트·빌드·E2E 결과

| 항목 | 이 환경 | 결과 |
|---|---|---|
| core 타입 검사 | 실행 | 통과 |
| 단위 시험 | 실행 | 36/36 (기존 25 그대로 통과) |
| DB 시험 | 실행 | 155/155 (기존 85개 항목 전부 그대로 통과) |
| 화면 미리보기 | 실행 | 통과(예약 상품·외부 상담 노출 0, 예약 상세 404) |
| E2E 스크립트 타입 검사 | 실행 | 통과 |
| 전체 타입 검사·Lint·Next.js 빌드·실제 브라우저 E2E | **미실행** | npm 저장소 접속 차단 → Mac에서 `bash scripts/verify-mac.sh` 실행 필요 |

## ④ 보안 검증 결과

- 승인 서명: 1회용(영구), 상품·종류·승인자·세션에 묶임, 5분 유효, 동시 재사용 불가.
- 활성화: 사용자+PM 2인, 동시 요청에도 1회만, 승인은 1회용, 7일 만료.
- 배포 전 점검이 보호 장치 꺼짐·삭제·되돌림을 감지.
- 외부 상담 채널 차단, 고객정보 수집·운영 배포 비활성 유지.
- 기존 보안·개인정보 시험(서명 일치, 권한 분리, RLS, 마스킹, 파기, IP 제한, 동시성) 전부 통과.

## ⑤ 남은 위험

1. Mac 검증(전체 타입 검사·Lint·빌드·실제 브라우저 E2E) 결과 미확보 — 최종 승인 전 필요.
2. DB 슈퍼유저 위험은 남음(트리거 끄기·서명 키 열람). 배포 전 점검으로 '꺼진 상태 배포'는 막지만, 배포 후 운영 중 변경은 운영 DB 접근 통제로 막아야 함. 세션 단위 `session_replication_role=replica` 우회도 슈퍼유저 권한 필요.
3. 운영 DB에 0004·0005가 적용되지 않은 상태로 배포 전 점검을 돌리면 V10~V12 위반으로 배포가 막힘(의도된 동작).
4. 같은 초에 같은 내용으로 만든 승인 서명은 동일 값이라 두 번째는 재사용으로 거부됨(정상 운영에서 문제 없음).
5. 홈의 "무료 상담 신청" 버튼은 수집이 꺼진 미리보기 양식으로 연결됨(접수 없음). 문구 유지 여부는 PM 판단.
6. `package-lock.json` 부재(OI-001).

---

# PHASE 1 Mac 검증 오류 보완 보고

- Mac 검증(4838b19 = bb5c581과 같은 내용): TypeScript·단위·DB 155/155·미리보기 통과 / ESLint 오류 7·경고 2 / 빌드 실패 / E2E 미실행.
- 원인: Next.js 15.5의 `next build`는 ESLint 오류가 있으면 빌드를 중단한다 → 빌드 실패의 직접 원인은 ESLint 오류 7건으로 판단.
- ESLint 규칙은 하나도 끄거나 예외 처리하지 않았다(`eslint.config.mjs`는 내보내기 형식만 변경).

## 변경 파일 · 수정 내용 · 원인

| # | 파일 | 원인 | 수정 |
|---|---|---|---|
| ① | `scripts/preview/css-stub.cjs` | PHASE 1에서 추가한 `require('node:module')`, `require('node:path')` → no-require-imports 오류 2건 | `require()` 호출 제거. 현재 모듈의 생성자(`module.constructor`)와 `__dirname` 경로 사용. 미리보기 대체 모듈 기능 유지 |
| ② | `scripts/preview/render.tsx` | 화면 목록 배열 안 JSX 4개(Home·InternetTv·AdminLogin·Admin)에 key 없음 → jsx-key 오류 4건 | 각 요소에 key 추가 |
| ③ | `src/components/Site.tsx` | 홈 이동 `<a href="/">` → no-html-link-for-pages 오류 1건 | `next/link`의 `Link`로 변경. 카카오톡 버튼은 계속 비표시(`EXTERNAL_CONSULT_ENABLED = false`) |
| ③-1 | `scripts/preview/next-link-stub.tsx`(신규), `css-hook.mjs` | 미리보기 실행 환경에 Next.js가 없으면 `next/link`를 못 불러옴 | Next.js가 **설치되지 않은 경우에만** 쓰는 대체 모듈(`<a href>` 출력). Mac에서는 실제 Link 사용 |
| ④ | `eslint.config.mjs` | 이름 없는 기본 내보내기 경고 | `const eslintConfig = [...]; export default eslintConfig;` (규칙 내용 동일) |
| ⑤ | `tests/unit/intake.test.ts` | I3의 미사용 변수 `_c` 경고 | 동의 항목을 지운 입력을 `delete`로 만듦(시험 의미 동일, I3 통과) |
| ⑥ | `scripts/db-test.sh` | 서명 일치 단계가 `tsx`를 PATH에서 찾음 → PATH에 없으면 실패 | `npx --no-install tsx`로 프로젝트에 설치된 tsx 사용(PATH에 tsx 없는 상태로 동작 확인) |
| ⑦ | `tsconfig.json` | Next.js 15 빌드가 빠진 기본값을 자동으로 써 넣음 | `allowJs: true`, include에 `.next/types/**/*.ts`를 미리 반영 → 빌드가 파일을 다시 고치지 않음. 시험 대상은 .ts/.tsx뿐이고 JS를 불러오는 TS 코드가 없어 기존 타입 검사 결과 영향 없음 |
| ⑧ | `src/content/channels.ts`, `src/app/page.tsx`, `src/components/ProductPage.tsx`, `Site.tsx`, `src/app/consult/page.tsx`, `ConsultForm.tsx`, `globals.css` | '무료 상담 신청' 등이 접수 가능으로 오해를 줌 | 안내 문구 `ONLINE_CONSULT_NOTICE = '온라인 상담 서비스 준비 중'` 한 곳에서 관리. 홈 버튼·상품 상세 버튼·하단 고정 바·상담 페이지 제목·폼 안내·제출 버튼 변경, 진행 단계는 "서비스가 열리면" 미래형 안내 |
| 시험 | `scripts/preview/render.tsx`, `tests/e2e/mobile-real.ts` | ⑧ 문구 회귀 방지 | 고객 화면에 접수 오해 문구 6종이 있으면 실패, 준비 중 안내가 없으면 실패 |

무수정: DB 마이그레이션 0001~0005, DB 시험(40·45), 권한 점검, CI, 보안 헤더, 상품 상태(catalog.ts), 승인 구조.

## 시험 결과 (이 작업 환경)

| 항목 | 결과 |
|---|---|
| core 타입 검사 | 통과 |
| 단위 시험 | 36/36 (intake I3 포함) |
| DB 시험 | 155/155 — Mac에서 통과한 155개 항목과 같은 구성, 누락 0 |
| 화면 미리보기 | 통과: 예약 상품·외부 상담·접수 오해 문구 0, 준비 중 안내 있음, 예약 상세 404 |
| 옛 문구 되살림 시험 | '무료 상담 신청'을 다시 넣으면 미리보기 실패 확인 후 원복 |
| E2E 스크립트 타입 검사 | 통과 |
| ESLint · 전체 타입 검사 · Next.js 빌드 · 실제 브라우저 E2E | **미실행** — 작업 환경 npm 접속 차단. Mac에서 `bash scripts/verify-mac.sh` 재실행 필요 |

## 남은 위험 · 검증 필요

1. ESLint·빌드·E2E 통과는 Mac 재실행으로만 확인 가능. 보고된 7건·2건은 원인 위치를 코드에서 모두 확인해 수정했으나, 실제 ESLint 실행 결과로 최종 확인 필요.
2. tsconfig 자동 변경 내용은 Next.js 15 기본 동작 기준으로 반영함. Mac에서 빌드 후 `git diff tsconfig.json`에 다른 변경이 남으면 그 내용 확인 필요.
3. 기존 위험(DB 슈퍼유저 통제, package-lock 부재 OI-001)은 그대로.
