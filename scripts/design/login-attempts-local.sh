#!/usr/bin/env bash
# 설계 초안 0007(로그인 시도 제한) 로컬 재현 시험. 정식 마이그레이션·CI 대상 아님.
# 안전장치
#  - 앱 환경(DATABASE_URL 등)을 쓰지 않는다. db-test.sh와 같은 로컬 시험 클러스터(유닉스 소켓, TCP 미수신)에
#    고유 이름의 폐기용 DB를 새로 만들고, 끝나면(실패 포함) 그 DB만 삭제한다. 같은 이름이 있으면 덮어쓰지 않고 중단.
#  - 서명 키는 가상 고정 fixture. 출력은 PASS/FAIL 라벨과 개수만(값·키 원문 없음).
# 사용: bash scripts/design/login-attempts-local.sh
set -euo pipefail
unset DATABASE_URL PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE PGSERVICE
cd "$(dirname "$0")/../.."

PG_BIN="${PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin /opt/homebrew/opt/postgresql@*/bin /usr/local/opt/postgresql@*/bin 2>/dev/null | sort -V | tail -1 || true)}"
[ -n "$PG_BIN" ] || PG_BIN=$(dirname "$(command -v initdb)")
if [ "$(uname)" = Darwin ]; then PG_LOCALE=C; else PG_LOCALE=C.UTF-8; fi
PORT="${PGPORT_TEST:-54329}"
SOCK=/tmp
if [ "$(id -u)" = 0 ]; then
  DATA="${PGDATA_TEST:-/var/lib/postgresql/fideon-test}"; as_pg() { su postgres -s /bin/bash -c "$*"; }
else
  DATA="${PGDATA_TEST:-$PWD/.local-pg}"; as_pg() { bash -c "$*"; }
fi
if [ ! -s "$DATA/PG_VERSION" ]; then
  as_pg "mkdir -p '$DATA' && '$PG_BIN/initdb' -D '$DATA' -U postgres --auth=trust --encoding=UTF8 --locale=$PG_LOCALE >/dev/null"
fi
if ! as_pg "'$PG_BIN/pg_ctl' -D '$DATA' status" >/dev/null 2>&1; then
  as_pg "'$PG_BIN/pg_ctl' -D '$DATA' -o \"-p $PORT -k $SOCK -c listen_addresses=''\" -l '$DATA/server.log' -w start" >/dev/null
fi

DB="fideon_design0007_$$"
LOG_DIR="${LOG_DIR:-test-results}/design-0007"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/results.log"; : > "$LOG"
rm -f "$LOG_DIR"/c-* "$LOG_DIR"/lt.* "$LOG_DIR"/tests.out   # 이전 실행 잔여 결과 제거(이 폴더의 시험 산출물만)
PSQL=(psql -X -q -h "$SOCK" -p "$PORT" -U postgres -v ON_ERROR_STOP=1)
if [ -n "$("${PSQL[@]}" -d postgres -At -c "select 1 from pg_database where datname = '$DB'")" ]; then
  echo "중단: 같은 이름의 DB가 이미 있음(덮어쓰지 않음)"; exit 1
fi
cleanup() { "${PSQL[@]}" -d postgres -c "drop database if exists $DB with (force)" >/dev/null 2>&1 || true; }
trap cleanup EXIT
"${PSQL[@]}" -d postgres -c "create database $DB" >/dev/null
pass() { echo "PASS | $1" >> "$LOG"; }
fail() { echo "FAIL | $1" | tee -a "$LOG"; exit 1; }

echo "== 폐기용 DB 준비(마이그레이션 0001~0006 + zz_grants + 시험 도우미)"
for f in db/migrations/0*.sql db/migrations/zz_grants.sql; do PGOPTIONS="-c client_min_messages=warning" "${PSQL[@]}" -d "$DB" -f "$f" >/dev/null; done
PGOPTIONS="-c client_min_messages=warning" "${PSQL[@]}" -d "$DB" -f db/tests/00_helpers.sql >/dev/null
echo "== 초안 적용(docs/design/0007-login-attempts/draft.sql)"
"${PSQL[@]}" -d "$DB" -f docs/design/0007-login-attempts/draft.sql >/dev/null
# 가상 고정 키 fixture(실제 키 아님): staff는 목적 재사용 시험용
"${PSQL[@]}" -d "$DB" -c "insert into security.server_keys (key_id, purpose, secret) values (1, 'staff', decode(repeat('11', 32), 'hex')), (1, 'login', decode(repeat('33', 32), 'hex'))" >/dev/null

echo "== 단일 세션 시험(tests.sql)"
if ! "${PSQL[@]}" -d "$DB" -f docs/design/0007-login-attempts/tests.sql > "$LOG_DIR/tests.out" 2>&1; then
  grep -o 'FAIL | .*' "$LOG_DIR/tests.out" | head -3 | tee -a "$LOG"; fail "tests.sql 실패"
fi
grep -o 'PASS | [^|]*' "$LOG_DIR/tests.out" | sed 's/ *$//' >> "$LOG"

TOKSQL() { # $1 단계 $2 대상 $3 IP $4 nonce → app_public 호출 SQL 한 줄
  local t; t=$("${PSQL[@]}" -d "$DB" -At -c "select test.token('login', array['reserve-request','$1',$2,$3,$4], 30)")
  echo "select api.login_attempt_reserve('$1', $2, $3, $4, '$t');"
}

echo "== 동시 10요청: 같은 대상·IP → 정확히 한도(5)만 예약"
pids=()
for i in $(seq 1 10); do
  TOKSQL password "repeat('5',64)" "repeat('5',64)" "test.d7_nonce(1000+$i)" > "$LOG_DIR/c-$i.sql"
done
for i in $(seq 1 10); do
  ( psql -X -q -At -h "$SOCK" -p "$PORT" -U app_server -d "$DB" -v ON_ERROR_STOP=1 -c "begin" -c "set local role app_public" -f "$LOG_DIR/c-$i.sql" -c "commit" > "$LOG_DIR/c-$i.out" 2>&1 ) &
  pids+=($!)
done
for p in "${pids[@]}"; do wait "$p" || true; done
ok=$(grep -lE '^[0-9a-f-]{36}$' "$LOG_DIR"/c-*.out | wc -l | tr -d ' ')
lim=$(grep -l 'LOGIN_RATE_LIMITED' "$LOG_DIR"/c-*.out | wc -l | tr -d ' ')
rows=$("${PSQL[@]}" -d "$DB" -At -c "select count(*) from security.login_attempts where subject_hmac = repeat('5',64) and ip_hash = repeat('5',64)")
[ "$ok" = 5 ] && [ "$lim" = 5 ] && [ "$rows" = 5 ] && pass "C1 동시 10요청 → 예약 5, 한도 거부 5, 행 5" || fail "C1 ok=$ok limited=$lim rows=$rows"

echo "== 교차 대상·IP 동시 12요청: 교착 없음(잠금 순서 대상 → IP)"
rm -f "$LOG_DIR"/c-*
pids=()
n=0
for s in 1 2 3; do for ip in 1 2 3 4; do n=$((n+1)); TOKSQL password "lpad('$s',64,'a')" "lpad('$ip',64,'b')" "test.d7_nonce(2000+$n)" > "$LOG_DIR/c-$n.sql"; done; done
for i in $(seq 1 $n); do
  ( psql -X -q -At -h "$SOCK" -p "$PORT" -U app_server -d "$DB" -v ON_ERROR_STOP=1 -c "begin" -c "set local role app_public" -f "$LOG_DIR/c-$i.sql" -c "commit" > "$LOG_DIR/c-$i.out" 2>&1 ) &
  pids+=($!)
done
for p in "${pids[@]}"; do wait "$p" || true; done
dead=$(cat "$LOG_DIR"/c-*.out | grep -c 'deadlock' || true)
ok=$(grep -lE '^[0-9a-f-]{36}$' "$LOG_DIR"/c-*.out | wc -l | tr -d ' ')
[ "$dead" = 0 ] && [ "$ok" = "$n" ] && pass "C2 교차 동시 $n요청 → 교착 0, 전부 예약" || fail "C2 deadlock=$dead ok=$ok/$n"

echo "== 잠금 대기 시간 제한: 다른 세션이 같은 대상 잠금을 4초 쥐면 2초 안에 실패"
TOKSQL password "repeat('6',64)" "repeat('6',64)" "test.d7_nonce(3001)" > "$LOG_DIR/lt.sql"
( "${PSQL[@]}" -d "$DB" -c "begin" -c "select pg_advisory_xact_lock(hashtextextended('fideon.login.subject:password:' || repeat('6',64), 0))" -c "select pg_sleep(4)" -c "commit" >/dev/null 2>&1 ) &
holder=$!
sleep 0.5
t0=$(date +%s)
psql -X -q -At -h "$SOCK" -p "$PORT" -U app_server -d "$DB" -v ON_ERROR_STOP=1 -c "begin" -c "set local role app_public" -f "$LOG_DIR/lt.sql" -c "commit" > "$LOG_DIR/lt.out" 2>&1 || true
t1=$(date +%s)
wait "$holder" || true
if grep -q 'lock timeout' "$LOG_DIR/lt.out" && [ $((t1 - t0)) -le 3 ]; then pass "C3 잠금 대기 2초 제한 → lock_timeout 실패(약 $((t1 - t0))초), 행 미생성"; else fail "C3 lock timeout 미동작($((t1 - t0))초)"; fi
[ "$("${PSQL[@]}" -d "$DB" -At -c "select count(*) from security.login_attempts where request_nonce = test.d7_nonce(3001)")" = 0 ] || fail "C3 행 생성됨"

echo "== 비밀값·원문 비출력: 시험 출력에 가상 키 원문(hex)·토큰이 없는지"
if grep -rqE '(3333333333333333|1111111111111111|[0-9]{1,6}\.[0-9]{9,12}\.[0-9a-f]{64})' "$LOG"; then fail "S1 결과 기록에 키·토큰 형식 문자열"; else pass "S1 결과 기록에 키·토큰 원문 없음"; fi

audit() { # $1 라벨 → 현재 catalog_audit 결과(위반 코드별 개수만 기록, 허용 목록을 넓히지 않음)
  local rc=0 aout codes
  aout=$(bash scripts/db-audit.sh "postgresql:///$DB?host=$SOCK&port=$PORT&user=release_auditor" 2>&1) || rc=$?
  codes=$( (printf '%s\n' "$aout" | grep -oE '^V[0-9]+' || true) | sort | uniq -c | awk '{print $2"×"$1}' | paste -sd, -)
  echo "INFO | $1 catalog_audit rc=$rc 위반 코드=${codes:-없음}" >> "$LOG"
}
echo "== 증거: 초안 권한 상태에서 현재 catalog_audit"
audit "E1 초안 적용 직후(초안이 app_public에 실행 권한 부여)"
echo "== 증거: 현재 zz_grants 재적용 → 초안 함수 실행 권한이 남는가"
PGOPTIONS="-c client_min_messages=warning" "${PSQL[@]}" -d "$DB" -f db/migrations/zz_grants.sql >/dev/null
keep=$("${PSQL[@]}" -d "$DB" -At -c "select has_function_privilege('app_public', 'api.login_attempt_reserve(text,text,text,text,text)', 'execute')::text || '/' || has_function_privilege('app_public', 'api.login_attempt_settle(uuid,text,text)', 'execute')::text")
echo "INFO | E2 zz_grants 재적용 후 app_public 실행 권한 reserve/settle = $keep" >> "$LOG"
audit "E3 zz_grants 재적용 후(초안 함수 실행 불가 상태)"

rm -f "$LOG_DIR"/c-* "$LOG_DIR"/lt.*
p=$(grep -c '^PASS |' "$LOG" || true); f=$(grep -c '^FAIL |' "$LOG" || true)
cat "$LOG"
echo "== 설계 초안 0007 로컬 시험: pass=$p fail=$f (폐기용 DB $DB 삭제)"
[ "$f" = 0 ]
