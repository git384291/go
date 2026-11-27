# 개발 Auth·owner MFA·세션·풀러 CA 실연결 — 구체 변경안 (PM 6916935437 3항, 6917234887 정정)

**상태: 제안만 담은 문서다.** 이 문서로 승인되거나 실행되는 것은 없다.
- 계정·키 생성, 원격 설정·권한·실제 env 수정, 외부 요청 없음
- 비밀값은 적지 않고, 설정 항목 이름과 필요한 권한만 적는다.
- fideon-dev에는 기존 0001~0006 + `zz_grants`가 `fideon_phase1_initial`로 적용돼 있다(PM 확인). 이를 전제로 하며, 초기화나 새 프로젝트는 제안하지 않는다.

기준 문서
- `docs/ADMIN-AUTH-OPERATIONS.md`: 3절 체크리스트 D1~D18, 7·8절 TOTP 등록 설계
- `docs/AUTH-SESSION-FOUNDATION.md`
- `docs/LAUNCH-READINESS.md`: 0-2 ⑧·⑨, 0-4~0-7

## 0. 현재 위치 (코드 존재 ≠ 실연결)
| 영역 | 코드 존재 | 가상·로컬 검증 | 실연결 검증 |
|---|---|---|---|
| Supabase 로그인(비밀번호 → TOTP aal2), `getClaims` 검증, 로그아웃·middleware | ○ | ○(경로·단위, 가짜 클라이언트) | × |
| DB 직원 세션(`staff_session_open`·`assert_staff`·12시간·폐기) | ○ | ○(로컬 PG I1~, DB 176) | × |
| 서버 서명(`staff` 목적) | ○ | ○(가상 키) | × 실제 키 미등록(D11) |
| 기본 DB 연결 `db()`(URL·`prepare:false`·CA 검증)·`withRole` | ○ | △(로컬은 Unix socket 주입 실행기만. 기본 `withRole` URL 경로는 실행 안 됨) | × (D9·D10) |
| 마스킹 목록 어댑터·route·읽기 전용 화면 | ○ | ○(가짜·폐기 DB PG 9, smoke 잠금) | × (`dbReadReady`가 loopback 폐기 DB만 허용) |
| TOTP 최초 등록·분실 복구 | 설계만(7·8절) | × | × |
| 로그인 시도 제한 | 초안 0007(비활성) | ○(초안 57·안전 6) | × |

## 1. 단계별 변경안
각 단계: 변경 전 → 후 / 필요한 권한 / 검증 / 되돌리기. **[사용자]**는 계정 소유자 본인만 할 수 있는 단계이고, **[Claude]**는 현재 도구(저장소 코드·CI·로컬)로 할 수 있는 단계다.

### 단계 A — fideon-dev Auth 설정: 확인 → 필요하면 변경 (D3~D8) — PM 6917234887 정정
**현재 값은 미확인이다.** 아래는 "확인할 항목 → 원하는 값"이며, 이전 값을 단정하지 않는다.

| 항목 | 확인 → 원하는 값 | 요금제 | 대체 통제·남는 한계 |
|---|---|---|---|
| 공개 가입(이메일 가입 허용) | 확인 → 끔 | 무료 가능 | — |
| MFA(TOTP) 사용 | 확인 → 켬 | 무료 가능(PM 제공 근거: auth-mfa/totp) | — |
| 세션 time-box·비활성 제한·사용자당 단일 세션 | 확인만 | **Pro 이상** (Supabase sessions 문서: "only available on Pro Plans and up", 확인함) | **무료 fideon-dev에는 적용할 수 없다고 본다.** 업그레이드·지출은 미승인. 대체 통제는 앱 DB 세션의 12시간·폐기·로그아웃 폐기(`security.staff_sessions`)이며, 앱 접근만 제한한다. Supabase 자체 refresh 세션은 그대로 유지되므로, 이를 Supabase 세션 제한을 적용한 증거로 쓰지 않는다 |
| 유출 비밀번호 차단 | 확인만 | **Pro 이상**(PM 제공 근거: password-security) | 무료에서는 최소 길이·문자 조합 요구(무료 가능 범위)로 대체한다. 유출 비밀번호 검사가 없다는 한계는 남는다 |
| 비밀번호 최소 길이·문자 요구 | 확인 → 강화 | 무료 가능 | — |
| Redirect URL 허용 목록 | 확인 → 로컬·preview 주소만 | 무료 가능 | — |
| JWT 서명 키 방식 | 확인 | — | 비대칭이면 `getClaims` 로컬 검증. 대칭이면 서버 확인 경로를 다시 점검한다 |

- **[사용자]** 대시보드에서 확인한다(프로젝트 관리자 권한). 바꿀 필요가 있는 항목만 PM 판단 뒤 변경한다.
- **[Claude]** 확인 결과를 D3~D8에 `완료(근거)`·`불가(사유: 요금제)`로 기록한다. 값과 화면 원문은 적지 않는다.
- **되돌리기:** 대시보드 이전 값(확인 때 기록한 상태 이름만)으로 되돌린다.

### 단계 B — 서버 서명 키 등록 (D11)
- **[사용자]**
  - 개발용 `staff` 목적 키 1개를 만든다(32바이트 이상).
  - 그 값을 ① fideon-dev `security.server_keys`(`purpose='staff'`, `key_id`)와 ② 개발 실행 환경의 `FIDEON_STAFF_SIGNING_KEY`(`<key_id>:<base64>`)에 **같은 값**으로 넣는다.
  - DB 쓰기는 소유자 권한(SQL 편집기) 또는 승인된 migration 실행 권한으로 한다.
- **[Claude]** 값 없이 확인할 SQL을 준비한다: 키 존재·목적·길이만 조회. 키 생성·입력은 하지 않는다.
- **검증:** 단계 D 로그인 성공 = 서명 일치.
- **되돌리기:** DB 행 비활성 또는 삭제, env 값 제거. 새 `key_id`로 교체한다.

### 단계 C — owner 계정·직원 등록·**앱 사용자** TOTP 최초 등록 (D12)
- **구체 변경안은 `docs/design/STAFF-ENROLLMENT-BOOTSTRAP.md`로 옮겼다**(PM 6919431756). 이 절은 요약만 둔다.
- 대시보드 계정 MFA와 앱 Auth 사용자 MFA는 다르다. 이 단계는 앱 사용자 MFA다.
- **현재 미구현**
  - 앱 enroll 경로가 없다.
  - 로그인은 `listFactors`의 첫 verified factor를 고른다.
  - DB 세션과 factor가 결합돼 있지 않다.
  - aal1 등록 자격 함수가 없다.
- **제안 요지**
  - 프로젝트 소유자 SQL로 최초 1회용 코드를 발급한다.
  - aal1 서명 begin → `mfa.enroll` → record → `challenge`·`verify` → bind로 진행한다. `core.staff.totp_factor_id`를 설정한다.
  - `staff_session_open` 서명에 `factor_id`를 넣는다.
  - 상태 전이표와 실패별 처리(verified factor는 자동 삭제하지 않음)는 새 문서 4절에 있다.
- **되돌리기:** 등록 스위치 끄기, 미종료 grant revoke, `staff_recovery_reset`(새 문서 7절). 첫·마지막 owner 복구는 프로젝트 소유자 SQL 전용 경로(같은 문서 9-4)
- 저장·서명 대조표, 안정 operation, 응답 유실 복원, commit 계약은 같은 문서 9절(PM 6919806262)에 있다.

### 단계 D — 풀러·CA 실연결: 별도 읽기 전용 프로브 (D9·D10) — **실제 로그인보다 먼저** (PM 6917234887 정정)
- **이유:** 실제 로그인(세션 열기·서명 확인)은 DB 연결이 성립해야 의미가 있다. 그래서 DB·풀러·CA를 먼저 검증한다.
- **기존 시험은 재사용하지 않는다:** I1·P1~P8은 Unix socket·관리자(postgres) fixture·쓰기(P6 INSERT/DELETE, 세션 생성 등)를 포함한다. URL로 바꿔 실행하지 않는다.
- **프로브 계약(제안, 구현·실접속은 별도 판단)**
  - 파일: `scripts/probe/dev-db-readonly.mjs`(새 파일). CI에 넣지 않고 사람이 명시적으로 실행한다.
  - 명령 인터페이스: `node scripts/probe/dev-db-readonly.mjs --url-env FIDEON_PROBE_DB_URL --ca-env FIDEON_PROBE_DB_CA [--bad-ca-env FIDEON_PROBE_BAD_CA]`
    - 값은 지정한 환경변수 이름에서만 읽는다. `DATABASE_URL`·dotenv는 읽지 않는다.
    - 호스트가 loopback이면 거부한다(실연결 전용).
  - 연결: 기존 `db()`와 같은 옵션(`prepare:false`, `ssl:{ca, rejectUnauthorized:true}`, `max:1`)을 프로브 안에 둔다. 공용 client는 바꾸지 않는다.
  - 허용 SQL(이 목록 밖은 실행하지 않음, 모두 읽기)
    1. `select current_user, current_setting('server_version_num')`
    2. `begin; set local role app_staff; set local statement_timeout='5s'; select current_user; rollback;`
    3. 트랜잭션 밖 `select current_user` → `app_server` 복귀 확인
    4. `select has_function_privilege('app_staff','api.list_leads(uuid,uuid,text,int,int)','execute')`
    5. `select has_table_privilege('app_server','core.leads','select')` → false 기대(지름길 없음)
  - CA 음성 시험: `--bad-ca-env`의 잘못된 CA로 연결하면 TLS 실패를 기대한다. 성공하면 FAIL이다.
  - 출력 허용 목록: 검사 이름, PASS·FAIL, `current_user` 이름, 서버 버전 번호, 권한 boolean만 출력한다. URL·호스트·사용자 비밀번호·인증서·오류 원문은 출력하지 않는다(오류는 분류 코드만).
  - 금지: 쓰기·DDL·`security`·`pii` 조회·함수 실행(목록 포함)·초기화·seed
- **[사용자]** fideon-dev 풀러 주소·`app_server` 자격·프로젝트 CA를 위 환경변수 이름으로 자기 터미널에 두고 실행한다(필요 권한: DB 설정 조회, `app_server` 비밀번호 설정).
- **[Claude] 구현 상태(PM 6918034030):** `scripts/probe/dev-db-readonly.mjs`와 가짜 드라이버 시험 `tests/unit/dev-db-probe.test.ts`(B1~B6)를 구현했다.
  - `PROBE_EXPECT`(호스트·포트·DB·역할)는 모두 미정(null)이라 실행 경로에서도 접속 전에 `EXPECT_UNSET`으로 닫힌다.
  - 기대값은 프로젝트 설정 확인 뒤 별도 승인으로 정한다.
  - **실제 네트워크 실행은 하지 않았다.** CI는 가짜 시험만 돌리며, 이는 D9·D10 통과 증거가 아니다.
  - 보완(PM 6918873159):
    - 역할 출력은 `app_server`·`app_staff` 고정 허용 목록만 쓴다(그 밖은 `invalid`).
    - 실행 단계 전체에 하나의 절대 마감을 두고, 마감 뒤에는 새 SQL·연결을 시작하지 않는다. 타이머는 해제한다.
    - 정리는 별도 짧은 한도로 한다. 늦게 생긴 자기 client도 닫고, 정리를 확인하지 못하면 FAIL이다.
    - 풀러 로그인명(`loginUser`)과 DB 역할(`dbRole`)을 분리한다.
    - 퍼센트 인코딩 오류는 `URL_ENCODING`으로 거부한다.
    - 잘못된 CA 미제공은 `NOT_RUN`(exit 3, 전체 통과 아님)이다.
    - 시험은 B1~B10이다.
- **되돌리기:** 프로브는 읽기 전용이라 되돌릴 상태가 없다. 환경변수는 사용자 터미널에서 지운다.

### 단계 E — 실제 로그인·세션 (D12~D17) — 단계 D(프로브) 통과 뒤
- **환경**
  - 개발 실행 환경의 `ADMIN_AUTH_MODE=supabase`
  - 필수 4개: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `FIDEON_STAFF_SIGNING_KEY`, `DATABASE_URL`
  - 운영(`VERCEL_ENV=production`)은 코드가 계속 끈다.
- **[사용자]** 브라우저 로그인: 비밀번호만이면 `/admin` 거부, TOTP 뒤 접근. 로그아웃, 12시간 초과, 다른 사용자 세션도 확인한다.
- **[Claude]**
  - 확인 순서와 기대 결과표(D12~D17)를 제공한다.
  - 결과 로그(값 없이 상태 코드·문구)로 체크리스트를 갱신한다.
  - 실패하면 원인 후보: 서명 불일치, 세션 열기 실패, `getClaims` 키 방식, 쿠키 도메인
- **되돌리기(범위 구분, PM 6917234887 정정)**
  - `ADMIN_AUTH_MODE=disabled`는 **실제 인증 경로와 db 출처 목록**을 닫는다.
    - db 출처: 인증이 꺼지면 목록 미포함(잠금 화면). smoke S1·경로 V2가 검증 조건이다.
    - 로컬 개발 서버(`next dev`)의 mock 출처 가상 화면은 계속 보일 수 있다. 이 설정이 "모든 화면을 잠근다"는 뜻은 아니다.
  - db 경로에 장애가 나도 `ADMIN_LEADS_SOURCE=mock`으로 바꾸는 것을 안전한 장애 처리로 쓰지 않는다. db 출처는 잠금·실패 화면으로 닫힌다.

### 단계 F — 관리자 목록 실데이터 읽기 (⑨)
- **전제:** A~E 완료, reviewer DB 범위 정정 migration 승인·적용(0-4절 변경안).
- **[Claude] 코드 변경안(승인 필요, 미적용)**
  - `dbReadReady`에 "승인된 개발 프로젝트 호스트 허용 목록"을 추가한다.
    - 예: `ADMIN_LEADS_DB_HOST_ALLOW`에 정확한 호스트 1개를 둔다. 와일드카드 없음, `NODE_ENV` development·test 유지, 운영·preview 계속 거부.
  - 운영 허용은 별도 단계다.
- **검증**
  - fideon-dev에 가상 리드 몇 건을 둔다(실제 고객 아님).
  - owner·counselor 목록 범위, reviewer 거부, 감사 무변화
- **되돌리기:** `ADMIN_LEADS_SOURCE` 해제는 출처 설정을 원래대로 돌리는 운영 결정일 뿐, db 장애 처리 수단이 아니다. 장애 시 db 출처는 잠금·실패 화면으로 닫힌다. 즉시 차단이 필요하면 `ADMIN_AUTH_MODE=disabled`(db 목록 미포함).

### 단계 G — 로그인 시도 제한 (0007)
초안 0007을 정식 migration으로 만드는 일은 별도 승인 대상이다. 단계 D 이전이나 이후 어느 쪽이든 가능하지만, 공개 전에는 필수다.

## 2. 사용자만 할 수 있는 일 / Claude가 할 수 있는 일
| 사용자(계정 소유자) | Claude(현재 도구) |
|---|---|
| Supabase 대시보드 Auth·MFA·Sessions·Redirect·JWT 설정 확인·변경 | 확인 절차·기대 결과표·체크리스트 기록 |
| `staff` 키 생성, DB·env 등록 | 값 없는 확인 SQL, 서명 일치 진단 |
| 대표 Auth 계정·`core.staff` 행·부트스트랩 코드 발급·TOTP 등록(`STAFF-ENROLLMENT-BOOTSTRAP.md` 2절) | 등록·결합 구현과 시험(승인 뒤, 같은 문서 6·7절) |
| 프로브용 환경변수(풀러 URL·CA)를 자기 터미널에 두고 실행 | 읽기 전용 프로브 구현(승인 뒤), CA 음성 시험·출력 허용 목록 시험 |
| 실제 브라우저 로그인·TOTP 입력 | 로그 기반 판정, 실패 원인 분리 |
| 승인된 migration 실행 권한 | reviewer 정정·0007 migration 작성(승인 뒤), 로컬·CI 시험 |

## 3. 이 문서로 하지 않는 것
- 실제 계정·키 생성, 원격 설정·권한·실제 env 변경, 외부 요청
- `db()`·TLS 완화·TCP 개방, schema·권한 변경, 0007·0008 적용
- 실제 고객 조회·원문·상세·수정, 운영 활성화·배포, 광고 관련 사용자 요청 반복

## 4. 남은 결정점 (PM)
1. Pro 전용 세션 통제(time-box·비활성·단일 세션)·유출 비밀번호 차단 없이 무료 fideon-dev로 진행할지(대체 통제와 한계 수용 여부)
2. 앱 사용자 TOTP 최초 등록: `STAFF-ENROLLMENT-BOOTSTRAP.md` 8절 결정점(서명 방식·코드 전달·응답 유실 처리·적용 순서)
3. factor 결합(설계 8-3)을 실제 로그인 전에 필수로 할지
4. 읽기 전용 프로브 구현 승인과 실행 주체(사용자 터미널)
5. reviewer 정정·0007 migration의 적용 순서(단계 E 전후)
