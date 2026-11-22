#!/usr/bin/env bash
# PM 11/21: 실제 Next 서버(next dev) → 실제 PostgreSQL 상담 경로 E2E. 가상 DB·무료 모의 모델만, 외부 호출·실제 AI·광고 없음.
# 안전장치: 이 실행이 새로 만든 TCP(127.0.0.1) 전용 폐기 클러스터·폐기 DB(fideon_lrs_<pid>_<8hex>)만 쓰고 끝나면 모두 지운다.
# next가 없으면 실패한다(CI에서는 건너뛰기 불가). 로컬에서 FIDEON_ALLOW_SKIP_NEXT_E2E=1일 때만 '미실행'(통과로 세지 않음).
set -uo pipefail
cd "$(dirname "$0")/../.."
unset DATABASE_URL PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE PGSERVICE
OUT=test-results/next-e2e; rm -rf "$OUT"; mkdir -p "$OUT"
if ! node -e "require.resolve('next/package.json')" >/dev/null 2>&1 || ! node -e "require.resolve('postgres')" >/dev/null 2>&1; then
  if [ "${FIDEON_ALLOW_SKIP_NEXT_E2E:-}" = 1 ] && [ "${CI:-}" != true ]; then echo "SKIP | next 미설치 — 미실행(통과로 세지 않음)" | tee "$OUT/result.txt"; exit 0; fi
  echo "FAIL | next 또는 postgres 드라이버 미설치(npm ci 필요)" | tee "$OUT/result.txt"; exit 1
fi
PG_BIN="${PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin /opt/homebrew/opt/postgresql@*/bin /usr/local/opt/postgresql@*/bin 2>/dev/null | sort -V | tail -1 || true)}"
[ -n "$PG_BIN" ] || PG_BIN=$(dirname "$(command -v initdb)")
if [ "$(uname)" = Darwin ]; then PG_LOCALE=C; else PG_LOCALE=C.UTF-8; fi
PGP=54331; WEB=3137
SOCK=$(mktemp -d /tmp/fideon-nx-sock.XXXXXX); chmod 777 "$SOCK"
if [ "$(id -u)" = 0 ]; then DATA="/var/lib/postgresql/fideon-next-e2e-$$"; as_pg() { su postgres -s /bin/bash -c "$*"; }
else DATA="$(mktemp -d /tmp/fideon-nx-data.XXXXXX)"; as_pg() { bash -c "$*"; }; fi
DB="fideon_lrs_$$_$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
NEXT_PID=""
cleanup() {
  rc=$?; trap - EXIT
  [ -n "$NEXT_PID" ] && kill "$NEXT_PID" 2>/dev/null && sleep 1; pkill -P "${NEXT_PID:-0}" 2>/dev/null
  as_pg "'$PG_BIN/pg_ctl' -D '$DATA' -m immediate -w stop" >/dev/null 2>&1
  as_pg "rm -rf '$DATA'" 2>/dev/null; rm -rf "$SOCK"
  exit $rc
}
trap cleanup EXIT
as_pg "mkdir -p '$DATA' && '$PG_BIN/initdb' -D '$DATA' -U postgres --auth=trust --encoding=UTF8 --locale=$PG_LOCALE >/dev/null" || { echo "FAIL | 폐기 클러스터 초기화 실패"; exit 1; }
as_pg "'$PG_BIN/pg_ctl' -D '$DATA' -o \"-p $PGP -k $SOCK -c listen_addresses=127.0.0.1\" -l '$DATA/server.log' -w start" >/dev/null || { echo "FAIL | 폐기 클러스터 시작 실패"; exit 1; }
PSQL=(psql -X -q -h 127.0.0.1 -p "$PGP" -U postgres -v ON_ERROR_STOP=1)
"${PSQL[@]}" -d postgres -c "create database \"$DB\"" || exit 1
for f in db/migrations/0*.sql db/migrations/zz_grants.sql; do "${PSQL[@]}" -d "$DB" -f "$f" >/dev/null || { echo "FAIL | 마이그레이션 $f"; exit 1; }; done
"${PSQL[@]}" -d "$DB" -f db/seed/test_seed.sql >/dev/null && "${PSQL[@]}" -d "$DB" -f db/seed/test_notices.sql >/dev/null && "${PSQL[@]}" -d "$DB" -f db/seed/test_notice_review.sql >/dev/null || { echo "FAIL | 가상 시드"; exit 1; }
export DATABASE_URL="postgresql://app_server@127.0.0.1:$PGP/$DB"
export E2E_ADMIN_URL="postgresql://postgres@127.0.0.1:$PGP/$DB"
export E2E_BASE="http://127.0.0.1:$WEB"
# 가상 인증·봇 확인 서버(check.mjs가 띄움, 이 프로세스 로컬 포트). 키는 모두 이 실행 전용 임시 값
FAKE=3138
export NEXT_PUBLIC_SUPABASE_URL="http://localhost:$FAKE" NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=test-publishable-key ADMIN_AUTH_MODE=supabase ADMIN_AD_SOURCE=db ADMIN_LEADS_SOURCE=db ADMIN_POLICY_SOURCE=db
export FIDEON_STAFF_SIGNING_KEY="1:$(printf '\x11%.0s' $(seq 1 32) | base64)" FIDEON_LEAD_SIGNING_KEY="1:$(printf '\x22%.0s' $(seq 1 32) | base64)"
export PII_ENC_KEYS="{\"1\":\"$(head -c 32 /dev/urandom | base64)\"}" PII_ENC_CURRENT=1 PII_HMAC_KEY="$(head -c 32 /dev/urandom | base64)" PII_IP_HASH_KEY="$(head -c 32 /dev/urandom | base64)"
export NEXT_PUBLIC_TURNSTILE_SITE_KEY=test-only-site-key TURNSTILE_SECRET_KEY=test-turnstile-secret TURNSTILE_VERIFY_URL_TEST="http://127.0.0.1:$FAKE/turnstile" PUBLIC_HOSTNAME=fideon.test PRIVACY_POLICY_VERSION=privacy-test-v1
export E2E_FAKE_PORT=$FAKE
export CONSULT_CHAT_ENABLED=true CONSULT_AI_MODEL=mock QUOTE_SUPPLIER_ID=supplier-a LEAD_INTAKE_MODE=local NEXT_TELEMETRY_DISABLED=1
export CONSULT_CHAT_CARRIER=carrier-x CONSULT_CHAT_PRODUCT=net500-tv-basic CONSULT_CHAT_REGION=region-1 NEXT_PUBLIC_PRIVACY_POLICY_VERSION=privacy-test-v1
export CONSULT_SESSION_KEY="$(head -c 32 /dev/urandom | base64)"
# 서버 환경: 관리자 인증·봇 확인은 가상 로컬 서버로 연결, AI 키·광고 키는 비워 둔다(실제 외부 호출 경로 없음)
env -u CONSULT_AI_API_KEY NODE_ENV=development ./node_modules/.bin/next dev -p "$WEB" -H 127.0.0.1 > "$OUT/next.log" 2>&1 &
NEXT_PID=$!
for i in $(seq 1 90); do
  curl -s -o /dev/null "http://127.0.0.1:$WEB/api/consult/chat" && break
  kill -0 "$NEXT_PID" 2>/dev/null || { echo "FAIL | next 서버가 종료됨"; tail -30 "$OUT/next.log"; exit 1; }
  sleep 1
done
node scripts/next-e2e/check.mjs | tee "$OUT/result.txt"
rc=${PIPESTATUS[0]}
[ "$rc" = 0 ] || { echo "--- next.log (끝 40줄)"; tail -40 "$OUT/next.log"; }
exit $rc
