#!/usr/bin/env bash
# REV-005 3항: 실제 Vercel 검수 배포에서 위조 IP 헤더로 횟수 제한 버킷을 바꿀 수 없는지 확인한다.
# 준비: 검수(Preview) 환경변수 DIAG_IP_ENABLED=1, PII 키 설정 후 배포. 확인이 끝나면 DIAG_IP_ENABLED를 지운다.
# 사용: bash scripts/verify-ip-spoofing.sh https://<preview-deployment>.vercel.app
#   검수 배포에 Vercel 배포 보호가 켜져 있으면 VERCEL_BYPASS=<protection bypass 토큰>을 함께 준다.
set -euo pipefail
BASE="${1:?preview deployment URL required}"
H=()
[ -n "${VERCEL_BYPASS:-}" ] && H+=(-H "x-vercel-protection-bypass: $VERCEL_BYPASS")

call() { curl -sS -f "${H[@]}" "$@" "$BASE/api/diag/ip"; }

base=$(call)
echo "기준 (위조 헤더 없음): $base"
grep -q '"fallback":false' <<<"$base" || { echo "FAIL: Vercel이 x-real-ip를 주지 않음(공용 버킷으로 떨어짐)"; exit 1; }

fail=0
for spoof in \
  "-H x-forwarded-for:1.2.3.4" \
  "-H x-real-ip:5.6.7.8" \
  "-H x-forwarded-for:9.9.9.9,8.8.8.8 -H x-real-ip:7.7.7.7" \
  "-H x-vercel-forwarded-for:6.6.6.6"; do
  # shellcheck disable=SC2086
  got=$(call $spoof)
  if [ "$got" = "$base" ]; then echo "PASS 위조 무시: $spoof"; else echo "FAIL 버킷이 바뀜: $spoof → $got"; fail=1; fi
done
[ "$fail" = 0 ] && echo "RESULT: 위조 IP 헤더로 횟수 제한 버킷을 바꿀 수 없음" || { echo "RESULT: FAIL"; exit 1; }
