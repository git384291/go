# 관리자 인증 운영 문서 — 시도 제한 · TOTP 등록/복구 · fideon-dev 연결 검증

PM 지시 6896909636(대상 `3ab044a`) 3·4항. 이 문서는 절차와 제안만 담는다. 계정·키 생성, 원격 Auth 설정 변경, 배포, 유료 리소스, 실제 고객 데이터는 아직 하지 않는다. 비밀값·이메일·연락처는 적지 않는다.

## 1. 로그인 시도 제한

### 1-1. Supabase Auth 기본 제한 (공식 문서 기준, 2026-11-16 확인)

출처: [Supabase Docs — Auth Rate limits](https://supabase.com/docs/guides/auth/rate-limits)

| FIDEON에서 쓰는 단계 | Supabase 엔드포인트 | 기준 | 기본값 | 대시보드 변경 |
|---|---|---|---|---|
| 비밀번호 로그인, 토큰 갱신 | `/token` (password grant, refresh token 포함) | IP | 5분 150회, 순간 30회 | 가능 |
| TOTP challenge·verify | `/factors/:id/challenge`, `/factors/:id/verify` | IP | 1분 15회, 순간 30회 | **불가** |
| 가입·재설정 계열(FIDEON 미사용) | `/signup`, `/recover`, `/otp` 등 | IP | 5분 30회 | 가능 |

- 초과하면 HTTP 429를 돌려준다.
- 토큰 갱신은 비밀번호 로그인과 같은 `/token` 한도를 함께 쓴다. 관리자 화면 이동이 많으면 같은 IP의 로그인 여유가 줄어든다.

### 1-2. 기본 제한만으로 부족한 점

1. **모든 제한이 IP 기준이다.** IP를 바꿔 가며 한 계정을 노리는 공격은 계정 단위로 막히지 않는다.
2. **비밀번호 한도가 넉넉하다.** 5분 150회는 한 IP에서 하루 4만 회 이상의 비밀번호 시도를 허용한다.
3. **TOTP는 6자리(100만 가지)다.** 1분 15회면 한 IP가 하루 약 2만 회까지 시도할 수 있다. 비밀번호가 이미 유출된 계정이라면 여러 IP로 확률을 높일 수 있다.
4. Supabase의 MFA 검증 훅([MFA Verification Hook](https://supabase.com/docs/guides/auth/auth-hooks/mfa-verification-hook))으로 사용자별 TOTP 실패 제한을 걸 수 있다. 다만 사용 가능한 요금제와 정확한 동작은 fideon-dev에서 **확인 전**이다. 문서의 예제 SQL에도 오류가 있어 그대로 쓰지 않는다.

### 1-3. 서버 제한안 (제안 — 구현 전 PM 승인 필요)

DB 스키마·권한 변경이 필요하므로 먼저 제안만 한다.

| 항목 | 제안 |
|---|---|
| 저장 | `security.login_attempts`(시각, 단계=password/totp, 이메일 HMAC, IP 해시, 성공 여부). 원문 이메일·IP는 저장하지 않는다(기존 `PII_HMAC_KEY`·`PII_IP_HASH_KEY` 방식) |
| 기록·판정 | SECURITY DEFINER 함수 `api.login_attempt_check(...)`, `api.login_attempt_record(...)`. 테이블 직접 권한은 주지 않는다 |
| 계정 기준 | 같은 이메일 HMAC로 15분 안에 비밀번호 실패 5회 → 15분 잠금. TOTP 실패 5회 → 잠그고 Supabase 로그아웃 |
| IP 기준 | 같은 IP 해시로 15분 실패 20회 → 15분 차단 |
| 응답 | 잠금도 기존 `INVALID_CREDENTIALS` / `INVALID_CODE`와 **같은 문구**로 응답한다. 잠금 여부로 계정 존재를 알 수 없게 한다 |
| 순서 | 비밀번호 단계는 Supabase 호출 **전에** 판정한다. TOTP 단계는 verify 전에 판정한다 |
| 보존 | 30일 뒤 삭제 |
| 시험 | 실DB 통합 시험에 경계값 추가: 4회 통과, 5회째 잠금, 시간 경과 후 해제, 다른 계정 무영향 |

대안 MFA 검증 훅은 Supabase 쪽에서 막는 방식이다. 서버 제한과 함께 쓰면 이중 방어가 된다. 요금제를 확인한 뒤 결정한다.

## 2. TOTP 최초 등록과 분실 복구 — 대표 확인 절차

로그인 화면은 TOTP 등록을 제공하지 않는다. 비밀번호만 아는 다른 사람이 먼저 TOTP를 등록해 계정을 가로채는 것을 막기 위해서다. 등록과 복구는 아래 절차로만 한다.

### 2-1. 사전 조건 (Supabase 설정, fideon-dev에서 확인 필요)
- 공개 가입 끄기. 직원 계정은 대표가 초대로만 만든다.
- `core.staff`에 등록된 사용자만 DB 세션을 열 수 있다. 미등록이면 TOTP를 등록해도 관리자 화면에 들어갈 수 없다.

### 2-2. 최초 등록
1. 대표가 직원을 초대한다. 초대 메일 링크로 직원이 비밀번호를 정한다.
2. **대표와 직원이 함께 있는 자리**(대면 또는 화면 공유 통화)에서 직원이 등록 전용 화면에 로그인한다.
   - 등록 전용 화면은 아직 구현되지 않았다. 별도 승인 후 만든다.
   - 그 화면은 `core.staff` 등록 여부와 "아직 검증된 TOTP 없음"을 서버에서 확인한 경우에만 열린다.
3. 직원이 인증 앱으로 QR을 읽고 6자리 코드를 입력해 검증한다.
   - QR과 비밀 문자열은 화면에만 표시한다. 채팅·메일·PR로 보내지 않는다.
4. 대표가 직원의 첫 로그인(비밀번호 → TOTP → 관리자 화면)과 감사 기록 `staff.session_open` 1건을 확인한다.
5. 등록 날짜와 확인자를 내부 기록에 남긴다. 비밀값은 남기지 않는다.

### 2-3. 분실·기기 교체 복구
1. 직원이 대표에게 직접 알린다. 다른 경로로 들어온 요청은 본인 확인 전까지 처리하지 않는다.
2. 대표가 본인 확인(대면 또는 영상 통화)을 한다.
3. 대표가 해당 직원을 즉시 `core.staff.active = false`로 바꾼다. DB가 모든 요청을 거부하므로 남은 세션도 바로 막힌다.
4. 대표가 Supabase 대시보드에서 그 사용자의 TOTP 요소를 삭제하고 모든 세션을 종료한다.
5. 2-2 절차로 다시 등록한 뒤 `active = true`로 되돌린다.
6. 대표 본인의 TOTP를 잃어버린 경우가 가장 위험하다.
   - **두 번째 owner 계정**(대표가 직접 관리)을 미리 만들어 두거나, Supabase 프로젝트 소유자 권한으로 복구하는 절차가 필요하다.
   - 어느 쪽으로 할지 결정은 **미정**(PM·사용자 결정 필요)이다.

## 3. fideon-dev 연결 검증 체크리스트

상태는 다음 셋 중 하나로만 적는다.
- `미완료`: 아직 실행하지 않음
- `완료(근거)`: 실행했고 근거가 있음
- `불가(사유)`: 실행할 수 없음

설정이 없어 하지 못한 항목은 완료로 적지 않는다.

| # | 항목 | 방법 | 상태 |
|---|---|---|---|
| D1 | 마이그레이션 0001~0006 + `zz_grants` 적용 | PM 보고(6895747516): 적용, RLS+FORCE, advisor 경고 0 | PM 완료 보고. Claude 미확인 |
| D2 | 배포 전 점검 V1~V15 위반 0건 | `release_auditor`로 `db/audit/catalog_audit.sql` 실행 | 미완료 (PM 보고상 V3 extensions USAGE 차이 검토 중) |
| D3 | 공개 가입 끄기 | 대시보드 Auth 설정 확인 | 미완료 |
| D4 | TOTP 사용 켜기 | 대시보드 MFA 설정 | 미완료 |
| D5 | 세션 time-box 12시간 이하, 비활성 제한 | 대시보드 Sessions | 미완료 |
| D6 | 비밀번호 정책(길이·유출 비밀번호 차단) | 대시보드 | 미완료 |
| D7 | redirect URL 허용 목록 = 로컬·preview 주소만 | 대시보드 URL 설정 | 미완료 |
| D8 | JWT 서명 방식(비대칭 키면 `getClaims` 로컬 검증), 키 교체 시 동작 | 대시보드 JWT Keys + 시험 로그인 | 미완료 |
| D9 | 트랜잭션 모드 풀러에서 `set local role`, `prepare:false`, 시간 제한 | 통합 시험 I1을 fideon-dev 풀러 주소로 실행 | 미완료 |
| D10 | SSL CA 검증 성공, 잘못된 CA 거부 | `SUPABASE_DB_CA_CERT` 맞는 값·틀린 값으로 연결 | 미완료 |
| D11 | 서버 서명 키를 DB `security.server_keys`와 앱 환경변수에 같은 값으로 등록 | 값은 문서·채팅에 적지 않음 | 미완료 (키 생성 금지 상태) |
| D12 | 실제 로그인: 비밀번호만 → `/admin` 거부, TOTP 후 → 접근, 감사 1건 | 시험 직원 계정(가상) | 미완료 (계정 생성 금지 상태) |
| D13 | 거부 확인: 미등록·비활성 직원, 12시간 초과, 로그아웃 후 이전 쿠키, 다른 사용자 세션 | 같은 시험 계정 | 미완료 |
| D14 | 토큰 갱신 뒤 `session_id` 유지 → DB 세션 연속 | 갱신 주기를 짧게 둔 시험 | 미완료 |
| D15 | 로그아웃 실패 표시: 네트워크 차단 상태에서 경고 문구, 쿠키 삭제 | 개발자 도구로 오프라인 | 미완료 |
| D16 | middleware 장애: Auth 주소 차단 시 `/admin` 503, `no-store` | 잘못된 Supabase URL로 실행 | 미완료 (가짜 클라이언트 경로 시험만 완료) |
| D17 | 시도 제한: 429 응답 시 화면 문구 일반화 | 반복 시도 | 미완료 |
| D18 | 실제 고객정보 미사용 | 시드·화면 확인 | 계속 유지 |

## 4. 로그아웃·장애 처리 동작 (`3ab044a` 이후 수정)

| 상황 | 결과 | 화면 |
|---|---|---|
| DB 폐기 성공 + Auth 로그아웃 성공 | `complete` | 로그인 화면(경고 없음) |
| DB 폐기 실패 | `db_unconfirmed` | 이 브라우저 로그인은 종료. DB 세션은 최대 12시간 뒤 만료 경고 |
| Auth 로그아웃 실패(쿠키는 직접 삭제) | `auth_unconfirmed` | DB 세션은 폐기됨. 그 세션으로는 관리자 접근 불가 |
| 둘 다 실패(쿠키는 직접 삭제) | `both_unconfirmed` | 서버 쪽 종료 미확인 경고 |
| 쿠키 삭제도 실패 | `local_not_cleared` | 로그아웃 미완료. 창을 모두 닫으라는 안내 |

**DB 폐기 확인 기준 (`c0bad81` 이후 보완)**
- 세션 조회 결과를 셋으로 나눈다. `none`(세션 없음) / `invalid`(검증 실패) / `ok`. 인증 서버 장애(예외, 재시도 오류, 5xx)는 원문 없는 예외 `AUTH_UNAVAILABLE`로 처리한다(`authErrors.ts`).
- `ok`이고 DB 폐기에 성공해야만 DB 폐기 확인이다.
- `none`만 폐기할 세션이 없는 것으로 본다.
- `invalid`·장애·예외는 폐기 미확인(`db_unconfirmed`/`both_unconfirmed`)이며 `complete`로 표시하지 않는다.

**보장의 한계**
- 쿠키 삭제는 이 브라우저의 연결만 끝낸다. 이미 복사된 접근 토큰이나 DB 세션이 즉시 무효화된다고 보장하지 않는다.
- DB 폐기를 확인하지 못하면, 그 전에 같은 토큰을 복사해 둔 사람은 DB 세션 만료(최대 12시간) 전까지 접근할 수 있다.
- Auth 로그아웃을 확인하지 못하면 Supabase의 refresh token이 서버에 남는다. 다만 DB 세션이 폐기됐다면 관리자 접근은 막힌다.

**middleware**
- 인증 서버에 닿지 못하면(예외, `AuthRetryableFetchError`, 5xx, 상태 없음) `/admin` 전체가 503 `잠시 후 다시 시도해 주세요.`로 닫힌다. `Cache-Control: private, no-store`이고, 이미 받은 갱신 쿠키는 보존한다.
- 로그인 안 됨·토큰 무효는 장애로 보지 않는다. 통과시키고, 화면이 DB 확인 후 로그인으로 보낸다.

## 5. 이전 패치 파일 정적 대조 (기록만, 적용하지 않음)

Claude 작업 환경에 남아 있는 패치 9개를 대조했다. 각 패치에서 추가된 줄(4글자 이상, `test-results`·이미지 제외)이 현재 저장소 이력의 어느 버전에든 있는지 확인했다.

| 패치 | 파일 | 추가 줄 | 이력에 있음 | 현재 HEAD에 있음 |
|---|---|---|---|---|
| FIDEON-PHASE1-full | 50 | 1214 | 1214 | 1184 |
| FIDEON-PHASE1-final-review | 38 | 361 | 361 | 358 |
| FIDEON-PHASE1-final-review-tests-only | 13 | 355 | 355 | 352 |
| FIDEON-PHASE1-macfix | 33 | 104 | 104 | 102 |
| FIDEON-PHASE1-restore-grants | 4 | 79 | 79 | 79 |
| FIDEON-PHASE1-x16-portable | 1 | 50 | 50 | 50 |
| FIDEON-PHASE1-dependency-security | 3 | 16 | 16 | 16 |
| FIDEON-PHASE1-gitleaks-finding | 2 | 11 | 11 | 11 |
| FIDEON-PHASE1-ci-gitleaks | 1 | 9 | 9 | 8 |

- 이력에 없는 추가 줄은 **0줄**이다. HEAD에 없는 줄은 이후 커밋에서 다시 고친 줄이다.
- **한계:** 줄 단위 포함 여부만 확인했다. 줄 순서·문맥이 같은지는 확인하지 않았다.
- 사용자가 PM에게 준 `PHASE1.patch`·`final-review.diff`가 위 파일과 같은 파일인지는 Claude가 확인할 수 없다(원본을 받지 않음).

## 6. 시도 제한 설계 보완 (PM 6897318608 — 구현·0007 적용 전 검토용)

### 6-1. 무료 요금제에서 쓸 수 있는 것
[Supabase Auth Hooks](https://supabase.com/docs/guides/auth/auth-hooks) 기준(2026-11-16 확인):
- Free·Pro에서 쓸 수 있는 훅: Before User Created, Custom Access Token, Send SMS, Send Email
- **Teams·Enterprise 전용:** MFA Verification Attempt, Password Verification Attempt
- 따라서 무료 요금제에서는 Supabase 쪽의 사용자별 비밀번호·TOTP 실패 제한 훅을 **쓸 수 없다.** 유료 기능은 집행하지 않는다.
- 남는 것은 Supabase 기본 IP 제한(1절)과 FIDEON 서버 제한이다.

### 6-2. 직접 Supabase 호출 우회
- 공개 키(publishable key)는 브라우저에 공개된다. 공격자는 FIDEON 서버를 거치지 않고 Supabase `/token`, `/factors/:id/verify`를 직접 호출할 수 있다. **서버 제한은 이 직접 호출을 막지 못한다.** 직접 호출에는 Supabase 기본 IP 제한만 걸린다.
- 그래도 관리자 접근의 결정 단계는 FIDEON 서버에만 있다.
  - DB 세션 개설(`api.staff_session_open`)은 서버 서명 키로 만든 토큰이 있어야 한다.
  - 그 토큰은 FIDEON 서버의 TOTP 단계를 통과해야만 만들어진다.
  - DB에 열리지 않은 Supabase 세션은 모든 관리자 요청에서 `whoami`가 거부한다.
- 따라서 서버 제한은 **"DB 세션을 여는 TOTP 단계"를 지키는 것이 핵심**이다. 직접 호출로 비밀번호 정답 여부를 알아내는 위험은 남는다.
- 남은 위험 대응
  - 직원 이메일 비공개, 긴 비밀번호 정책(D6)
  - Supabase 유출 비밀번호 차단 기능의 요금제 확인(미확인)
  - 아래 6-4의 사용자 단위 TOTP 제한

### 6-3. 원자적 예약 (check·record 분리 금지)
- check와 record를 따로 부르면, 동시에 들어온 요청이 모두 "한도 미달"로 판정받고 통과한다. 따라서 **함수 하나로 판정과 예약을 같은 트랜잭션에서** 한다.
- `api.login_attempt_reserve(p_step, p_subject_hmac, p_ip_hash)` → 예약 ID 또는 거부
  1. `pg_advisory_xact_lock`으로 같은 대상(이메일 HMAC 또는 사용자 ID)을 직렬화한다.
  2. 최근 실패 수에 **아직 결과가 없는 예약 수를 더해 센다**(fail-closed).
  3. 한도 미만이면 `pending` 예약 행을 넣고 ID를 돌려준다. 한도 이상이면 거부한다.
- `api.login_attempt_settle(p_id, p_success)`
  - Supabase 결과 뒤에 호출한다. 성공하면 해당 대상의 실패 계수를 초기화한다.
  - 1분이 지나도 결과가 없는 예약은 실패로 센다(서버가 중간에 죽어도 한도가 풀리지 않음).
- 두 함수 모두 SECURITY DEFINER, `search_path=''`, 테이블 직접 권한 없음, `app_public`에서만 실행 가능하게 한다.
- 실DB 통합 시험에 동시 10건 요청 → 정확히 한도 수만 예약되는지 확인을 추가한다(기존 C2·C3 방식).

### 6-4. 악의적 잠금(서비스 거부) 대응
| 단계 | 기준 | 한도 | 넘으면 |
|---|---|---|---|
| 비밀번호 | (이메일 HMAC, IP 해시) | 15분 5회 | 그 IP에서 그 계정만 15분 거부 |
| 비밀번호 | 이메일 HMAC 전체 | 1시간 30회 | **잠그지 않고** 대표 알림(감사 기록)만 남김. 다른 IP의 정상 직원은 계속 로그인 가능 |
| 비밀번호 | IP 해시 전체 | 15분 20회 | 그 IP 15분 거부 |
| TOTP | 사용자 ID | 15분 5회 | 15분 거부 + Supabase 로그아웃 |

- 이메일만 알아서는 다른 IP의 직원을 잠글 수 없다. 공격자가 바꾼 IP 수만큼 시도 수만 늘어나고, 그 대가는 대표 알림이다.
- TOTP 잠금은 비밀번호를 알아야 걸 수 있다. 그 상황이면 이미 계정 침해이므로 잠그는 쪽이 맞다.
- 잠금 해제: owner가 감사 기록을 확인한 뒤 해당 대상의 계수를 초기화하는 함수(owner 전용)를 둔다.
- 응답 문구는 잠금 여부와 무관하게 기존과 같다.

### 6-5. 보존 최소화
- 원문 이메일·IP는 저장하지 않는다. 이메일은 `PII_HMAC_KEY` HMAC, IP는 `PII_IP_HASH_KEY` 해시로 기존 방식과 같다.
- 시도 행은 24시간 뒤 계수에서 빠지고 **7일 뒤 삭제**한다. 대표 알림용 감사 기록은 기존 `core.audit_logs` 보존 규칙을 따른다.
- 비밀번호·TOTP 코드·토큰은 어디에도 기록하지 않는다.

## 7. TOTP 최초 등록 설계 근거 (코딩 전 확정용)

### 7-1. 기존 DB 함수로 aal1 등록 자격을 확인할 수 있는가 — **없다**
- `api.staff_session_open`은 서명 대상에 `'aal2'`가 들어간다(0001). 서버도 aal2가 아니면 서명하지 않는다(`staffAssertion.ts`).
- `security.assert_staff`/`api.whoami`는 열린 DB 세션을 요구한다.
- 등록 전 직원은 aal1이라 둘 다 쓸 수 없다. 기존 함수를 aal1로 완화하면 aal2 필수 원칙이 무너지므로 **완화하지 않는다.**
- 결론: 등록 전용 DB 함수가 따로 필요하다(스키마 변경 → 승인 후 0007 이후 번호).

### 7-2. 대표 발급 1회용 등록 승인 (화면 공유만으로는 권한이 생기지 않게)
1. **발급:** owner가 aal2 DB 세션으로 `api.enrollment_grant_issue(owner 인증, 대상 user_id)`를 실행한다.
   - DB는 대상이 `core.staff`의 활성 직원이고 검증된 TOTP가 아직 등록되지 않았는지 확인한다.
   - 무작위 등록 코드를 만들고, 해시만 `security.enrollment_grants`에 저장한다(대상, 발급자, 15분 만료, 미사용).
   - 코드는 owner 화면에 1회만 표시하고, 직원에게 대면으로 전달한다. 채팅·메일·PR로는 보내지 않는다.
2. **사용:** 직원이 비밀번호로 로그인(aal1)한 뒤 등록 화면에서 코드를 입력한다. 서버가 `api.enrollment_grant_consume`를 부른다.
   - 인자는 aal1 전용 서명 토큰 `['enroll', actor, session, 'aal1']`과 코드다.
   - 원자적으로 확인한다: 대상 일치, 미만료, 미사용. 확인되면 사용 처리하고 감사 기록을 남긴다.
   - 성공한 경우에만 서버가 Supabase `mfa.enroll` → QR 표시 → `mfa.challengeAndVerify`를 진행한다.
3. **결합:** 검증이 끝나면 서버가 그 factor ID를 `core.staff`의 등록 요소로 기록한다(owner 승인과 연결). 이후 로그인 TOTP 단계에서 다음을 모두 확인하고, 아니면 거부하고 대표에게 알린다.
   - 사용한 factor가 등록 요소와 같은지
   - 검증된 TOTP가 정확히 1개인지
4. **이유:** 공개 키로 Supabase `mfa.enroll`을 **직접** 호출하면 FIDEON 화면을 거치지 않고 등록할 수 있다. 3번의 결합 확인이 있어야 그렇게 직접 등록한 요소로는 DB 세션이 열리지 않는다. 화면 공유나 구두 확인만으로는 이 결합이 생기지 않는다.
5. **첫 owner(부트스트랩):** 발급해 줄 owner가 없으므로, Supabase 프로젝트 소유자가 SQL 편집기에서 1회 발급한다. 그 실행 기록을 남긴다.

### 7-3. 분실 복구 기본안 — 프로젝트 소유자의 공식 절차 우선
- 직원 분실: 2-3절 순서를 따른다. 요소 삭제는 Supabase 관리 기능으로 한다(대시보드 또는 서버 전용 관리자 API의 MFA 요소 삭제). 정확한 메뉴와 API 이름은 fideon-dev에서 **확인 필요**하다. 이후 owner가 7-2로 재발급한다.
- 대표 분실: Supabase 프로젝트 소유자 계정(그 계정의 MFA로 보호)이 요소를 삭제하고 7-2-5 부트스트랩으로 재발급한다.
- **두 번째 owner 계정은 자동 생성하지 않는다.** 만들지 여부는 PM·사용자 결정이다.

### 7-4. 필요한 승인 항목 (구현 전)
- 스키마
  - `security.enrollment_grants`
  - `core.staff` 등록 요소 열
  - 함수 `enrollment_grant_issue`·`enrollment_grant_consume`
  - TOTP 단계 요소 확인을 세션 개설 서명에 포함할지 여부
- aal1 전용 서명 목적(`'enroll'`) 추가
- 등록 화면(인증 스위치 하위, 기본 꺼짐)
