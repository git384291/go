# 운영 Supabase 실행 계획서 — 마이그레이션 0007~0024 · 서버 키 · TOTP (PM 11/23, 기준 87ea95e)

**이 문서는 계획서다. 코드·DB·키·계정·설정을 바꾸지 않았고, 이 문서로 승인되거나 실행되는 것은 없다.**
모든 변경은 순서 `Claude 검수 → PM 승인 → 대표 실행`을 지킨다. 병합·배포·실광고·유료 AI 호출은 계속 금지.

## 0. 현황과 확인할 점
| 항목 | 조회 결과(대표 캡처 03:50) | 해석 |
|---|---|---|
| core.staff | `owner / active=true` | 등록 완료 |
| TOTP 검증 요소 | 0 | 등록 화면이 없어 예상대로 |
| 활성 서버 키 | 없음 | 관리자 세션을 열 수 없는 상태 |
| 마이그레이션 0007~0015 | 미적용 | 0016~0024는 화면이 잘려 **미확인**(아래 SQL로 재확인) |

**확인이 필요한 사항 (추정 금지)**
1. 조회한 프로젝트가 **fideon-dev(개발용)인지 별도 운영 프로젝트인지.** 저장소 문서(LAUNCH-READINESS)는 0001~0006이 fideon-dev에 적용됐다고 기록한다. 이름을 PM·대표가 확인해 주세요.
2. 현재 요금제에서 **백업·시점 복구 가능 여부**(Supabase 설정에서 확인. Claude는 미확인).
3. **관리자 인증은 `VERCEL_ENV=production`이면 코드상 항상 꺼진다**(`adminAuthMode.ts`: "운영 활성화는 PM·사용자 별도 승인 뒤 이 줄을 바꾼다"). 따라서 실제 로그인 검증은 **로컬 개발 서버나 preview**에서만 가능하다. 운영 배포에서의 관리자 로그인은 별도 코드 변경과 승인이 필요하다(이 계획서 범위 밖).

## 1. 조건 분리
### 1-A. 관리자 로그인 실검증 최소 조건 (마이그레이션 0007 이후는 필요 없음)
| # | 조건 | 담당 | 증거 |
|---|---|---|---|
| A1 | 마이그레이션 0001~0006 + `zz_grants` 적용(D1) | 대표 | 위 조회에서 core.staff 존재(확인됨). 권한 점검은 A7 |
| A2 | 공개 가입 끄기(D3) | 대표 | 대시보드 설정 캡처 |
| A3 | Supabase MFA(TOTP) 켜기(D4) | 대표 | 대시보드 설정 캡처 |
| A4 | 서버 서명 키 `staff` 1개를 DB와 앱 환경변수에 같은 값으로 등록(D11) | 대표 | 값 없이 "용도별 개수" 조회 결과, 환경변수 이름 목록 |
| A5 | 앱 필수 환경변수 4개: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `FIDEON_STAFF_SIGNING_KEY`, `DATABASE_URL` + `ADMIN_AUTH_MODE=supabase` + **원격 DB면 `SUPABASE_DB_CA_CERT`(Supabase 공개 CA 인증서, 비밀값 아님)**. CA가 없으면 관리자 인증은 꺼진 상태로 유지된다(11/23 보완, 7절) | 대표 | 이름 목록 캡처(값 제외) |
| A6 | 대표 owner의 TOTP 최초 등록과 결합(4~5절) | 대표 + PM 결정 | 등록 방식 승인 기록 |
| A7 | `scripts/db-audit.sh` 위반 0(D2) | 대표 | 출력 한 줄 |
| A8 | 실제 로그인·거부·로그아웃·갱신 시험(D12~D15) | 대표 | 화면 캡처, 감사 기록 1건 |

### 1-B. 운영 접수·광고·AI 상담에 추가로 필요한 조건
| 기능 | 추가 조건 |
|---|---|
| 접수 | 마이그레이션 0007·0014~0017·0019·0023(고지·접수·신청서·후속 연락), 고지문 확정·검수 기록, `lead` 서명 키, 암호화·HMAC 키 3종, Turnstile 키, 운영 모드 게이트 개방 승인 |
| 정책·견적 | 0008·0009·0014, 정책 2인 승인·게시 |
| 광고 | 0010·0011·0013·0018·0020~0022, Google 테스트 계정 검증, 스케줄러 등록, 정산금 확인, PM·대표 승인(일 1만원·누적 3만원) |
| AI 상담 | 0011·0012·0013, 0024(횟수 제한), Turnstile, 월 한도 설정 |
| 공통 | 최종 상태에서 `db-audit.sh` 위반 0 |

## 2. 마이그레이션 0007~0024 적용 계획
### 2-1. 순서·의존·롤백 (번호 순서 필수, 건너뛰기·역순 금지)
일부 마이그레이션은 앞 번호가 만든 함수를 `create or replace`로 **교체**한다: create_lead(0004→0007), ai_budget_reserve(0011→0012), ad_spend_request(0010→0013→0020→0021), ad_performance_record(0011→0021).
| 번호 | 만드는 것 | 선행 의존 | 롤백(db/rollback) |
|---|---|---|---|
| 0007 | 필수 고지 문구·노출 기록, create_lead 교체 | 0001~0006 | 0007_down + 복구 0007_restore |
| 0008 | 정책 저장소(초안→제출→승인→게시) | 0004 상품 카탈로그 | 0008_down / _restore |
| 0009 | 정책 조회 함수 | 0008 | 0009_down |
| 0010 | 광고 예산 승인·원장 | 0001 직원 | 0010_down / _restore |
| 0011 | 광고 성과·AI 사용 집계 | 0010 | 0011_down / _restore |
| 0012 | 상담 시작 집계·AI 비용 예약 | 0011 | 0012_down / _restore |
| 0013 | 광고 중지 경고·AI 월 한도 | 0010·0011·0012 | 0013_down / _restore |
| 0014 | 정책 게시 스위치·고지 문구 관리 | 0007·0008 | 0014_down |
| 0015 | 고지 검수 기록 | 0007 | 0015_down |
| 0016 | 접수 고지 게이트 | 0007·0015 | 0016_down |
| 0017 | 신청서 암호화 저장·전달 이력 | 0002 접수·0007 | 0017_down |
| 0018 | 광고 launch 상태 | 0010 | 0018_down / _restore |
| 0019 | 재접수 변경 요청 | 0017 | 0019_down / _restore |
| 0020 | 계정 합산 한도(함수 교체, 트랜잭션 구문 없음) | 0013·0018 | 0020_down(0013 정의로 복귀) |
| 0021 | 집행 기간·노출·정기 감시 | 0018·0020 | 0021_down |
| 0022 | 감시 중복 실행 방지 | 0021 | 0022_down |
| 0023 | 대표 직접 연락 목록 | 0002·core.staff | 0023_down |
| 0024 | 상담 횟수 제한 | 없음 | 0024_down |
마지막에 `zz_grants.sql`(멱등, 매번 실행)을 다시 적용한다.

### 2-2. 적용 방법(제안)
1. **사전:** 백업·복구 가능 여부 확인, 프로젝트 이름 확인(0절), 적용 대상 SHA 고정(저장소의 87ea95e 기준 파일).
2. **한 번에 한 파일**을 번호 순으로, 대표 PC에서 `psql --single-transaction -v ON_ERROR_STOP=1 -f <파일>`로 실행한다(0020은 파일 안에 begin/commit이 없어 이 옵션이 필수). 연결 문자열은 채팅·GitHub에 남기지 않는다. 또는 SQL Editor에 파일 내용을 그대로 붙여 넣는다(수정 금지).
3. **각 파일 직후:** 오류 없음 확인 → 다음 번호. 오류가 나면 그 파일은 롤백됐으므로 멈추고 PM에게 보고한다.
4. **전부 끝난 뒤:** `zz_grants.sql` → `scripts/db-audit.sh "<release_auditor 연결>"` 위반 0. 중간 단계에서는 audit을 돌리지 않는다(audit의 함수 본문 고정값은 최종 상태 기준이다).
5. **사후 확인:** 앞서 쓴 통합 조회 SQL에서 0007~0024가 모두 `적용`(0020은 존재 여부로 판별 불가, audit와 `\df`로 확인).
6. 이 프로젝트는 PM 보고상 고객 데이터가 없는 상태여야 한다. 데이터가 있으면 0007의 create_lead 교체 전 대표 확인이 필요하다.

### 2-3. 롤백 방법
- 번호의 **역순**(0024→0007)으로 `*_down.sql` 실행. 각 파일 머리 주석의 보관·복구 조건을 따른다(0007·0008·0010~0013·0018·0019는 보관 테이블 생성, 이미 있으면 실패하도록 설계됨).
- 롤백 뒤 `zz_grants.sql`과 audit의 고정 해시를 이전 값으로 되돌려야 하는 파일이 있다(0007 머리 주석). **운영에서 롤백 실행 전 PM 승인.**
- 롤백 절차는 가상 DB에서 M-시험(db-test.sh)으로 검증된 상태다. 운영 DB에서 실행한 적은 없다.

## 3. 서버 서명 키(server_keys) 절차 — 실제 생성 금지, 값 출력 금지
기준: DEPLOY-CHECKLIST, DEV-AUTH-CONNECTION-PLAN.
1. **형식:** DB `security.server_keys(key_id int, purpose 'staff'|'lead', secret bytea ≥32바이트, active)`와 앱 `FIDEON_STAFF_SIGNING_KEY` / `FIDEON_LEAD_SIGNING_KEY` = `<key_id>:<base64 32바이트 이상>`. **DB와 앱 값이 같아야** 한다.
2. **생성·등록은 대표 PC에서만.** 키 값은 채팅·GitHub·메모·화면 캡처에 남기지 않는다. 비밀번호 관리자에 보관한다. 명령 형식은 PM 승인 후 별도 안내한다.
3. **로그인 최소 조건엔 `staff` 1개만 필요**하다. `lead`는 접수 개방 단계(1-B)에서 만든다.
4. **등록 순서 제약(중요):** 서버 키가 등록되고 앱이 켜진 뒤에는, TOTP가 없는 owner 계정도 **비밀번호를 아는 사람이 Supabase 공개 API로 먼저 TOTP를 등록해 로그인**할 수 있다(현재 코드는 첫 verified TOTP를 쓰고 결합 확인이 없다). 따라서 **TOTP 결합이 승인된 방식으로 끝나기 전에는 키를 등록하지 않는다**, 또는 그 사이 `core.staff.active=false`로 둔다(변경은 PM 승인).
5. **확인:** 키 값 없이 용도별 개수만 조회, 환경변수는 이름 목록 캡처.
6. 키 교체 절차(key_id 증가, 이전 키 비활성)는 이 계획서에서 제안만 하고 실행하지 않는다.
7. **11/23 노출 사고 기록(PM 보고, Claude는 결과 화면 미수신):** fideon-dev에 등록됐던 key_id 1·2(`staff`·`lead`) 값이 화면 캡처로 외부 대화에 노출되어 `active=false`로 폐기했다고 보고됨. 폐기 행은 지우지 않는다(같은 값 재사용 방지). **다음 키는 key_id=3부터**, Mac에서 생성해 화면·채팅·파일·로그에 출력하지 않고 DB와 환경변수에 같은 값으로 넣는다. 결과 표에 키 값을 내는 SQL(`encode(secret, …)`)은 쓰지 않는다. 앱 코드는 key_id를 고정하지 않는다(`src/server/security/token.ts`의 `<key_id>:` 파싱).

## 4. Supabase TOTP 활성화와 최초 등록 — 현재 코드 구조 기준 제안
- 현재 코드: 로그인 화면(`/admin/login`)에는 등록 기능이 **없다**. 비밀번호 → `listFactors()`의 **첫 verified TOTP** → 검증 → aal2 → DB 세션. 등록 후보를 확인하는 DB 함수도 없다(ADMIN-AUTH-OPERATIONS 7-1).
- **TOTP 활성화(A3):** 대시보드의 MFA(TOTP) 설정을 켠다(메뉴 이름은 화면에서 확인 필요). 요금제 제한은 확인 필요.
- **최초 등록 방식 후보**
| 후보 | 내용 | 장점 | 위험 |
|---|---|---|---|
| **A(권장)** 등록 전용 화면 구현 | 5절의 DB 함수·권한 + 대표 발급 1회용 코드로 aal1 단계 등록 | 직접 등록 우회 차단, 결합 기록 | 스키마 변경·코드 구현·승인 필요 |
| B(임시 검토) 서버 키 등록 **전에** 대표 PC에서 1회성 로컬 스크립트로 `mfa.enroll` | 코드·DB 변경 없이 owner 1명만 등록 | 빠름 | 결합 기록 없음, 키 등록 전 구간이 안전한 유일한 시간, 스크립트가 저장소 밖 새 코드(보안 검토 필요), 분실 복구 절차는 별도 |
- Claude 의견: 운영 사용은 **A**, B는 개발 프로젝트에서 로그인 흐름만 시험할 때의 임시 수단으로만 PM·대표가 결정한다. 결정은 이 계획서에서 하지 않는다.
- 분실 복구: ADMIN-AUTH-OPERATIONS 2-3·7-3(두 번째 owner 여부는 PM·대표 결정).

## 5. TOTP 등록 전용 화면이 필요한 경우의 변경 범위 (구현 금지, 기존 설계 STAFF-ENROLLMENT-BOOTSTRAP.md 기준)
| 구분 | 범위(제안) |
|---|---|
| 새 마이그레이션 번호 | **0025 이상.** 기존 설계 문서가 "0007 이후"라고 적은 번호는 이미 다른 기능(0007~0024)에 쓰였으므로 번호를 새로 정해야 한다 |
| 테이블·열 | `core.staff`에 `totp_factor_id`, `totp_bound_at` 추가(일반 update 금지 트리거), 새 `security.enrollment_grants`(해시만 저장, 15분 만료, 대상당 미종료 1건) |
| 함수 | 발급·사용·바인딩·복구 함수(이름·인자는 구현 승인 때 확정). aal1 단계 함수는 `app_public` 권한이 필요하므로 `zz_grants`·`catalog_audit` 허용 목록과 함수 본문 고정값(V5·V13)을 함께 갱신 |
| 서명 | 첫 필드 구분(`enroll`)으로 기존 `staff` 키를 재사용하는 안(새 키 불필요) 또는 별도 목적 추가안. **결정 필요** |
| 로그인 변경 | TOTP 단계에서 사용 요소가 등록 요소와 같은지 확인(결합), 다르면 거부 |
| 화면·API | 인증 스위치 하위, 기본 꺼짐 |
| 시험 | 가상 DB 시험(권한·직접 enroll 우회 거부·만료·재사용), 화면 시험, CI |
| 영향 | 기존 `catalog_audit` 갱신 필요. 운영 DB에는 마이그레이션 적용 승인이 별도로 필요 |

## 7. DB 연결(Transaction pooler·app_server·CA) — 11/23 검수
**코드 보완(로컬, PM 승인 범위):** `src/server/auth/adminAuthMode.ts`의 `isLocalDatabaseUrl`(호스트가 정확히 `localhost`·`127.0.0.1`일 때만 로컬, 해석 실패는 원격)과 CA 조건 추가. 원격 DB + CA 없음이면 `disabled` → 관리자 API는 503 `ADMIN_AUTH_DISABLED`, 화면은 잠금·로그인 이동(우회 없음). `src/server/db/client.ts`도 같은 판단을 쓴다(이전 정규식은 비밀번호 안의 `@localhost:` 문자열을 로컬로 오인할 수 있었음).

**접속 계정:** 설계상 앱은 `app_server`(`0001_security.sql`: login, noinherit, 권한 없음, `app_public`·`app_staff`(·0011의 `app_ai`)로만 전환)로 접속한다. `postgres` 계정으로 `DATABASE_URL`을 만들지 않는다(최소 권한 위반). `app_server` 비밀번호는 마이그레이션에 없으므로 설정은 DB 변경(PM 승인)이다.

**7-1. app_server 권한 확인(읽기 전용, 대표 실행, 승인 후)**
```sql
select rolname, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolinherit, rolcanlogin
from pg_roles where rolname = 'app_server';
select r.rolname as member_of from pg_auth_members m
join pg_roles r on r.oid = m.roleid
join pg_roles u on u.oid = m.member
where u.rolname = 'app_server' order by 1;
```
기대: super·createrole·createdb·bypassrls = false, inherit = false, canlogin = true, 소속은 `app_public`, `app_staff`(0011 적용 후 `app_ai`)뿐. 다르면 진행 중단·보고.

**7-2. 파이프라이닝 위험(공식 문서 기준)**
- Supabase 문서: 트랜잭션 모드(6543)는 prepared statement 미지원, postgres.js는 `prepare: false`(우리 `client.ts` 일치). Supavisor FAQ: 트랜잭션 모드는 트랜잭션 단위로 서버 연결을 돌려준다.
- 파이프라이닝에 대한 공식 언급은 찾지 못했다(미확인). 우리 코드는 모든 쿼리를 `sql.begin()` 안에서 순차 await(`withRoleOn`)하고 `set local`만 쓰며 세션 전용 기능(LISTEN, 세션 `set role`, advisory lock)이 없다 → 위험 낮음으로 판단, 실측으로 확정한다.

**7-3. 실측 시험 계획(실행은 app_server 비밀번호 설정·PM 승인 뒤, 개발 프로젝트만, 쓰기 없음)**
| 번호 | 시험 | 기대 |
|---|---|---|
| P1 | 6543 풀러에 `app_server.<project-ref>` 사용자로 접속(형식은 공식 문서 명시 없음, 미확인) + `SUPABASE_DB_CA_CERT`로 `verify-full` | 접속 성공. 틀린 CA로는 실패(D10) |
| P2 | `begin; set local role app_staff; select current_user; commit;` | `app_staff`, 커밋 뒤 다음 트랜잭션은 `app_server`로 돌아옴 |
| P3 | 같은 프로세스에서 `withRole` 트랜잭션 20개 동시 실행(읽기 전용 `select 1`, `current_setting('role')`) | 오류 0, 각 트랜잭션의 role이 섞이지 않음 |
| P4 | 트랜잭션 밖 동시 쿼리 10개(`sql\`select 1\``) | 오류 0(파이프라이닝 충돌 없음) |
| P5 | `prepare: true`로 바꾼 임시 클라이언트로 같은 쿼리 반복(대조군, 시험 스크립트 안에서만) | 오류가 나면 `prepare:false` 필요성 재확인 |
| P6 | 거부: `select * from security.server_keys`, `set role postgres` | 둘 다 권한 오류 |
결과는 통과/실패와 오류 코드만 보고하고 접속 문자열·비밀번호는 남기지 않는다. 시험 스크립트는 저장소 밖 1회용으로 만들고 PM 검수 후 실행한다.

## 6. 실행 순서(제안)와 승인 게이트
1. [PM] 프로젝트 이름(dev/운영)·백업 가능 여부 확인 및 이 계획서 승인.
2. [대표] A2·A3 대시보드 설정(공개 가입 끄기, TOTP 켜기) — 읽기·설정 캡처.
3. [PM 결정] TOTP 최초 등록 방식(4절 A 또는 B). A면 5절 구현 승인 → Claude 구현·가상 DB 시험·CI → 마이그레이션 적용 승인.
4. [대표, 승인 후] 마이그레이션 0007~0024 적용(2절) → zz_grants → db-audit.
5. [대표, 승인 후, TOTP 결합 확정 뒤] `staff` 서버 키 등록과 환경변수(3절).
6. [대표] 개발 서버/preview에서 실제 로그인·로그아웃·갱신 시험(D12~D15) → Claude가 캡처 검수.
7. 운영 접수·광고·AI는 1-B 조건이 모두 충족된 뒤 각각 별도 승인.

미확인 항목: 0016~0024 적용 여부, 프로젝트 이름, 백업 가능 여부, Supabase 대시보드의 정확한 메뉴·요금제 제한, `db-audit.sh`를 운영 DB에서 실행한 결과.
