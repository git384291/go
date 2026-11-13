#!/usr/bin/env bash
# 로컬 가상 DB를 새로 만들고 마이그레이션 → 가상 시드 → 보안·권한 테스트를 실행한다.
# 실제 고객정보·운영 DB를 사용하지 않는다. 사용: bash scripts/db-test.sh
set -euo pipefail
cd "$(dirname "$0")/.."

PG_BIN="${PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
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
  as_pg "mkdir -p '$DATA' && '$PG_BIN/initdb' -D '$DATA' -U postgres --auth=trust --encoding=UTF8 --locale=C.UTF-8 >/dev/null"
fi
if ! as_pg "'$PG_BIN/pg_ctl' -D '$DATA' status" >/dev/null 2>&1; then
  as_pg "'$PG_BIN/pg_ctl' -D '$DATA' -o \"-p $PORT -k $SOCK -c listen_addresses=''\" -l '$DATA/server.log' -w start" >/dev/null
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
"${PSQL[@]}" -d "$DB" -f db/tests/00_helpers.sql >/dev/null

echo "== permission report + tests"
run db/tests/10_grants.sql > "$LOG_DIR/db-grants-report.txt"
cat "$LOG_DIR/db-grants-report.txt"
run db/tests/20_staff_auth.sql >/dev/null
run db/tests/30_leads_pii.sql >/dev/null

echo "== TypeScript ↔ DB signature parity"
tsx scripts/sign-parity.ts > "$LOG_DIR/parity.sql"
run "$LOG_DIR/parity.sql" >/dev/null

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
rm -f "$LOG_DIR"/conc-*.sql "$LOG_DIR"/conc-*.out "$LOG_DIR/app_server.err"

pass=$(grep -c 'PASS |' "$LOG_DIR/db-test.log" || true)
fail=$(grep -c 'FAIL |' "$LOG_DIR/db-test.log" || true)
grep -o 'PASS | [^|]*' "$LOG_DIR/db-test.log" | sed 's/^PASS | /  ✓ /'
echo "== DB tests: pass=$pass fail=$fail"
[ "$fail" = 0 ]
