# 개발 Auth·owner MFA·세션·풀러 CA 실연결 — 구체 변경안 (PM 6916935437 3항)

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

### 단계 A — fideon-dev Auth 설정 확인 (D3~D8)
- **[사용자]** Supabase 대시보드(프로젝트 소유자 또는 관리자 권한)
  - 공개 가입: 켜짐 → **끔**
  - MFA TOTP: → **켬**
  - Sessions time-box: → **12시간 이하**, 비활성 제한 설정
  - 비밀번호 정책: 최소 길이·유출 비밀번호 차단
  - Redirect URL 허용 목록: → 로컬·preview 주소만
  - JWT 서명 키 방식: 비대칭인지 확인. `getClaims`의 로컬 검증 경로와 맞는지 본다.
- **[Claude]** 확인 결과를 체크리스트 D3~D8에 `완료(근거)` 또는 `불가(사유)`로 기록한다. 스크린샷이나 값 원문은 적지 않는다.
- **되돌리기:** 대시보드에서 이전 값으로 되돌린다. 코드 변경은 없다.

### 단계 B — 서버 서명 키 등록 (D11)
- **[사용자]**
  - 개발용 `staff` 목적 키 1개를 만든다(32바이트 이상).
  - 그 값을 ① fideon-dev `security.server_keys`(`purpose='staff'`, `key_id`)와 ② 개발 실행 환경의 `FIDEON_STAFF_SIGNING_KEY`(`<key_id>:<base64>`)에 **같은 값**으로 넣는다.
  - DB 쓰기는 소유자 권한(SQL 편집기) 또는 승인된 migration 실행 권한으로 한다.
- **[Claude]** 값 없이 확인할 SQL을 준비한다: 키 존재·목적·길이만 조회. 키 생성·입력은 하지 않는다.
- **검증:** 단계 D 로그인 성공 = 서명 일치.
- **되돌리기:** DB 행 비활성 또는 삭제, env 값 제거. 새 `key_id`로 교체한다.

### 단계 C — owner 계정·직원 등록·TOTP 최초 등록 (D12)
- **[사용자]**
  - fideon-dev Auth에 대표 계정을 만든다(이메일·비밀번호).
  - `core.staff`에 `(user_id, 'owner', active=true)` 1행을 넣는다(소유자 SQL 권한).
- **TOTP 최초 등록 경로(설계 7·8절)**
  - 현재 aal1 등록 자격을 확인하는 DB 함수가 없다(7-1).
  - 기본안: 대표가 대시보드나 공식 절차로 TOTP를 등록한다. 앱 내 등록 화면은 만들지 않는다.
  - 앱 내 등록이 필요해지면 "대표 발급 1회용 등록 승인"(7-2)을 새 migration으로 별도 승인받는다.
- **분실 복구:** 프로젝트 소유자의 공식 절차를 우선한다(7-3).
- **[Claude]** 등록 뒤 확인 절차를 문서화한다. 계정 생성은 하지 않는다.
- **되돌리기:** 직원 행 `active=false`, Auth 사용자 비활성.

### 단계 D — 실제 로그인·세션 (D12~D17)
- **환경**
  - 개발 실행 환경의 `ADMIN_AUTH_MODE=supabase`
  - 필수 4개: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `FIDEON_STAFF_SIGNING_KEY`, `DATABASE_URL`
  - 운영(`VERCEL_ENV=production`)은 코드가 계속 끈다.
- **[사용자]** 브라우저 로그인: 비밀번호만이면 `/admin` 거부, TOTP 뒤 접근. 로그아웃, 12시간 초과, 다른 사용자 세션도 확인한다.
- **[Claude]**
  - 확인 순서와 기대 결과표(D12~D17)를 제공한다.
  - 결과 로그(값 없이 상태 코드·문구)로 체크리스트를 갱신한다.
  - 실패하면 원인 후보: 서명 불일치, 세션 열기 실패, `getClaims` 키 방식, 쿠키 도메인
- **되돌리기:** `ADMIN_AUTH_MODE=disabled`(즉시 잠금).

### 단계 E — 풀러·CA 실연결 (D9·D10)
- **현재 차이:** 로컬 시험은 TCP 미수신 Unix socket + 주입 실행기다. 기본 `withRole`(URL·TLS) 경로는 실행된 적이 없다.
- **[사용자]**
  - fideon-dev 트랜잭션 모드 풀러 주소와 `app_server` 로그인 자격을 개발 실행 환경의 `DATABASE_URL`에 둔다.
  - 프로젝트 CA 인증서를 `SUPABASE_DB_CA_CERT`에 둔다.
  - 필요한 권한: 프로젝트 DB 설정 조회, `app_server` 비밀번호 설정.
- **[Claude] 코드 변경안(승인 필요, 미적용)**
  1. 통합 시험 I1·P1~P8을 **URL 연결 모드**로도 돌리는 별도 수동 명령을 만든다(`FIDEON_DEV_PG_URL`·`FIDEON_DEV_PG_CA`를 명시적으로 넘길 때만 실행, CI 미포함). 읽기 전용 확인만 하고 쓰기 시험은 하지 않는다.
  2. 틀린 CA로 연결 거부(D10)를 같은 명령의 음성 시험으로 둔다.
  3. 공용 `db()`·TLS 설정은 바꾸지 않는다. `rejectUnauthorized: true`를 유지한다.
- **되돌리기:** env 값 제거. 코드 변경은 수동 명령 파일뿐이다.

### 단계 F — 관리자 목록 실데이터 읽기 (⑨)
- **전제:** A~E 완료, reviewer DB 범위 정정 migration 승인·적용(0-4절 변경안).
- **[Claude] 코드 변경안(승인 필요, 미적용)**
  - `dbReadReady`에 "승인된 개발 프로젝트 호스트 허용 목록"을 추가한다.
    - 예: `ADMIN_LEADS_DB_HOST_ALLOW`에 정확한 호스트 1개를 둔다. 와일드카드 없음, `NODE_ENV` development·test 유지, 운영·preview 계속 거부.
  - 운영 허용은 별도 단계다.
- **검증**
  - fideon-dev에 가상 리드 몇 건을 둔다(실제 고객 아님).
  - owner·counselor 목록 범위, reviewer 거부, 감사 무변화
- **되돌리기:** `ADMIN_LEADS_SOURCE=mock`(즉시 가상 화면 또는 잠금).

### 단계 G — 로그인 시도 제한 (0007)
초안 0007을 정식 migration으로 만드는 일은 별도 승인 대상이다. 단계 D 이전이나 이후 어느 쪽이든 가능하지만, 공개 전에는 필수다.

## 2. 사용자만 할 수 있는 일 / Claude가 할 수 있는 일
| 사용자(계정 소유자) | Claude(현재 도구) |
|---|---|
| Supabase 대시보드 Auth·MFA·Sessions·Redirect·JWT 설정 확인·변경 | 확인 절차·기대 결과표·체크리스트 기록 |
| `staff` 키 생성, DB·env 등록 | 값 없는 확인 SQL, 서명 일치 진단 |
| 대표 Auth 계정·`core.staff` 행·TOTP 등록 | 등록 뒤 확인 절차, 거부 경로 시험 설계 |
| 개발 env에 `DATABASE_URL`(풀러)·CA 입력 | URL 모드 수동 시험 명령 작성(승인 뒤), CA 음성 시험 |
| 실제 브라우저 로그인·TOTP 입력 | 로그 기반 판정, 실패 원인 분리 |
| 승인된 migration 실행 권한 | reviewer 정정·0007 migration 작성(승인 뒤), 로컬·CI 시험 |

## 3. 이 문서로 하지 않는 것
- 실제 계정·키 생성, 원격 설정·권한·실제 env 변경, 외부 요청
- `db()`·TLS 완화·TCP 개방, schema·권한 변경, 0007·0008 적용
- 실제 고객 조회·원문·상세·수정, 운영 활성화·배포, 광고 관련 사용자 요청 반복
