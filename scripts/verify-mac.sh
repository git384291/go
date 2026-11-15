#!/usr/bin/env bash
# REV-006 3항: 개발 PC(Mac)에서 Next.js 통합 검증을 실행하고 원문 기록을 남긴다.
# PHASE 1 보완 5항: 전체 타입 검사·Lint·Next.js 빌드·실제 브라우저 E2E를 이 스크립트 한 번으로 실행한다.
# 사용: bash scripts/verify-mac.sh
# - 단계가 실패해도 검사를 건너뛰거나 끄지 않는다. 각 단계의 종료 코드와 출력 원문을 그대로 남긴다.
# - 비밀값은 기록하지 않는다(.env* 내용은 출력하지 않음).
# - 상담 신청 실제 수집은 끈 상태로 실행한다(LEAD_INTAKE_MODE 미설정 → 접수 차단).
set -uo pipefail
cd "$(dirname "$0")/.."
TS=$(date +%Y%m%d-%H%M%S)
OUT="verify-results/$TS"
mkdir -p "$OUT"
SUMMARY="$OUT/summary.txt"
: > "$SUMMARY"

step() { # step <이름> <명령...>
  local name="$1"; shift
  echo "== $name"
  local start=$(date +%s)
  ( "$@" ) > "$OUT/$name.log" 2>&1
  local code=$?
  printf '%-22s exit=%-3s %ss\n' "$name" "$code" "$(( $(date +%s) - start ))" | tee -a "$SUMMARY"
  [ $code -eq 0 ] || tail -n 30 "$OUT/$name.log"
  return $code
}

env_info() {
  echo "arch: $(uname -m)"
  sw_vers 2>/dev/null || uname -a
  echo "node: $(node -v 2>&1)"
  echo "npm: $(npm -v 2>&1)"
  echo "git HEAD: $(git rev-parse HEAD)"
  echo "git status:"; git status --short
  echo "package-lock.json: $([ -f package-lock.json ] && echo present || echo absent)"
}
step 00-env env_info

# 1~2) lockfile이 없을 때만 npm install로 생성한다. 이후 검증은 npm ci 결과로 한다.
if [ ! -f package-lock.json ]; then
  step 01-npm-install npm install --no-audit --no-fund
fi
step 02-npm-ci npm ci --no-audit --no-fund || { echo "npm ci 실패 → 이후 단계 중단"; exit 1; }
step 03-typecheck npm run -s typecheck
step 04-lint npm run -s lint
step 05-unit npm run -s test:unit
step 05b-route npm run -s test:route   # 예약 상품 API 차단(403 PRODUCT_NOT_ACTIVE) 정확 검증
step 06-build npm run -s build

# 7) 실제 Next.js 서버(프로덕션 빌드)를 띄우고 8) 실제 브라우저로 모바일 화면 검사
PORT=3100
step 07-browsers npx playwright install chromium webkit
# PHASE 1: 화면 미리보기 검사(예약 상품·외부 상담 연결 노출, 예약 상세 404). 브라우저 설치 후 실행
step 07b-preview npm run -s test:preview -- "$OUT/preview"
if [ -f .next/BUILD_ID ]; then
  ( env -u LEAD_INTAKE_MODE npx next start -p $PORT > "$OUT/07-next-start.log" 2>&1 ) &
  SERVER_PID=$!
  for _ in $(seq 1 60); do curl -fs "http://127.0.0.1:$PORT/" -o /dev/null && break; sleep 1; done
  step 08-e2e-mobile npx tsx tests/e2e/mobile-real.ts "http://127.0.0.1:$PORT" "$OUT/screens"
  kill $SERVER_PID 2>/dev/null; wait $SERVER_PID 2>/dev/null
else
  echo "08-e2e-mobile          skipped (빌드 실패)" | tee -a "$SUMMARY"
fi

# 로컬 PostgreSQL이 있으면 DB 테스트도 실행
if command -v initdb >/dev/null 2>&1 || ls -d /opt/homebrew/opt/postgresql@*/bin >/dev/null 2>&1; then
  step 09-db-test npm run -s test:db
  step 09b-restore npm run -s test:restore   # 덤프·복구 후 권한 상태 = 원본, 배포 전 점검 통과(CI와 같은 절차)
else
  echo "09-db-test             skipped (PostgreSQL 미설치: brew install postgresql@16)" | tee -a "$SUMMARY"
fi

echo; echo "결과: $OUT"; cat "$SUMMARY"
grep -q 'exit=[1-9]' "$SUMMARY" && exit 1 || exit 0
