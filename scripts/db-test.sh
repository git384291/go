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
rm -f "$LOG_DIR"/conc-*.sql "$LOG_DIR"/conc-*.out "$LOG_DIR/app_server.err"

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
leak=$("${PSQL[@]}" -d "$DB" -At -c "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'api' and p.prosrc ~* '(commission|settlement)'")
if [ "$leak" = 0 ]; then
  echo "NOTICE:  PASS | F3 api 함수 중 수수료·정산 테이블을 읽는 함수 0개" >> "$LOG_DIR/db-test.log"
else
  echo "FAIL | F3 api functions referencing commission/settlement: $leak" | tee -a "$LOG_DIR/db-test.log"; exit 1
fi
SQL "drop table core.commissions_probe, core.settlement_ledger_probe"
rm -f "$LOG_DIR/probe.err"

pass=$(grep -c 'PASS |' "$LOG_DIR/db-test.log" || true)
fail=$(grep -c 'FAIL |' "$LOG_DIR/db-test.log" || true)
grep -o 'PASS | [^|]*' "$LOG_DIR/db-test.log" | sed 's/^PASS | /  ✓ /'
echo "== DB tests: pass=$pass fail=$fail"
[ "$fail" = 0 ]
