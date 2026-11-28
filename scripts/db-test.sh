#!/usr/bin/env bash
# 로컬 가상 DB를 새로 만들고 마이그레이션 → 가상 시드 → 보안·권한 테스트를 실행한다.
# 실제 고객정보·운영 DB를 사용하지 않는다. 사용: bash scripts/db-test.sh
set -euo pipefail
cd "$(dirname "$0")/.."

PG_BIN="${PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin /opt/homebrew/opt/postgresql@*/bin /usr/local/opt/postgresql@*/bin 2>/dev/null | sort -V | tail -1 || true)}"
[ -n "$PG_BIN" ] || PG_BIN=$(dirname "$(command -v initdb)")
# macOS에는 C.UTF-8 로캘이 없을 수 있다
if [ "$(uname)" = Darwin ]; then PG_LOCALE=C; else PG_LOCALE=C.UTF-8; fi
PORT="${PGPORT_TEST:-54329}"
SOCK=/tmp
DB=fideon_test
LOG_DIR="${LOG_DIR:-test-results}"
mkdir -p "$LOG_DIR"

if [ "$(id -u)" = 0 ]; then
  DATA="${PGDATA_TEST:-/var/lib/postgresql/fideon-test}"
  as_pg() { su postgres -s /bin/bash -c "$*"; }
else
  DATA="${PGDATA_TEST:-$PWD/.local-pg}"
  as_pg() { bash -c "$*"; }
fi

if [ ! -s "$DATA/PG_VERSION" ]; then
  as_pg "mkdir -p '$DATA' && '$PG_BIN/initdb' -D '$DATA' -U postgres --auth=trust --encoding=UTF8 --locale=$PG_LOCALE >/dev/null"
fi
if ! as_pg "'$PG_BIN/pg_ctl' -D '$DATA' status" >/dev/null 2>&1; then
  as_pg "'$PG_BIN/pg_ctl' -D '$DATA' -o \"-p $PORT -k $SOCK -c listen_addresses='' -c max_connections=200\" -l '$DATA/server.log' -w start" >/dev/null  # 동시 100건 시험(R10)용 연결 여유
fi

PSQL=(psql -X -q -h "$SOCK" -p "$PORT" -U postgres -v ON_ERROR_STOP=1)
"${PSQL[@]}" -d postgres -c "drop database if exists $DB" -c "create database $DB" >/dev/null

run() { # 파일 실행, NOTICE(PASS) 출력을 로그에 모은다
  "${PSQL[@]}" -d "$DB" -f "$1" 2>&1 | tee -a "$LOG_DIR/db-test.log"
}
: > "$LOG_DIR/db-test.log"

echo "== migrations"
for f in db/migrations/0*.sql db/migrations/zz_grants.sql; do
  "${PSQL[@]}" -d "$DB" -f "$f" >/dev/null
  echo "  applied $f"
done
echo "== seed (virtual data)"
"${PSQL[@]}" -d "$DB" -f db/seed/test_seed.sql >/dev/null
"${PSQL[@]}" -d "$DB" -f db/seed/test_notices.sql >/dev/null
"${PSQL[@]}" -d "$DB" -f db/tests/00_helpers.sql >/dev/null
# 0034 광고 월 예산: 새로 만든 DB의 기본값은 0원(= 집행 금지)·안전 여유 20%여야 한다. 확인 뒤 기존 광고 시험용으로만 넉넉히 연다(폐기 DB)
m34=$("${PSQL[@]}" -d "$DB" -At -c "select monthly_limit_krw || '/' || margin_pct || '/' || core.ad_month_effective_limit() || '/' || (select count(*) from core.ad_month_config) from core.ad_month_config")
[ "$m34" = "0/20/0/1" ] || { echo "FAIL | MC-default 광고 월 예산 기본값 $m34 (기대 0/20/0/1)" | tee -a "$LOG_DIR/db-test.log"; exit 1; }
echo "NOTICE:  PASS | MC-default 광고 월 예산 기본값 0원·여유 20%·판정 한도 0(미설정 = 집행 금지)·설정 행 1개" >> "$LOG_DIR/db-test.log"
"${PSQL[@]}" -d "$DB" -c "update core.ad_month_config set monthly_limit_krw = 1000000, margin_pct = 10" >/dev/null

echo "== permission report + tests"
run db/tests/10_grants.sql > "$LOG_DIR/db-grants-report.txt"
cat "$LOG_DIR/db-grants-report.txt"
run db/tests/20_staff_auth.sql >/dev/null
run db/tests/30_leads_pii.sql >/dev/null
run db/tests/40_product_scope.sql >/dev/null   # PHASE 1 상품 상태·2인 승인
run db/tests/45_product_scope_hardening.sql >/dev/null   # PHASE 1 보완: 승인 서명 재사용 방지
run db/tests/50_required_notices.sql >/dev/null   # 필수 고지 문구·버전·노출 기록(0007)
run db/tests/60_policy_store.sql >/dev/null   # 정책 저장소(0008)
run db/tests/61_policy_list.sql >/dev/null   # 정책 조회 함수(0009)
run db/tests/70_ad_budget.sql >/dev/null    # 광고 예산 통제(0010)
run db/tests/80_ad_performance.sql >/dev/null   # 광고 성과·AI 사용료(0011)
run db/tests/90_consult_ai_confirm.sql >/dev/null   # 상담 집계·AI 정산(0012)
run db/tests/95_ad_alerts_ai_limit.sql >/dev/null   # 광고 중지 경고·AI 한도(0013)
run db/tests/96_policy_publish_notice_texts.sql >/dev/null   # 정책 게시 ON/OFF·고지 문구 관리(0014)
run db/tests/97_notice_reviews.sql >/dev/null   # 총판 고지 검수 기록(0015)
run db/tests/98_notice_intake_gate.sql >/dev/null   # 접수 직전 고지 승인 게이트(0016)
run db/tests/99_dealer_application.sql >/dev/null   # 총판 전달용 신청서(0017)
run db/tests/99_ad_launches.sql >/dev/null   # 광고 launch 상태(0018)
run db/tests/99_ad_overspend_repro.sql >/dev/null   # 광고비 초과 위험(PM 11/22 P1): 0020 계정 합산 한도·fail-closed 검증
run db/tests/99_lead_amendments.sql >/dev/null   # 재접수 변경 요청(0019)
run db/tests/99_ad_window_monitor.sql >/dev/null   # 집행 기간·날짜별 최대 청구액·정기 감시(0021, PM 11/22 P0)
run db/tests/99_ad_monthly_cap.sql >/dev/null   # 광고 월 예산 하드 한도(0034, PM 11/25 M1~M14)
run db/tests/99_ad_account_monthly.sql >/dev/null   # 계정 누적 3만원 평생 → 월별(0036, PM 11/25 ①)
run db/tests/99_ad_enable_scheduler.sql >/dev/null   # 광고 자동 스케줄러·PAUSED→ENABLED 안전 자동전환(0035, PM 11/25 ②③)
echo "== 광고 월 예산 동시 요청(0034 M5·M14): 판정 한도 8,000원에 100원 × 100건 동시, 같은 요청 키 20건 동시 — 여러 연결(서버) 경합"
"${PSQL[@]}" -d "$DB" -q -f db/tests/reset_ad_account.sql >/dev/null
"${PSQL[@]}" -d "$DB" -q -c "update core.ad_month_config set monthly_limit_krw = 10000, margin_pct = 20" >/dev/null
mc_run() { "${PSQL[@]}" -d "$DB" -At -c "set role app_staff; $("${PSQL[@]}" -d "$DB" -At -c "$1")"; }   # 직원 앱 계정으로 실행(서명 토큰은 시험 도우미가 만든다)
mc_run "select test.adapprove('owner', 'camp-mc-par', 10000, 30000, 24, '월 예산 동시 시험')" >/dev/null
for i in $(seq 1 100); do
  mc_run "select test.adcall('owner', 'ad_spend_request', format('%L, 100, %L', 'camp-mc-par', 'req-mc-par-' || lpad('$i', 8, '0')))" > "$LOG_DIR/mc-par-$i.out" 2>&1 &
done
wait
for i in $(seq 1 20); do
  mc_run "select test.adcall('owner', 'ad_spend_request', format('%L, 100, %L', 'camp-mc-par', 'req-mc-dup-00000001'))" > "$LOG_DIR/mc-dup-$i.out" 2>&1 &
done
wait
mc_allow=$(cat "$LOG_DIR"/mc-par-*.out | grep -c '"ALLOW"' || true)
mc_cap=$(cat "$LOG_DIR"/mc-par-*.out | grep -c 'MONTHLY_CAP_EXCEEDED' || true)
mc_dup=$(cat "$LOG_DIR"/mc-dup-*.out | grep -c '"ALLOW"' || true)
mc_dupb=$(cat "$LOG_DIR"/mc-dup-*.out | grep -c 'DUPLICATE_REQUEST\|MONTHLY_CAP_EXCEEDED' || true)
mc_sum=$("${PSQL[@]}" -d "$DB" -At -c "select coalesce(sum(amount_krw), 0) || '/' || core.ad_account_month((now() at time zone 'Asia/Seoul')::date) from core.ad_spend_ledger where campaign_key = 'camp-mc-par'")
if [ "$mc_allow" = 80 ] && [ "$mc_cap" = 20 ] && [ "$mc_dup" = 0 ] && [ "$mc_dupb" = 20 ] && [ "$mc_sum" = "8000/8000" ]; then
  echo "NOTICE:  PASS | M5 동시 100건: 허용 80건 × 100원 = 8,000원 정확히, 나머지 20건 MONTHLY_CAP_EXCEEDED(초과 0원). M14 같은 요청 키 20건 동시: 추가 허용 0건(한도 도달·중복 차단)" >> "$LOG_DIR/db-test.log"
else
  echo "FAIL | M5/M14 동시 요청 허용=$mc_allow 월차단=$mc_cap 중복허용=$mc_dup 중복차단=$mc_dupb 원장/월=$mc_sum" | tee -a "$LOG_DIR/db-test.log"; head -3 "$LOG_DIR"/mc-par-1.out; exit 1
fi
# 같은 키 동시 중복(한도 여유 있을 때): 정확히 1건만 허용
"${PSQL[@]}" -d "$DB" -q -c "update core.ad_month_config set monthly_limit_krw = 1000000, margin_pct = 10" >/dev/null
for i in $(seq 1 20); do
  mc_run "select test.adcall('owner', 'ad_spend_request', format('%L, 100, %L', 'camp-mc-par', 'req-mc-dup-00000002'))" > "$LOG_DIR/mc-dup2-$i.out" 2>&1 &
done
wait
d2a=$(cat "$LOG_DIR"/mc-dup2-*.out | grep -c '"ALLOW"' || true); d2b=$(cat "$LOG_DIR"/mc-dup2-*.out | grep -c 'DUPLICATE_REQUEST' || true)
[ "$d2a" = 1 ] && [ "$d2b" = 19 ] || { echo "FAIL | M14b 같은 키 동시 20건 허용=$d2a 중복=$d2b" | tee -a "$LOG_DIR/db-test.log"; exit 1; }
echo "NOTICE:  PASS | M14b 같은 요청 키 20건 동시(여러 연결): 정확히 1건 허용·19건 DUPLICATE_REQUEST" >> "$LOG_DIR/db-test.log"
"${PSQL[@]}" -d "$DB" -q -f db/tests/reset_ad_account.sql >/dev/null
echo "== 광고 활성화 예약 동시 실행(0035 ②): 실행 시각 지난 예약 1건에 스케줄러 100회 동시 호출(여러 서버) → 1회만 잡음"
"${PSQL[@]}" -d "$DB" -q -c "insert into core.ad_enable_jobs (campaign_key, launch_request_key, run_at, keywords, creative_sha256, max_cpc_krw, created_by, reason) values ('camp-sch-par', 'req-sch-par-000001', now() - interval '1 second', array['새집 인터넷'], repeat('c', 64), 100, '00000000-0000-4000-8000-000000000001', '동시 시험')" >/dev/null
for i in $(seq 1 100); do
  "${PSQL[@]}" -d "$DB" -At -c "set role app_ad_scheduler; select api.ad_sched_claim(gen_random_uuid())" > "$LOG_DIR/sch-par-$i.out" 2>&1 &
done
wait
sch_got=$(cat "$LOG_DIR"/sch-par-*.out | grep -c '"campaign": "camp-sch-par"' || true)
sch_none=$(cat "$LOG_DIR"/sch-par-*.out | grep -c '"job": null' || true)
sch_state=$("${PSQL[@]}" -d "$DB" -At -c "select state || '/' || (select count(*) from core.audit_logs where action = 'ad.enable_claim' and detail->>'campaign' = 'camp-sch-par') from core.ad_enable_jobs where campaign_key = 'camp-sch-par'")
[ "$sch_got" = 1 ] && [ "$sch_none" = 99 ] && [ "$sch_state" = "running/1" ] || { echo "FAIL | SCH-par 동시 100회 잡음=$sch_got 없음=$sch_none 상태=$sch_state" | tee -a "$LOG_DIR/db-test.log"; head -3 "$LOG_DIR"/sch-par-1.out; exit 1; }
echo "NOTICE:  PASS | SCH-par 스케줄러 100회 동시(여러 연결): 예약 1건을 정확히 1회만 잡음, 99회 없음, 감사 1건" >> "$LOG_DIR/db-test.log"
"${PSQL[@]}" -d "$DB" -q -c "set session_replication_role = replica; delete from core.ad_enable_jobs where campaign_key = 'camp-sch-par'" >/dev/null
run db/tests/99_lead_followups.sql >/dev/null   # 대표 직접 연락 동의·후속 연락 목록(0023, PM 11/22 ②)
run db/tests/99_recontact_schedule.sql >/dev/null   # 날짜별 재연락 일정·수신 거부(0060, PM 11/25 ③)
run db/tests/99_install_settlement.sql >/dev/null   # 설치·정산·환수(0069, PM 11/27 CRM ⑤)
run db/tests/99_naver_form_import.sql >/dev/null   # 네이버 폼 결과 → CRM 안전 가져오기(0071)
run db/tests/99_crm_unify.sql >/dev/null   # 고객·접수·CRM 통합(0061, PM 11/25 ①③)
run db/tests/99_purge_scope.sql >/dev/null   # 파기 범위 분리(0062, PM 11/25 B)
run db/tests/99_purge_notes_retention.sql >/dev/null   # 메모 파기·5년 보존 분리(0063)
run db/tests/99_consult_rate.sql >/dev/null   # 상담 채팅 공용 횟수 제한(0024, PM 11/22 F1)
run db/tests/99_ai_cost_hardlimit.sql >/dev/null   # AI 사용료 하드 한도: 일·사용자 한도·긴급 차단·멱등·불확실 정산(0028)
run db/tests/99_policy_intake_gate.sql >/dev/null   # 정책 검증 장애 접수 게이트(0025, PM 11/24)
run db/tests/99_ad_precheck.sql >/dev/null   # 광고 사전검증 10: 예약 시작 전 집행 차단·대조군·1회 실행
run db/tests/99_lead_gclid.sql >/dev/null   # 광고 사전검증 8: gclid 접수 귀속·첫 값 보존·형식·변조·보존기간(0027)
run db/tests/99_policy_pr16_verify.sql >/dev/null   # PR #16 추가 검증(PM 11/25): 비활성 상품 차단·정확성·캐시 구조·실패 롤백·Supabase 보안 구조(한 트랜잭션, 마지막에 되돌림)
run db/tests/99_calls.sql >/dev/null   # 통화 녹취·STT·AI 요약·고객 이력(0064~0067, PM 11/25)
run db/tests/99_outbound_persistence.sql >/dev/null   # 광고성 전화 수신거부·시도·판정 기록 영구화(0070, 코사장 11/27)
# 0070 지속성·동시성: 새 연결에서도 blocked 유지, 20개 연결 동시 block → 1행, 동시 시도 20건 → 1건만 기록
OPH=$(printf '5e%.0s' $(seq 1 32))
pers=$("${PSQL[@]}" -d "$DB" -At -c "begin" -c "set local role app_call" -c "select result from api.outbound_suppression_check('bareun365', repeat('1a', 32))" -c "commit" | grep -v -E '^(BEGIN|SET|COMMIT)$')
[ "$pers" = blocked ] || { echo "FAIL | OP39 새 연결에서 수신거부 유지 안 됨: $pers" | tee -a "$LOG_DIR/db-test.log"; exit 1; }
pids=(); for i in $(seq 1 20); do "${PSQL[@]}" -d "$DB" -At -c "begin" -c "set local role app_call" -c "select api.outbound_suppression_block('bareun365', '$OPH')" -c "commit" >/dev/null 2>&1 & pids+=($!); done
for p in "${pids[@]}"; do wait "$p" || { echo "FAIL | OP40 동시 수신거부 기록 중 오류" | tee -a "$LOG_DIR/db-test.log"; exit 1; }; done
c40=$("${PSQL[@]}" -d "$DB" -At -c "select count(*) from core.outbound_suppressions where phone_hmac = '$OPH'")
[ "$c40" = 1 ] || { echo "FAIL | OP40 동시 20회 block → 행 $c40 (기대 1)" | tee -a "$LOG_DIR/db-test.log"; exit 1; }
OPA=$(printf '6f%.0s' $(seq 1 32)); pids=()
for i in $(seq 1 20); do "${PSQL[@]}" -d "$DB" -At -c "begin" -c "set local role app_call" -c "select api.outbound_attempt_begin('bareun365', '$OPA', 'ad-internet-tv', 'live_agent', 'manual')" -c "commit" >/dev/null 2>&1 & pids+=($!); done
for p in "${pids[@]}"; do wait "$p" || true; done
c41=$("${PSQL[@]}" -d "$DB" -At -c "select count(*) from core.outbound_attempts where phone_hmac = '$OPA'")
[ "$c41" = 1 ] || { echo "FAIL | OP41 동시 20회 시도 시작 → 기록 $c41 (기대 1, 24시간 간격)" | tee -a "$LOG_DIR/db-test.log"; exit 1; }
# OP42 수신거부 기록과 시도 시작이 같은 잠금: 수신거부 트랜잭션이 끝나기 전 시작한 시도는 기다렸다가 OPTED_OUT
OPL=$(printf '7b%.0s' $(seq 1 32))
( "${PSQL[@]}" -d "$DB" -At -c "begin" -c "set local role app_call" -c "select api.outbound_suppression_block('bareun365', '$OPL')" -c "select pg_sleep(2)" -c "commit" >/dev/null 2>&1 ) &
LKPID=$!
sleep 0.7
r42=$( { "${PSQL[@]}" -d "$DB" -At -c "begin" -c "set local role app_call" -c "select api.outbound_attempt_begin('bareun365', '$OPL', 'ad-internet-tv', 'live_agent', 'manual')" -c "commit" 2>&1 >/dev/null || true; } | grep -oE 'OPTED_OUT' | head -1 || true)
wait "$LKPID"
c42=$("${PSQL[@]}" -d "$DB" -At -c "select count(*) from core.outbound_attempts where phone_hmac = '$OPL'")
[ "$r42" = OPTED_OUT ] && [ "$c42" = 0 ] || { echo "FAIL | OP42 수신거부·시도 잠금 경합 r=$r42 시도기록=$c42" | tee -a "$LOG_DIR/db-test.log"; exit 1; }
echo "NOTICE:  PASS | OP42 수신거부 기록 중(커밋 전) 시작한 시도는 같은 잠금을 기다린 뒤 OPTED_OUT, 시도 기록 0건" >> "$LOG_DIR/db-test.log"
echo "NOTICE:  PASS | OP39~41 새 연결 후 수신거부 유지, 동시 20회 block 1행(멱등), 동시 20회 시도 시작 1건만 기록(24시간 간격 직렬화)" >> "$LOG_DIR/db-test.log"

echo "== 정책 변경과 접수 동시 요청(0025·0026): 접수 트랜잭션(게이트 통과)이 끝날 때까지 정책 쓰기는 대기"
# 게이트가 통과하려면 스위치 ON + 유효 정책이 필요하다. 정책 행은 지울 수 없어 고유 키(pg6-*)·짧은 유효기간(2분)으로 만들고, 스위치는 시작 값으로 되돌린다
PUB0=$("${PSQL[@]}" -d "$DB" -At -c "select enabled::text from core.feature_flags where key = 'policy_publish'")
CAT=$("${PSQL[@]}" -d "$DB" -At -c "select product_key from core.product_catalog where status = 'active' order by product_key limit 1")
"${PSQL[@]}" -d "$DB" -c "update core.feature_flags set enabled = true where key = 'policy_publish'" \
  -c "insert into core.policy_versions (supplier_id, segment, carrier, product_id, category, revision, state, source_kind, confirmed_at, valid_from, valid_until, product_label, terms, content_hash, created_by)
      values ('pg6-sup', 'household', 'pg6-car', 'pg6-prod', '$CAT', 1, 'approved', 'official_policy_sheet', now() - interval '1 minute', now() - interval '1 minute', now() + interval '2 minute', '가상(PG6)', '{\"monthlyFee\":{\"known\":false},\"contractMonths\":{\"known\":false},\"equipmentMonthlyFee\":{\"known\":false},\"installFee\":{\"known\":false},\"bundlePrerequisites\":{\"known\":false},\"regionScope\":{\"known\":false},\"customerBenefit\":{\"known\":false}}', repeat('e', 64), '00000000-0000-4000-8000-0000000000f6')" >/dev/null
"${PSQL[@]}" -d "$DB" -c "begin; set local role app_public; select api.policy_intake_gate('pg6-sup', 'pg6-car', 'pg6-prod'); select pg_sleep(3); commit;" >/dev/null 2>"$LOG_DIR/policy_gate_bg.err" &
GATE_BG=$!
sleep 1
if "${PSQL[@]}" -d "$DB" -c "set lock_timeout = '500ms'; update core.feature_flags set enabled = enabled where key = 'policy_publish'" >/dev/null 2>"$LOG_DIR/policy_lock.err"; then
  wait "$GATE_BG" || true
  echo "FAIL | PG6 접수 트랜잭션 진행 중 게시 스위치 쓰기가 기다리지 않음" | tee -a "$LOG_DIR/db-test.log"; exit 1
fi
grep -q "lock timeout" "$LOG_DIR/policy_lock.err" || { wait "$GATE_BG" || true; echo "FAIL | PG6 예상 밖 오류: $(head -c 200 "$LOG_DIR/policy_lock.err")" | tee -a "$LOG_DIR/db-test.log"; exit 1; }
wait "$GATE_BG" || { echo "FAIL | PG6 배경 접수 게이트 실패: $(head -c 200 "$LOG_DIR/policy_gate_bg.err")" | tee -a "$LOG_DIR/db-test.log"; exit 1; }
"${PSQL[@]}" -d "$DB" -c "set lock_timeout = '2s'; update core.feature_flags set enabled = $PUB0 where key = 'policy_publish'" >/dev/null
[ "$("${PSQL[@]}" -d "$DB" -At -c "select enabled::text from core.feature_flags where key = 'policy_publish'")" = "$PUB0" ] || { echo "FAIL | PG6 게시 스위치 복원 실패" | tee -a "$LOG_DIR/db-test.log"; exit 1; }
echo "NOTICE:  PASS | PG6 [필수4] 게이트 통과한 접수 트랜잭션 중 정책 쓰기 대기(lock timeout) → 종료 뒤 쓰기 가능, 스위치 시작 값($PUB0) 복원" >> "$LOG_DIR/db-test.log"

echo "== TypeScript ↔ DB signature parity"
npx --no-install tsx scripts/sign-parity.ts > "$LOG_DIR/parity.sql"   # 프로젝트에 설치된 tsx 사용(PATH에 없어도 동작)
run "$LOG_DIR/parity.sql" >/dev/null
npx --no-install tsx scripts/call-parity.ts > "$LOG_DIR/call-parity.sql"   # 0064 통화 수신 서명·인자 일치
run "$LOG_DIR/call-parity.sql" >/dev/null

echo "== app_server login role has no direct table access"
if psql -X -q -h "$SOCK" -p "$PORT" -U app_server -d "$DB" -c "select count(*) from core.leads" >/dev/null 2>"$LOG_DIR/app_server.err"; then
  echo "FAIL | C1 app_server direct table read succeeded" | tee -a "$LOG_DIR/db-test.log"; exit 1
else
  echo "NOTICE:  PASS | C1 app_server(역할 전환 전) 테이블 직접 조회 불가 | $(head -1 "$LOG_DIR/app_server.err")" | tee -a "$LOG_DIR/db-test.log" >/dev/null
fi

echo "== concurrency: same phone, 10 parallel submissions"
for i in $(seq 1 10); do
  "${PSQL[@]}" -d "$DB" -At -c "select test.lead_sql(repeat('8', 64), 'idem-conc-' || lpad('$i', 10, '0'), p_ip => repeat('9', 64))" > "$LOG_DIR/conc-$i.sql"
done
pids=()
for i in $(seq 1 10); do
  ( psql -X -q -At -h "$SOCK" -p "$PORT" -U app_server -d "$DB" -v ON_ERROR_STOP=1 \
      -c "begin" -c "set local role app_public" -f "$LOG_DIR/conc-$i.sql" -c "commit" > "$LOG_DIR/conc-$i.out" 2>&1 ) &
  pids+=($!)
done
for p in "${pids[@]}"; do wait "$p" || true; done
accepted=$(cat "$LOG_DIR"/conc-*.out | grep -c '^accepted$' || true)
leads=$("${PSQL[@]}" -d "$DB" -At -c "select count(*) from core.leads l join pii.customers c on c.id = l.customer_id where c.phone_hmac = repeat('8', 64)")
repeat=$("${PSQL[@]}" -d "$DB" -At -c "select count(*) from core.lead_status_history h join core.leads l on l.id = h.lead_id join pii.customers c on c.id = l.customer_id where c.phone_hmac = repeat('8', 64) and h.reason = 'repeat_inquiry'")
if [ "$accepted" = 10 ] && [ "$leads" = 1 ] && [ "$repeat" = 9 ]; then
  echo "NOTICE:  PASS | C2 동시 10건 → 응답 10건 모두 accepted, 리드 1건, 재문의 9건" >> "$LOG_DIR/db-test.log"
else
  echo "FAIL | C2 accepted=$accepted leads=$leads repeat=$repeat" | tee -a "$LOG_DIR/db-test.log"; exit 1
fi
echo "== concurrency: same IP, 12 parallel submissions (limit 10/hour)"
rm -f "$LOG_DIR"/conc-*
for i in $(seq 1 12); do
  "${PSQL[@]}" -d "$DB" -At -c "select test.lead_sql(lpad(to_hex($i), 64, '7'), 'idem-rate-' || lpad('$i', 10, '0'), p_ip => repeat('d', 64))" > "$LOG_DIR/conc-$i.sql"
done
pids=()
for i in $(seq 1 12); do
  ( psql -X -q -At -h "$SOCK" -p "$PORT" -U app_server -d "$DB" -v ON_ERROR_STOP=1 \
      -c "begin" -c "set local role app_public" -f "$LOG_DIR/conc-$i.sql" -c "commit" > "$LOG_DIR/conc-$i.out" 2>&1 ) &
  pids+=($!)
done
for p in "${pids[@]}"; do wait "$p" || true; done
ok=$(cat "$LOG_DIR"/conc-*.out | grep -c '^accepted$' || true)
limited=$(cat "$LOG_DIR"/conc-*.out | grep -c 'RATE_LIMITED' || true)
if [ "$ok" = 10 ] && [ "$limited" = 2 ]; then
  echo "NOTICE:  PASS | C3 같은 IP 동시 12건 → 정확히 10건 접수, 2건 횟수 제한" >> "$LOG_DIR/db-test.log"
else
  echo "FAIL | C3 accepted=$ok limited=$limited" | tee -a "$LOG_DIR/db-test.log"; exit 1
fi
echo "== concurrency: 전환 100건 동시 + gclid(PM 11/25 8번 D2) — 같은 고객 100건 / 서로 다른 고객 100건"
rm -f "$LOG_DIR"/conc-*
# (a) 같은 고객(연락처 HMAC 같음)·서로 다른 요청 키·서로 다른 IP·서로 다른 gclid 100건 동시 → 리드(전환) 1건, 재문의 99건, gclid 1개(먼저 확정된 값)
for i in $(seq 1 100); do
  { "${PSQL[@]}" -d "$DB" -At -c "select test.lead_sql(repeat('c', 64), 'idem-cv-same-' || lpad('$i', 8, '0'), p_ip => lpad(to_hex(70000 + $i), 64, 'a')) || ';'";
    "${PSQL[@]}" -d "$DB" -At -c "select test.gclid_sql('idem-cv-same-' || lpad('$i', 8, '0'), repeat('c', 64), 'CvSame_gclid_' || lpad('$i', 3, '0')) || ';'"; } > "$LOG_DIR/conc-a$i.sql"
done
# (b) 서로 다른 고객 100명 동시, 각자 자기 gclid → 리드 100건, 각 리드의 gclid = 자기 값(섞임 0)
for i in $(seq 1 100); do
  { "${PSQL[@]}" -d "$DB" -At -c "select test.lead_sql(lpad(to_hex(80000 + $i), 64, 'f'), 'idem-cv-diff-' || lpad('$i', 8, '0'), p_ip => lpad(to_hex(90000 + $i), 64, 'b')) || ';'";
    "${PSQL[@]}" -d "$DB" -At -c "select test.gclid_sql('idem-cv-diff-' || lpad('$i', 8, '0'), lpad(to_hex(80000 + $i), 64, 'f'), 'CvDiff_gclid_' || lpad('$i', 3, '0')) || ';'"; } > "$LOG_DIR/conc-b$i.sql"
done
for set in a b; do
  pids=()
  for i in $(seq 1 100); do
    ( psql -X -q -At -h "$SOCK" -p "$PORT" -U app_server -d "$DB" -v ON_ERROR_STOP=1 \
        -c "begin" -c "set local role app_public" -f "$LOG_DIR/conc-$set$i.sql" -c "commit" > "$LOG_DIR/conc-$set$i.out" 2>&1 ) &
    pids+=($!)
  done
  for p in "${pids[@]}"; do wait "$p" || true; done
done
errs=$(cat "$LOG_DIR"/conc-a*.out "$LOG_DIR"/conc-b*.out | grep -c 'ERROR' || true)
a_leads=$("${PSQL[@]}" -d "$DB" -At -c "select count(*) from core.leads l join pii.customers c on c.id = l.customer_id where c.phone_hmac = repeat('c', 64)")
a_rep=$("${PSQL[@]}" -d "$DB" -At -c "select count(*) from core.lead_status_history h join core.leads l on l.id = h.lead_id join pii.customers c on c.id = l.customer_id where c.phone_hmac = repeat('c', 64) and h.reason = 'repeat_inquiry'")
a_clk=$("${PSQL[@]}" -d "$DB" -At -c "select count(*) || ':' || coalesce(min(k.gclid) ~ '^CvSame_gclid_[0-9]{3}$', false) from pii.lead_clicks k join core.leads l on l.id = k.lead_id join pii.customers c on c.id = l.customer_id where c.phone_hmac = repeat('c', 64)")
b_leads=$("${PSQL[@]}" -d "$DB" -At -c "select count(*) from core.leads where idempotency_key like 'idem-cv-diff-%'")
b_mix=$("${PSQL[@]}" -d "$DB" -At -c "select count(*) from core.leads l join pii.lead_clicks k on k.lead_id = l.id where l.idempotency_key like 'idem-cv-diff-%' and k.gclid <> 'CvDiff_gclid_' || right(l.idempotency_key, 3)")
b_clk=$("${PSQL[@]}" -d "$DB" -At -c "select count(*) from core.leads l join pii.lead_clicks k on k.lead_id = l.id where l.idempotency_key like 'idem-cv-diff-%'")
if [ "$errs" = 0 ] && [ "$a_leads" = 1 ] && [ "$a_rep" = 99 ] && [ "$a_clk" = "1:true" ] && [ "$b_leads" = 100 ] && [ "$b_clk" = 100 ] && [ "$b_mix" = 0 ]; then
  echo "NOTICE:  PASS | C5 전환 동시 100건: 같은 고객 → 리드 1건·재문의 99건·gclid 1개 / 다른 고객 100명 → 리드 100건·gclid 100개·섞임 0·오류 0" >> "$LOG_DIR/db-test.log"
else
  echo "FAIL | C5 errs=$errs a_leads=$a_leads a_rep=$a_rep a_clk=$a_clk b_leads=$b_leads b_clk=$b_clk b_mix=$b_mix" | tee -a "$LOG_DIR/db-test.log"; exit 1
fi
echo "== concurrency: consult chat rate, 25 parallel hits from one IP on separate connections (limit 10/min)"
"${PSQL[@]}" -d "$DB" -c "delete from core.consult_rate" >/dev/null
while [ "$(date +%S)" -ge 55 ]; do sleep 1; done   # 1분 창 경계를 넘지 않게
pids=()
for i in $(seq 1 25); do
  ( psql -X -q -At -h "$SOCK" -p "$PORT" -U app_server -d "$DB" -v ON_ERROR_STOP=1 \
      -c "begin" -c "set local role app_public" -c "select api.consult_rate_hit(repeat('c1', 32), 'chat')" -c "commit" > "$LOG_DIR/rate-$i.out" 2>&1 ) &
  pids+=($!)
done
for p in "${pids[@]}"; do wait "$p" || true; done
rt=$(cat "$LOG_DIR"/rate-*.out | grep -c '^t$' || true)
rf=$(cat "$LOG_DIR"/rate-*.out | grep -c '^f$' || true)
rows=$("${PSQL[@]}" -d "$DB" -At -c "select coalesce(max(hits), 0) from core.consult_rate where bucket = 'chat:' || repeat('c1', 32)")
if [ "$rt" = 10 ] && [ "$rf" = 15 ] && [ "$rows" = 10 ]; then
  echo "NOTICE:  PASS | C5 상담 공용 제한: 서로 다른 연결(다중 서버 모사) 동시 25건 → 정확히 10건 허용, 15건 거부, 집계 10" >> "$LOG_DIR/db-test.log"
else
  echo "FAIL | C5 allowed=$rt denied=$rf hits=$rows" | tee -a "$LOG_DIR/db-test.log"; exit 1
fi
rm -f "$LOG_DIR"/rate-*
"${PSQL[@]}" -d "$DB" -c "delete from core.consult_rate" >/dev/null
echo "== concurrency: identical request submitted 5 times at once (double click)"
# 경쟁 상황을 확실히 만든다: 1번 요청은 저장 후 1.5초 동안 확정(commit)하지 않고, 그 사이 2~5번이 시작된다.
# 2~5번은 잠금 전 재전송 확인 시점에 1번의 행을 볼 수 없으므로, 잠금 후 재확인이 없으면 '재문의'로 잘못 기록된다.
rm -f "$LOG_DIR"/conc-*
"${PSQL[@]}" -d "$DB" -At -c "select test.lead_sql(repeat('6', 63) || '1', 'idem-double-0000000001', p_ip => repeat('5', 64))" > "$LOG_DIR/conc-same.sql"
pids=()
( psql -X -q -At -h "$SOCK" -p "$PORT" -U app_server -d "$DB" -v ON_ERROR_STOP=1 \
    -c "begin" -c "set local role app_public" -f "$LOG_DIR/conc-same.sql" -c "select pg_sleep(1.5)" -c "commit" \
    | grep -v '^$' > "$LOG_DIR/conc-1.out" 2>&1 ) &
pids+=($!)
sleep 0.4
for i in $(seq 2 5); do
  ( psql -X -q -At -h "$SOCK" -p "$PORT" -U app_server -d "$DB" -v ON_ERROR_STOP=1 \
      -c "begin" -c "set local role app_public" -f "$LOG_DIR/conc-same.sql" -c "commit" > "$LOG_DIR/conc-$i.out" 2>&1 ) &
  pids+=($!)
done
for p in "${pids[@]}"; do wait "$p" || true; done
ok=$(cat "$LOG_DIR"/conc-*.out | grep -c '^accepted$' || true)
leads=$("${PSQL[@]}" -d "$DB" -At -c "select count(*) from core.leads where idempotency_key = 'idem-double-0000000001'")
repeat=$("${PSQL[@]}" -d "$DB" -At -c "select count(*) from core.lead_status_history h join core.leads l on l.id = h.lead_id where l.idempotency_key = 'idem-double-0000000001' and h.reason = 'repeat_inquiry'")
if [ "$ok" = 5 ] && [ "$leads" = 1 ] && [ "$repeat" = 0 ]; then
  echo "NOTICE:  PASS | C4 같은 요청 동시 5건 → 응답 5건 accepted, 리드 1건, 재문의 0건" >> "$LOG_DIR/db-test.log"
else
  echo "FAIL | C4 accepted=$ok leads=$leads repeat=$repeat" | tee -a "$LOG_DIR/db-test.log"; exit 1
fi
# 9. 전환 중복 방지(광고 사전검증): 응답 유실(timeout) 뒤 같은 요청 키로 재시도 — 새 연결(서버 재시작·재처리 모사)에서 3회
for i in 1 2 3; do
  psql -X -q -At -h "$SOCK" -p "$PORT" -U app_server -d "$DB" -v ON_ERROR_STOP=1 \
    -c "begin" -c "set local role app_public" -f "$LOG_DIR/conc-same.sql" -c "commit" | grep -v '^$' > "$LOG_DIR/conc-retry-$i.out" 2>&1 || true
done
ok=$(cat "$LOG_DIR"/conc-retry-*.out | grep -c '^accepted$' || true)
leads=$("${PSQL[@]}" -d "$DB" -At -c "select count(*) from core.leads where idempotency_key = 'idem-double-0000000001'")
repeat=$("${PSQL[@]}" -d "$DB" -At -c "select count(*) from core.lead_status_history h join core.leads l on l.id = h.lead_id where l.idempotency_key = 'idem-double-0000000001' and h.reason = 'repeat_inquiry'")
if [ "$ok" = 3 ] && [ "$leads" = 1 ] && [ "$repeat" = 0 ]; then
  echo "NOTICE:  PASS | C4b 확정 뒤 같은 요청 키 재시도 3회(새 연결) → 모두 accepted, 리드(=전환) 1건 유지, 재문의 0건" >> "$LOG_DIR/db-test.log"
else
  echo "FAIL | C4b accepted=$ok leads=$leads repeat=$repeat" | tee -a "$LOG_DIR/db-test.log"; exit 1
fi
# 상담 시작(전환 퍼널 1단계): 같은 세션 키 8건 동시(서로 다른 연결) → 1건만
for i in $(seq 1 8); do
  ( psql -X -q -At -h "$SOCK" -p "$PORT" -U app_server -d "$DB" -v ON_ERROR_STOP=1 \
      -c "begin" -c "set local role app_public" -c "select api.consult_event_record('sess-conv-dup-000000001', 'conv-dup')" -c "commit" > "$LOG_DIR/conc-ev-$i.out" 2>&1 ) &
done
wait
evfail=$(cat "$LOG_DIR"/conc-ev-*.out | grep -ci 'error' || true)
events=$("${PSQL[@]}" -d "$DB" -At -c "select count(*) from core.consult_events where session_key = 'sess-conv-dup-000000001'")
if [ "$events" = 1 ] && [ "$evfail" = 0 ]; then
  echo "NOTICE:  PASS | C4c 같은 상담 세션 동시 8건(서로 다른 연결) → 상담 시작 1건, 오류 0건" >> "$LOG_DIR/db-test.log"
else
  echo "FAIL | C4c events=$events errors=$evfail" | tee -a "$LOG_DIR/db-test.log"; exit 1
fi
echo "== concurrency: identical request submitted 100 times at once (R5·R10, separate connections)"
"${PSQL[@]}" -d "$DB" -At -c "select test.lead_sql(repeat('6', 63) || '2', 'idem-hundred-000000001', p_ip => repeat('7', 64))" > "$LOG_DIR/conc-100.sql"
pids=()
for i in $(seq 1 100); do
  ( psql -X -q -At -h "$SOCK" -p "$PORT" -U app_server -d "$DB" -v ON_ERROR_STOP=1 \
      -c "begin" -c "set local role app_public" -f "$LOG_DIR/conc-100.sql" -c "commit" > "$LOG_DIR/c100-$i.out" 2>&1 ) &
  pids+=($!)
done
for p in "${pids[@]}"; do wait "$p" || true; done
ok=$(cat "$LOG_DIR"/c100-*.out | grep -c '^accepted$' || true)
other=$(cat "$LOG_DIR"/c100-*.out | grep -v '^$' | grep -vc '^accepted$' || true)
leads=$("${PSQL[@]}" -d "$DB" -At -c "select count(*) from core.leads where idempotency_key = 'idem-hundred-000000001'")
repeat=$("${PSQL[@]}" -d "$DB" -At -c "select count(*) from core.lead_status_history h join core.leads l on l.id = h.lead_id where l.idempotency_key = 'idem-hundred-000000001' and h.reason = 'repeat_inquiry'")
if [ "$ok" = 100 ] && [ "$other" = 0 ] && [ "$leads" = 1 ] && [ "$repeat" = 0 ]; then
  echo "NOTICE:  PASS | C4d 같은 요청 동시 100건(서로 다른 연결) → 응답 100건 accepted, 리드 1건, 재문의 0건, 오류 0건" >> "$LOG_DIR/db-test.log"
else
  echo "FAIL | C4d accepted=$ok other=$other leads=$leads repeat=$repeat" | tee -a "$LOG_DIR/db-test.log"; cat "$LOG_DIR"/c100-*.out | sort | uniq -c | head; exit 1
fi
rm -f "$LOG_DIR"/c100-*.out "$LOG_DIR/conc-100.sql"
rm -f "$LOG_DIR"/conc-*.sql "$LOG_DIR"/conc-*.out "$LOG_DIR/app_server.err"

# ===== PHASE 1 보완(검수 지적 2항): 승인·활성화 동시성 =====
# 승인 기록과 활성화는 앱 역할에 열려 있지 않으므로(관리자 직접 실행만 가능) 관리자 연결로 동시 실행한다.
# 서명은 미리 만들어 둔다(같은 서명 = 글자까지 같은 값).
PSQL_ADMIN=(psql -X -q -At -h "$SOCK" -p "$PORT" -U postgres -d "$DB" -v ON_ERROR_STOP=1)
APPROVE_SQL() { # $1 상품 $2 종류 $3 직원 $4 세션 $5 서명 유효시간(초) → insert 문 출력
  "${PSQL[@]}" -d "$DB" -At -c "select test.approval_sql('$3'::uuid, '$4'::uuid, '$1', '$2', p_ttl => $5)"
}
OWNER_ID=00000000-0000-4000-8000-000000000001; OWNER_SES=10000000-0000-4000-8000-000000000001
PM_ID=00000000-0000-4000-8000-000000000005;    PM_SES=10000000-0000-4000-8000-000000000005

echo "== concurrency: same approval signature submitted 5 times at once"
# 1번은 기록 후 1.5초 동안 확정하지 않고, 그 사이 2~5번이 같은 서명으로 들어온다.
rm -f "$LOG_DIR"/conc-*
APPROVE_SQL internet_only owner $OWNER_ID $OWNER_SES 100 > "$LOG_DIR/conc-same.sql"
( "${PSQL_ADMIN[@]}" -c "begin" -f "$LOG_DIR/conc-same.sql" -c "select pg_sleep(1.5)" -c "commit" > "$LOG_DIR/conc-1.out" 2>&1; echo "rc=$?" >> "$LOG_DIR/conc-1.out" ) &
pids=($!); sleep 0.4
for i in $(seq 2 5); do
  ( "${PSQL_ADMIN[@]}" -f "$LOG_DIR/conc-same.sql" > "$LOG_DIR/conc-$i.out" 2>&1; echo "rc=$?" >> "$LOG_DIR/conc-$i.out" ) &
  pids+=($!)
done
for p in "${pids[@]}"; do wait "$p" || true; done
ok=$(grep -l '^rc=0$' "$LOG_DIR"/conc-*.out | wc -l | tr -d ' ')
reused=$(cat "$LOG_DIR"/conc-*.out | grep -c 'APPROVAL_PROOF_REUSED' || true)
rows=$("${PSQL[@]}" -d "$DB" -At -c "select count(*) from core.product_activation_approvals where product_key = 'internet_only'")
if [ "$ok" = 1 ] && [ "$reused" = 4 ] && [ "$rows" = 1 ]; then
  echo "NOTICE:  PASS | K1 같은 승인 서명 동시 5건 → 1건만 기록, 4건 재사용 거부" >> "$LOG_DIR/db-test.log"
else
  echo "FAIL | K1 ok=$ok reused=$reused rows=$rows" | tee -a "$LOG_DIR/db-test.log"; cat "$LOG_DIR"/conc-*.out; exit 1
fi

echo "== concurrency: 5 different valid signatures for the same approval slot at once"
rm -f "$LOG_DIR"/conc-*
# 서명마다 만료 시각이 반드시 달라야 한다: 유효시간 간격을 1초로 두면 생성 사이에 초가 바뀔 때 같은 서명이 나와 재사용으로 거부된다(CI 43734238101 1회차). 60초 간격, DB 상한 300초 이내(280~40초).
for i in $(seq 1 5); do APPROVE_SQL other owner $OWNER_ID $OWNER_SES $((340 - 60 * i)) > "$LOG_DIR/conc-$i.sql"; done
if [ "$(cat "$LOG_DIR"/conc-[1-5].sql | sort -u | wc -l | tr -d " ")" != 5 ]; then echo "FAIL | K2 준비: 서로 다른 서명 5개가 아님" | tee -a "$LOG_DIR/db-test.log"; exit 1; fi
pids=()
for i in $(seq 1 5); do
  ( "${PSQL_ADMIN[@]}" -f "$LOG_DIR/conc-$i.sql" > "$LOG_DIR/conc-$i.out" 2>&1; echo "rc=$?" >> "$LOG_DIR/conc-$i.out" ) &
  pids+=($!)
done
for p in "${pids[@]}"; do wait "$p" || true; done
ok=$(grep -l '^rc=0$' "$LOG_DIR"/conc-*.out | wc -l | tr -d ' ')
pending=$(cat "$LOG_DIR"/conc-*.out | grep -c 'APPROVAL_ALREADY_PENDING' || true)
open_rows=$("${PSQL[@]}" -d "$DB" -At -c "select count(*) from core.product_activation_approvals where product_key = 'other' and approval_kind = 'owner' and consumed_at is null")
if [ "$ok" = 1 ] && [ "$pending" = 4 ] && [ "$open_rows" = 1 ]; then
  echo "NOTICE:  PASS | K2 같은 승인 칸에 서로 다른 서명 동시 5건 → 미소진 승인 1건만" >> "$LOG_DIR/db-test.log"
else
  echo "FAIL | K2 ok=$ok pending=$pending open=$open_rows" | tee -a "$LOG_DIR/db-test.log"; cat "$LOG_DIR"/conc-*.out; exit 1
fi

echo "== concurrency: 5 activation attempts at once (virtual DB only, reverted right after)"
# 가상 시험 DB에서 '중복 활성화 방지'만 확인하고 즉시 예약으로 되돌린다. 운영 DB·운영 코드와 무관.
APPROVE_SQL other pm $PM_ID $PM_SES 100 > "$LOG_DIR/conc-pm.sql"
"${PSQL_ADMIN[@]}" -f "$LOG_DIR/conc-pm.sql" >/dev/null
rm -f "$LOG_DIR"/conc-*.out
pids=()
for i in $(seq 1 5); do
  ( "${PSQL_ADMIN[@]}" -c "begin" -c "update core.product_catalog set status = 'active' where product_key = 'other'" \
      -c "select pg_sleep(0.3)" -c "commit" > "$LOG_DIR/conc-$i.out" 2>&1; echo "rc=$?" >> "$LOG_DIR/conc-$i.out" ) &
  pids+=($!)
done
for p in "${pids[@]}"; do wait "$p" || true; done
acts=$("${PSQL[@]}" -d "$DB" -At -c "select count(*) from core.audit_logs where action = 'product.activate' and detail->>'product' = 'other'")
open_rows=$("${PSQL[@]}" -d "$DB" -At -c "select count(*) from core.product_activation_approvals where product_key = 'other' and consumed_at is null")
errs=$(grep -L '^rc=0$' "$LOG_DIR"/conc-*.out | wc -l | tr -d ' ')
"${PSQL[@]}" -d "$DB" -c "update core.product_catalog set status = 'reserved' where product_key = 'other'" >/dev/null
after=$("${PSQL[@]}" -d "$DB" -At -c "select string_agg(product_key, ',' order by product_key) from core.product_catalog where status = 'active'")
if [ "$acts" = 1 ] && [ "$open_rows" = 0 ] && [ "$errs" = 0 ] && [ "$after" = internet_tv ]; then
  echo "NOTICE:  PASS | K3 동시 활성화 5건 → 활성화 기록 1건, 승인 2건 모두 소진, 즉시 예약 복귀(활성 상품 internet_tv만)" >> "$LOG_DIR/db-test.log"
else
  echo "FAIL | K3 activations=$acts open=$open_rows errors=$errs active_after=$after" | tee -a "$LOG_DIR/db-test.log"; cat "$LOG_DIR"/conc-*.out; exit 1
fi

echo "== concurrency: reactivation right after with the same (consumed) approvals"
rm -f "$LOG_DIR"/conc-*.out
pids=()
for i in $(seq 1 3); do
  ( "${PSQL_ADMIN[@]}" -c "update core.product_catalog set status = 'active' where product_key = 'other'" > "$LOG_DIR/conc-$i.out" 2>&1; echo "rc=$?" >> "$LOG_DIR/conc-$i.out" ) &
  pids+=($!)
done
for p in "${pids[@]}"; do wait "$p" || true; done
denied=$(cat "$LOG_DIR"/conc-*.out | grep -c 'PRODUCT_ACTIVATION_REQUIRES_APPROVAL' || true)
st=$("${PSQL[@]}" -d "$DB" -At -c "select status from core.product_catalog where product_key = 'other'")
if [ "$denied" = 3 ] && [ "$st" = reserved ]; then
  echo "NOTICE:  PASS | K4 소진된 승인으로 동시 재활성화 3건 → 모두 거부, 예약 유지" >> "$LOG_DIR/db-test.log"
else
  echo "FAIL | K4 denied=$denied status=$st" | tee -a "$LOG_DIR/db-test.log"; exit 1
fi
rm -f "$LOG_DIR"/conc-*.sql "$LOG_DIR"/conc-*.out
# 시험이 남긴 미소진 승인(K1 등)을 허용된 '소진 표시'로 정리한다(배포 전 점검 P4는 진행 중인 승인을 위반으로 본다)
"${PSQL[@]}" -d "$DB" -c "update core.product_activation_approvals set consumed_at = now() where consumed_at is null" >/dev/null

echo "== catalog audit as release_auditor (the same check release-check runs against the production DB)"
AUDIT_URL="postgresql:///$DB?host=$SOCK&port=$PORT&user=release_auditor"
audit_expect() { # $1 라벨, $2 기대(pass | 위반 문자열 일부)
  local out rc=0
  out=$(bash scripts/db-audit.sh "$AUDIT_URL" 2>&1) || rc=$?
  if [ "$2" = pass ]; then
    if [ "$rc" = 0 ]; then echo "NOTICE:  PASS | $1 | 위반 0건" >> "$LOG_DIR/db-test.log"
    else echo "FAIL | $1 | $out" | tee -a "$LOG_DIR/db-test.log"; exit 1; fi
  else
    if [ "$rc" != 0 ] && printf '%s' "$out" | grep -qF "$2"; then
      echo "NOTICE:  PASS | $1 | 감지: $2" >> "$LOG_DIR/db-test.log"
    else echo "FAIL | $1 | expected violation '$2', got rc=$rc: $out" | tee -a "$LOG_DIR/db-test.log"; exit 1; fi
  fi
}
SQL() { "${PSQL[@]}" -d "$DB" -c "$1" >/dev/null; }

# ---- 함수 본문 변조·복원 도구(X11·X16). macOS BSD sed / Linux GNU sed 공통: POSIX sed -n 범위 출력과 awk만 사용 ----
# psql -f <(…) 형태는 앞단(sed 등)이 실패해도 psql이 빈 입력을 받아 rc=0으로 끝나 '조용히' 넘어가므로 쓰지 않는다.
# 정의를 파일로 뽑아 내용이 온전한지 확인한 뒤 적용하고, 적용 후 DB의 실제 본문 해시로 결과를 확인한다.
CREATE_LEAD_SIG="api.create_lead(text,text,text,text,text,text,text,text,text,text,text,text,text,boolean,boolean,text)"
# 배포 전 점검(V13)에 고정된 검수본 해시. 시험 기준값도 같은 곳에서 읽어 둘이 어긋날 수 없게 한다
PINNED_CREATE_LEAD_MD5=$(grep -E "^ +\('api', 'create_lead'," db/audit/catalog_audit.sql | grep -oE "'[0-9a-f]{32}'" | tr -d "'")
[ "${#PINNED_CREATE_LEAD_MD5}" = 32 ] || { echo "FAIL | create_lead 고정 해시를 catalog_audit.sql에서 찾지 못함" | tee -a "$LOG_DIR/db-test.log"; exit 1; }
fn_md5() { "${PSQL[@]}" -d "$DB" -At -c "select md5(prosrc) from pg_proc where oid = '$CREATE_LEAD_SIG'::regprocedure"; }
extract_create_lead() { # $1 마이그레이션 파일 → 표준출력: create_lead 정의(시작~끝 줄이 모두 있어야 함)
  local out
  out=$(sed -n '/^create or replace function api.create_lead(/,/^\$\$;/p' "$1")
  if ! printf '%s\n' "$out" | head -n 1 | grep -q '^create or replace function api.create_lead(' \
     || ! printf '%s\n' "$out" | tail -n 1 | grep -q '^\$\$;$'; then
    echo "FAIL | create_lead 정의 추출 실패: $1" | tee -a "$LOG_DIR/db-test.log" >&2; exit 1
  fi
  printf '%s\n' "$out"
}
apply_sql_file() { # $1 SQL 파일(비어 있으면 실패)
  [ -s "$1" ] || { echo "FAIL | 적용할 SQL이 비어 있음: $1" | tee -a "$LOG_DIR/db-test.log"; exit 1; }
  "${PSQL[@]}" -d "$DB" -f "$1" >/dev/null
}
restore_create_lead() { # 최신 검수본(0061: 0007 + 고객 중복 금지)으로 복원하고, 실제 본문이 고정 해시와 같은지 확인
  extract_create_lead db/migrations/0061_crm_unify.sql > "$LOG_DIR/fn-create_lead.sql"
  apply_sql_file "$LOG_DIR/fn-create_lead.sql"; rm -f "$LOG_DIR/fn-create_lead.sql"
  [ "$(fn_md5)" = "$PINNED_CREATE_LEAD_MD5" ] || { echo "FAIL | $1 create_lead 복원 실패(본문이 검수본과 다름)" | tee -a "$LOG_DIR/db-test.log"; exit 1; }
}

audit_expect "X1 점검 계정으로 권한 점검" pass
SQL "grant select on core.leads to app_staff"
audit_expect "X2 일부러 준 테이블 권한 감지" "V2 table privilege: app_staff on core.leads"
SQL "revoke select on core.leads from app_staff"
SQL "alter table pii.consents no force row level security"
audit_expect "X3 일부러 끈 FORCE RLS 감지" "V1 RLS/FORCE off: pii.consents"
SQL "alter table pii.consents force row level security"
SQL "grant execute on function core.purge_expired() to app_public"
audit_expect "X4 허용 목록 밖 함수 실행 권한 감지" "V5 execute not allowed: app_public -> core.purge_expired"
SQL "revoke execute on function core.purge_expired() from app_public"
SQL "grant usage on schema core to app_public"
audit_expect "X5 허용되지 않은 스키마 USAGE 감지" "V3 schema usage: app_public on core"
SQL "revoke usage on schema core from app_public"
# PHASE 1 보완: 상품 보호 장치가 꺼지거나 사라지면 배포 전 점검이 막아야 한다
SQL "alter table core.product_catalog disable trigger product_catalog_guard"
audit_expect "X7 꺼진 상품 상태 보호 트리거 감지" "V10 protection trigger missing or disabled: core.product_catalog product_catalog_guard"
SQL "alter table core.product_catalog enable trigger product_catalog_guard"
SQL "alter table core.product_activation_approvals disable trigger product_approval_guard"
audit_expect "X8 꺼진 승인 기록 보호 트리거 감지" "V10 protection trigger missing or disabled: core.product_activation_approvals product_approval_guard"
SQL "alter table core.product_activation_approvals enable trigger product_approval_guard"
SQL "alter table core.product_catalog enable replica trigger product_catalog_no_truncate"
audit_expect "X9 복제 전용으로 바꾼 트리거 감지(일반 세션에서 안 돎)" "V10 protection trigger missing or disabled: core.product_catalog product_catalog_no_truncate"
SQL "alter table core.product_catalog enable trigger product_catalog_no_truncate"
SQL "drop index core.product_approvals_proof_once"
audit_expect "X10 지워진 승인 서명 1회용 인덱스 감지" "V12 approval unique index missing or invalid: product_approvals_proof_once"
SQL "create unique index product_approvals_proof_once on core.product_activation_approvals (proof_sha256)"
[ "$(fn_md5)" = "$PINNED_CREATE_LEAD_MD5" ] || { echo "FAIL | X11 시작 전 create_lead가 검수본 상태가 아님" | tee -a "$LOG_DIR/db-test.log"; exit 1; }
extract_create_lead db/migrations/0002_leads.sql > "$LOG_DIR/fn-create_lead.sql"
apply_sql_file "$LOG_DIR/fn-create_lead.sql"; rm -f "$LOG_DIR/fn-create_lead.sql"
"${PSQL[@]}" -d "$DB" -At -c "select position('PRODUCT_NOT_ACTIVE' in prosrc) = 0 from pg_proc where oid = '$CREATE_LEAD_SIG'::regprocedure" | grep -qx t \
  || { echo "FAIL | X11 변조 주입 실패: 옛 함수(상품 확인 없음)로 바뀌지 않음 — 점검(V11)과 무관한 시험 준비 오류" | tee -a "$LOG_DIR/db-test.log"; exit 1; }
audit_expect "X11 상품 확인이 빠진 옛 상담 신청 함수로 되돌린 상태 감지" "V11 api.create_lead without product check"
restore_create_lead X11
# PHASE 1 최종 보완: 점검이 '실제 차단 동작(운영 데이터 기준)'과 함수 본문 동일성을 확인하는지
# X12 운영 DB에서 누군가 보호 장치를 우회해 CCTV를 활성으로 바꾼 상황(시험 DB에서만 재현) → 접수 허용 상태 감지
SQL "alter table core.product_catalog disable trigger product_catalog_guard"
SQL "update core.product_catalog set status = 'active', activated_at = now() where product_key = 'cctv_security'"
SQL "alter table core.product_catalog enable trigger product_catalog_guard"
audit_expect "X12 예약 상품(CCTV)이 운영 데이터에서 접수 가능 상태 → 감지" "V15 P1 lead accepted for reserved product: cctv_security"
SQL "update core.product_catalog set status = 'reserved' where product_key = 'cctv_security'"   # 보호 장치가 허용하는 안전 방향 복구
# X13 인터넷+TV가 차단된 상태(서비스 중단) → 감지
SQL "update core.product_catalog set status = 'reserved' where product_key = 'internet_tv'"
audit_expect "X13 활성 상품(인터넷+TV)이 차단된 상태 → 감지" "V15 P1 lead blocked for active product: internet_tv"
SQL "alter table core.product_catalog disable trigger product_catalog_guard"
SQL "update core.product_catalog set status = 'active', activated_at = now() where product_key = 'internet_tv'"
SQL "alter table core.product_catalog enable trigger product_catalog_guard"
# X14 진행 중인 활성화 승인(휴대폰)이 있는 상태 → 감지. 정상 서명으로 기록한 뒤 허용된 '소진 표시'로 정리
SQL "$("${PSQL[@]}" -d "$DB" -At -c "select test.approval_sql('00000000-0000-4000-8000-000000000001'::uuid, '10000000-0000-4000-8000-000000000001'::uuid, 'mobile', 'owner', p_ttl => 97)")"
audit_expect "X14 진행 중인 예약 상품 활성화 승인 → 감지" "V15 P4 pending activation approval: mobile (owner)"
SQL "update core.product_activation_approvals set consumed_at = now() where product_key = 'mobile' and consumed_at is null"
# X15 기준에 없는 상품(정의 미확정인 동판)이 DB에 추가된 상태 → 감지. 허용 키 제약을 잠시 풀어 재현한 뒤 원상 복구
SQL "alter table core.product_catalog drop constraint product_catalog_product_key_check"
SQL "insert into core.product_catalog (product_key, label, status) values ('dongpan', '동판', 'reserved')"
audit_expect "X15 상품 목록이 기준과 달라짐(미승인 상품 추가) → 감지" "V15 P2 product keys differ from baseline: cctv_security,dongpan,internet_only,internet_phone,internet_tv,mobile,other"
SQL "alter table core.product_catalog disable trigger product_catalog_guard"
SQL "delete from core.product_catalog where product_key = 'dongpan'"
SQL "alter table core.product_catalog enable trigger product_catalog_guard"
SQL "alter table core.product_catalog add constraint product_catalog_product_key_check check (product_key in ('internet_tv', 'internet_phone', 'internet_only', 'cctv_security', 'other', 'mobile'))"
# X16 상품 차단 함수 본문에 주석 한 줄만 추가해도 → 검수본과 다름 감지(문자열 포함 검사 V11은 통과하는 변경)
#   준비: 0004 검수본 정의에서 첫 'begin' 줄 바로 뒤에 주석 1줄 추가(awk — BSD·GNU 공통). GNU 전용 sed 문법(0,/re/ 주소, 치환 안 \n)을 쓰지 않는다.
#   단계마다 확인: ① 시작 전 검수본 ② 주입 후 본문이 실제로 바뀌고 표식 주석 포함 ③ V13 감지 + V11 미감지 ④ 복원 후 검수본
X16_MARK='-- 검수 후 몰래 추가한 주석'
[ "$(fn_md5)" = "$PINNED_CREATE_LEAD_MD5" ] || { echo "FAIL | X16 시작 전 create_lead가 검수본 상태가 아님" | tee -a "$LOG_DIR/db-test.log"; exit 1; }
extract_create_lead db/migrations/0004_product_scope.sql \
  | awk -v mark="  $X16_MARK" '{ print } !done && $0 == "begin" { print mark; done = 1 } END { if (!done) exit 3 }' \
  > "$LOG_DIR/fn-create_lead-x16.sql" \
  || { echo "FAIL | X16 변조 주입 준비 실패: 본문에서 'begin' 줄을 찾지 못함 — 점검(V13)과 무관한 시험 준비 오류" | tee -a "$LOG_DIR/db-test.log"; exit 1; }
[ "$(grep -c -- "$X16_MARK" "$LOG_DIR/fn-create_lead-x16.sql")" = 1 ] \
  || { echo "FAIL | X16 변조 주입 준비 실패: 표식 주석이 정확히 1줄이 아님" | tee -a "$LOG_DIR/db-test.log"; exit 1; }
apply_sql_file "$LOG_DIR/fn-create_lead-x16.sql"; rm -f "$LOG_DIR/fn-create_lead-x16.sql"
X16_MD5=$(fn_md5)
if [ "$X16_MD5" = "$PINNED_CREATE_LEAD_MD5" ] \
   || ! "${PSQL[@]}" -d "$DB" -At -c "select position('$X16_MARK' in prosrc) > 0 from pg_proc where oid = '$CREATE_LEAD_SIG'::regprocedure" | grep -qx t; then
  echo "FAIL | X16 변조 주입 실패: DB의 create_lead 본문이 바뀌지 않음 — 점검(V13)과 무관한 시험 준비 오류" | tee -a "$LOG_DIR/db-test.log"; exit 1
fi
echo "NOTICE:  PASS | X16a 변조 주입 확인(본문 해시 변경, 표식 주석 1줄 포함)" >> "$LOG_DIR/db-test.log"
audit_expect "X16 상담 신청 함수 본문 1줄 변경 → 감지(V11은 통과하는 변경)" "V13 function body differs from reviewed migration: api.create_lead(text, text"
X16_OUT=$(bash scripts/db-audit.sh "$AUDIT_URL" 2>&1 || true)
if printf '%s' "$X16_OUT" | grep -q '^V11 '; then
  echo "FAIL | X16b 주석 1줄 변경을 V11도 잡음(시험 전제 불일치): $X16_OUT" | tee -a "$LOG_DIR/db-test.log"; exit 1
fi
echo "NOTICE:  PASS | X16b 같은 변경을 문자열 검사(V11)는 통과 — V13만 감지" >> "$LOG_DIR/db-test.log"
restore_create_lead X16
echo "NOTICE:  PASS | X16c 시험 후 create_lead가 검수본으로 복원됨(본문 해시 = 점검 고정값)" >> "$LOG_DIR/db-test.log"
# X17 점검 함수를 VOLATILE(쓰기 가능)로 바꾼 상태 → 감지
SQL "alter function api.release_probe_product_scope() volatile"
audit_expect "X17 점검 함수가 읽기 전용(STABLE)이 아님 → 감지" "V14 release probe must be STABLE SECURITY DEFINER returning setof text"
SQL "alter function api.release_probe_product_scope() stable"
# X18 STABLE 함수는 운영 데이터를 바꿀 수 없다(점검 함수와 같은 방식의 시험 함수로 확인)
SQL "create function test.stable_write_probe() returns void language plpgsql stable as \$f\$ begin update core.product_catalog set label = label where product_key = 'internet_tv'; end \$f\$"
if "${PSQL[@]}" -d "$DB" -c "select test.stable_write_probe()" >/dev/null 2>"$LOG_DIR/stable.err"; then
  echo "FAIL | X18 STABLE function was able to write" | tee -a "$LOG_DIR/db-test.log"; exit 1
fi
grep -q 'not allowed in a non-volatile function' "$LOG_DIR/stable.err" \
  && echo "NOTICE:  PASS | X18 STABLE 함수 안의 UPDATE는 PostgreSQL이 거부(점검 함수는 쓰기 불가)" >> "$LOG_DIR/db-test.log" \
  || { echo "FAIL | X18 $(cat "$LOG_DIR/stable.err")" | tee -a "$LOG_DIR/db-test.log"; exit 1; }
SQL "drop function test.stable_write_probe()"; rm -f "$LOG_DIR/stable.err"
# X19 점검 계정은 여전히 상품·승인 테이블을 직접 읽지 못한다(함수 결과 문장만 받음)
for t in core.product_catalog core.product_activation_approvals core.leads; do
  if psql -X -q -At "$AUDIT_URL" -c "select count(*) from $t" >/dev/null 2>"$LOG_DIR/aud.err"; then
    echo "FAIL | X19 release_auditor read $t" | tee -a "$LOG_DIR/db-test.log"; exit 1
  fi
  grep -q 'permission denied' "$LOG_DIR/aud.err" || { echo "FAIL | X19 $t: $(cat "$LOG_DIR/aud.err")" | tee -a "$LOG_DIR/db-test.log"; exit 1; }
done
rm -f "$LOG_DIR/aud.err"
echo "NOTICE:  PASS | X19 점검 계정은 상품·승인·리드 테이블 직접 조회 불가(permission denied)" >> "$LOG_DIR/db-test.log"
audit_expect "X6 원상 복구 후 다시 0건" pass

echo "== future internal tables (commission/settlement) are locked automatically"
# 2단계에서 생길 수수료·정산 테이블을 흉내 낸 임시 테이블. zz_grants.sql을 다시 실행하면 자동으로 잠겨야 한다.
SQL "create table core.commissions_probe (offer_id uuid primary key, dealer_commission int not null)"
SQL "create table core.settlement_ledger_probe (id bigint generated always as identity primary key, amount int not null)"
SQL "insert into core.commissions_probe values (gen_random_uuid(), 150000)"
SQL "grant select on core.commissions_probe to public"      # 실수로 전체 공개한 상황까지 가정
"${PSQL[@]}" -d "$DB" -f db/migrations/zz_grants.sql >/dev/null
audit_expect "F1 수수료·정산 테이블 추가 후 권한 재적용 → 위반 0건" pass
for role in app_public app_staff; do
  for t in core.commissions_probe core.settlement_ledger_probe; do
    if psql -X -q -At -h "$SOCK" -p "$PORT" -U app_server -d "$DB" -v ON_ERROR_STOP=1 \
         -c "begin" -c "set local role $role" -c "select count(*) from $t" -c "commit" >/dev/null 2>"$LOG_DIR/probe.err"; then
      echo "FAIL | F2 $role read $t" | tee -a "$LOG_DIR/db-test.log"; exit 1
    fi
    grep -q 'permission denied' "$LOG_DIR/probe.err" || { echo "FAIL | F2 $role $t: $(cat "$LOG_DIR/probe.err")" | tee -a "$LOG_DIR/db-test.log"; exit 1; }
  done
done
echo "NOTICE:  PASS | F2 공개 고객·관리자 역할 모두 수수료·정산 테이블 조회 불가(permission denied)" >> "$LOG_DIR/db-test.log"
# F3 예외(코사장 11/27 결정 A): 대표 전용 정산 함수 2개만 정확히 허용. 그 밖의 api 함수는 여전히 0개여야 한다
F3_ALLOW="'api.settlement_record(uuid,uuid,text,uuid,text,integer,date)','api.contract_list(uuid,uuid,text,text)'"
leak=$("${PSQL[@]}" -d "$DB" -At -c "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'api' and p.prosrc ~* '(commission|settlement)' and p.oid::regprocedure::text not in ($F3_ALLOW)")
allow=$("${PSQL[@]}" -d "$DB" -At -c "select count(*) from pg_proc p where p.oid::regprocedure::text in ($F3_ALLOW) and p.prosecdef and pg_get_userbyid(p.proowner) = 'fideon_api' and p.prosrc ~ 'assert_staff\(p_actor, p_session, p_token, array\[''owner''\]\)' and not has_function_privilege('app_public', p.oid, 'execute')")
[ "$allow" = 2 ] || { echo "FAIL | F3a 예외 함수 2개가 대표 전용·소유자 fideon_api·공개 실행 불가가 아님: $allow" | tee -a "$LOG_DIR/db-test.log"; exit 1; }
echo "NOTICE:  PASS | F3a 예외는 대표 전용 정산 함수 2개뿐(owner 검증·fideon_api 소유·공개 역할 실행 불가)" >> "$LOG_DIR/db-test.log"
tbl=$("${PSQL[@]}" -d "$DB" -At -c "select count(*) from (values ('app_public'),('app_staff'),('app_ai'),('app_call'),('app_server')) r(role), (values ('core.settlements'),('core.lead_contracts')) t(tb) where has_table_privilege(r.role, t.tb, 'select,insert,update,delete')")
[ "$tbl" = 0 ] || { echo "FAIL | F3b 앱 역할이 정산·계약 표 직접 권한 보유: $tbl" | tee -a "$LOG_DIR/db-test.log"; exit 1; }
rls=$("${PSQL[@]}" -d "$DB" -At -c "select count(*) from pg_class where oid in ('core.settlements'::regclass, 'core.lead_contracts'::regclass) and relrowsecurity and relforcerowsecurity")
[ "$rls" = 2 ] || { echo "FAIL | F3c 정산·계약 표 강제 RLS 아님" | tee -a "$LOG_DIR/db-test.log"; exit 1; }
echo "NOTICE:  PASS | F3b·F3c 앱 역할 정산·계약 표 직접 권한 0, 강제 RLS 2/2" >> "$LOG_DIR/db-test.log"
if [ "$leak" = 0 ]; then
  echo "NOTICE:  PASS | F3 api 함수 중 수수료·정산 테이블을 읽는 함수 0개" >> "$LOG_DIR/db-test.log"
else
  echo "FAIL | F3 api functions referencing commission/settlement: $leak" | tee -a "$LOG_DIR/db-test.log"; exit 1
fi
SQL "drop table core.commissions_probe, core.settlement_ledger_probe"
rm -f "$LOG_DIR/probe.err"

echo "== concurrency: 정책 교체는 원자적(승인 커밋 전후로 게시 결과가 0건·2건이 되지 않음)"
ADM() { "${PSQL[@]}" -d "$DB" -At -c "$1"; }
as_role() { psql -X -q -At -h "$SOCK" -p "$PORT" -U app_server -d "$DB" -v ON_ERROR_STOP=1 -c "begin" -c "set local role $1" -c "$2" -c "commit" >/dev/null; }
pub() { psql -X -q -At -h "$SOCK" -p "$PORT" -U app_server -d "$DB" -v ON_ERROR_STOP=1 -c "begin" -c "set local role app_public" -c "select count(*) || ':' || coalesce(string_agg(p->>'version', ','), '') from api.policy_published() p where p->>'productId' = 'p5'" -c "commit" | grep -E '^[0-9]+:' | head -1; }
as_role app_staff "$(ADM "select test.pdraft('owner', p_product => 'p5')")"
ID1=$(ADM "select id from core.policy_versions where product_id = 'p5' and revision = 1")
as_role app_staff "$(ADM "select test.pcall('owner', 'policy_submit', '$ID1')")"
as_role app_staff "$(ADM "select test.pcall('owner', 'policy_approve', '$ID1', test.allchecks())")"
as_role app_staff "$(ADM "select test.pdraft('owner', p_product => 'p5')")"
ID2=$(ADM "select id from core.policy_versions where product_id = 'p5' and revision = 2")
as_role app_staff "$(ADM "select test.pcall('owner', 'policy_submit', '$ID2')")"
[ "$(pub)" = "1:r1" ] || { echo "FAIL | K5 준비: 교체 전 게시가 r1 한 건이 아님 ($(pub))" | tee -a "$LOG_DIR/db-test.log"; exit 1; }
APPROVE2=$(ADM "select test.pcall('owner', 'policy_approve', '$ID2', test.allchecks())")
( psql -X -q -At -h "$SOCK" -p "$PORT" -U app_server -d "$DB" -v ON_ERROR_STOP=1 -c "begin" -c "set local role app_staff" -c "$APPROVE2" -c "select pg_sleep(2)" -c "commit" > "$LOG_DIR/k5-approve.out" 2>&1 ) &
K5PID=$!
seen=""; bad=0
for n in $(seq 1 14); do
  r=$(pub); seen="$seen $r"
  case "$r" in 1:r1|1:r2) ;; *) bad=$((bad+1));; esac
  sleep 0.25
done
wait "$K5PID" || { echo "FAIL | K5 승인 세션 실패: $(cat "$LOG_DIR/k5-approve.out")" | tee -a "$LOG_DIR/db-test.log"; exit 1; }
final=$(pub)
if [ "$bad" = 0 ] && [ "$final" = "1:r2" ] && printf '%s' "$seen" | grep -q "1:r1"; then
  echo "NOTICE:  PASS | K5 정책 교체 중 게시 결과는 항상 1건(r1 → r2), 최종 r2. 관찰:$seen" >> "$LOG_DIR/db-test.log"
else
  echo "FAIL | K5 bad=$bad final=$final seen=$seen" | tee -a "$LOG_DIR/db-test.log"; exit 1
fi

echo "== migration drill: 0007·0008 적용(기존 데이터 보존) → 롤백(고지·정책 보관) → 복구 → 재적용 (별도 가상 DB)"
DRILL=fideon_drill
"${PSQL[@]}" -d postgres -c "drop database if exists $DRILL" -c "create database $DRILL" >/dev/null
D() { "${PSQL[@]}" -d "$DRILL" "$@"; }
for f in db/migrations/000[1-6]_*.sql; do D -f "$f" >/dev/null; done
D -f db/seed/test_seed.sql >/dev/null
CNT="select (select count(*) from core.leads) || '/' || (select count(*) from pii.customers) || '/' || (select count(*) from pii.consents)"
d_before=$(D -At -c "$CNT")
D -f db/migrations/0007_required_notices.sql >/dev/null
D -f db/migrations/0008_policy_store.sql >/dev/null
D -f db/migrations/0009_policy_list.sql >/dev/null
d_after=$(D -At -c "$CNT")
[ "$d_before" = "$d_after" ] || { echo "FAIL | M1 0007·0008 적용 뒤 기존 데이터 건수 변화 $d_before → $d_after" | tee -a "$LOG_DIR/db-test.log"; exit 1; }
echo "NOTICE:  PASS | M1 0007·0008 적용 뒤 기존 리드·고객·동의 건수 그대로 ($d_after)" >> "$LOG_DIR/db-test.log"
# 고지·정책 기록을 만들어 롤백 때 보존되는지 본다(가상 값)
D -f db/seed/test_notices.sql >/dev/null
D -q -c "insert into pii.notice_exposures (customer_id, doc_version, notice_key, body_sha256, channel)
         select '20000000-0000-4000-8000-000000000001', n.version, n.notice_key, n.body_sha256, 'web' from core.notice_texts n"
D -q -c "insert into core.policy_versions (supplier_id, segment, carrier, product_id, category, revision, state, source_kind, confirmed_at, valid_from, valid_until, product_label, terms, content_hash, created_by)
         values ('supplier-a', 'household', 'carrier-x', 'p1', 'internet_tv', 1, 'draft', 'official_policy_sheet', now(), now(), now() + interval '1 day', '가상',
           '{\"monthlyFee\":{\"known\":false},\"contractMonths\":{\"known\":false},\"equipmentMonthlyFee\":{\"known\":false},\"installFee\":{\"known\":false},\"bundlePrerequisites\":{\"known\":false},\"regionScope\":{\"known\":false},\"customerBenefit\":{\"known\":false}}'::jsonb,
           repeat('a', 64), '00000000-0000-4000-8000-000000000001')"
n_exp=$(D -At -c "select count(*) from pii.notice_exposures"); n_pol=$(D -At -c "select count(*) from core.policy_versions")
D -f db/rollback/0009_down.sql >/dev/null
D -f db/rollback/0008_down.sql >/dev/null
D -f db/rollback/0007_down.sql >/dev/null
d_down=$(D -At -c "$CNT")
[ "$d_before" = "$d_down" ] || { echo "FAIL | M2 롤백 뒤 기존 데이터 건수 변화 $d_before → $d_down" | tee -a "$LOG_DIR/db-test.log"; exit 1; }
gone=$(D -At -c "select (to_regclass('core.notice_texts') is null and to_regclass('pii.notice_exposures') is null and to_regclass('core.policy_versions') is null)::text")
[ "$gone" = true ] || { echo "FAIL | M3 롤백 뒤 새 테이블이 남음" | tee -a "$LOG_DIR/db-test.log"; exit 1; }
d_md5=$(D -At -c "select md5(prosrc) from pg_proc where oid = '$CREATE_LEAD_SIG'::regprocedure")
[ "$d_md5" = "a99eddfc2884a4e7e588925a5664c811" ] || { echo "FAIL | M4 롤백 뒤 create_lead가 0004 본문이 아님 ($d_md5)" | tee -a "$LOG_DIR/db-test.log"; exit 1; }
a_exp=$(D -At -c "select count(*) from pii.notice_exposures_rollback_archive"); a_pol=$(D -At -c "select count(*) from core.policy_versions_rollback_archive")
[ "$a_exp" = "$n_exp" ] && [ "$a_pol" = "$n_pol" ] && [ "$n_exp" -gt 0 ] || { echo "FAIL | M6 롤백 보관본 건수 불일치 exp $n_exp/$a_exp pol $n_pol/$a_pol" | tee -a "$LOG_DIR/db-test.log"; exit 1; }
echo "NOTICE:  PASS | M2~M4·M6 롤백: 기존 데이터 보존, 새 테이블 제거, create_lead 0004 본문, 고지 노출 $a_exp건·정책 $a_pol건 보관" >> "$LOG_DIR/db-test.log"
prot=$(D -At -c "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where (n.nspname, c.relname) in (('core', 'notice_texts_rollback_archive'), ('pii', 'notice_exposures_rollback_archive'), ('core', 'policy_versions_rollback_archive'))
    and c.relrowsecurity and c.relforcerowsecurity")
open_priv=$(D -At -c "select count(*) from (values ('core.notice_texts_rollback_archive'), ('pii.notice_exposures_rollback_archive'), ('core.policy_versions_rollback_archive')) t(r)
  cross join (values ('public'), ('app_public'), ('app_staff'), ('app_server')) g(role)
  where has_table_privilege(g.role, t.r, 'SELECT')")
[ "$prot" = 3 ] && [ "$open_priv" = 0 ] || { echo "FAIL | M9 보관 테이블 보호 RLS=$prot/3 앱 역할 조회 가능=$open_priv" | tee -a "$LOG_DIR/db-test.log"; exit 1; }
echo "NOTICE:  PASS | M9 보관 테이블 3개 RLS enable+force, PUBLIC·앱 역할 조회 불가" >> "$LOG_DIR/db-test.log"
if D -q -f db/rollback/0007_down.sql >/dev/null 2>&1; then echo "FAIL | M7 보관본이 있는데 롤백이 다시 성공(덮어쓰기)" | tee -a "$LOG_DIR/db-test.log"; exit 1; fi
echo "NOTICE:  PASS | M7 보관본이 있으면 롤백이 실패(덮어쓰지 않음)" >> "$LOG_DIR/db-test.log"
D -f db/migrations/0007_required_notices.sql >/dev/null
D -f db/migrations/0008_policy_store.sql >/dev/null
D -f db/migrations/0009_policy_list.sql >/dev/null
D -f db/migrations/0061_crm_unify.sql >/dev/null   # create_lead 최신 검수본(0061)으로 되돌림
D -q -f db/rollback/0007_restore.sql >/dev/null
D -q -f db/rollback/0008_restore.sql >/dev/null
r_exp=$(D -At -c "select count(*) from pii.notice_exposures"); r_pol=$(D -At -c "select count(*) from core.policy_versions")
[ "$r_exp" = "$n_exp" ] && [ "$r_pol" = "$n_pol" ] || { echo "FAIL | M8 복구 건수 불일치 exp $n_exp/$r_exp pol $n_pol/$r_pol" | tee -a "$LOG_DIR/db-test.log"; exit 1; }
d_re=$(D -At -c "select md5(prosrc) from pg_proc where oid = '$CREATE_LEAD_SIG'::regprocedure")
[ "$d_re" = "$PINNED_CREATE_LEAD_MD5" ] || { echo "FAIL | M5 재적용 뒤 create_lead 본문이 고정 해시와 다름" | tee -a "$LOG_DIR/db-test.log"; exit 1; }
echo "NOTICE:  PASS | M5·M8 재적용·복구: 고지 노출 $r_exp건·정책 $r_pol건 되살림, create_lead 고정 해시 일치" >> "$LOG_DIR/db-test.log"
# 0010 광고 예산 통제: 적용 → 승인·지출 기록 → 롤백(보관) → 복구
D -f db/migrations/0010_ad_budget.sql >/dev/null
D -q -c "insert into core.ad_budget_approvals (id, campaign_key, daily_cap_krw, total_cap_krw, valid_from, valid_until, approved_by, reason)
         values ('50000000-0000-4000-8000-000000000001', 'drill-camp', 5000, 9000, now(), now() + interval '1 day', '00000000-0000-4000-8000-000000000001', '가상')"
D -q -c "insert into core.ad_spend_ledger (campaign_key, approval_id, spend_date, amount_krw, request_key, recorded_by)
         values ('drill-camp', '50000000-0000-4000-8000-000000000001', current_date, 1234, 'drill-req-0000000001', '00000000-0000-4000-8000-000000000001')"
D -f db/rollback/0010_down.sql >/dev/null
gone10=$(D -At -c "select (to_regclass('core.ad_budget_approvals') is null and to_regclass('core.ad_spend_ledger') is null)::text")
a10=$(D -At -c "select (select count(*) from core.ad_budget_approvals_rollback_archive) || '/' || (select coalesce(sum(amount_krw), 0) from core.ad_spend_ledger_rollback_archive)")
prot10=$(D -At -c "select count(*) from pg_class c where c.oid in ('core.ad_budget_approvals_rollback_archive'::regclass, 'core.ad_spend_ledger_rollback_archive'::regclass) and c.relrowsecurity and c.relforcerowsecurity")
open10=$(D -At -c "select count(*) from (values ('core.ad_budget_approvals_rollback_archive'), ('core.ad_spend_ledger_rollback_archive')) t(r) cross join (values ('public'), ('app_public'), ('app_staff'), ('app_server')) g(role) where has_table_privilege(g.role, t.r, 'SELECT')")
[ "$gone10" = true ] && [ "$a10" = "1/1234" ] && [ "$prot10" = 2 ] && [ "$open10" = 0 ] || { echo "FAIL | M10 0010 롤백 gone=$gone10 보관=$a10 RLS=$prot10 열림=$open10" | tee -a "$LOG_DIR/db-test.log"; exit 1; }
if D -q -f db/rollback/0010_down.sql >/dev/null 2>&1; then echo "FAIL | M10b 0010 보관본이 있는데 롤백이 다시 성공" | tee -a "$LOG_DIR/db-test.log"; exit 1; fi
D -f db/migrations/0010_ad_budget.sql >/dev/null
D -q -f db/rollback/0010_restore.sql >/dev/null
r10=$(D -At -c "select (select count(*) from core.ad_budget_approvals) || '/' || (select coalesce(sum(amount_krw), 0) from core.ad_spend_ledger)")
[ "$r10" = "1/1234" ] || { echo "FAIL | M10c 0010 복구 건수 불일치 $r10" | tee -a "$LOG_DIR/db-test.log"; exit 1; }
echo "NOTICE:  PASS | M10 광고 예산 0010 롤백: 승인·원장 보관(1건/1,234원), 새 테이블 제거, 보관본 RLS·접근 차단, 덮어쓰기 거부, 재적용·복구 일치" >> "$LOG_DIR/db-test.log"
# 0011 광고 성과·AI 사용료: 적용 → 기록 → 롤백(보관) → 복구
D -f db/migrations/0011_ad_performance_ai_usage.sql >/dev/null
D -q -c "insert into core.ad_performance (campaign_key, day, impressions, clicks, cost_krw, source, over_ledger, recorded_by)
         values ('drill-camp', current_date, 900, 30, 321, 'mock', false, '00000000-0000-4000-8000-000000000001')"
D -q -c "insert into core.ai_usage_ledger (month, cost_krw) values ('2026-11', 7)"
D -q -c "update core.ai_budget_config set monthly_limit_krw = 40 where singleton"
D -f db/rollback/0011_down.sql >/dev/null
gone11=$(D -At -c "select (to_regclass('core.ad_performance') is null and to_regclass('core.ai_usage_ledger') is null and to_regclass('core.ai_budget_config') is null and to_regprocedure('api.ai_budget_reserve(int)') is null)::text")
a11=$(D -At -c "select (select count(*) from core.ad_performance_rollback_archive) || '/' || (select coalesce(sum(cost_krw), 0) from core.ai_usage_ledger_rollback_archive) || '/' || (select monthly_limit_krw from core.ai_budget_config_rollback_archive)")
prot11=$(D -At -c "select count(*) from pg_class c where c.oid in ('core.ad_performance_rollback_archive'::regclass, 'core.ai_usage_ledger_rollback_archive'::regclass, 'core.ai_budget_config_rollback_archive'::regclass) and c.relrowsecurity and c.relforcerowsecurity")
open11=$(D -At -c "select count(*) from (values ('core.ad_performance_rollback_archive'), ('core.ai_usage_ledger_rollback_archive'), ('core.ai_budget_config_rollback_archive')) t(r) cross join (values ('public'), ('app_public'), ('app_staff'), ('app_server'), ('app_ai')) g(role) where has_table_privilege(g.role, t.r, 'SELECT')")
[ "$gone11" = true ] && [ "$a11" = "1/7/40" ] && [ "$prot11" = 3 ] && [ "$open11" = 0 ] || { echo "FAIL | M11 0011 롤백 gone=$gone11 보관=$a11 RLS=$prot11 열림=$open11" | tee -a "$LOG_DIR/db-test.log"; exit 1; }
if D -q -f db/rollback/0011_down.sql >/dev/null 2>&1; then echo "FAIL | M11b 0011 보관본이 있는데 롤백이 다시 성공" | tee -a "$LOG_DIR/db-test.log"; exit 1; fi
D -f db/migrations/0011_ad_performance_ai_usage.sql >/dev/null
D -q -f db/rollback/0011_restore.sql >/dev/null
r11=$(D -At -c "select (select count(*) from core.ad_performance) || '/' || (select coalesce(sum(cost_krw), 0) from core.ai_usage_ledger) || '/' || (select monthly_limit_krw from core.ai_budget_config)")
[ "$r11" = "1/7/40" ] || { echo "FAIL | M11c 0011 복구 건수 불일치 $r11" | tee -a "$LOG_DIR/db-test.log"; exit 1; }
echo "NOTICE:  PASS | M11 광고 성과·AI 사용료 0011 롤백: 성과 1건·사용 7원·한도 40원 보관, 새 객체 제거, 보관본 RLS·접근 차단, 덮어쓰기 거부, 재적용·복구 일치" >> "$LOG_DIR/db-test.log"
# 0012 상담 집계·AI 정산: 적용 → 기록 → 롤백(보관, ai_budget_reserve는 0011 정의로) → 복구
D -f db/migrations/0012_consult_events_ai_confirm.sql >/dev/null
D -q -c "insert into core.consult_events (session_key, campaign_key) values ('drill-session-000000001', 'drill-camp')"
D -q -c "insert into core.ai_usage_ledger (month, cost_krw) values ('2026-11', 9)"
D -q -c "insert into core.ai_usage_closures (reservation_id, kind, actual_cost_krw) select max(id), 'confirm', 4 from core.ai_usage_ledger"
D -f db/rollback/0012_down.sql >/dev/null
gone12=$(D -At -c "select (to_regclass('core.consult_events') is null and to_regclass('core.ai_usage_closures') is null and to_regprocedure('api.ai_budget_hold(int)') is null and to_regprocedure('api.ai_budget_reserve(int)') is not null)::text")
a12=$(D -At -c "select (select count(*) from core.consult_events_rollback_archive) || '/' || (select sum(actual_cost_krw) from core.ai_usage_closures_rollback_archive)")
prot12=$(D -At -c "select count(*) from pg_class c where c.oid in ('core.consult_events_rollback_archive'::regclass, 'core.ai_usage_closures_rollback_archive'::regclass) and c.relrowsecurity and c.relforcerowsecurity")
open12=$(D -At -c "select count(*) from (values ('core.consult_events_rollback_archive'), ('core.ai_usage_closures_rollback_archive')) t(r) cross join (values ('public'), ('app_public'), ('app_staff'), ('app_server'), ('app_ai')) g(role) where has_table_privilege(g.role, t.r, 'SELECT')")
[ "$gone12" = true ] && [ "$a12" = "1/4" ] && [ "$prot12" = 2 ] && [ "$open12" = 0 ] || { echo "FAIL | M12 0012 롤백 gone=$gone12 보관=$a12 RLS=$prot12 열림=$open12" | tee -a "$LOG_DIR/db-test.log"; exit 1; }
if D -q -f db/rollback/0012_down.sql >/dev/null 2>&1; then echo "FAIL | M12b 0012 보관본이 있는데 롤백이 다시 성공" | tee -a "$LOG_DIR/db-test.log"; exit 1; fi
D -f db/migrations/0012_consult_events_ai_confirm.sql >/dev/null
D -q -f db/rollback/0012_restore.sql >/dev/null
r12=$(D -At -c "select (select count(*) from core.consult_events) || '/' || (select sum(actual_cost_krw) from core.ai_usage_closures)")
[ "$r12" = "1/4" ] || { echo "FAIL | M12c 0012 복구 건수 불일치 $r12" | tee -a "$LOG_DIR/db-test.log"; exit 1; }
echo "NOTICE:  PASS | M12 상담 집계·AI 정산 0012 롤백: 상담 1건·정산 4원 보관, 새 객체 제거·예약 함수 0011로 복귀, 보관본 RLS·접근 차단, 덮어쓰기 거부, 재적용·복구 일치" >> "$LOG_DIR/db-test.log"
# 0013 광고 중지 경고·AI 한도: 적용 → 경고 기록 → 롤백(보관, 승인·지출 판정은 0010 정의로) → 복구
D -f db/migrations/0013_ad_alerts_ai_limit.sql >/dev/null
D -q -c "insert into core.ad_alerts (id, campaign_key, kind, detail, created_by) values ('50000000-0000-4000-8000-0000000000a1', 'drill-camp', 'stop_failed', '{\"paused\": false}', '00000000-0000-4000-8000-000000000001')"
D -f db/rollback/0013_down.sql >/dev/null
gone13=$(D -At -c "select (to_regclass('core.ad_alerts') is null and to_regprocedure('api.ad_alert_open(uuid,uuid,text,text,jsonb)') is null and to_regprocedure('api.ai_budget_limit_set(uuid,uuid,text,int,text)') is null and to_regprocedure('api.ad_spend_request(uuid,uuid,text,text,int,text)') is not null and (select prosrc not like '%ad_alerts%' from pg_proc where oid = 'api.ad_spend_request(uuid,uuid,text,text,int,text)'::regprocedure))::text")
a13=$(D -At -c "select count(*) from core.ad_alerts_rollback_archive")
prot13=$(D -At -c "select count(*) from pg_class c where c.oid = 'core.ad_alerts_rollback_archive'::regclass and c.relrowsecurity and c.relforcerowsecurity")
open13=$(D -At -c "select count(*) from (values ('public'), ('app_public'), ('app_staff'), ('app_server'), ('app_ai')) g(role) where has_table_privilege(g.role, 'core.ad_alerts_rollback_archive', 'SELECT')")
[ "$gone13" = true ] && [ "$a13" = 1 ] && [ "$prot13" = 1 ] && [ "$open13" = 0 ] || { echo "FAIL | M13 0013 롤백 gone=$gone13 보관=$a13 RLS=$prot13 열림=$open13" | tee -a "$LOG_DIR/db-test.log"; exit 1; }
if D -q -f db/rollback/0013_down.sql >/dev/null 2>&1; then echo "FAIL | M13b 0013 보관본이 있는데 롤백이 다시 성공" | tee -a "$LOG_DIR/db-test.log"; exit 1; fi
D -f db/migrations/0013_ad_alerts_ai_limit.sql >/dev/null
D -q -f db/rollback/0013_restore.sql >/dev/null
r13=$(D -At -c "select count(*) from core.ad_alerts where state = 'open'")
[ "$r13" = 1 ] || { echo "FAIL | M13c 0013 복구 건수 불일치 $r13" | tee -a "$LOG_DIR/db-test.log"; exit 1; }
echo "NOTICE:  PASS | M13 중지 경고·AI 한도 0013 롤백: 경고 1건 보관, 새 객체 제거·승인/지출 판정 0010으로 복귀, 보관본 RLS·접근 차단, 덮어쓰기 거부, 재적용·복구 일치" >> "$LOG_DIR/db-test.log"
# 0014 정책 게시·고지 문구 관리: 적용 → 롤백(함수만 제거, 스위치·문구·감사는 남음) → 재적용
D -f db/migrations/0014_policy_publish_notice_texts.sql >/dev/null
D -q -c "insert into core.notice_texts (version, notice_key, body, body_sha256) values ('drill-v1', 'drill_key', '드릴 문구', repeat('0', 64))"
D -f db/rollback/0014_down.sql >/dev/null
gone14=$(D -At -c "select (to_regprocedure('api.policy_publish_set(uuid,uuid,text,boolean,text)') is null and to_regprocedure('api.policy_publish_get(uuid,uuid,text)') is null and to_regprocedure('api.notice_text_add(uuid,uuid,text,text,text,text,text)') is null and to_regprocedure('api.notice_text_list(uuid,uuid,text)') is null)")
keep14=$(D -At -c "select count(*) from core.notice_texts where version = 'drill-v1'")
D -f db/migrations/0014_policy_publish_notice_texts.sql >/dev/null
back14=$(D -At -c "select (to_regprocedure('api.policy_publish_set(uuid,uuid,text,boolean,text)') is not null and to_regprocedure('api.notice_text_add(uuid,uuid,text,text,text,text,text)') is not null)")
[ "$gone14" = t ] && [ "$keep14" = 1 ] && [ "$back14" = t ] || { echo "FAIL | M14 0014 롤백 gone=$gone14 문구보존=$keep14 재적용=$back14" | tee -a "$LOG_DIR/db-test.log"; exit 1; }
echo "NOTICE:  PASS | M14 정책 게시·고지 문구 0014 롤백: 함수 5개 제거, 이미 넣은 고지 문구(추가 전용)는 보존, 재적용 일치" >> "$LOG_DIR/db-test.log"
# 0015 고지 검수 기록: 적용 → 롤백(함수만 제거, 검수 기록·감사는 남음) → 재적용
D -f db/migrations/0015_notice_reviews.sql >/dev/null
D -q -c "insert into core.notice_reviews (version, decision, checks, texts_sha256, reason, reviewer_id) values ('drill-v1', 'rejected', '{}'::jsonb, repeat('a', 64), '드릴', gen_random_uuid())"
D -f db/rollback/0015_down.sql >/dev/null
gone15=$(D -At -c "select (to_regprocedure('api.notice_review_add(uuid,uuid,text,text,jsonb,text,text)') is null and to_regprocedure('api.notice_review_list(uuid,uuid,text)') is null)")
keep15=$(D -At -c "select count(*) from core.notice_reviews where version = 'drill-v1'")
D -f db/migrations/0015_notice_reviews.sql >/dev/null
back15=$(D -At -c "select (to_regprocedure('api.notice_review_add(uuid,uuid,text,text,jsonb,text,text)') is not null and to_regprocedure('api.notice_review_list(uuid,uuid,text)') is not null)")
[ "$gone15" = t ] && [ "$keep15" = 1 ] && [ "$back15" = t ] || { echo "FAIL | M15 0015 롤백 gone=$gone15 기록보존=$keep15 재적용=$back15" | tee -a "$LOG_DIR/db-test.log"; exit 1; }
echo "NOTICE:  PASS | M15 고지 검수 0015 롤백: 함수 2개 제거, 이미 남긴 검수 기록(추가 전용)은 보존, 재적용 일치" >> "$LOG_DIR/db-test.log"
# 0016 접수 직전 고지 게이트: 적용 → 롤백(함수만 제거) → 재적용
D -f db/migrations/0016_notice_intake_gate.sql >/dev/null
D -f db/rollback/0016_down.sql >/dev/null
gone16=$(D -At -c "select to_regprocedure('api.notice_intake_gate(text,jsonb)') is null")
D -f db/migrations/0016_notice_intake_gate.sql >/dev/null
back16=$(D -At -c "select to_regprocedure('api.notice_intake_gate(text,jsonb)') is not null")
[ "$gone16" = t ] && [ "$back16" = t ] || { echo "FAIL | M16 0016 롤백 gone=$gone16 재적용=$back16" | tee -a "$LOG_DIR/db-test.log"; exit 1; }
echo "NOTICE:  PASS | M16 접수 직전 고지 게이트 0016 롤백: 함수 제거, 재적용 일치" >> "$LOG_DIR/db-test.log"
# 0017 총판 전달용 신청서: 적용 → 롤백(함수만 제거, 암호화 신청서·전달 이력은 남음) → 재적용
D -f db/migrations/0017_dealer_application.sql >/dev/null
D -f db/rollback/0017_down.sql >/dev/null
gone17=$(D -At -c "select (to_regprocedure('api.application_save(text,text,text,text)') is null and to_regprocedure('api.dealer_packet_get(uuid,uuid,text,uuid,text)') is null and to_regprocedure('api.handoff_record(uuid,uuid,text,uuid,text,text)') is null and to_regprocedure('api.handoff_list(uuid,uuid,text,uuid)') is null and to_regprocedure('api.dealer_packet_status(uuid,uuid,text,uuid)') is null)")
keep17=$(D -At -c "select (to_regclass('pii.lead_applications') is not null and to_regclass('core.dealer_handoffs') is not null)")
D -f db/migrations/0017_dealer_application.sql >/dev/null
back17=$(D -At -c "select (to_regprocedure('api.application_save(text,text,text,text)') is not null and to_regprocedure('api.handoff_list(uuid,uuid,text,uuid)') is not null)")
[ "$gone17" = t ] && [ "$keep17" = t ] && [ "$back17" = t ] || { echo "FAIL | M17 0017 롤백 gone=$gone17 테이블보존=$keep17 재적용=$back17" | tee -a "$LOG_DIR/db-test.log"; exit 1; }
echo "NOTICE:  PASS | M17 총판 전달용 신청서 0017 롤백: 함수 5개 제거, 저장된 신청서·전달 이력 테이블 보존, 재적용 일치" >> "$LOG_DIR/db-test.log"
# 0018 광고 launch 상태: 적용 → 기록 1건 → 롤백(함수 5개·테이블 제거, 보관 1건) → 재적용 → 복구(1건)
D -f db/migrations/0018_ad_launches.sql >/dev/null
D -q -c "insert into core.ad_launches (campaign_key, request_key, amount_krw, state, external_id, created_by) values ('camp-m18', 'req-m18-0123456789', 1000, 'active', 'ext-m18', gen_random_uuid())" >/dev/null
D -f db/rollback/0018_down.sql >/dev/null
gone18=$(D -At -c "select (to_regprocedure('api.ad_launch_begin(uuid,uuid,text,text,text,int)') is null and to_regprocedure('api.ad_launch_finish(uuid,uuid,text,text,text,text,text)') is null and to_regprocedure('api.ad_launch_active(uuid,uuid,text,text)') is null and to_regprocedure('api.ad_launch_paused(uuid,uuid,text,text)') is null and to_regprocedure('api.ad_launch_resolve(uuid,uuid,text,text,text,text,text)') is null and to_regclass('core.ad_launches') is null)")
arch18=$(D -At -c "select count(*) from core.ad_launches_rollback_archive")
D -f db/migrations/0018_ad_launches.sql >/dev/null
D -f db/rollback/0018_restore.sql >/dev/null
back18=$(D -At -c "select count(*) from core.ad_launches where request_key = 'req-m18-0123456789'")
[ "$gone18" = t ] && [ "$arch18" = 1 ] && [ "$back18" = 1 ] || { echo "FAIL | M18 0018 롤백 gone=$gone18 보관=$arch18 복구=$back18" | tee -a "$LOG_DIR/db-test.log"; exit 1; }
echo "NOTICE:  PASS | M18 광고 launch 상태 0018 롤백: 함수 5개·테이블 제거, 기록 보관, 재적용·복구 일치" >> "$LOG_DIR/db-test.log"
# 0019 재접수 변경 요청: 적용 → 함수 2개·테이블 제거(보관) → 재적용 → 복구
D -f db/migrations/0019_lead_amendments.sql >/dev/null
D -f db/rollback/0019_down.sql >/dev/null
gone19=$(D -At -c "select (to_regprocedure('api.application_amend(text,text,text,text,text,text)') is null and to_regprocedure('api.application_amendments(uuid,uuid,text,uuid)') is null and to_regclass('pii.lead_amendments') is null and to_regclass('pii.lead_amendments_rollback_archive') is not null)")
D -f db/migrations/0019_lead_amendments.sql >/dev/null
D -f db/rollback/0019_restore.sql >/dev/null
back19=$(D -At -c "select (to_regprocedure('api.application_amend(text,text,text,text,text,text)') is not null and to_regclass('pii.lead_amendments') is not null)")
[ "$gone19" = t ] && [ "$back19" = t ] || { echo "FAIL | M19 0019 롤백 gone=$gone19 복구=$back19" | tee -a "$LOG_DIR/db-test.log"; exit 1; }
echo "NOTICE:  PASS | M19 재접수 변경 요청 0019 롤백: 함수 2개·테이블 제거(보관), 재적용·복구" >> "$LOG_DIR/db-test.log"
# 0020 계정 합산 광고 한도: 적용 → 롤백(0013 정의 복원) → 재적용
D -f db/migrations/0020_ad_account_caps.sql >/dev/null
has20() { D -At -c "select position('ACCOUNT_DAILY_CAP_EXCEEDED' in prosrc) > 0 from pg_proc where oid = 'api.ad_spend_request(uuid,uuid,text,text,int,text)'::regprocedure"; }
on20=$(has20); D -f db/rollback/0020_down.sql >/dev/null; off20=$(has20); D -f db/migrations/0020_ad_account_caps.sql >/dev/null; back20=$(has20)
[ "$on20" = t ] && [ "$off20" = f ] && [ "$back20" = t ] || { echo "FAIL | M20 0020 롤백 적용=$on20 롤백=$off20 재적용=$back20" | tee -a "$LOG_DIR/db-test.log"; exit 1; }
echo "NOTICE:  PASS | M20 계정 합산 광고 한도 0020 롤백: 0013 정의 복원, 재적용 일치" >> "$LOG_DIR/db-test.log"
# 0021 집행 기간·정기 감시: 적용 → 롤백(함수 4개 제거, 0020·0011 복원, 기록 테이블 보존) → 재적용
D -f db/migrations/0021_ad_window_monitor.sql >/dev/null
D -f db/rollback/0021_down.sql >/dev/null
gone21=$(D -At -c "select (to_regprocedure('api.ad_spend_request_window(uuid,uuid,text,text,int,text)') is null and to_regprocedure('api.ad_monitor_stop(text,text,boolean)') is null and to_regclass('core.ad_exposure') is not null and position('ad_exposure' in (select prosrc from pg_proc where oid = 'api.ad_performance_record(uuid,uuid,text,text,date,int,int,int,text)'::regprocedure)) = 0)")
D -f db/migrations/0021_ad_window_monitor.sql >/dev/null
back21=$(D -At -c "select (to_regprocedure('api.ad_spend_request_window(uuid,uuid,text,text,int,text)') is not null and to_regprocedure('api.ad_monitor_record(boolean,jsonb)') is not null)")
[ "$gone21" = t ] && [ "$back21" = t ] || { echo "FAIL | M21 0021 롤백 gone=$gone21 재적용=$back21" | tee -a "$LOG_DIR/db-test.log"; exit 1; }
echo "NOTICE:  PASS | M21 집행 기간·정기 감시 0021 롤백: 함수 4개 제거·0020/0011 복원·기록 보존, 재적용 일치" >> "$LOG_DIR/db-test.log"
# 0022 감시 중복 실행 방지: 적용 → 롤백(함수 제거, 시작 기록 보존) → 재적용
D -f db/migrations/0022_ad_monitor_lease.sql >/dev/null
D -f db/rollback/0022_down.sql >/dev/null
gone22=$(D -At -c "select (to_regprocedure('api.ad_monitor_begin(uuid)') is null and to_regclass('core.ad_monitor_leases') is not null)")
D -f db/migrations/0022_ad_monitor_lease.sql >/dev/null
back22=$(D -At -c "select to_regprocedure('api.ad_monitor_begin(uuid)') is not null")
[ "$gone22" = t ] && [ "$back22" = t ] || { echo "FAIL | M22 0022 롤백 gone=$gone22 재적용=$back22" | tee -a "$LOG_DIR/db-test.log"; exit 1; }
echo "NOTICE:  PASS | M22 감시 중복 실행 방지 0022 롤백: 함수 제거·시작 기록 보존, 재적용 일치" >> "$LOG_DIR/db-test.log"
# 0023 대표 직접 연락 동의: 적용 → 롤백(함수 제거, 기록 보존) → 재적용
D -f db/migrations/0023_lead_followups.sql >/dev/null
D -f db/rollback/0023_down.sql >/dev/null
gone23=$(D -At -c "select (to_regprocedure('api.followup_request(text,text,text,text)') is null and to_regprocedure('api.followup_list(uuid,uuid,text)') is null and to_regclass('core.lead_followups') is not null)")
D -f db/migrations/0023_lead_followups.sql >/dev/null
back23=$(D -At -c "select to_regprocedure('api.followup_done(uuid,uuid,text,uuid)') is not null")
[ "$gone23" = t ] && [ "$back23" = t ] || { echo "FAIL | M23 0023 롤백 gone=$gone23 재적용=$back23" | tee -a "$LOG_DIR/db-test.log"; exit 1; }
echo "NOTICE:  PASS | M23 대표 직접 연락 동의 0023 롤백: 함수 제거·기록 보존, 재적용 일치" >> "$LOG_DIR/db-test.log"
# 0060 날짜별 재연락·수신 거부: 적용 → 롤백(함수 제거, 기록 보존) → 재적용
D -f db/migrations/0060_recontact_schedule.sql >/dev/null
D -f db/rollback/0060_down.sql >/dev/null
gone60=$(D -At -c "select (to_regprocedure('api.recontact_schedule(uuid,uuid,text,uuid,date,text)') is null and to_regprocedure('api.marketing_opt_out(text,text,text)') is null and to_regclass('core.recontact_schedule') is not null)")
D -f db/migrations/0060_recontact_schedule.sql >/dev/null
back60=$(D -At -c "select to_regprocedure('api.recontact_sweep(uuid,uuid,text)') is not null")
[ "$gone60" = t ] && [ "$back60" = t ] || { echo "FAIL | M60 0060 롤백 gone=$gone60 재적용=$back60" | tee -a "$LOG_DIR/db-test.log"; exit 1; }
echo "NOTICE:  PASS | M60 날짜별 재연락 0060 롤백: 함수 제거·기록 보존, 재적용 일치" >> "$LOG_DIR/db-test.log"
# 0061 CRM 통합: 롤백(새 함수 제거·이전 정의 복원) → 재적용
D -f db/rollback/0061_down.sql >/dev/null
gone61=$(D -At -c "select to_regprocedure('api.crm_unhandled(uuid,uuid,text)') is null and position('0061' in pg_get_functiondef('api.create_lead(text,text,text,text,text,text,text,text,text,text,text,text,text,boolean,boolean,text)'::regprocedure)) = 0")
D -f db/migrations/0061_crm_unify.sql >/dev/null
back61=$(D -At -c "select position('0061' in pg_get_functiondef('api.create_lead(text,text,text,text,text,text,text,text,text,text,text,text,text,boolean,boolean,text)'::regprocedure)) > 0 and to_regprocedure('api.crm_unhandled(uuid,uuid,text)') is not null")
[ "$gone61" = t ] && [ "$back61" = t ] || { echo "FAIL | M61 0061 롤백 gone=$gone61 재적용=$back61" | tee -a "$LOG_DIR/db-test.log"; exit 1; }
echo "NOTICE:  PASS | M61 CRM 통합 0061 롤백: 새 함수 제거·이전 정의 복원, 재적용 일치" >> "$LOG_DIR/db-test.log"
# 0062 파기 범위: 롤백(신청 파기 함수 제거·0002 정의 복원) → 재적용
D -f db/rollback/0062_down.sql >/dev/null
gone62=$(D -At -c "select to_regprocedure('api.purge_lead(uuid,uuid,text,uuid,text)') is null and position('LEGAL_HOLD' in pg_get_functiondef('api.purge_customer(uuid,uuid,text,uuid,text)'::regprocedure)) = 0")
D -f db/migrations/0062_purge_scope.sql >/dev/null
back62=$(D -At -c "select to_regprocedure('api.purge_lead(uuid,uuid,text,uuid,text)') is not null and position('LEGAL_HOLD' in pg_get_functiondef('api.purge_customer(uuid,uuid,text,uuid,text)'::regprocedure)) > 0")
[ "$gone62" = t ] && [ "$back62" = t ] || { echo "FAIL | M62 0062 롤백 gone=$gone62 재적용=$back62" | tee -a "$LOG_DIR/db-test.log"; exit 1; }
echo "NOTICE:  PASS | M62 파기 범위 0062 롤백: 함수 제거·0002 복원, 재적용 일치" >> "$LOG_DIR/db-test.log"
# 0063 메모 파기·보존 분리: 롤백(보존 판정 제거·0002/0062 복원) → 재적용
D -f db/rollback/0063_down.sql >/dev/null
gone63=$(D -At -c "select to_regprocedure('core.legal_hold(uuid)') is null and position('lead_notes' in pg_get_functiondef('core.purge_lead_internal(uuid,uuid,text)'::regprocedure)) = 0")
D -f db/migrations/0063_purge_notes_retention.sql >/dev/null
back63=$(D -At -c "select to_regprocedure('core.legal_hold(uuid)') is not null and position('lead_notes' in pg_get_functiondef('core.purge_customer_internal(uuid,uuid,text)'::regprocedure)) > 0")
[ "$gone63" = t ] && [ "$back63" = t ] || { echo "FAIL | M63 0063 롤백 gone=$gone63 재적용=$back63" | tee -a "$LOG_DIR/db-test.log"; exit 1; }
echo "NOTICE:  PASS | M63 메모 파기·보존 분리 0063 롤백: 함수 제거·이전 복원, 재적용 일치" >> "$LOG_DIR/db-test.log"
# 0070 광고성 전화 기록: 적용 → 기록 → 롤백(함수 6개만 제거, 표·기록·추가 전용 트리거 보존) → 재적용(기록 그대로)
D -f db/migrations/0070_outbound_persistence.sql >/dev/null
pub70=$(D -At -c "select count(*) from pg_proc p where p.pronamespace = 'api'::regnamespace and p.proname like 'outbound\_%' and (p.proacl is null or array_to_string(p.proacl::text[], ',') ~ '(^|,)=X' or has_function_privilege('app_public', p.oid, 'execute') or has_function_privilege('app_staff', p.oid, 'execute') or has_function_privilege('app_call', p.oid, 'execute'))")
[ "$pub70" = 0 ] || { echo "FAIL | OP43 0070 단독 적용 직후 실행 권한 열림: $pub70" | tee -a "$LOG_DIR/db-test.log"; exit 1; }
echo "NOTICE:  PASS | OP43 0070 단독 적용 직후(zz_grants 전) PUBLIC·공개·관리자·통화 역할 모두 실행 불가(함수 6개)" >> "$LOG_DIR/db-test.log"
D -q -c "insert into core.outbound_suppressions (business_id, phone_hmac) values ('bareun365', repeat('7a', 32))" >/dev/null
D -f db/rollback/0070_down.sql >/dev/null
gone70=$(D -At -c "select to_regprocedure('api.outbound_suppression_block(text,text)') is null and to_regprocedure('api.outbound_attempt_begin(text,text,text,text,text)') is null and to_regprocedure('api.outbound_decision_record(text,text,boolean,text,text[])') is null")
keep70=$(D -At -c "select (select count(*) from core.outbound_suppressions) || '/' || (select count(*) from pg_trigger where tgname like 'outbound_%_append_only')")
del70=$( { D -q -c "delete from core.outbound_suppressions" 2>&1 >/dev/null || true; } | grep -c OUTBOUND_APPEND_ONLY || true)
D -f db/migrations/0070_outbound_persistence.sql >/dev/null
back70=$(D -At -c "select to_regprocedure('api.outbound_suppression_check(text,text)') is not null and (select count(*) from core.outbound_suppressions) = 1")
[ "$gone70" = t ] && [ "$keep70" = "1/4" ] && [ "$del70" = 1 ] && [ "$back70" = t ] || { echo "FAIL | M70 0070 롤백 gone=$gone70 보존=$keep70 삭제차단=$del70 재적용=$back70" | tee -a "$LOG_DIR/db-test.log"; exit 1; }
echo "NOTICE:  PASS | M70 광고성 전화 기록 0070 롤백: 함수 6개만 제거, 수신거부 기록·추가 전용 트리거 4개 보존(롤백 뒤에도 삭제 차단), 재적용 시 기록 그대로" >> "$LOG_DIR/db-test.log"
# 0069 설치·정산·환수(코사장 11/27 안전 보완): 적용 전 지문 → 적용·기록 1건씩 → 롤백(api 함수 4개만 제거, 기록·보호 트리거 보존, 0069 밖 지문 불변) → 재적용(기록 그대로)
FP69="select md5(coalesce(string_agg(x, ';' order by x), '')) from (
  select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' || md5(p.prosrc) || coalesce(array_to_string(p.proacl::text[], ','), '') as x
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('api', 'core', 'security', 'pii')
     and p.proname not in ('contract_schedule', 'contract_status', 'settlement_record', 'contract_list', 'lead_contracts_guard', 'settlements_guard')
  union all
  select 'T:' || n.nspname || '.' || c.relname || c.relrowsecurity::text || c.relforcerowsecurity::text || coalesce(array_to_string(c.relacl::text[], ','), '')
         || (select string_agg(a.attname || format_type(a.atttypid, a.atttypmod), ',' order by a.attnum) from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped)
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where c.relkind in ('r', 'p') and n.nspname in ('core', 'security', 'pii') and c.relname not in ('lead_contracts', 'settlements')
  union all
  select 'G:' || tgrelid::regclass::text || '.' || tgname from pg_trigger where not tgisinternal
     and tgrelid not in (select oid from pg_class where relname in ('lead_contracts', 'settlements'))
) q"
DATA69="select (select count(*) from core.leads) || '/' || (select count(*) from pii.customers) || '/' || (select count(*) from core.audit_logs)"
D -q -c "drop function if exists api.contract_schedule(uuid,uuid,text,uuid,text,date,int,int), api.contract_status(uuid,uuid,text,uuid,text,date), api.settlement_record(uuid,uuid,text,uuid,text,int,date), api.contract_list(uuid,uuid,text,text)" >/dev/null
f69a=$(D -At -c "$FP69"); d69a=$(D -At -c "$DATA69")
D -f db/migrations/0069_install_settlement.sql >/dev/null
lead69=$(D -At -c "select id from core.leads order by created_at limit 1"); staff69=$(D -At -c "select user_id from core.staff order by user_id limit 1")
[ -n "$lead69" ] && [ -n "$staff69" ] || { echo "FAIL | M69 시험용 가상 리드·직원 없음" | tee -a "$LOG_DIR/db-test.log"; exit 1; }
D -q -c "insert into core.lead_contracts (lead_id, carrier, status, install_scheduled_on, installed_on, contract_months, clawback_months, created_by) values ('$lead69', 'KT', 'installed', current_date - 5, current_date - 1, 36, 12, '$staff69')" \
     -c "insert into core.settlements (lead_id, kind, amount_krw, occurred_on, created_by) values ('$lead69', 'received', 1000, current_date, '$staff69')" >/dev/null
d69b=$(D -At -c "$DATA69")
D -f db/rollback/0069_down.sql >/dev/null
gone69=$(D -At -c "select to_regprocedure('api.contract_schedule(uuid,uuid,text,uuid,text,date,int,int)') is null and to_regprocedure('api.contract_status(uuid,uuid,text,uuid,text,date)') is null and to_regprocedure('api.settlement_record(uuid,uuid,text,uuid,text,int,date)') is null and to_regprocedure('api.contract_list(uuid,uuid,text,text)') is null")
keep69=$(D -At -c "select (select count(*) from core.lead_contracts) || '/' || (select count(*) from core.settlements) || '/' || (select count(*) from pg_trigger where tgname in ('lead_contracts_guard', 'settlements_guard', 'lead_contracts_no_truncate', 'settlements_no_truncate'))")
f69b=$(D -At -c "$FP69"); d69c=$(D -At -c "$DATA69")
del69=$( { D -q -c "delete from core.settlements" 2>&1 >/dev/null || true; } | grep -c SETTLEMENT_APPEND_ONLY || true)
D -f db/migrations/0069_install_settlement.sql >/dev/null
back69=$(D -At -c "select to_regprocedure('api.contract_list(uuid,uuid,text,text)') is not null and to_regprocedure('api.settlement_record(uuid,uuid,text,uuid,text,int,date)') is not null and (select count(*) from core.lead_contracts) = 1 and (select count(*) from core.settlements) = 1")
f69c=$(D -At -c "$FP69")
[ "$gone69" = t ] && [ "$keep69" = "1/1/4" ] && [ "$f69a" = "$f69b" ] && [ "$f69a" = "$f69c" ] && [ "$d69a" = "$d69b" ] && [ "$d69b" = "$d69c" ] && [ "$del69" = 1 ] && [ "$back69" = t ] \
  || { echo "FAIL | M69 0069 롤백 gone=$gone69 보존=$keep69 지문(전/롤백/재적용)=${f69a:0:8}/${f69b:0:8}/${f69c:0:8} 데이터=$d69a/$d69b/$d69c 삭제차단=$del69 재적용=$back69" | tee -a "$LOG_DIR/db-test.log"; exit 1; }
echo "NOTICE:  PASS | M69 설치·정산·환수 0069 롤백: api 함수 4개만 제거, 계약·정산 기록 1/1·보호 트리거 4개 보존(롤백 뒤에도 삭제 차단), 0069 밖 함수·표·트리거 지문 불변(적용 전=롤백 뒤=재적용 뒤), 기존 리드·고객·감사 건수 불변, 재적용 시 기록 그대로" >> "$LOG_DIR/db-test.log"
# 0024 상담 공용 횟수 제한: 적용 → 롤백(함수 제거, 집계 보존) → 재적용
D -f db/migrations/0024_consult_rate.sql >/dev/null
D -f db/rollback/0024_down.sql >/dev/null
gone24=$(D -At -c "select (to_regprocedure('api.consult_rate_hit(text,text)') is null and to_regclass('core.consult_rate') is not null)")
D -f db/migrations/0024_consult_rate.sql >/dev/null
back24=$(D -At -c "select to_regprocedure('api.consult_rate_hit(text,text)') is not null")
[ "$gone24" = t ] && [ "$back24" = t ] || { echo "FAIL | M24 0024 롤백 gone=$gone24 재적용=$back24" | tee -a "$LOG_DIR/db-test.log"; exit 1; }
echo "NOTICE:  PASS | M24 상담 공용 횟수 제한 0024 롤백: 함수 제거·집계 보존, 재적용 일치" >> "$LOG_DIR/db-test.log"
# 0025·0026 접수 정책 게이트(PM 11/24): 적용 → 동작 확인 → 롤백(0026 → 0025, 함수·트리거 제거, 데이터·스위치 보존) → 재적용
SNAP="select (select count(*) from core.leads) || '/' || (select count(*) from pii.customers) || '/' || (select count(*) from core.policy_versions) || '/' || (select enabled::text from core.feature_flags where key = 'policy_publish')"
s0=$(D -At -c "$SNAP")
D -f db/migrations/0025_policy_intake_gate.sql >/dev/null
D -f db/migrations/0026_policy_intake_rule.sql >/dev/null
on26=$(D -At -c "select to_regprocedure('api.policy_intake_gate(text,text,text)') is not null and to_regprocedure('api.policy_intake_gate()') is null and (select count(*) from pg_trigger where tgname in ('policy_versions_state_lock', 'feature_flags_state_lock')) = 2")
err26=$({ D -At -c "select api.policy_intake_gate('m26-sup', 'm26-car', 'm26-prod')" 2>&1 >/dev/null || true; } | grep -oE 'POLICY_[A-Z_]+' | head -1 || true)
D -f db/rollback/0026_down.sql >/dev/null
mid=$(D -At -c "select to_regprocedure('api.policy_intake_gate(text,text,text)') is null and to_regprocedure('api.policy_intake_gate()') is not null")
D -f db/rollback/0025_down.sql >/dev/null
gone25=$(D -At -c "select to_regprocedure('api.policy_intake_gate()') is null and to_regprocedure('core.policy_state_lock()') is null and (select count(*) from pg_trigger where tgname in ('policy_versions_state_lock', 'feature_flags_state_lock')) = 0")
s1=$(D -At -c "$SNAP")
D -c "update core.feature_flags set enabled = enabled where key = 'policy_publish'" >/dev/null   # 롤백 뒤 기존 쓰기 동작(트리거 없음)
D -f db/migrations/0025_policy_intake_gate.sql >/dev/null
D -f db/migrations/0026_policy_intake_rule.sql >/dev/null
back26=$(D -At -c "select to_regprocedure('api.policy_intake_gate(text,text,text)') is not null and (select count(*) from pg_trigger where tgname in ('policy_versions_state_lock', 'feature_flags_state_lock')) = 2")
s2=$(D -At -c "$SNAP")
if [ "$on26" = t ] && [ -n "$err26" ] && [ "$mid" = t ] && [ "$gone25" = t ] && [ "$back26" = t ] && [ "$s0" = "$s1" ] && [ "$s1" = "$s2" ]; then
  echo "NOTICE:  PASS | M26 0025·0026 적용($err26 차단 확인) → 롤백(0026→0025 게이트 복귀 → 함수·트리거 제거) → 재적용, 리드/고객/정책/스위치 보존($s0)" >> "$LOG_DIR/db-test.log"
else
  echo "FAIL | M26 0025·0026 롤백 on=$on26 err=$err26 mid=$mid gone=$gone25 back=$back26 snap=$s0→$s1→$s2" | tee -a "$LOG_DIR/db-test.log"; exit 1
fi
# 0034 광고 월 예산: 적용 → 롤백(0021 판정·감시 본문 복원, 설정 표·함수 제거, 원장 보존) → 재적용
D -f db/migrations/0034_ad_monthly_cap.sql >/dev/null
has34() { D -At -c "select (position('ad_month_check' in (select prosrc from pg_proc where oid = 'api.ad_spend_request(uuid,uuid,text,text,int,text)'::regprocedure)) > 0)::text || (position('ad_month_check' in (select prosrc from pg_proc where oid = 'api.ad_spend_request_window(uuid,uuid,text,text,int,text)'::regprocedure)) > 0)::text || (position('month_limit_krw' in (select prosrc from pg_proc where oid = 'api.ad_monitor_targets()'::regprocedure)) > 0)::text || (to_regclass('core.ad_month_config') is not null)::text"; }
l34a=$(D -At -c "select count(*) from core.ad_spend_ledger")
on34=$(has34); D -f db/rollback/0034_down.sql >/dev/null; off34=$(has34); l34b=$(D -At -c "select count(*) from core.ad_spend_ledger")
D -f db/migrations/0034_ad_monthly_cap.sql >/dev/null; back34=$(has34); def34=$(D -At -c "select monthly_limit_krw from core.ad_month_config")
[ "$on34" = truetruetruetrue ] && [ "$off34" = falsefalsefalsefalse ] && [ "$back34" = truetruetruetrue ] && [ "$l34a" = "$l34b" ] && [ "$def34" = 0 ] \
  || { echo "FAIL | M34 0034 롤백 적용=$on34 롤백=$off34 재적용=$back34 원장=$l34a→$l34b 재적용기본=$def34" | tee -a "$LOG_DIR/db-test.log"; exit 1; }
echo "NOTICE:  PASS | M34 광고 월 예산 0034 롤백: 0021 판정·감시 본문 복원·설정 표 제거·원장 보존($l34a건), 재적용 시 기본 0원" >> "$LOG_DIR/db-test.log"
# 0036 계정 누적 월별: 적용 → 롤백(평생 합계·월 예산만 판정 한도 복원) → 재적용
D -f db/migrations/0036_ad_account_monthly.sql >/dev/null
has36() { D -At -c "select (position('date_trunc' in (select prosrc from pg_proc where oid = 'core.ad_account_total()'::regprocedure)) > 0)::text || (position('30000' in (select prosrc from pg_proc where oid = 'core.ad_month_effective_limit()'::regprocedure)) > 0)::text"; }
on36=$(has36); D -f db/rollback/0036_down.sql >/dev/null; off36=$(has36); D -f db/migrations/0036_ad_account_monthly.sql >/dev/null; back36=$(has36)
[ "$on36" = truetrue ] && [ "$off36" = falsefalse ] && [ "$back36" = truetrue ] || { echo "FAIL | M36 0036 롤백 적용=$on36 롤백=$off36 재적용=$back36" | tee -a "$LOG_DIR/db-test.log"; exit 1; }
echo "NOTICE:  PASS | M36 계정 누적 월별 0036 롤백: 평생 합계·월 예산만 한도 복원, 재적용 일치" >> "$LOG_DIR/db-test.log"
# 0035 광고 자동 스케줄러·활성화: 적용 → 롤백(함수 제거, 예약·키워드·CPC 기록 보존) → 재적용
D -f db/migrations/0035_ad_enable_scheduler.sql >/dev/null
D -f db/rollback/0035_down.sql >/dev/null
gone35=$(D -At -c "select (to_regprocedure('api.ad_sched_claim(uuid)') is null and to_regprocedure('api.ad_enable_schedule(uuid,uuid,text,text,text,timestamptz,text[],text,int,text)') is null and to_regclass('core.ad_enable_jobs') is not null and to_regclass('core.ad_keyword_registry') is not null)")
D -f db/migrations/0035_ad_enable_scheduler.sql >/dev/null
back35=$(D -At -c "select to_regprocedure('api.ad_sched_gate(uuid,uuid)') is not null and (select max_cpc_krw from core.ad_cpc_policy) = 0")
[ "$gone35" = t ] && [ "$back35" = t ] || { echo "FAIL | M35 0035 롤백 gone=$gone35 재적용=$back35" | tee -a "$LOG_DIR/db-test.log"; exit 1; }
echo "NOTICE:  PASS | M35 광고 스케줄러·활성화 0035 롤백: 함수 제거·기록 보존, 재적용 일치(CPC 기본 0원)" >> "$LOG_DIR/db-test.log"
"${PSQL[@]}" -d postgres -c "drop database if exists $DRILL" >/dev/null

"${PSQL[@]}" -d "$DB" -f db/seed/test_notice_review.sql >/dev/null
# 0020 계정 합산 한도는 DB 전체 원장을 본다: 앞선 SQL 시험이 남긴 광고 원장·경고·launch를 폐기 DB에서만 비운다(통합 시험 격리, 운영 DB에 쓰지 않음)
"${PSQL[@]}" -d "$DB" -f db/tests/reset_ad_account.sql >/dev/null   # 통합 시험의 가상 고지 승인(접수 게이트용)
echo "== app ↔ DB integration (staff session service + withRole, real PostgreSQL)"
# 앱과 같은 TypeScript 배선을 실제 가상 DB에 실행한다. postgres 드라이버가 없으면 통과로 처리하지 않고 실패한다.
if ! node -e "require.resolve('postgres')" >/dev/null 2>&1; then
  if [ "${FIDEON_ALLOW_SKIP_DB_INTEGRATION:-}" = 1 ]; then
    echo "SKIP  | I* 통합 시험: postgres 드라이버 미설치(npm ci 필요) — 통과로 세지 않음" | tee -a "$LOG_DIR/db-test.log"
  else
    echo "FAIL | I* postgres 드라이버 미설치: npm ci 후 다시 실행" | tee -a "$LOG_DIR/db-test.log"; exit 1
  fi
else
  if FIDEON_TEST_PGSOCK="$SOCK" FIDEON_TEST_PGPORT="$PORT" FIDEON_TEST_PGDATABASE="$DB" \
       node --conditions=react-server --import tsx --test --test-reporter=tap tests/integration/*.test.ts > "$LOG_DIR/db-integration.log" 2>&1; then
    n=$(grep -c '^ok ' "$LOG_DIR/db-integration.log" || true)
    grep '^ok ' "$LOG_DIR/db-integration.log" | sed 's/^ok [0-9]* - /NOTICE:  PASS | /' >> "$LOG_DIR/db-test.log"
    echo "  integration: $n passed"
  else
    grep -vE '^\s+at ' "$LOG_DIR/db-integration.log" | grep -E -B1 -A16 '^not ok' | head -120
    echo "FAIL | I* 앱 ↔ DB 통합 시험 실패 (test-results/db-integration.log)" | tee -a "$LOG_DIR/db-test.log"; exit 1
  fi
fi

pass=$(grep -c 'PASS |' "$LOG_DIR/db-test.log" || true)
fail=$(grep -c 'FAIL |' "$LOG_DIR/db-test.log" || true)
grep -o 'PASS | [^|]*' "$LOG_DIR/db-test.log" | sed 's/^PASS | /  ✓ /'
echo "== DB tests: pass=$pass fail=$fail"
[ "$fail" = 0 ] || exit 1

# AI 비용 예약 동시성(D1~D14, 동시 100건 포함, 최종검증 R10·R12). 같은 가상 DB에서 실행하고 끝나면 AI 원장·한도를 원상 복구한다.
echo "== AI cost reservation concurrency (D1~D14, separate connections)"
if ! bash scripts/ai-cost-db-concurrency.sh > "$LOG_DIR/ai-cost-concurrency.log" 2>&1; then
  grep -E '^(FAIL|BLOCKED|REFUSED)' "$LOG_DIR/ai-cost-concurrency.log" | head -20
  echo "FAIL | AI 비용 예약 동시성 검사 실패 (test-results/ai-cost-concurrency.log)"; exit 1
fi
tail -1 "$LOG_DIR/ai-cost-concurrency.log"

# 사용자별 AI 한도 우회(세션 재발급·다중 서버) 실DB 검증(SB-D*). 끝나면 한도·원장·횟수 집계 원상 복구.
echo "== AI per-user limit bypass (session reissue, multi-server, SB-D*)"
if ! bash scripts/ai-scope-bypass-db.sh > "$LOG_DIR/ai-scope-bypass.log" 2>&1; then
  grep -E '^(FAIL|BLOCKED|REFUSED)' "$LOG_DIR/ai-scope-bypass.log" | head -20
  echo "FAIL | 사용자별 AI 한도 우회 검사 실패 (test-results/ai-scope-bypass.log)"; exit 1
fi
tail -1 "$LOG_DIR/ai-scope-bypass.log"

# 설계 초안 0007(로그인 시도 제한)은 정식 마이그레이션에 자동 로드되지 않는다. GitHub Actions CI에서만, 기본 DB 검사가
# 통과한 뒤 같은 TCP 미수신 가상 클러스터에 별도 폐기용 DB를 만들어 명시 실행한다(fideon_test는 건드리지 않음).
# 이 단계가 실패하면 전체 DB 검사도 실패한다. 결과는 기본 DB 검사와 다른 라벨로 남는다.
if [ "${CI:-}" = true ] && [ "${GITHUB_ACTIONS:-}" = true ]; then
  echo "== design draft 0007 (login attempt limits): local disposable DB + safety tests (CI only)"
  npm run -s test:design:login-limits || { echo "FAIL | 설계 초안 0007 시험 실패(기본 DB 검사와 별도)"; exit 1; }
fi

# 마스킹 목록 어댑터 PG 통합 시험(PM 6909719658): GitHub Actions CI에서만, 위 검사가 모두 통과한 뒤 별도 폐기 DB에서 실행.
# 기존 집계(DB·설계 초안·안전장치)와 섞지 않고 자기 라벨로 보고한다. 실패하면 전체 DB 검사도 실패한다.
if [ "${CI:-}" = true ] && [ "${GITHUB_ACTIONS:-}" = true ]; then
  echo "== leads read adapter: real PostgreSQL integration (disposable DB, CI only)"
  npm run -s test:integration:leads-read || { echo "FAIL | 목록 어댑터 PG 통합 시험 실패(기본 DB 검사와 별도)"; exit 1; }
fi
