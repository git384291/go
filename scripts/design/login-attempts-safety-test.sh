#!/usr/bin/env bash
# login-attempts-local.sh의 안전장치 시험: 동명 DB 존재·생성 실패·중간 실패·다른 클러스터·이름 형식에서
# 기존 DB(감시용)를 지우지 않고, 각 실행이 직접 만든 DB만 정리하는지 확인한다. 가짜 fixture만 사용.
set -euo pipefail
unset DATABASE_URL PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE PGSERVICE
cd "$(dirname "$0")/../.."
PORT="${PGPORT_TEST:-54329}"
P=(psql -X -q -h /tmp -p "$PORT" -U postgres -v ON_ERROR_STOP=1)
MAIN=scripts/design/login-attempts-local.sh
rnd() { od -An -N4 -tx1 /dev/urandom | tr -d ' \n'; }
exists() { [ -n "$("${P[@]}" -d postgres -At -c "select 1 from pg_database where datname = '$1'")" ]; }
results=(); ok=1
check() { if eval "$2"; then results+=("PASS | $1"); else results+=("FAIL | $1"); ok=0; fi; }

# 시험 클러스터에 연결할 수 없을 때만 기본 스크립트를 1회 실행해 클러스터를 준비한다(CI에서는 이미 떠 있어 실행 안 함).
if ! "${P[@]}" -d postgres -At -c "select 1" >/dev/null 2>&1; then bash "$MAIN" >/dev/null 2>&1 || true; fi
SENT="fideon_design0007_sentinel_$(rnd)"
sent_created=0
cleanup() { if [ "$sent_created" = 1 ]; then "${P[@]}" -d postgres -c "drop database if exists \"$SENT\" with (force)" >/dev/null 2>&1 || true; fi; }
trap cleanup EXIT
"${P[@]}" -d postgres -c "create database \"$SENT\"" >/dev/null && sent_created=1
"${P[@]}" -d "$SENT" -c "create table marker(v text); insert into marker values ('keep')" >/dev/null
sentinel_ok() { exists "$SENT" && [ "$("${P[@]}" -d "$SENT" -At -c "select v from marker")" = keep ]; }
members_before=$("${P[@]}" -d postgres -At -c "select count(*) from pg_auth_members")

rc=0; FIDEON_D7_DB_NAME="$SENT" bash "$MAIN" >/dev/null 2>&1 || rc=$?
check "G1 동명 DB 존재 → 중단(rc=3), 기존 DB·내용 유지" '[ "$rc" = 3 ] && sentinel_ok'

N1="fideon_design0007_safety_$(rnd)"
rc=0; FIDEON_D7_DB_NAME="$N1" FIDEON_D7_FAIL_AT=create bash "$MAIN" >/dev/null 2>&1 || rc=$?
check "G2 생성 실패 → 중단(rc=4), 그 이름의 DB 없음, 기존 DB 유지(정리 미시도)" '[ "$rc" = 4 ] && ! exists "$N1" && sentinel_ok'

N2="fideon_design0007_safety_$(rnd)"
rc=0; FIDEON_D7_DB_NAME="$N2" FIDEON_D7_FAIL_AT=midway bash "$MAIN" >/dev/null 2>&1 || rc=$?
check "G3 중간 실패 → 중단(rc=5), 이 실행이 만든 DB만 삭제, 기존 DB 유지" '[ "$rc" = 5 ] && ! exists "$N2" && sentinel_ok'

N3="fideon_design0007_safety_$(rnd)"
rc=0; FIDEON_D7_DB_NAME="$N3" FIDEON_D7_EXPECT_DATA=/nonexistent/other-cluster bash "$MAIN" >/dev/null 2>&1 || rc=$?
members_after=$("${P[@]}" -d postgres -At -c "select count(*) from pg_auth_members")
check "G4 예상과 다른 클러스터 → 중단(rc=2), DB 미생성, 역할 멤버십 변화 없음" '[ "$rc" = 2 ] && ! exists "$N3" && [ "$members_before" = "$members_after" ] && sentinel_ok'

rc=0; FIDEON_D7_DB_NAME=postgres bash "$MAIN" >/dev/null 2>&1 || rc=$?
check "G5 형식 밖 이름(postgres) → 중단(rc=2), postgres DB 유지" '[ "$rc" = 2 ] && exists postgres'

leftover=$("${P[@]}" -d postgres -At -c "select count(*) from pg_database where datname like 'fideon_design0007_safety_%'")
check "G6 시험이 만든 폐기용 DB 잔여 0" '[ "$leftover" = 0 ]'

printf '%s\n' "${results[@]}"
echo "== 안전장치 시험: pass=$(printf '%s\n' "${results[@]}" | grep -c '^PASS') fail=$(printf '%s\n' "${results[@]}" | grep -c '^FAIL' || true) (감시용 DB는 이 시험이 만든 것만 삭제)"
[ "$ok" = 1 ]
