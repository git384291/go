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
| 신규 | `docs/REPORT-PHASE1.md`, `test-results/phase1/*` | 이 보고서, 시험 기록·화면 캡처 |
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
