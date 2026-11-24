#!/usr/bin/env bash
# 사용자별 AI 한도 우회 검증(PM 11/24) — 실제 로컬 가상 DB, 서로 다른 DB 연결 = 서버 인스턴스 여러 대 가정.
#  SB-D1 세션 재발급(쿠키 삭제): 같은 IP 해시로 새 세션 40건 동시 → 5건만(0024, 메모리 제한 없이 DB만으로)
#  SB-D2 전체 새 세션 한도: 서로 다른 IP 해시 80건 동시 → 60건
#  SB-D3 같은 세션(사용자 키) 100건 동시 → 1건(0029, 다중 서버)
#  SB-D4 쿠키 삭제 = 새 사용자 키 → 사용자 일 한도는 새로 생긴다(설계상 한계) / 서비스 일 한도는 키 수와 무관하게 지켜진다
# 사용: scripts/db-test.sh가 만든 fideon_test에서만. 끝나면 한도 기본값(0원·사용자 동시 1)·원장·횟수 집계를 원상 복구.
# 안전: 로컬 유닉스 소켓만 허용. 외부 AI 호출 없음. 운영 DB·고객정보·원문 IP 사용 안 함(가상 해시만).
set -uo pipefail
SOCK="${PGHOST_TEST:-/tmp}"; PORT="${PGPORT_TEST:-54329}"; DB=fideon_test
case "$SOCK" in /*) ;; *) echo "REFUSED: 로컬 유닉스 소켓만 허용"; exit 2;; esac
SU=(psql -X -q -At -h "$SOCK" -p "$PORT" -U postgres -d "$DB" -v ON_ERROR_STOP=1)
"${SU[@]}" -c "select 1" >/dev/null 2>&1 || { echo "BLOCKED: 로컬 가상 DB 연결 불가 — scripts/db-test.sh 먼저"; exit 3; }
"${SU[@]}" -c "select 1 from pg_attribute where attrelid='core.ai_budget_config'::regclass and attname='scope_max_inflight'" | grep -q 1 || { echo "BLOCKED: 0029 미적용"; exit 3; }

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0
eq()  { if [ "$2" = "$3" ]; then echo "PASS | $1 ($2)"; pass=$((pass+1)); else echo "FAIL | $1 — 기대 [$3] 실제 [$2]"; fail=$((fail+1)); fi; }
as_role() { psql -X -q -At -h "$SOCK" -p "$PORT" -U app_server -d "$DB" -v ON_ERROR_STOP=1 -c "begin" -c "set local role $1" -c "$2" -c "commit" 2>&1 | grep -v -E '^(BEGIN|SET|COMMIT)$'; }
hex64() { printf '%064x' "$1"; }
cfg() { "${SU[@]}" -c "truncate core.ai_usage_adjustments, core.ai_usage_closures, core.ai_usage_ledger" -c "update core.ai_budget_config set paused = false, monthly_limit_krw = $1, daily_limit_krw = $2, scope_daily_limit_krw = $3, scope_monthly_limit_krw = $4, max_inflight = $5, scope_max_inflight = $6"; }
hold() { as_role app_ai "select coalesce(api.ai_budget_hold(1, '$(cat /proc/sys/kernel/random/uuid)', '$1')::text, 'null')"; }
oks()  { cat "$@" | grep -cE '^[0-9]+$'; }

echo "== SB-D1 같은 IP 새 세션 40건 동시(서버 여러 대, 메모리 제한 우회 가정) → DB가 5건만"
"${SU[@]}" -c "delete from core.consult_rate"
IPH=$(hex64 4242)
for i in $(seq 1 40); do as_role app_public "select api.consult_rate_hit('$IPH', 'session')::text" > "$TMP/s$i" & done; wait
eq "SB-D1 허용 5건" "$(cat "$TMP"/s* | grep -c '^true$')" 5
eq "SB-D1 오류 0건" "$(cat "$TMP"/s* | grep -cvE '^(true|false)$')" 0

# 0031: IP 한도로 거부된 시도는 전체 집계를 소비하지 않는다
eq "SB-D1c 전체 집계는 허용된 5건만(0031)" "$("${SU[@]}" -c "select hits from core.consult_rate where bucket = 'session:all'")" 5
"${SU[@]}" -c "delete from core.consult_rate"
echo "== SB-D2 서로 다른 IP 80건 동시 → 전체 1시간 60개"
for i in $(seq 1 80); do as_role app_public "select api.consult_rate_hit('$(hex64 $((9000 + i)))', 'session')::text" > "$TMP/g$i" & done; wait
eq "SB-D2 전체 허용 60건" "$(cat "$TMP"/g* | grep -c '^true$')" 60
eq "SB-D2 오류 0건" "$(cat "$TMP"/g* | grep -cvE '^(true|false)$')" 0
"${SU[@]}" -c "delete from core.consult_rate"

echo "== SB-D5 정상 고객 과잉 차단 없음: 공격 IP 120건 + 정상 IP 55명 동시(다중 서버) → 정상 55명 전원 허용"
"${SU[@]}" -c "delete from core.consult_rate"
ATK=$(hex64 31337)
for i in $(seq 1 120); do as_role app_public "select api.consult_rate_hit('$ATK', 'session')::text" > "$TMP/x$i" & done
for i in $(seq 1 55); do as_role app_public "select api.consult_rate_hit('$(hex64 $((20000 + i)))', 'session')::text" > "$TMP/l$i" & done; wait
eq "SB-D5 정상 55명 허용" "$(cat "$TMP"/l* | grep -c '^true$')" 55
eq "SB-D5 공격 IP 허용 5건" "$(cat "$TMP"/x* | grep -c '^true$')" 5
eq "SB-D5 전체 집계 60(상한 그대로)" "$("${SU[@]}" -c "select hits from core.consult_rate where bucket = 'session:all'")" 60
eq "SB-D5 오류 0건" "$(cat "$TMP"/x* "$TMP"/l* | grep -cvE '^(true|false)$')" 0
"${SU[@]}" -c "delete from core.consult_rate"

echo "== SB-D3 같은 사용자 키(세션) 100건 동시, 서로 다른 연결 → 1건(0029)"
cfg 1000000 1000000 1000000 1000000 1000 1
SC=$(hex64 77)
for i in $(seq 1 100); do hold "$SC" > "$TMP/c$i" & done; wait
eq "SB-D3 성공 1건" "$(oks "$TMP"/c*)" 1

echo "== SB-D4 쿠키 삭제(새 세션 = 새 사용자 키): 사용자 일 3원, 서비스 일 5원, 1회 1원"
cfg 1000000 5 3 1000000 1000 100
A=$(hex64 101); B=$(hex64 102)
for i in 1 2 3 4; do hold "$A"; done > "$TMP/a"
eq "SB-D4a 같은 세션은 3건에서 막힘" "$(oks "$TMP/a")" 3
for i in 1 2 3; do hold "$B"; done > "$TMP/b"
eq "SB-D4b 새 세션은 서비스 일 한도 남은 2건만(사용자 한도는 새로 생김 = 설계상 한계)" "$(oks "$TMP/b")" 2
cfg 1000000 5 3 1000000 1000 100
for i in $(seq 1 40); do hold "$(hex64 $((500 + i)))" > "$TMP/m$i" & done; wait
eq "SB-D4c 새 세션 40개 동시(다중 서버) → 서비스 일 한도 5건 그대로" "$(oks "$TMP"/m*)" 5

# 원상 복구(가상 DB): 0028·0029 기본값(0원 = 호출 금지, 사용자 동시 1), 원장·횟수 집계 비움
cfg 0 0 0 0 0 1
"${SU[@]}" -c "delete from core.consult_rate"
echo "== 결과: PASS $pass · FAIL $fail"
[ "$fail" = 0 ]
