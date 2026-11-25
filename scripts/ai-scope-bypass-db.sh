#!/usr/bin/env bash
# 사용자별 AI 한도 우회 검증(PM 11/24) — 실제 로컬 가상 DB, 서로 다른 DB 연결 = 서버 인스턴스 여러 대 가정.
#  SB-D1 세션 재발급(쿠키 삭제): 같은 IP 해시로 새 세션 40건 동시 → 5건만(0024, 메모리 제한 없이 DB만으로)
#  SB-D2 전체 새 세션 한도: 서로 다른 IP 해시 80건 동시 → 60건
#  SB-D3 같은 세션(사용자 키) 100건 동시 → 1건(0029, 다중 서버)
#  SB-D4 쿠키 삭제 = 새 사용자 키 → 사용자 일 한도는 새로 생긴다(설계상 한계) / 서비스 일 한도는 키 수와 무관하게 지켜진다
#  SB-D6 회선별 하루 300원(0032): 세션 재발급·동시 100건·다중 서버로 넘지 못함, 취소·불확실·하루 초기화·형식 오류·전체 한도
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
cfg() { "${SU[@]}" -c "truncate core.ai_usage_adjustments, core.ai_usage_closures, core.ai_usage_ledger" -c "update core.ai_budget_config set paused = false, monthly_limit_krw = $1, daily_limit_krw = $2, scope_daily_limit_krw = $3, scope_monthly_limit_krw = $4, max_inflight = $5, scope_max_inflight = $6, net_daily_limit_krw = ${7:-300}"; }
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

echo "== SB-D6 회선별 하루 300원(0032, PM 결정): 세션 재발급·동시·다중 서버로 넘지 못한다"
"${SU[@]}" -c "select 1 from pg_attribute where attrelid='core.ai_budget_config'::regclass and attname='net_daily_limit_krw'" | grep -q 1 || { echo "FAIL | 0032 미적용"; fail=$((fail+1)); }
eq "SB-D6 기본값 300원" "$("${SU[@]}" -c "select column_default from information_schema.columns where table_schema='core' and table_name='ai_budget_config' and column_name='net_daily_limit_krw'")" 300
holdN() { as_role app_ai "select coalesce(api.ai_budget_hold(${3:-4}, '$(cat /proc/sys/kernel/random/uuid)', '$1', '$2')::text, 'null')"; }
conf() { as_role app_ai "select api.ai_budget_confirm($1, ${2:-4})" >/dev/null; }
netspent() { "${SU[@]}" -c "select coalesce(sum(case x.kind when 'cancel' then 0 when 'confirm' then x.actual_cost_krw else u.cost_krw end),0) from core.ai_usage_ledger u left join core.ai_usage_closures x on x.reservation_id=u.id where u.net_key='$1'"; }
# PM 한도 그대로: 전체 일 3,000·월 50,000·사용자 일 300·월 1,500·동시 5·사용자 동시 1·회선 일 300
cfg 50000 3000 300 1500 5 1 300
NET=$(hex64 7001); n=0
for s in $(seq 1 10); do for i in $(seq 1 10); do r=$(holdN "$(hex64 $((7100 + s)))" "$NET"); [[ "$r" =~ ^[0-9]+$ ]] && { n=$((n+1)); conf "$r"; }; done; done
eq "SB-D6a 같은 회선에서 세션 10개로 재발급(각 10회·4원) → 합계 75건" "$n" 75
eq "SB-D6b 회선 사용액 300원(초과 0)" "$(netspent "$NET")" 300
eq "SB-D6c 같은 와이파이의 새 고객(새 세션)도 오늘은 거부(회선 공유 — 정상 고객 영향)" "$(holdN "$(hex64 7999)" "$NET")" null
r=$(holdN "$(hex64 7998)" "$(hex64 7002)"); [[ "$r" =~ ^[0-9]+$ ]] && eq "SB-D6d 다른 회선은 영향 없음" ok ok || eq "SB-D6d 다른 회선은 영향 없음" "$r" id
cfg 1000000 1000000 1000000 1000000 1000 100 300
NET=$(hex64 7003)
for i in $(seq 1 100); do holdN "$(hex64 $((7200 + i)))" "$NET" > "$TMP/n$i" & done; wait
eq "SB-D6e 같은 회선 서로 다른 세션 100건 동시(서버 여러 대 = 연결 100개) → 75건" "$(oks "$TMP"/n*)" 75
eq "SB-D6f 예약 총액 300원(미정산 = 예약 전액으로 셈)" "$(netspent "$NET")" 300
eq "SB-D6g 오류 0건" "$(cat "$TMP"/n* | grep -cvE '^([0-9]+|null)$')" 0
cfg 1000000 1000000 1000000 1000000 1000 100 300
NET=$(hex64 7004)
r1=$(holdN "$(hex64 7301)" "$NET" 300); as_role app_ai "select api.ai_budget_release($r1)" >/dev/null
r2=$(holdN "$(hex64 7302)" "$NET" 300)
[[ "$r2" =~ ^[0-9]+$ ]] && eq "SB-D6h 호출 전 취소(0원)는 회선 한도를 돌려준다" ok ok || eq "SB-D6h 호출 전 취소(0원)는 회선 한도를 돌려준다" "$r2" id
as_role app_ai "select api.ai_budget_uncertain($r2)" >/dev/null
eq "SB-D6i 과금 불확실은 예약 전액(300)으로 세어 추가 1원 거부" "$(holdN "$(hex64 7303)" "$NET" 1)" null
eq "SB-D6j 회선 키 형식 오류 → 거부(fail-closed)" "$(as_role app_ai "select coalesce(api.ai_budget_hold(1, '$(cat /proc/sys/kernel/random/uuid)', '$(hex64 7304)', 'not-a-hash')::text, 'null')")" null
cfg 1000000 1000000 1000000 1000000 1000 100 0
eq "SB-D6k 회선 한도 0 = 회선 키 있는 호출 금지" "$(holdN "$(hex64 7305)" "$(hex64 7005)" 1)" null
cfg 1000000 1000000 1000000 1000000 1000 100 300
NET=$(hex64 7006)
"${SU[@]}" -c "with i as (insert into core.ai_usage_ledger(month,cost_krw,scope_key,net_key,created_at) values (to_char((now()-interval '1 day') at time zone 'Asia/Seoul','YYYY-MM'),300,'$(hex64 7306)','$NET',now()-interval '1 day') returning id) insert into core.ai_usage_closures(reservation_id,kind,actual_cost_krw) select id,'confirm',300 from i" >/dev/null
r=$(holdN "$(hex64 7307)" "$NET"); [[ "$r" =~ ^[0-9]+$ ]] && eq "SB-D6l 어제(한국 날짜) 300원 쓴 회선도 오늘은 다시 허용(하루 단위 초기화)" ok ok || eq "SB-D6l 하루 초기화" "$r" id
cfg 1000000 5 1000000 1000000 1000 100 1000000
for i in $(seq 1 30); do holdN "$(hex64 $((7400 + i)))" "$(hex64 $((7500 + i)))" 1 > "$TMP/q$i" & done; wait
eq "SB-D6m 회선이 모두 달라도 전체 일 한도(5원)는 그대로 최종 차단" "$(oks "$TMP"/q*)" 5
eq "SB-D6n 원장에 저장된 회선 키는 64자리 HMAC 형식뿐(원문 IP 없음)" "$("${SU[@]}" -c "select count(*) from core.ai_usage_ledger where net_key is not null and net_key !~ '^[0-9a-f]{64}$'")" 0

echo "== SB-D7 0033 실행 권한: 실제 앱 경로(app_server 로그인 → set local role app_ai)만, 다른 역할·직접 실행 불가"
cfg 1000000 1000000 1000000 1000000 1000 100 300
r=$(holdN "$(hex64 7601)" "$(hex64 7602)" 6)
eq "SB-D7a 앱 경로(app_ai) 불확실 3원 정산" "$(as_role app_ai "select api.ai_budget_uncertain($r, 3)::text")" true
eq "SB-D7b 정산 금액 3원(예약 6원 전액 아님)" "$("${SU[@]}" -c "select actual_cost_krw from core.ai_usage_closures where reservation_id = $r")" 3
for role in app_public app_staff app_ad_monitor; do
  eq "SB-D7c $role 실행 불가" "$(as_role $role "select api.ai_budget_uncertain($r, 1)" | grep -c 'permission denied')" 1
done
eq "SB-D7d app_server 로그인 그대로(역할 전환 없음) 실행 불가(NOINHERIT)" "$(psql -X -q -At -h "$SOCK" -p "$PORT" -U app_server -d "$DB" -c "select api.ai_budget_uncertain($r, 1)" 2>&1 | grep -c 'permission denied')" 1
eq "SB-D7e PUBLIC 실행 불가" "$("${SU[@]}" -c "select has_function_privilege('public', 'api.ai_budget_uncertain(bigint,int)', 'execute')")" f
eq "SB-D7f 소유자 fideon_api(슈퍼유저 아님)" "$("${SU[@]}" -c "select proowner::regrole from pg_proc where oid = 'api.ai_budget_uncertain(bigint,int)'::regprocedure")" fideon_api

# 원상 복구(가상 DB): 0028·0029 기본값(0원 = 호출 금지, 사용자 동시 1), 원장·횟수 집계 비움
cfg 0 0 0 0 0 1 300
"${SU[@]}" -c "delete from core.consult_rate"
echo "== 결과: PASS $pass · FAIL $fail"
[ "$fail" = 0 ]
