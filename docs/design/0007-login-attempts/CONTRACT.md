# 설계 초안 0007 — 로그인 시도 제한 계약과 정식 반영 제안

**상태: 초안. 정식 마이그레이션·원격 적용·앱 로그인 연동은 승인되지 않았다(PM 6901779342).**
- 아래는 하지 않았다
  - `db/migrations`, `zz_grants.sql`, `catalog_audit.sql` 변경
  - 앱의 `TokenPurpose`·키 로더·로그인 흐름 변경
  - 실제 키 생성·등록
- 초안 SQL(`draft.sql`)은 `scripts/design/login-attempts-local.sh`가 만든 **폐기용 DB**에서만 명시 실행한다(로컬, CI db-test 뒤).
- 근거 설계: `docs/ADMIN-AUTH-OPERATIONS.md` 6절·8절(8-1, 8-5)

## 1. 객체

**테이블 `security.login_attempts`**
- 열
  - `id`
  - `step`: `password` | `totp`
  - `subject_hmac`: 64 hex. 이메일 HMAC 또는 사용자 ID HMAC
  - `ip_hash`: 64 hex
  - `request_nonce`: 32 hex, 고유
  - `created_at`, `settled_at`
  - `result`: `success` | `failure` | `expired`
- 원문 이메일·IP는 없다. 서버가 기존 `PII_HMAC_KEY`·`PII_IP_HASH_KEY`로 만든 값만 받는다.
- RLS enable + FORCE. 정책은 `fideon_api`만. 테이블 직접 권한도 `fideon_api`만.

**공개 함수 (SECURITY DEFINER, 소유자 `fideon_api`, `search_path=''`, `lock_timeout=2s`)**
| 함수 | 반환 |
|---|---|
| `api.login_attempt_reserve(step, subject, ip, nonce, token)` | 예약 ID |
| `api.login_attempt_settle(id, result, token)` | `settled` 또는 `already` |

**보조 함수**
- `security.login_limit_count`, `login_lock`, `login_expire_stale`, `login_token_short`
- **security invoker:** api 함수 소유자의 권한으로만 실행된다. 정의자 권한을 넓히지 않는다.

## 2. 서명 계약 (목적 `login` — 기존 `staff`·`lead` 키와 분리)
| 호출 | 서명 필드(순서대로) |
|---|---|
| reserve | `['reserve-request', step, subject_hmac, ip_hash, request_nonce]` |
| settle | `['settle', 예약ID, step, subject_hmac, ip_hash, result]` — 결과 자체가 서명 대상 |

- 형식은 기존 `signToken`·`security.verify_token`과 같다: `<key_id>.<exp>.<hmac>`
- 만료는 **지금부터 60초 이내**만 허용한다. `verify_token`의 300초보다 좁다.
- 서명이 없거나, 다른 목적 키, 다른 nonce·대상·단계·예약·결과, 만료·초과 유효시간이면 모두 `42501 FORBIDDEN`이다.
- nonce는 1회용이다. 재사용하면 `NONCE_REUSED`(42501)이다.
- 실행 권한은 `app_public`만 가진다. `app_staff`·`app_server`는 실행할 수 없다.

## 3. 한도·잠금·정산 의미
- **한도(초안 상수)**
  - 비밀번호: (대상, IP) 15분 5회, IP 전체 15분 20회
  - TOTP: 사용자 15분 5회
  - 초과하면 `P0429 LOGIN_RATE_LIMITED`
- **계수:** 실패 + 만료 + **대기(결과 없음)**를 모두 센다(fail-closed). 대상 전체 기준으로는 잠그지 않는다(잠금 DoS 완화).
- **대기 만료:** 결과 없이 60초가 지난 예약은 실패로 센다. `expired` 확정은 **잠근 범위(같은 단계·대상·IP)의 행만** 한다. 다른 대상·IP의 오래된 대기는 바꾸지 않는다(PM 6903042141 ③: OR 범위 갱신은 행 잠금 순환 교착 경로가 있었음).
  - 오래된 대기에 settle이 오면 그 범위를 `expired`로 확정·커밋하고 `'expired'`를 반환한다. success·failure는 기록하지 않는다.
- **잠금 순서:** 대상(`fideon.login.subject:<step>:<hmac>`) → IP(`fideon.login.ip:<hash>`), 트랜잭션 advisory lock. reserve·settle 모두 같은 순서다.
- **잠금 대기:** 함수 `lock_timeout=2s`. 넘으면 `55P03`으로 실패하고 행은 생기지 않는다.
- **정산 멱등:** 첫 확정만 기록한다. 같은 결과를 다시 보내면 `already`, 다른 결과면 `RESULT_CONFLICT`(42501)이다. 서버는 `expired`를 직접 요청할 수 없다.
- **순서 기준(PM 6903042141 ②):** 시각이 아니라 단조 순번으로 판정한다. `created_seq`(identity)와 `settled_seq`(정산·만료 때 sequence)를 쓴다. 같은 대상의 reserve·settle은 대상 잠금으로 직렬화되므로 순번 순서가 실제 확정 순서와 같다. `created_at`·`settled_at`이 같아도 모호하지 않다.
- **성공이 실패를 계수에서 빼는 조건** — 모두 만족해야 한다.
  1. 같은 단계·대상. 비밀번호 (대상, IP) 범위는 **같은 IP까지**(①: 다른 IP의 성공은 이 IP 실패를 지우지 않음)
  2. 실패 예약이 성공 예약보다 먼저 생성됨(`created_seq`)
  3. 실패가 **성공 확정보다 먼저 확정됨**(`settled_seq`). 성공 확정 뒤에 확정된 실패와 아직 대기 중인 예약은 남는다.
- **IP 전체 버킷:** 성공으로 초기화하지 않는다.
- **success를 보내는 경계(앱 연동 시):** 서버가 Supabase 응답을 직접 확인한 경우에만 보낸다. 비밀번호 단계는 `signInWithPassword` 성공 + 다음 단계 aal2 가능, TOTP 단계는 `challengeAndVerify` 성공 + aal2 클레임일 때다. 브라우저 값으로 정하지 않는다.

## 4. 로컬 재현 결과
**정식 migration 자동 로드 안 됨.** 아래 시험은 별도 폐기용 DB에서 명시 실행한다.
- **로컬:** Claude 작업 환경(PostgreSQL 16, 유닉스 소켓 클러스터)에서 수동 실행한다.
- **CI:** GitHub Actions `scripts/db-test.sh`의 기본 DB 검사가 통과한 뒤 `npm run test:design:login-limits`가 실행된다(`CI=true` + `GITHUB_ACTIONS=true`일 때만, workflow 변경 없음). 실패하면 전체 DB 검사가 실패한다.
- 앱·운영·원격 DB에는 적용되지 않는다. PM 환경 재현 아님.

### 4-1. `bash scripts/design/login-attempts-local.sh` — pass=57 fail=0
| 구분 | 결과 |
|---|---|
| 단일 세션 L1~L45 | 52/52 PASS. 서명·목적·nonce·만료·변조·멱등·권한·RLS·FORCE·`search_path`·invoker·한도(대기 포함)·대기 만료·지연 성공·IP 버킷·TOTP 분리 + 아래 회귀 |
| L42 | IP-A 실패 5 → IP-B 성공 → IP-A 여전히 거부 |
| L43 | **서로 다른 트랜잭션 4개**: F예약 → S예약 → S성공 → F실패 → F 남음(계수 1). 대조 L43b·L43c |
| L44 | `created_at`·`settled_at`이 같은 행에서 순번 기준으로 판정 |
| L45 | 만료 정리는 잠근 범위 행만. 다른 대상·IP의 오래된 대기는 그대로 두되 실패로 셈 |
| L33·L34 | 오래된 대기에 failure·success → `expired` 반환·커밋, success 없음 |
| C1 동시 10요청(같은 대상·IP) | 예약 5, 한도 거부 5, 행 5 |
| C2 교차 동시 12요청 | 교착 0, 전부 예약 |
| C3 다른 세션이 대상 잠금 4초 보유 | 약 2초 뒤 `lock timeout`, 행 미생성 |
| **C4** 교차 대상 3 × IP 4, 범위마다 오래된 대기 5(총 60) 위에서 reserve 12·settle(success) 12 동시 | 교착 0, 예약 0(한도 우회 0), settle 12 모두 `expired`, success 0, 만료 확정 60, 대기 0, 상태 열 불일치 0 |
| S1 | 결과 기록에 가상 키·토큰 원문 없음 |

**구버전 초안 대조(`b35c604` draft에 새 회귀만 실행, 별도 폐기용 DB):** L42 FAIL(거부 안 됨), L43 FAIL(계수 0), L45 FAIL(다른 범위까지 expired). 새 시험이 지적된 결함을 실제로 잡는다.

### 4-2. `bash scripts/design/login-attempts-safety-test.sh` — pass=6 fail=0
| 시험 | 결과 |
|---|---|
| G1 동명 DB 존재 | 중단(rc=3), 기존 감시용 DB·내용 유지 |
| G2 생성 실패(시험용 hook) | 중단(rc=4), 그 이름 DB 없음, 정리 미시도 |
| G3 중간 실패(시험용 hook) | 중단(rc=5), 이 실행이 만든 DB만 삭제 |
| G4 예상과 다른 클러스터 | 마이그레이션 전 중단(rc=2), DB 미생성, `pg_auth_members` 변화 없음 |
| G5 형식 밖 이름(`postgres`) | 중단(rc=2) |
| G6 | 시험이 만든 폐기용 DB 잔여 0 |

**스크립트 안전장치**
- DB 이름은 `fideon_design0007_<pid>_<8hex>`이다. 덮어쓰기는 금지한다.
- create 성공 뒤에만 `created_by_this_run=1`이 되고 trap이 그 DB만 정리한다.
- 마이그레이션(클러스터 전역 역할 GRANT 포함) 전에 클러스터가 `listen_addresses=''`·지정 포트·예상 `data_directory`인지 확인한다. 생성 실패 hook은 실제 생성 전에 멈춘다(실제 권한 오류로 생성이 실패하는 경우도 같은 플래그 경로).

### 4-3. 감사·권한 증거 (허용 목록은 넓히지 않음)
| 구분 | 결과 |
|---|---|
| E1 초안 적용 직후 현재 `catalog_audit` | **rc=1, V5×2**(`app_public` → reserve·settle) |
| E2 현재 `zz_grants` 재적용 후 | 실행 권한 **false/false** |
| E3 그 상태의 감사 | rc=0. 함수를 **쓸 수 없는 상태**라서 그렇고, 초안이 감사를 통과했다는 뜻이 아니다 |

시각 경계는 토큰 유효시간 음수·초과값, 역산한 `created_at` 행, 순번으로 결정적으로 시험했다. sleep은 C3의 4초 보유뿐이다.

## 5. 정식 반영 시 필요한 변경 — 제안 목록 (승인 전 적용 금지)
| ID | 위치 | 제안 |
|---|---|---|
| P-1 | 0001 `security.server_keys` 제약 | `purpose in ('staff','lead','login')`. 운영 키 생성·등록 절차 별도 승인 |
| P-2 | `zz_grants` 4)항 | `grant select, insert, update on security.login_attempts to fideon_api`, `grant usage on sequence security.login_settle_seq to fideon_api`(identity 열 `created_seq`는 로컬 실행에서 별도 sequence 권한 없이 INSERT 권한만으로 동작) |
| P-3 | `zz_grants` 7)항 | `grant execute on function api.login_attempt_reserve(text,text,text,text,text), api.login_attempt_settle(uuid,text,text) to app_public`, 보조 함수 4개 execute는 `fideon_api`에(E2 근거: 없으면 재적용 때 회수됨) |
| P-4 | `catalog_audit` V5 `exec_allow` | (app_public, login_attempt_reserve), (app_public, login_attempt_settle) 추가(E1 근거). 함수 본문 고정이 필요하면 V13 `pinned_funcs`에 2개 추가하고 단위 시험 갱신 |
| P-5 | 한도 상수 | 함수 상수 유지 또는 `core.settings`로 이동(변경 시 감사 대상) |
| P-6 | 보존 | 7일 지난 행 삭제 예약 작업(`core.purge_expired`와 같은 방식, 마이그레이션 역할만 실행) |
| P-7 | 대표 알림 | 대상 전체 1시간 30회 초과 시 감사 기록. 거부가 롤백되므로 별도 경로 필요 |
| P-8 | 앱 | `TokenPurpose`에 `login`, 환경 변수 `FIDEON_LOGIN_SIGNING_KEY`, `loginFlow`에 reserve·settle 연결, preflight 항목 추가 |
| P-9 | 시험 | `db-test.sh`에 C1~C4 같은 동시성 시험 편입, `restore-drill` 권한 비교 대상에 새 객체(테이블·sequence) 포함 |

## 6. 바뀌지 않는 한계
- 무료 요금제에서는 Supabase MFA·비밀번호 검증 훅(Teams·Enterprise 전용)을 쓸 수 없다.
- 공개 키로 Supabase `/token`·`/verify`를 **직접** 호출하면 이 제한을 거치지 않는다(Supabase 기본 IP 제한만 적용). 이 초안이 지키는 것은 FIDEON 서버의 결정 지점(TOTP 단계 → DB 세션 개설)이다.
- 서버 서명 키가 유출되면 이 결합도 우회된다(기존 서명 체계와 같은 신뢰 경계).
- 광고·접수 개방과 무관하다.
