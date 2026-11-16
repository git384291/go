# 최초 owner 인증 등록(부트스트랩) — 구체 변경안 (PM 6919431756, 6919806262 보완)

**상태: 제안만 담은 문서다.** 이 문서로 승인되거나 실행되는 것은 없다.
- migration 작성·등록·적용 없음(0007·0008 파일에 쓰지 않음), 앱 UI·API·SQL 초안 구현 없음
- 키 목적·로그인 동작 변경 없음, 원격 Auth·DB·계정·키·env 변경 없음
- 무료 개발 환경(fideon-dev)을 전제로 한다. Pro 기능·비용은 전제하지 않는다.
- 이 문서는 **앱 Auth 사용자의 MFA**(FIDEON 관리자 로그인)만 다룬다. Supabase 대시보드 계정의 MFA(프로젝트 관리자 로그인)와는 별개다.

관련 문서: `docs/ADMIN-AUTH-OPERATIONS.md` 7·8절(기존 설계 근거), `docs/design/DEV-AUTH-CONNECTION-PLAN.md` 단계 C

## 0. 현재 상태 (코드·스키마 기준)
| 항목 | 현재 | 문제 |
|---|---|---|
| `core.staff(user_id, role, active, created_at)` | 등록 factor를 기록하는 열 없음 | 어떤 TOTP로 로그인했는지 DB가 모름 |
| `security.staff_sessions(id, user_id, created_at, revoked_at)` | 세션 개설 함수 `api.staff_session_open(actor, session, token)`, 서명 `staff:['session-open', actor, session, 'aal2']` | aal2 클레임만 확인. factor 결합 없음 |
| `security.server_keys.purpose ∈ {staff, lead}`, 앱 `TokenPurpose = 'staff' \| 'lead'` | `staff` 키를 여러 용도가 첫 필드로 구분해 공유한다(`session-open`, `product-approve`) | — |
| 로그인(`loginFlow.ts`·`supabaseServer.ts`) | 비밀번호 → `listFactors()`의 **첫 verified TOTP** 선택 → `challengeAndVerify` → aal2 → 세션 개설 | 등록(enroll) 경로 없음. 첫 verified 선택은 결합 근거가 아님 |
| aal1 등록 자격 확인 DB 함수 | 없음(`assert_staff`·`whoami`는 열린 aal2 세션 필요) | 등록 전 사용자를 확인할 수단 없음 |
| 권한(`zz_grants`) | `app_public`: `create_lead`만. `app_staff`: 직원 함수 10개 | 등록 함수는 aal1 단계라 `app_public` 쪽에 필요 |

## 1. 스키마·함수·권한·서명 변경 전후 (제안)

### 1-1. 테이블·열
| 대상 | 변경 전 | 변경 후 |
|---|---|---|
| `core.staff` | `user_id, role, active, created_at` | + `totp_factor_id uuid null`, + `totp_bound_at timestamptz null`. 일반 update 금지 트리거: 바인딩 함수·복구 함수만 변경 가능 |
| `security.enrollment_grants` | 없음 | 새 테이블. 열은 아래와 같다. |

`security.enrollment_grants` 열
- `id uuid pk`, `user_id uuid fk core.staff`, `purpose text check (purpose = 'totp_enroll')`
- `code_sha256 text`: 1회용 코드의 해시만 저장한다.
- `issued_via text check in ('project_owner_sql','owner')`, `issued_by uuid null`
- `expires_at timestamptz`(발급 + 15분)
- `state text check in ('issued','reserved','enrolling','bound','failed','expired','revoked')`
- `operation_id uuid null`, `factor_id uuid null`, `created_at`, `updated_at`

제약
- 대상 1명당 미종료(`issued`·`reserved`·`enrolling`) grant는 1건까지다(부분 unique 인덱스).
- 테이블 권한은 0이다. 모든 접근은 함수로만 한다.

### 1-2. 함수
| 함수 | 호출자(DB 역할) | 하는 일 |
|---|---|---|
| `security.enrollment_bootstrap_issue(p_user uuid) returns text` | **프로젝트 소유자 SQL 편집기만**(앱 역할 실행 권한 0) | 조건: owner 역할 활성 직원 + `totp_factor_id`가 있는 owner가 0명일 때만. 무작위 코드를 1회 반환하고 해시만 저장. 감사 `enroll.bootstrap_issue` |
| `api.enrollment_grant_issue(actor, session, token, p_user)` | `app_staff`(owner aal2 세션) | 이후 직원용(최초 owner에는 쓰지 않음) |
| `api.enrollment_begin(actor, auth_session, token, op_id, code)` | `app_public` | `issued → reserved` |
| `api.enrollment_record_factor(actor, auth_session, token, op_id, factor_id)` | `app_public` | `reserved → enrolling` |
| `api.enrollment_bind(actor, auth_session, token, op_id, factor_id)` | `app_public` | `enrolling → bound` + `core.staff.totp_factor_id` 설정 + 감사(한 트랜잭션) |
| `api.enrollment_fail(actor, auth_session, token, op_id, reason_code)` | `app_public` | `reserved·enrolling → failed`(고정 사유 코드만) |
| `api.staff_session_open` | `app_staff` | **변경:** 인자에 `p_factor_id uuid` 추가. `totp_factor_id = p_factor_id`가 아니거나 NULL이면 FORBIDDEN |
| `api.staff_recovery_reset(owner 인증, p_user)` | `app_staff`(owner aal2) | 복구: `active=false`, `totp_factor_id=NULL`, 세션 전부 폐기, 미종료 grant `revoked`, 감사(한 트랜잭션) |

- 모든 함수는 SECURITY DEFINER, `search_path=''`이고 소유자는 `fideon_api`다.
- `catalog_audit` V5(실행 허용 목록)와 V13(본문 고정 해시)을 갱신해야 한다. `staff_session_open` 시그니처가 바뀐다.

### 1-3. 서명(키 목적)
- **제안: 새 키 목적을 추가하지 않고 기존 `staff` 키를 첫 필드로 분리해 쓴다.** 기존 `session-open`·`product-approve`와 같은 방식이다.
  - `['enroll-begin', actor, auth_session, 'aal1', op_id]`
  - `['enroll-factor', actor, auth_session, 'aal1', op_id, factor_id]`
  - `['enroll-bind', actor, auth_session, 'aal2', op_id, factor_id]`
  - `['enroll-fail', actor, auth_session, op_id, reason_code]`
  - 세션 개설 변경: `['session-open', actor, session, 'aal2']` → `['session-open', actor, session, 'aal2', factor_id]`
- **이유:** 서명 대상의 첫 필드가 달라 서로 재사용할 수 없다. 새 키·환경변수·`server_keys.purpose` 변경이 필요 없다.
- **한계:** `staff` 키 하나가 유출되면 모든 용도가 함께 위험해진다. 다만 현재 신뢰 경계와 같다.
- **대안:** 새 목적 `enroll`(별도 키, `server_keys.purpose`·`TokenPurpose`·env 추가). 결정점 1번이다.
- 앱 `TokenPurpose`는 변경하지 않는다(제안안 기준).

## 2. 최초 owner 1명의 순서와 신뢰 경계
신뢰 근거는 ① 서버가 검증한 Auth 클레임(`getClaims`: `sub`, `session_id`, `aal`), ② 서버 서명(`staff` 키), ③ DB의 직원·grant 상태뿐이다. 클라이언트가 보낸 actor·role·factorId·approved 같은 값은 근거로 쓰지 않는다.

1. **[프로젝트 소유자]**
   - Supabase에 대표 Auth 사용자를 만든다(이메일·비밀번호).
   - SQL 편집기에서 `insert into core.staff (user_id, role, active) values (<그 user_id>, 'owner', true)`를 실행한다.
   - `select security.enrollment_bootstrap_issue(<user_id>)`로 1회용 코드를 받는다. 결과 화면에 한 번만 보이며, 저장·복사·전송하지 않는다.
   - 감사에는 `enroll.bootstrap_issue`(actor NULL, 대상 user_id)만 남긴다.
2. **[대표] 비밀번호 로그인(aal1)**
   - 서버가 `getClaims`로 `sub`·`session_id`·`aal='aal1'`을 확인한다.
   - 등록 스위치(`ADMIN_ENROLL_MODE`, 기본 꺼짐)가 켜져 있을 때만 등록 화면을 연다.
3. **[대표] 코드 입력 → 서버 `enrollment_begin`**
   - 서버가 새 `op_id`(uuid)를 만들고 `enroll-begin` 서명과 함께 호출한다.
   - DB가 원자적으로 확인하는 것
     - 서명
     - 활성 owner 직원
     - `totp_factor_id IS NULL`
     - 그 사용자의 `issued` grant, 미만료, 코드 해시 일치
   - 확인되면 `issued → reserved`로 바꾸고 `op_id`를 기록한다. 감사 1건을 남긴다.
4. **서버: 사전 정리**
   - 사용자 세션으로 `listFactors()`를 호출한다.
   - **verified TOTP가 이미 있으면 중단한다**(지우지 않음 → `enrollment_fail('VERIFIED_EXISTS')`, 복구 절차로 안내).
   - unverified TOTP만 `mfa.unenroll`한다(이 사용자 것만).
5. **서버: `mfa.enroll({factorType:'totp'})`**
   - 성공하면 `enrollment_record_factor(op_id, factor_id)`로 `reserved → enrolling`이 된다.
   - QR·secret은 **브라우저 응답 1회 표시만** 한다. 서버 저장·로그는 없다.
6. **[대표] 앱 인증기 코드 입력 → 서버 `mfa.challenge` + `mfa.verify`(사용자 세션)**
   - 성공 뒤 서버가 확인하는 것
     - `getClaims`의 `aal='aal2'`, `sub` 동일
     - `listFactors()`의 verified TOTP가 **정확히 1개**이고, 그 id가 `factor_id`와 같음
7. **서버 `enrollment_bind`(`enroll-bind` 서명, aal2)**
   - DB 한 트랜잭션에서 처리한다: `enrolling → bound` + `core.staff.totp_factor_id = factor_id`, `totp_bound_at = now()` + 감사
8. **세션 개설(변경된 `staff_session_open`)**
   - 서버가 서명 필드에 이번 검증의 `factor_id`를 넣는다.
   - DB가 `totp_factor_id`와 같은지 확인해야 세션이 열린다.
   - 이후 로그인도 같다: "첫 verified 선택"이 아니라 `totp_factor_id`와 같은 factor로 challenge하고, 서명에 포함한다.

**원자성 경계:** Supabase 호출(4~6)과 DB 트랜잭션(3·5 기록·7)은 **하나의 원자적 작업이 아니다.** 단계마다 상태를 기록하고, 다음 단계는 이전 상태와 `op_id`가 맞을 때만 진행한다.

## 3. 1회용 승인 규칙
- **결합:** grant는 대상 `user_id`, 용도 `totp_enroll`, 만료(15분), 코드 해시와 묶인다. begin 이후에는 `op_id`가 결합되고, enrolling 이후에는 `factor_id`까지 결합된다.
- **원자적 소진:** `update … set state='reserved', operation_id=$op where id=$g and state='issued' and expires_at > now() and code_sha256=$h returning …`. 0행이면 실패다.
- **재시도·중복**
  - 같은 `op_id`로 같은 전이를 다시 요청하면 현재 상태를 그대로 돌려준다(멱등).
  - 다른 `op_id`면 거부하고 감사를 남긴다.
  - begin이 성공한 grant는 다시 begin할 수 없다.
- **경쟁:** 각 함수는 `pg_advisory_xact_lock(hashtextextended('fideon.enroll.user:'||user_id, 0))`를 먼저 잡는다. 같은 사용자의 전이는 직렬화된다.
- **실패 롤백:** DB 전이는 각자 트랜잭션이다. 실패하면 그 단계만 롤백되고, 이전 상태가 유지된다. 외부 Auth 상태는 4절 표대로 따로 처리한다.
- **만료:** 미종료 grant가 `expires_at`을 지나면 다음 호출 때 `expired`로 바꾼다. 스케줄러는 쓰지 않는다.

## 4. 상태 전이·실패 처리표
| 상황 | 감지 | DB 처리 | Auth 처리 | 결과 |
|---|---|---|---|---|
| 정상 | 2절 1~8 | issued→reserved→enrolling→bound | factor verified 1개 | 세션 개설 가능 |
| 코드 틀림·만료·재사용 | begin 0행 | 변화 없음(만료면 expired) | 없음 | 재발급 필요(재사용은 감사) |
| enroll 실패 | SDK 오류 | `enrollment_fail` → failed | 없음 | 재발급 |
| enroll 성공 뒤 DB 기록 실패 | record_factor 실패 | reserved 유지 | **미검증 factor 남음** | 다음 시도(새 grant) 4단계에서 unverified만 unenroll |
| verify 실패(코드 틀림) | SDK 오류 | enrolling 유지(만료 전까지 재시도) | 미검증 유지 | 만료 시 failed. 다음 시도에서 unverified 정리 |
| verify 응답 유실 | 응답 없음 | enrolling 유지 | **verified일 수 있음** | 재진입 시 `listFactors`로 판정. verified 1개 + id 일치면 bind로 진행. **unenroll하지 않음** |
| verify 성공 뒤 bind DB 실패 | bind 실패 | enrolling 유지 | verified 1개 | 같은 op_id로 bind 재시도(멱등). 만료 뒤엔 failed로 두고 **verified factor는 지우지 않음** → 복구 절차 |
| 이미 verified factor가 있는 상태에서 재시도 | 4단계 | failed(VERIFIED_EXISTS) | 그대로 | 복구 절차(소유자 해제) 뒤 재발급 |
| verified 2개 이상(직접 enroll 의심) | 6단계 | failed + 감사 | 그대로 | 계정 `active=false` 권고, 소유자 확인 |
| 직원 비활성화 | begin·bind의 `active` 확인 | 거부, 미종료 grant revoked | 그대로 | — |
| Auth 세션 변경·폐기 | 서명의 `auth_session` ≠ 클레임 | 거부 | — | 다시 로그인 후 같은 grant(만료 전, 같은 op_id 없음)로는 begin 불가 → 재발급 |
| 복구 중 | `staff_recovery_reset` | factor_id NULL, 세션 전부 폐기, 미종료 grant revoked | 소유자가 factor 해제 | 부트스트랩 또는 owner 발급으로 재등록 |

원칙
- 실패마다 무조건 unenroll하지 않는다(성공한 verified factor를 지우지 않음). unenroll 대상은 이 사용자의 **unverified** factor뿐이다.
- 실패를 성공으로 숨기지 않는다. 어떤 실패도 bound를 만들지 않는다.

## 5. 비밀 자료 취급
- QR·TOTP secret·복구 자료는 본인 등록 화면 응답에 1회만 담는다(no-store). DB·Git·PR·로그·진행판에 넣지 않는다.
- 1회용 코드: 원문은 저장하지 않고 해시만 저장한다. 프로젝트 소유자 SQL 결과로 1회 보며, 채팅·메일·PR로 전달하지 않는다.
- 감사 `detail` 허용 필드: `op`(고정 코드), `state_from/to`, `grant_id`, `via`, 고정 `reason_code`
  - `actor_id`·`target_id`는 user_id만 쓴다.
  - factor_id는 감사에 넣지 않는다(DB 열에만 둠).
  - 코드·secret·QR·토큰·IP 원문은 넣지 않는다.

## 6. 검증 구분
| 구분 | 항목 |
|---|---|
| **가짜 포트(이 컨테이너, 경로·단위)** | 상태 전이·멱등·op_id 불일치·만료·verify 응답 유실 재진입·verified 존재 중단·verified 2개 거부·unverified만 unenroll·클라이언트 값 무시·비밀 미로그(가짜 Auth 포트로 SDK 응답 주입) |
| **이 컨테이너의 로컬 PG 폐기 DB** | grant 원자 소진·동시 begin 1건만·재사용 거부·만료·서명 필드 분리(`enroll-*` vs `session-open` 교차 거부)·bind 트랜잭션·`staff_session_open` factor 불일치 FORBIDDEN·복구 리셋·권한(앱 역할 직접 접근 0, bootstrap 함수 앱 실행 0)·V5/V13 |
| **공식 Auth 문서로 확인할 계약** | `mfa.enroll`·`challenge`·`verify`·`listFactors`·`unenroll`의 응답 형태, verify 뒤 세션 aal2 반영 시점, 미검증 factor 개수 제한, 사용자 세션으로 unenroll 가능한 범위, 소유자 관리 API의 factor 삭제 |
| **실제 사용자 인증 필요(사용자 본인)** | 대표 Auth 사용자 생성, `core.staff` 행·부트스트랩 코드 발급(SQL 편집기), 앱 인증기 등록·코드 입력, 실제 로그인·세션 개설, 분실 복구 리허설 |

## 7. 구현 파일·시험 파일(승인 뒤)
- **DB:** 다음 번호 migration 1개(등록·결합), `zz_grants.sql`(app_public·app_staff 실행 허용, bootstrap 함수는 앱 0), `db/audit/catalog_audit.sql`(V5·V13), `db/tests/50_enrollment.sql`
- **앱**
  - `src/server/auth/enrollFlow.ts`: 상태 진행, 포트 주입
  - `src/server/auth/supabaseServer.ts`: enroll·challenge·verify·listFactors·unenroll 포트
  - `src/server/auth/staffAssertion.ts`: `enroll-*` 서명, `session-open`에 factor_id
  - `src/server/auth/loginFlow.ts`: `totp_factor_id` 일치 factor로 challenge
  - `src/app/admin/enroll/*`: 등록 스위치 하위, 기본 꺼짐, no-store, 검색 제외
- **시험:** `tests/route/enroll-flow.test.ts`(가짜 포트), `tests/route/login-factor-binding.test.ts`, `db/tests/50_enrollment.sql`, smoke에 등록 화면 꺼짐 확인 추가
- **롤백·잠금**
  - `ADMIN_ENROLL_MODE` 꺼짐: 등록 화면·API 닫힘
  - `ADMIN_AUTH_MODE=disabled`: 실인증·db 목록 닫힘
  - 미종료 grant revoke(owner 또는 소유자 SQL)
  - `staff_recovery_reset`
  - migration 되돌리기는 새 down migration으로 한다(열·함수 제거 전에 세션 개설을 기존 시그니처로 되돌리는 순서).

## 9. 보완 (PM 6919806262) — 아래가 1~4절보다 우선한다

### 9-1. 저장·서명·함수 인자 대조표
`security.enrollment_grants`에 추가할 열
- `revision int not null default 0`: 전이마다 +1
- `auth_session_id uuid null`: begin 때 고정
- `begin_digest text null`: `sha256(grant_id | user_id | auth_session_id | operation_id | purpose | code_sha256)`
- `factor_origin text null check (factor_origin = 'this_operation')`

| 결합 항목 | 저장(grant) | 서명 필드 | 함수 인자 | 결합 시작 단계 |
|---|---|---|---|---|
| grant_id | `id` | begin 이후 전부 | begin 뒤 모든 함수 | 발급 |
| actor(user_id) | `user_id` | 전부 | `actor` | 발급 |
| 용도 | `purpose='totp_enroll'` | 첫 필드 `enroll-*` | — | 발급 |
| 코드 지문 | `code_sha256` | `enroll-begin`에 `code_sha256` | `code`(원문은 서버 → DB 해시 비교) | 발급 |
| 최초 auth_session | `auth_session_id` | 전부 | `auth_session` | **begin**(이후 다른 세션은 거부) |
| operation | `operation_id` | 전부 | `op_id` | **begin**(DB가 생성) |
| 내용 지문 | `begin_digest` | `enroll-factor`·`enroll-bind`에 포함 | `begin_digest` | begin |
| factor | `factor_id`, `factor_origin` | `enroll-factor`·`enroll-bind` | `factor_id` | record_factor |
| 기대 revision | `revision` | 전이 함수 서명에 포함 | `expected_revision` | 모든 전이 |

- 서명 예시(내용 결합)
  - `['enroll-begin', actor, auth_session, 'aal1', code_sha256]`
  - `['enroll-factor', actor, auth_session, 'aal1', grant_id, op_id, begin_digest, factor_id, expected_revision]`
  - `['enroll-bind', actor, auth_session, 'aal2', grant_id, op_id, begin_digest, factor_id, expected_revision]`
- 모든 함수가 매번 다시 검사하는 것: 서명, `core.staff`의 활성 owner 여부, `totp_factor_id IS NULL`(bind 전), 만료, `auth_session_id`·`operation_id`·`begin_digest`·`factor_id`·`revision` 일치
- 같은 op_id라도 actor·세션·내용·대상(factor)이 다르면 거부한다.

### 9-2. 안정 operation과 재시도 구분
- **operation_id는 서버가 아니라 DB가 begin 때 만든다.**
- 같은 요청 재시도: `actor + auth_session + code_sha256`이 이미 `reserved`·`enrolling`인 grant와 같으면, 같은 `operation_id`·`revision`을 돌려준다(새 감사 없음, 멱등).
- 서버는 operation을 브라우저에서 받지 않는다. 각 단계 전에 `api.enrollment_status(actor, auth_session, token)`로 DB에서 조회한다. 이 함수는 그 actor·세션이 소유한 미종료 operation 1건을 돌려준다.
- 이미 소진된 grant와 새 begin 구분
  - 같은 세션·같은 코드 → 재시도(같은 operation)
  - 다른 세션 → `SESSION_MISMATCH` 거부
  - 종료 상태(`bound`·`failed`·`expired`·`revoked`) grant의 코드 → `GRANT_CLOSED`(새 발급 필요)
- **점유 해소:** 발급 함수(bootstrap·owner 발급)는 대상 사용자 락 안에서 먼저 만료가 지난 미종료 grant를 `expired`로 바꾼다(commit). 그 뒤에도 미종료 grant가 있으면 `GRANT_PENDING`으로 거부한다.
  - `record_factor` 실패로 `reserved`에 남은 grant는 ① 만료(15분) 뒤 자동 expired, ② 소유자 SQL `security.enrollment_grant_revoke(user)` 둘 중 하나로만 비운다.

### 9-3. verify 응답 유실 재진입 — 복원 먼저
1. `enrollment_status`로 이 actor·세션의 operation을 복원한다.
2. 상태가 `enrolling`(factor F 기록됨)이면 `listFactors`로 판정한다.
   - **F가 verified이고 verified TOTP가 정확히 1개** → bind로 진행. VERIFIED_EXISTS 검사는 적용하지 않는다(이 operation이 소유한 factor).
   - F가 unverified → challenge·verify 재시도
   - F 외의 verified가 있음 → `failed(FOREIGN_VERIFIED)`, 아무것도 지우지 않음, 소유자 확인
3. VERIFIED_EXISTS 검사는 **operation이 factor를 아직 소유하지 않은 begin 직후 단계에서만** 적용한다.
4. 정리(unenroll) 대상은 **이 operation이 기록한 F가 unverified일 때 F 하나뿐**이다. 출처를 모르는 다른 unverified factor는 지우지 않고 보고만 한다(2절 4단계의 "unverified 일괄 정리"를 이것으로 대체).
5. 만료됐거나 세션이 바뀐 뒤에는 자동 bind하지 않는다. F가 verified로 남아 있으면 9-4 복구로 처리한다.

### 9-4. 첫·마지막 owner 복구 — 프로젝트 소유자 SQL 전용
`api.staff_recovery_reset`(owner aal2)은 owner가 TOTP를 잃으면 부를 수 없다. 그래서 아래 함수를 추가한다(앱 역할 실행 권한 0, 전역 부트스트랩 락).

1. `security.owner_recovery_reset(p_user)`: 한 트랜잭션에서 처리한다.
   - `active=false`, `totp_factor_id=NULL`
   - 그 사용자 세션 전부 `revoked_at`
   - 미종료 grant `revoked`
   - 감사 `owner.recovery_reset`
2. **[프로젝트 소유자]** Supabase 쪽 해당 사용자의 factor를 해제한다. 어느 공식 기능으로 할 수 있는지는 계약 확인 전이라 확정하지 않는다.
3. `security.owner_recovery_reactivate(p_user)`: `totp_factor_id IS NULL`일 때만 `active=true`로 바꾼다. 감사를 남긴다.
4. `security.enrollment_bootstrap_issue(p_user)`로 새 1회 코드를 발급한다(bound owner가 0명일 때만, 9-5).

- **우회 금지:** `staff_session_open`은 `totp_factor_id`가 NULL이면 항상 FORBIDDEN이다. 그래서 복구 뒤에도 예전 aal2-only 로그인으로 돌아갈 수 없고, 반드시 새 등록·결합을 거쳐야 한다.

### 9-5. commit·rollback 계약과 전역 불변식
- **상태를 남겨야 하는 결과**(만료 처리, failed, 멱등 재응답)는 예외를 던지지 않는다. 결과 코드를 반환하고 commit한다(예: `{"result":"EXPIRED","revision":n}`). 이 경우의 감사는 같은 트랜잭션에 넣는다.
- **예외(rollback)**는 상태를 바꾸지 않는 거부(서명·권한·불일치·revision 충돌)에만 쓴다. 이 경우 감사는 남지 않는다. 필요하면 서버가 별도 호출 `api.enrollment_reject_log`로 고정 사유만 기록한다.
- **bootstrap 불변식:** 모든 bootstrap·bind(owner)·owner 복구 함수는 같은 전역 락 `pg_advisory_xact_lock(hashtextextended('fideon.enroll.bootstrap', 0))`을 잡는다. 그 안에서 다음을 확인한다.
  - bootstrap 발급: "bound owner 0명 + 미종료 bootstrap grant 0건"
  - bind: bootstrap grant라면 "다른 bound owner 0명"
  - 동시 발급은 이 락으로 직렬화되므로 bound owner가 2명이 될 수 없다.
- **1회 코드 사용 절차:** 프로젝트 소유자가 SQL 결과를 보고 → 같은 사람이 본인 기기의 등록 화면에 바로 입력한다(로컬 일시 사용).
  - 파일·메모·채팅·PR·스크린샷에 남기지 않는다.
  - 15분 안에 쓰지 못하면 버리고 새로 발급한다.

### 9-6. 참조 모델
- `docs/design/staff-enrollment/model.ts`(비활성 순수 함수)와 `tests/route/staff-enrollment-model.test.ts`가 9-1~9-5 규칙을 가상 상태로 실행한다.
- **이 모델의 통과는 실제 JWT 검증·RLS·PG 동시성·Auth 원자성·실계정 복구 통과가 아니다.**

### 9-7. 검증 뒤 멱등 (PM 6920128585)
- **처리 순서는 모든 단계·재시도·`status`에 같다**
  1. 공통 검증(직원 활성 owner·허용 AAL)
  2. operation 소유(actor·세션)
  3. 만료 commit
  4. 내용·상태·revision 검증
  5. 동일 요청이면 멱등 응답
- **우선순위:** 권한·소유 불일치 거부(rollback)가 만료 commit보다 먼저다.
- **동일 요청:** grant에 마지막 반영 요청(`단계 + 정규화 내용`)을 저장하고, 정확히 같을 때만 동일 요청이다.
  - begin: 코드 지문
  - record_factor: digest·기대 revision·factor
  - bind: digest·기대 revision·factor·verified 목록(정렬)
  - fail: digest·기대 revision·사유
  - 사유·digest·revision이 하나라도 다르면 거부한다. 정상 중복은 감사 0, 원본 불변이다.
- **종료된 grant(`bound`·`failed`):** 상태 변경 없는 기존 결과 확인만 한다. 재예약이나 권한 복원으로 이어지지 않는다. 다음 단계로 간 operation에 begin을 다시 보내도 되돌아가지 않는다.
- **세션 개설**
  - 세션 id는 서버가 검증한 auth 세션과 같아야 한다.
  - 같은 id의 기존 세션이 다른 사용자 것이거나 폐기됐으면 거부한다(폐기를 되돌리지 않음).
  - 유효한 같은 세션 재시도만 멱등이다.

## 8. 결정점 (PM·사용자)
1. 서명: 기존 `staff` 키 + 첫 필드 분리(제안) vs 새 목적 `enroll`(별도 키·env)
2. 최초 코드 전달: SQL 편집기 결과 1회 표시(제안) vs 소유자가 로컬에서 만든 해시만 입력하는 방식
3. verify 응답 유실·bind 실패 뒤 만료 시 verified factor 처리: 복구 절차로만(제안) vs 같은 사용자 재로그인 때 자동 bind 허용 범위
4. 등록·결합 migration과 reviewer 정정·0007의 적용 순서
5. 사용자 행동(아직 실행 요청 아님): 대표 Auth 사용자 생성, `core.staff` 행·부트스트랩 코드 발급, 앱 인증기 등록
