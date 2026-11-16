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
run db/tests/40_product_scope.sql >/dev/null   # PHASE 1 상품 상태·2인 승인
run db/tests/45_product_scope_hardening.sql >/dev/null   # PHASE 1 보완: 승인 서명 재사용 방지

echo "== TypeScript ↔ DB signature parity"
npx --no-install tsx scripts/sign-parity.ts > "$LOG_DIR/parity.sql"   # 프로젝트에 설치된 tsx 사용(PATH에 없어도 동작)
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
restore_create_lead() { # 0004 검수본으로 복원하고, 실제 본문이 고정 해시와 같은지 확인
  extract_create_lead db/migrations/0004_product_scope.sql > "$LOG_DIR/fn-create_lead.sql"
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
leak=$("${PSQL[@]}" -d "$DB" -At -c "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'api' and p.prosrc ~* '(commission|settlement)'")
if [ "$leak" = 0 ]; then
  echo "NOTICE:  PASS | F3 api 함수 중 수수료·정산 테이블을 읽는 함수 0개" >> "$LOG_DIR/db-test.log"
else
  echo "FAIL | F3 api functions referencing commission/settlement: $leak" | tee -a "$LOG_DIR/db-test.log"; exit 1
fi
SQL "drop table core.commissions_probe, core.settlement_ledger_probe"
rm -f "$LOG_DIR/probe.err"

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
    tail -40 "$LOG_DIR/db-integration.log"
    echo "FAIL | I* 앱 ↔ DB 통합 시험 실패 (test-results/db-integration.log)" | tee -a "$LOG_DIR/db-test.log"; exit 1
  fi
fi

pass=$(grep -c 'PASS |' "$LOG_DIR/db-test.log" || true)
fail=$(grep -c 'FAIL |' "$LOG_DIR/db-test.log" || true)
grep -o 'PASS | [^|]*' "$LOG_DIR/db-test.log" | sed 's/^PASS | /  ✓ /'
echo "== DB tests: pass=$pass fail=$fail"
[ "$fail" = 0 ] || exit 1

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
