#!/usr/bin/env bash
# 마스킹 목록 어댑터(src/server/admin/leadsReadStore.ts) 실제 PostgreSQL 통합 시험 (PM 6909719658).
# 로컬 수동 실행 + GitHub Actions CI(scripts/db-test.sh 기본 검사·설계 초안 시험 통과 뒤)에서 별도 폐기 DB로 명시 실행.
# 안전장치(scripts/design/login-attempts-local.sh와 같은 방식)
#  - 앱 환경(DATABASE_URL 등)·실키를 쓰지 않는다. 유닉스 소켓만 쓰는 TCP 미수신 로컬 시험 클러스터인지 먼저 확인하고,
#    확인 전에는 DDL을 실행하지 않는다.
#  - 고유 이름의 폐기용 DB를 새로 만들고(같은 이름이 있으면 중단), 생성에 성공한 뒤에만 정리 대상으로 표시한다.
#    끝나면(실패 포함) 그 DB만 삭제한다. fideon_test·다른 DB는 건드리지 않는다.
#  - 집계는 기존 DB(176)·설계 초안(57)·안전장치(6)와 섞지 않는다. 드라이버가 없으면 SKIP이 아니라 실패한다.
# 사용: bash scripts/integration/leads-read-store-pg.sh
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

LOG_DIR="${LOG_DIR:-test-results}/leads-read-store-pg"
mkdir -p "$LOG_DIR"
rm -f "$LOG_DIR"/*.log
PSQL=(psql -X -q -h "$SOCK" -p "$PORT" -U postgres -v ON_ERROR_STOP=1)

# 안전 1: 이 스크립트의 로컬 시험 클러스터인지 확인(TCP 미수신·포트·데이터 경로). 아니면 아무것도 바꾸지 않고 중단
EXPECT_DATA="${FIDEON_LRS_EXPECT_DATA:-$DATA}"
cluster=$("${PSQL[@]}" -d postgres -At -F '|' -c "select current_setting('listen_addresses'), current_setting('port'), current_setting('data_directory')" 2>/dev/null) \
  || { echo "중단: 시험 클러스터에 연결할 수 없음(변경 없음)"; exit 2; }
IFS='|' read -r c_listen c_port c_data <<< "$cluster"
real() { (cd "$1" 2>/dev/null && pwd -P) || echo "$1"; }
if [ -n "$c_listen" ] || [ "$c_port" != "$PORT" ] || [ "$(real "$c_data")" != "$(real "$EXPECT_DATA")" ]; then
  echo "중단: 예상한 로컬 시험 클러스터가 아님(TCP 수신·포트·데이터 경로 불일치). 역할·DB를 변경하지 않음"; exit 2
fi

# 안전 2: 고유 이름, 이미 있으면 중단. 생성 성공 뒤에만 정리 대상으로 표시
DB="fideon_lrs_$$_$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
[[ "$DB" =~ ^fideon_lrs_[a-z0-9_]{1,40}$ ]] || { echo "중단: DB 이름 형식 오류"; exit 2; }
if [ -n "$("${PSQL[@]}" -d postgres -At -c "select 1 from pg_database where datname = '$DB'")" ]; then
  echo "중단: 같은 이름의 DB가 이미 있음(덮어쓰지 않음)"; exit 3
fi
created_by_this_run=0
cleanup() {
  local rc=$?
  if [ "$created_by_this_run" = 1 ]; then
    "${PSQL[@]}" -d postgres -c "drop database if exists \"$DB\" with (force)" >/dev/null 2>&1 || true
    left=$("${PSQL[@]}" -d postgres -At -c "select count(*) from pg_database where datname = '$DB'" 2>/dev/null || echo '?')
    echo "== 정리: 이 실행이 만든 폐기 DB 잔여 ${left}개"
  fi
  exit $rc
}
trap cleanup EXIT
"${PSQL[@]}" -d postgres -c "create database \"$DB\"" >/dev/null || { echo "중단: DB 생성 실패(정리할 DB 없음)"; exit 4; }
created_by_this_run=1

echo "== 폐기용 DB 준비(마이그레이션 0001~0006 + zz_grants + 가상 fixture)"
for f in db/migrations/0*.sql db/migrations/zz_grants.sql; do PGOPTIONS="-c client_min_messages=warning" "${PSQL[@]}" -d "$DB" -f "$f" >/dev/null; done
"${PSQL[@]}" -d "$DB" -f tests/pg-integration/leads-read-store.fixture.sql >/dev/null

echo "== 목록 어댑터 PG 통합 시험(app_server → withRoleOn('staff') → api.list_leads)"
if ! node -e "require.resolve('postgres')" >/dev/null 2>&1; then
  echo "FAIL | postgres 드라이버 미설치: npm ci 후 다시 실행(SKIP으로 통과시키지 않음)"; exit 1
fi
if FIDEON_LRS_PGSOCK="$SOCK" FIDEON_LRS_PGPORT="$PORT" FIDEON_LRS_PGDATABASE="$DB" \
     node --conditions=react-server --import tsx --test --test-reporter=tap tests/pg-integration/leads-read-store.pg.ts > "$LOG_DIR/results.log" 2>&1; then
  ok=1
else
  ok=0
fi
grep -E '^# NOTE' "$LOG_DIR/results.log" || true
grep -E '^(not )?ok ' "$LOG_DIR/results.log" | sed -E 's/^ok [0-9]+ - /PASS | /; s/^not ok [0-9]+ - /FAIL | /'
p=$(grep -cE '^ok ' "$LOG_DIR/results.log" || true)
f=$(grep -cE '^not ok ' "$LOG_DIR/results.log" || true)
echo "== 목록 어댑터 PG 통합 시험: pass=$p fail=$f (기존 DB·초안·안전장치 집계와 별도)"
if [ "$ok" != 1 ] || [ "$f" != 0 ] || [ "$p" = 0 ]; then
  grep -vE '^\s+at ' "$LOG_DIR/results.log" | tail -40
  exit 1
fi
