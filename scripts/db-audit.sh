#!/usr/bin/env bash
# DB 권한 점검. 위반이 하나라도 있으면 실패(종료 코드 1).
# 사용: bash scripts/db-audit.sh "<release_auditor 연결 문자열>"
#   - 운영 배포 전(release-check.yml): 운영 DB에 읽기 전용 점검 계정으로 실행
#   - 로컬 테스트(db-test.sh): 테스트 DB에 같은 계정으로 실행
set -euo pipefail
cd "$(dirname "$0")/.."
URL="${1:?connection string for release_auditor required}"

out=$(psql "$URL" -X -q -A -t -v ON_ERROR_STOP=1 -f db/audit/catalog_audit.sql)
if [ -n "$out" ]; then
  echo "DB AUDIT FAILED ($(printf '%s\n' "$out" | wc -l) violations):"
  printf '%s\n' "$out"
  exit 1
fi
echo "DB AUDIT PASSED (0 violations)"
