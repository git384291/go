# FIDEON 1차 구현 보고 (REV-004 대응)

- 작성일: 2026-11-13
- 개발: Claude / 검수: ChatGPT / 운영 배포 승인: 사용자
- 상태: 1단계 기반 개발 완료. **실제 고객정보 수집·운영 DB 저장·운영 배포는 하지 않았다.**

## 0. 먼저 알려야 할 제약

이번 작업 환경은 외부 네트워크가 막혀 있어 `npm install`이 불가능했다. 그래서 다음은 **실행하지 못했다**.

| 실행하지 못한 것 | 영향 | 대신 확인한 것 |
| --- | --- | --- |
| Next.js 설치·`next build`·개발 서버 | 라우팅·빌드 오류는 첫 설치 때 확인해야 함 | 같은 페이지 컴포넌트를 React 서버 렌더러로 렌더링해 모바일 화면 캡처(7개 화면) |
| `postgres`, `@supabase/ssr` 패키지 | `requireStaff.ts`, `db/client.ts`, `api/leads/route.ts`는 타입 검사·실행 미검증 | 이 파일들이 호출하는 핵심 로직(서명·암호화·입력 검증·인증 판정)은 별도 모듈로 분리해 타입 검사·단위 테스트 통과 |
| ESLint, Vitest | 린트 규칙 미실행 | 테스트는 Node 내장 `node:test`로 작성(추가 설치 불필요) |
| `package-lock.json` 생성 | 의존성 버전 미고정 | 첫 설치 때 lockfile을 만들어 커밋해야 함 |

DB 테스트는 이 환경에 있는 **PostgreSQL 16**으로 실제 실행했다. Supabase가 아닌 일반 PostgreSQL이므로, Supabase에서만 다를 수 있는 부분은 7절에 따로 적었다.

## 1. Git 커밋 해시와 변경 파일

- 코드 커밋: `bd2dc30c3ed5cec59f1eaeaea6efb22a3cfd5619` (`feat: 1단계 기반 개발 (REV-004)`)
- 이 보고서는 다음 커밋으로 추가된다.
- 저장소 전체는 `fideon.bundle`(git bundle, 이력 포함)로 제출한다. 받는 쪽에서 `git clone fideon.bundle fideon`으로 연다.

| 구분 | 파일 |
| --- | --- |
| DB | `db/migrations/0001_security.sql`, `0002_leads.sql`, `zz_grants.sql`, `db/seed/test_seed.sql`, `db/tests/00~30*.sql` |
| 서버 코드 | `src/server/security/token.ts`, `piiCrypto.ts`, `src/server/leads/intake.ts`, `turnstile.ts`, `src/server/auth/staffAssertion.ts`, `requireStaff.ts`, `src/server/db/client.ts`, `src/app/api/leads/route.ts` |
| 화면 | `src/app/page.tsx`, `products/*/page.tsx`, `consult/page.tsx`, `admin/page.tsx`, `admin/login/page.tsx`, `privacy/page.tsx`, `src/components/*`, `src/content/products.ts`, `src/mock/leads.ts`, `src/app/globals.css` |
| 테스트·도구 | `tests/unit/*.test.ts`, `scripts/db-test.sh`, `restore-drill.sh`, `sign-parity.ts`, `scripts/preview/*` |
| 설정 | `package.json`, `tsconfig*.json`, `next.config.ts`(보안 헤더), `eslint.config.mjs`, `vercel.json`, `.github/workflows/ci.yml`, `deploy-production.yml`, `.env.example` |
| 결과 | `test-results/*` |

## 2. 프로젝트 폴더 구조

`README.md` 참고. 요약: `db/`(마이그레이션·시드·SQL 테스트), `src/app/`(화면·API), `src/server/`(서버 전용 로직), `src/components/`(화면 컴포넌트, 서버 모듈 import 금지), `tests/unit/`, `scripts/`.

## 3. 모바일 화면 실행 결과

390×844(아이폰 크기), 2배율 캡처. `test-results/screens/`

| 화면 | 파일 | 자동 검사 |
| --- | --- | --- |
| 메인 | `01-home.png` | 가로 넘침 없음, 금액 표기 0 |
| 인터넷 + TV | `02-internet-tv.png` | 〃 |
| 인터넷 + 집전화 | `03-internet-phone.png` | 〃 |
| CCTV · 보안 | `04-cctv-security.png` | 〃 |
| 상담 신청 | `05-consult.png` | 〃, 입력칸 비활성·"온라인 신청 준비 중" 안내 |
| 관리자 로그인 | `06-admin-login.png` | 〃, 미리보기 표시 |
| 관리자 목록 | `07-admin-leads.png` | 〃, "가상 데이터" 표시, 연락처 마스킹 |

`*-first-view.png`는 첫 화면(스크롤 전) 모습이다. 금액·사은품 숫자는 어느 화면에도 없다(자동 검사). 검색 노출은 `robots: noindex`로 막아 두었다.

## 4. 수정한 관리자 인증 코드 (SEC-01)

**변경 요지:** 세션 ID 단독 인증을 없애고 **(사용자 ID, 세션 ID)를 서버 키로 함께 서명한 토큰 + DB 자체 세션 테이블**로 바꿨다. Supabase 내부 테이블(`auth.sessions`)은 더 이상 쓰지 않는다.

1. 서버(`requireStaff.ts`): Supabase가 서명을 검증한 토큰 클레임에서 `sub`(사용자), `session_id`, `aal`을 꺼낸다. `aal2`(2단계 인증 완료)가 아니면 거부한다.
2. 서버(`staffAssertion.ts`): `signToken('staff', [사용자, 세션])` — 5분 이내 만료되는 HMAC-SHA256 서명.
3. DB(`security.assert_staff`): 서명을 다시 계산해 확인하고, **자체 세션 테이블에서 그 세션의 주인이 같은 사용자인지**, 취소되지 않았는지, 12시간 이내인지, 관리자 활성·역할을 확인한다.
4. 로그인 직후 1회만 `api.staff_session_open`으로 세션을 등록한다. 이 함수는 서명 대상이 달라서 일반 요청 토큰으로는 세션을 만들 수 없다. 로그아웃은 `api.staff_session_revoke`로 즉시 무효화한다.

| 공격 시나리오 | 결과 (테스트 번호) |
| --- | --- |
| 세션 ID만 전달 / 위조 서명 | 거부 (A2, A3) |
| 다른 관리자의 세션 ID 사용 | 거부 (A4, A5, A6) |
| `app.actor_role` 등 설정값 위조 | 효과 없음 (A12) |
| 비활성 계정·12시간 초과·로그아웃 세션·만료 서명·다른 용도 키 | 거부 (A7~A11, A21) |
| SQL 인젝션으로 테이블·키·검증 함수 직접 접근 | 권한 없음 (A14~A19) |

남은 한계: 서명 키는 서버 환경변수와 DB(`security.server_keys`, 앱 역할 접근 불가)에 있다. 운영 서버 환경변수가 유출되면 관리자 토큰을 위조할 수 있으므로, 키 교체 절차가 필요하다(`key_id`로 교체 가능하게 설계).

## 5. 수정한 상담 신청 API 코드 (SEC-02)

- **암호화·HMAC은 서버에서만:** 브라우저는 이름·번호 원문만 보내고, 서버가 AES-256-GCM 암호화, 번호 HMAC, IP HMAC(원문 IP 미저장)을 만든다. 브라우저가 `phoneHmac`·`nameEnc`·`leadId` 같은 필드를 보내면 거부한다(I5).
- **서버 서명:** DB로 보내는 15개 필드 전체를 서명한다. DB가 서명을 다시 확인하므로 서버를 거치지 않은 값이나 변조된 값은 저장되지 않는다(L4, L5).
- **동의:** 서버에서 필수 동의와 처리방침 버전을 확인하고(I3, I4), DB에서도 다시 확인한다(L6, L7). 광고 수신 동의는 별도 이력 테이블에 기록한다(S5).
- **리드 ID 비노출:** 응답은 신규·중복·재전송 모두 `accepted` 하나다(L1~L3). API 응답도 `{ ok: true }`뿐이다.
- **동시·중복 신청:** 같은 번호는 DB 잠금으로 직렬화해 동시 10건에도 리드 1건 + 재문의 9건(C2). 같은 IP는 시간당 10건이며, 동시 12건에서 정확히 10건만 받는다(C3).
- **수집 차단:** `leadIntakeGate`가 `LEAD_INTAKE_MODE=local` + 로컬 DB일 때만 열린다. Vercel 운영·검수 환경, 원격 DB, 그 외 모든 값은 503(I7). DB 쪽도 `lead_form` 스위치·보유기간·처리방침 버전이 없으면 거부한다(L13, L14).

## 6. 데이터베이스 권한 검사 결과 (SEC-03)

`test-results/db-grants-report.txt`. SECURITY DEFINER 함수 13개 전수:

| 함수 | 소유자 | 실행 가능 역할 |
| --- | --- | --- |
| `api.create_lead` | fideon_api | app_public |
| `api.whoami`, `list_leads`, `reveal_contact`, `update_lead`, `assign_lead`, `export_leads_masked`, `set_feature_flag`, `purge_customer`, `staff_session_open`, `staff_session_revoke` | fideon_api | app_staff |
| `security.assert_staff`, `security.verify_token` | postgres | fideon_api(함수 내부 호출 전용) |

모든 함수의 `search_path` 고정. 검사 항목 G1~G9 통과: 모든 테이블 RLS+FORCE, 앱 역할 테이블 권한 0, 앱 역할 스키마 USAGE는 `api`만, 허용 목록 밖 EXECUTE 0, PUBLIC 실행 가능 함수 0, 역할 간 교차 실행 불가, 서명 키는 함수 소유자만 조회.

역할별 분리: 대표(owner)는 전체, 상담원(counselor)은 배정분만 조회·수정·원문 열람, 검수자(reviewer)는 마스킹 목록만, 정책 담당(policy_editor)은 1단계 고객 기능 접근 없음. 공개 고객은 상담 신청 1개 함수만 실행한다.

**수수료·정산 차단에 대해:** 1단계에는 수수료·정산 테이블이 아직 없다. 대신 G2·G5가 "앱 역할에는 어떤 테이블 권한도, 허용 목록 밖 함수 권한도 없다"를 스키마 전체에 대해 검사하므로, 2단계에서 수수료·정산 테이블이 추가되면 별도 작업 없이 같은 검사에 포함된다. 2단계에서 "고객용 조회는 성공하고 수수료는 조회되지 않음"을 확인하는 동작 테스트를 추가한다.

**AI 비용 함수 (SEC-04):** 3단계 기능이라 이번에 만들지 않았다. `zz_grants.sql`에 "AI 예산 함수는 app_public이 아닌 서버 내부 전용 역할에만 부여"를 명시했고, G5 허용 목록 검사가 이를 강제한다.

## 7. 자동 테스트 실행 결과

| 묶음 | 결과 | 파일 |
| --- | --- | --- |
| 핵심 모듈 타입 검사 (TypeScript 6.0.3) | 오류 0 | `typecheck-core.txt` |
| 단위 테스트 (서명·암호화·입력 검증·인증 판정·수집 차단) | 19 / 19 통과 | `unit.txt` |
| DB 보안 테스트 (권한 9, 관리자 인증 21, 상담 신청 15, 개인정보 22, TS↔DB 서명 일치 5, 역할·동시성 3) | 75 / 75 통과, 3회 반복 실행 동일 | `db-test-results.txt`, `db-grants-report.txt` |
| 복구 훈련 (암호화 덤프 → 새 DB 복원 → 비교) | 통과: 9개 테이블 행 수·내용 해시 일치, 복원 DB 권한 검사 통과, 잘못된 키 복호화 거부 | `restore-result.txt` |
| 화면 검사 (7개 화면) | 가로 넘침 0, 금액 표기 0 | `screens/checks.txt` |

테스트가 실제로 실패를 잡는지도 확인했다: `app_staff`에 리드 테이블 조회 권한을 일부러 주면 G2가, 세션 테이블 RLS를 끄면 G1이 실패했다.

**Supabase에서 다시 확인해야 하는 것 (1주차 Supabase 프로젝트 개설 후)**

1. `postgres` 역할로 `grant fideon_api to current_user`, 함수 소유자 변경, 서명 키 정책(`key_reader`)이 동작하는지
2. 연결 풀러에서 `app_server` 사용자 정의 역할 로그인, CA 인증서 검증
3. `getClaims()`가 주는 `session_id`·`aal` 클레임 형식
4. `pgcrypto`가 `extensions` 스키마에 있는지(Supabase 기본값)

하나라도 다르면 구현을 멈추고 먼저 보고한다.

## 8. 발견된 오류와 남은 위험

**개발 중 발견해 고친 오류**

| 오류 | 원인 | 수정 |
| --- | --- | --- |
| 동시성 테스트가 가끔 실패 | IP별 횟수 제한 검사가 잠금 전에 실행돼, 같은 IP의 동시 요청들이 서로의 기록을 못 보고 모두 통과할 수 있었음(제한 초과 허용 버그) | IP 해시 단위 DB 잠금 후 검사. 같은 IP 동시 12건 → 정확히 10건 테스트(C3) 추가 |
| 복구 훈련에서 백업에 서명 키 포함 | 덤프 범위가 `security` 스키마 전체 | 서명 키 테이블 데이터를 덤프에서 제외. 복원 후 키는 별도 등록 절차로 넣는다 |
| 운영 배포 승인이 태그 메시지·Markdown 기반(REV-003) | PM 지적 SEC-05 | GitHub Environment `production` 필수 승인자 방식으로 교체(`deploy-production.yml`) |

**남은 위험**

| 위험 | 등급 | 대응 |
| --- | --- | --- |
| Next.js·DB 드라이버·Supabase 연동 코드가 아직 실행되지 않음 | 높음 | 네트워크가 되는 환경에서 `npm ci` → `npm test` → `next build` 후 재제출 |
| 비공개 저장소에서 Environment 필수 승인자를 쓸 수 있는 GitHub 요금제 미확인 | 중 | 저장소 개설 시 확인. 불가하면 대안을 PM에게 먼저 보고 |
| 서명 토큰은 5분 안에 같은 요청을 다시 보내는 재사용을 막지 않음 | 낮음 | 관리자 토큰은 요청마다 새로 만들고 HTTPS로만 전송. 상담 신청은 멱등 키로 재전송 무해화 |
| PL/pgSQL의 서명 비교가 상수 시간 비교가 아님 | 낮음 | 네트워크 지연에 비해 차이가 매우 작음. 필요 시 2단계에서 보완 |
| 처리 주체·보유기간·사업자 표시 등 법률 확인 미완료 | 높음 | 확정 전에는 DB가 상담 신청을 거부(L14), 화면은 수집하지 않음 |
| 덤프 복원 시 관리자 계정(Supabase Auth)은 복원 대상 아님 | 중 | 전체 손실 시 관리자 재등록 절차를 운영 문서에 포함 |

자체 증분 복구 스크립트(REV-003 `export-delta`·`reimport-delta`)는 PM 지시대로 운영 절차에서 뺐고 이번 커밋에도 넣지 않았다.

## 9. 예상 운영비 변동

| 항목 | REV-002 | 이번 변동 |
| --- | --- | --- |
| Supabase Pro, Vercel Pro, 알림톡, 도메인 | 월 약 7.5만 원(1단계) | 변동 없음 |
| 봇 차단(Turnstile) | 무료 | 변동 없음 |
| GitHub | 무료 가정 | **추가 가능성**: 비공개 저장소에서 브랜치 보호·배포 승인 기능을 쓰려면 유료 요금제가 필요할 수 있음. 저장소 개설 시 요금제와 금액을 확인해 보고 |
| AI | 3단계부터 | 변동 없음 |

## 10. 다음 개발 단계 제안

1. **네트워크가 되는 환경에서 설치·빌드 검증 (최우선):** `npm ci`, lockfile 커밋, `npm run typecheck`·`lint`·`build`, 화면을 실제 Next.js 개발 서버로 다시 캡처.
2. **Supabase 개발 프로젝트 개설 후 7절 4개 항목 확인**, 같은 DB 테스트를 Supabase 개발 프로젝트에서 한 번 더 실행.
3. **관리자 로그인 실제 연결:** Supabase Auth 이메일+TOTP, 로그인 직후 `staff_session_open`, 로그아웃 `revoke`. 관리자 화면을 가상 데이터에서 로컬 DB 함수 호출로 전환.
4. **SEC-01~03 재검수 요청:** 위 결과와 함께 제출. 통과 전에는 실제 고객정보 수집을 열지 않는다.
5. 재검수 통과 후 법률 확인 결과(처리 주체·보유기간)를 반영하고, 운영 배포는 사용자 승인으로 진행.
