#!/usr/bin/env bash
# leads-read-store-pg.sh 정리·안전장치 시험(PM 6910895023). 실제 PostgreSQL·다른 DB를 조작하지 않는다.
# 가짜 psql·node(PATH 앞에 둠)와 가짜 pg_ctl·initdb(PG_BIN)를 임시 폴더에 만들고, 동작 모드를 환경변수로 바꿔 가며 실행한다.
# 가짜 명령은 호출 기록만 남긴다. 실제 클러스터·소켓에는 연결하지 않는다.
set -euo pipefail
cd "$(dirname "$0")/../.."
RUNNER="$PWD/scripts/integration/leads-read-store-pg.sh"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
chmod 755 "$TMP"
FAKE="$TMP/bin"; mkdir -p "$FAKE"; chmod 755 "$FAKE"
DATA="$TMP/data"; mkdir -p "$DATA"; echo 16 > "$DATA/PG_VERSION"; chmod -R 777 "$DATA"
CALLS="$TMP/calls.log"; : > "$CALLS"; chmod 666 "$CALLS"

cat > "$FAKE/psql" <<'EOF'
#!/usr/bin/env bash
# 가짜 psql: 실제 DB에 연결하지 않는다
args="$*"
echo "psql $args" >> "$FAKE_CALLS"
case "$args" in
  *"current_setting('listen_addresses')"*)
    [ "${FAKE_MODE:-}" = not_ours ] && { echo "*|54329|$FAKE_DATA"; exit 0; }
    echo "|54329|$FAKE_DATA"; exit 0 ;;
  *"count(*) from pg_database"*)
    if grep -q "drop database" "$FAKE_CALLS"; then
      case "${FAKE_MODE:-}" in left1) echo 1 ;; left_query_fail) exit 1 ;; *) echo 0 ;; esac
    else
      case "${FAKE_MODE:-}" in exists) echo 1 ;; exists_query_fail) exit 1 ;; *) echo 0 ;; esac
    fi
    exit 0 ;;
  *"create database"*) [ "${FAKE_MODE:-}" = create_fail ] && exit 1; exit 0 ;;
  *"drop database"*) [ "${FAKE_MODE:-}" = drop_fail ] && exit 1; exit 0 ;;
  *) exit 0 ;;
esac
EOF
cat > "$FAKE/node" <<'EOF'
#!/usr/bin/env bash
# 가짜 node: 드라이버 확인은 통과, 시험 실행은 모드에 따라 성공/실패 TAP만 출력
echo "node $*" >> "$FAKE_CALLS"
case "$*" in
  *require.resolve*) exit 0 ;;
esac
if [ "${FAKE_TEST:-pass}" = fail ]; then echo "not ok 1 - fake"; exit 1; fi
echo "ok 1 - fake"; exit 0
EOF
cat > "$FAKE/pg_ctl" <<'EOF'
#!/usr/bin/env bash
echo "pg_ctl $*" >> "$FAKE_CALLS"
case "$*" in
  *" status"*) [ "${FAKE_CLUSTER:-running}" = running ] && exit 0; exit 3 ;;
  *) exit 0 ;;
esac
EOF
cat > "$FAKE/initdb" <<'EOF'
#!/usr/bin/env bash
echo "initdb $*" >> "$FAKE_CALLS"; exit 0
EOF
chmod 755 "$FAKE"/*

pass=0; failn=0
ok() { echo "PASS | $1"; pass=$((pass + 1)); }
ng() { echo "FAIL | $1"; failn=$((failn + 1)); }

# 실행: 모드 환경변수만 바꾼다. 실제 PG 환경(DATABASE_URL 등)은 비운다
run() {
  : > "$CALLS"
  set +e
  env -u DATABASE_URL PATH="$FAKE:$PATH" PG_BIN="$FAKE" PGDATA_TEST="$DATA" FIDEON_LRS_EXPECT_DATA="$DATA" LOG_DIR="$TMP/out" \
    FAKE_CALLS="$CALLS" FAKE_DATA="$DATA" "$@" bash "$RUNNER" > "$TMP/run.out" 2>&1
  rc=$?
  set -e
}
count() { grep -c "$1" "$CALLS" || true; }

run FAKE_MODE=ok
[ "$rc" = 0 ] && [ "$(count 'create database')" = 1 ] && [ "$(count 'drop database')" = 1 ] && grep -q '잔여 0개' "$TMP/run.out" \
  && ok "S1 정상: 생성 1·삭제 1·잔여 0 → 0" || ng "S1 정상 rc=$rc"
[ "$(count 'pg_ctl.*stop')" = 0 ] && ok "S1b 기존 클러스터 재사용 → 중지하지 않음" || ng "S1b 재사용 클러스터를 중지함"

run FAKE_MODE=drop_fail
[ "$rc" = 6 ] && grep -q '삭제 실패' "$TMP/run.out" && ok "S2 삭제 실패 → 성공이었어도 6" || ng "S2 삭제 실패 rc=$rc"

run FAKE_MODE=left1
[ "$rc" = 6 ] && grep -q '잔여 1개' "$TMP/run.out" && ok "S3 잔여 1 → 6" || ng "S3 잔여 1 rc=$rc"

run FAKE_MODE=left_query_fail
[ "$rc" = 6 ] && grep -q '잔여 확인 실패' "$TMP/run.out" && ok "S4 잔여 조회 실패 → 6" || ng "S4 잔여 조회 실패 rc=$rc"

run FAKE_MODE=create_fail
[ "$rc" = 4 ] && [ "$(count 'drop database')" = 0 ] && ok "S5 생성 실패 → 4, 삭제 시도 없음" || ng "S5 생성 실패 rc=$rc"

run FAKE_MODE=exists
[ "$rc" = 3 ] && [ "$(count 'create database')" = 0 ] && [ "$(count 'drop database')" = 0 ] && ok "S6 같은 이름 존재 → 3, 생성·삭제 없음(기존 DB 보호)" || ng "S6 기존 DB 보호 rc=$rc"

run FAKE_MODE=exists_query_fail
[ "$rc" = 2 ] && [ "$(count 'create database')" = 0 ] && ok "S7 기존 DB 확인 실패 → 2, 생성 없음" || ng "S7 확인 실패 rc=$rc"

run FAKE_MODE=not_ours
[ "$rc" = 2 ] && [ "$(count 'create database')" = 0 ] && [ "$(count '\-f ')" = 0 ] && ok "S8 예상 클러스터 아님(TCP 수신) → 2, DDL·생성 없음" || ng "S8 클러스터 불일치 rc=$rc"

run FAKE_MODE=ok FAKE_TEST=fail
[ "$rc" = 1 ] && [ "$(count 'drop database')" = 1 ] && ok "S9 시험 실패 + 정리 성공 → 원래 실패 코드 1 보존" || ng "S9 rc=$rc"

run FAKE_MODE=drop_fail FAKE_TEST=fail
[ "$rc" = 1 ] && grep -q '삭제 실패' "$TMP/run.out" && ok "S10 시험 실패 + 정리 실패 → 원래 실패 코드 1 보존, 정리 실패도 표시" || ng "S10 rc=$rc"

run FAKE_MODE=ok FAKE_CLUSTER=stopped
[ "$rc" = 0 ] && [ "$(count 'pg_ctl.*start')" = 1 ] && [ "$(count 'pg_ctl.*stop')" = 1 ] && ok "S11 이 실행이 시작한 클러스터만 종료 때 중지" || ng "S11 rc=$rc"

run FAKE_MODE=not_ours FAKE_CLUSTER=stopped
[ "$rc" = 2 ] && [ "$(count 'pg_ctl.*stop')" = 1 ] && ok "S12 조기 중단에도 이 실행이 시작한 클러스터 정리" || ng "S12 rc=$rc"

echo "== 목록 어댑터 PG runner 안전장치 시험: pass=$pass fail=$failn (가짜 명령만, 실제 DB 조작 없음)"
[ "$failn" = 0 ] && [ "$pass" -gt 0 ]
