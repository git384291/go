#!/usr/bin/env bash
# P0 AI 비용 예약(0011·0012) 로컬 가상 DB 통합 검증 — 원자성·중복 정산·미정산 보수 계산·권한·추가 전용 + 0028(멱등·동시 상한·일 한도·확정 하한).
# 사용: 먼저 `bash scripts/db-test.sh`(또는 같은 마이그레이션이 적용된 로컬 가상 DB)를 준비한 뒤 `bash scripts/ai-cost-db-concurrency.sh`.
# 안전: 유닉스 소켓(로컬)의 fideon_test DB에서만 동작한다. 그 외는 거부한다. 외부 AI 호출 없음. 운영 DB·고객정보 사용 안 함.
# 주의: 로컬 가상 DB 결과는 운영(Supabase) 환경의 원자성·무과금을 실증하지 않는다. 운영 DB 통합 검증은 별도다.
set -uo pipefail
SOCK="${PGHOST_TEST:-/tmp}"; PORT="${PGPORT_TEST:-54329}"; DB=fideon_test
case "$SOCK" in /*) ;; *) echo "REFUSED: 로컬 유닉스 소켓만 허용"; exit 2;; esac
SU=(psql -X -q -At -h "$SOCK" -p "$PORT" -U postgres -d "$DB" -v ON_ERROR_STOP=1)
"${SU[@]}" -c "select 1" >/dev/null 2>&1 || { echo "BLOCKED: 로컬 가상 DB($SOCK:$PORT/$DB)에 연결할 수 없음 — scripts/db-test.sh를 먼저 실행"; exit 3; }
"${SU[@]}" -c "select 1 from pg_proc where proname='ai_budget_hold' and pronargs = 3" | grep -q 1 || { echo "BLOCKED: 0012·0028 마이그레이션이 적용되지 않음"; exit 3; }

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0
ok()  { echo "PASS | $1"; pass=$((pass+1)); }
bad() { echo "FAIL | $1"; fail=$((fail+1)); }
eq()  { if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1 — 기대 [$3] 실제 [$2]"; fi; }

reset()  { "${SU[@]}" -c "truncate core.ai_usage_adjustments, core.ai_usage_closures, core.ai_usage_ledger" -c "update core.ai_budget_config set paused = false, monthly_limit_krw = $1, daily_limit_krw = ${2:-1000000}, scope_daily_limit_krw = 1000000, scope_monthly_limit_krw = 1000000, max_inflight = ${3:-1000}"; }  # 가상 DB 전용
month()  { "${SU[@]}" -c "select to_char(now() at time zone 'Asia/Seoul','YYYY-MM')"; }
# 앱 경로와 같은 역할(app_server 로그인 → app_ai로 전환)로 실행
as_ai()  { psql -X -q -At -h "$SOCK" -p "$PORT" -U app_server -d "$DB" -v ON_ERROR_STOP=1 -c "begin" -c "set local role app_ai" -c "$1" -c "commit" 2>&1 | grep -v -E '^(BEGIN|SET|COMMIT)$'; }
SCOPE=$(printf 'c%.0s' $(seq 1 64))
# 0028 서명: (비용, 요청 ID, 사용자 키). 요청 ID를 안 주면 매번 새 ID
hold()   { local req="${2:-$(cat /proc/sys/kernel/random/uuid)}"; as_ai "select api.ai_budget_hold($1, '$req', '$SCOPE')::text"; }
used()   { "${SU[@]}" -c "select coalesce(sum(case s.kind when 'cancel' then 0 when 'confirm' then s.actual_cost_krw else u.cost_krw end),0) from core.ai_usage_ledger u left join core.ai_usage_closures s on s.reservation_id=u.id"; }
reserved_sum() { "${SU[@]}" -c "select coalesce(sum(cost_krw),0) from core.ai_usage_ledger"; }
seed_confirmed() { # 확정 사용액을 직접 채운다(1건 최대 1,000원)
  local left=$1 m; m=$(month)
  while [ "$left" -gt 0 ]; do
    local c=$(( left > 1000 ? 1000 : left ))
    "${SU[@]}" -c "with i as (insert into core.ai_usage_ledger(month,cost_krw) values ('$m',$c) returning id) insert into core.ai_usage_closures(reservation_id,kind,actual_cost_krw) select id,'confirm',$c from i"
    left=$((left-c))
  done
}

echo "== D1 TEST-04 동시 요청: 한도 100원, A 80원·B 80원 동시(25회 반복, 서로 다른 DB 세션)"
bad_round=0; over=0
for r in $(seq 1 25); do
  reset 100
  hold 80 > "$TMP/a" & pa=$!
  hold 80 > "$TMP/b" & pb=$!
  wait $pa $pb
  n=$(cat "$TMP/a" "$TMP/b" | grep -cE '^[0-9]+$')
  [ "$n" = 1 ] || bad_round=$((bad_round+1))
  [ "$(reserved_sum)" -le 100 ] || over=$((over+1))
done
eq "D1 25회 모두 정확히 1건만 예약 성공(실패 라운드 수)" "$bad_round" 0
eq "D1 예약 총액이 100원을 넘은 라운드 수" "$over" 0

echo "== D2 TEST-04 확장: 한도 100원, 30원 요청 12건 동시"
reset 100
for i in $(seq 1 12); do hold 30 > "$TMP/h$i" & done; wait
eq "D2 성공 건수(30원×3=90 ≤ 100 < 120)" "$(cat "$TMP"/h* | grep -cE '^[0-9]+$')" 3
eq "D2 예약 총액" "$(reserved_sum)" 90

echo "== D3 TEST-03 월 한도 10,000원·확정 9,995원"
reset 10000; seed_confirmed 9995
eq "D3 예상 10원 요청 거부(빈 응답 = null)" "$(hold 10)" ""
r5=$(hold 5); [[ "$r5" =~ ^[0-9]+$ ]] && ok "D3 5원은 허용(9,995+5=10,000)" || bad "D3 5원 허용 실패 [$r5]"
eq "D3 한도 도달 뒤 1원 거부" "$(hold 1)" ""
eq "D3 사용액" "$(used)" 10000

echo "== D4 기본 한도 0원 = 호출 금지(TEST-08 대체 수단, TEST-09 기본값)"
reset 0
eq "D4 한도 0원이면 1원도 거부" "$(hold 1)" ""

echo "== D5 TEST-05·07·12b 미정산 예약은 전액으로 세고, 정산은 예약당 1회"
reset 1000
id=$(hold 600)
[[ "$id" =~ ^[0-9]+$ ]] && ok "D5 600원 예약" || bad "D5 예약 실패 [$id]"
eq "D5 미정산 600원이 남은 잔액에서 빠진다(500원 거부)" "$(hold 500)" ""
eq "D5 확정(실제 200원) 1회차" "$(as_ai "select api.ai_budget_confirm($id, 200)")" t
eq "D5 같은 예약 확정 2회차는 반영되지 않음" "$(as_ai "select api.ai_budget_confirm($id, 0)")" f
eq "D5 확정된 예약의 취소는 반영되지 않음(환불 우회 불가)" "$(as_ai "select api.ai_budget_release($id)")" f
eq "D5 사용액 = 200(중복 정산 없음)" "$(used)" 200
id2=$(hold 500); [[ "$id2" =~ ^[0-9]+$ ]] && ok "D5 200+500=700 ≤ 1000 예약 허용" || bad "D5 재예약 실패 [$id2]"
eq "D5 200+500+400=1100 > 1000 거부" "$(hold 400)" ""
eq "D5 입력 오류(0·음수·1001·null) 거부" "$(hold 0)|$(hold -1)|$(hold 1001)|$(as_ai "select api.ai_budget_hold(null, gen_random_uuid()::text, '$SCOPE')::text")" "|||"

echo "== D6 TEST-11 한국 시간(KST) 월 키"
eq "D6 함수 소스가 Asia/Seoul 월 키를 쓴다" "$("${SU[@]}" -c "select (prosrc like '%at time zone ''Asia/Seoul'', ''YYYY-MM''%')::text from pg_proc where proname='ai_budget_hold'")" true
eq "D6 UTC 11/30 15:30 = KST 12/01 → 월 키 2026-12" "$("${SU[@]}" -c "select to_char(timestamptz '2026-11-30 15:30:00+00' at time zone 'Asia/Seoul','YYYY-MM')")" 2026-12
eq "D6 같은 순간 UTC 월 키는 2026-11(우회 가능성 비교)" "$("${SU[@]}" -c "select to_char(timestamptz '2026-11-30 15:30:00+00' at time zone 'UTC','YYYY-MM')")" 2026-11
echo "NOTE | D6은 표현식·함수 소스 검증이다. 실제 시계가 자정을 넘는 순간의 전환은 이 로컬 검증으로 실증하지 못한다(별도 검증 필요)."

echo "== D7 보안: 권한·추가 전용"
exec_as() { psql -X -q -At -h "$SOCK" -p "$PORT" -U app_server -d "$DB" -c "begin" -c "set local role $1" -c "$2" -c "rollback" 2>&1 | grep -oE 'permission denied[^"]*|APPEND_ONLY' | head -1; }
eq "D7 app_public은 예약 실행 불가" "$(exec_as app_public "select api.ai_budget_hold(1, gen_random_uuid()::text, repeat('c', 64))" | cut -c1-17)" "permission denied"
eq "D7 app_staff는 예약 실행 불가" "$(exec_as app_staff "select api.ai_budget_hold(1, gen_random_uuid()::text, repeat('c', 64))" | cut -c1-17)" "permission denied"
eq "D7 app_ai는 원장 테이블 직접 조회 불가" "$(exec_as app_ai "select * from core.ai_usage_ledger" | cut -c1-17)" "permission denied"
eq "D7 app_ai는 한도 설정 직접 변경 불가" "$(exec_as app_ai "update core.ai_budget_config set monthly_limit_krw = 1000000" | cut -c1-17)" "permission denied"
eq "D7 app_ai는 한도 설정 함수(관리자용) 실행 불가" "$(exec_as app_ai "select api.ai_budget_limit_set(gen_random_uuid(),gen_random_uuid(),'x',1000,'x')" | cut -c1-17)" "permission denied"
eq "D7 원장 수정은 추가 전용 트리거가 막는다(슈퍼유저도)" "$("${SU[@]}" -c "update core.ai_usage_ledger set cost_krw = 1" 2>&1 | grep -oE 'APPEND_ONLY' | head -1)" APPEND_ONLY
eq "D7 정산 기록 삭제도 막는다" "$("${SU[@]}" -c "delete from core.ai_usage_closures" 2>&1 | grep -oE 'APPEND_ONLY' | head -1)" APPEND_ONLY

echo "== D8 확정 하한(0028): 호출이 나간 뒤 0원 확정으로 사용액을 지울 수 없다"
reset 1000
id=$(hold 600)
eq "D8 0원 확정 거부" "$(as_ai "select api.ai_budget_confirm($id, 0)")" f
eq "D8b 사용액은 예약 전액 유지" "$(used)" 600

echo "== D9 TEST-12 같은 요청 ID 10건 동시(서로 다른 DB 세션) → 예약 1건"
reset 100000
for i in $(seq 1 10); do hold 5 "req-d9-same-0000000001" > "$TMP/i$i" & done; wait
eq "D9 성공 1건" "$(cat "$TMP"/i* | grep -cE '^[0-9]+$')" 1
eq "D9 원장 1건" "$("${SU[@]}" -c "select count(*) from core.ai_usage_ledger where request_id = 'req-d9-same-0000000001'")" 1

echo "== D10 동시 요청 한도: max_inflight 3, 서로 다른 요청 12건 동시 → 3건"
reset 100000 1000000 3
for i in $(seq 1 12); do hold 1 > "$TMP/f$i" & done; wait
eq "D10 성공 3건" "$(cat "$TMP"/f* | grep -cE '^[0-9]+$')" 3

echo "== D11 TEST-02 일일 한도: 일 50원, 20원 요청 6건 동시 → 2건(월 한도는 넉넉)"
reset 100000 50
for i in $(seq 1 6); do hold 20 > "$TMP/g$i" & done; wait
eq "D11 성공 2건" "$(cat "$TMP"/g* | grep -cE '^[0-9]+$')" 2
eq "D11 예약 총액 ≤ 50" "$(reserved_sum)" 40

# 원상 복구(가상 DB): 한도 0원(기본), 원장 비움
reset 0 0 0
echo "== 결과: PASS $pass · FAIL $fail"
[ "$fail" = 0 ]
