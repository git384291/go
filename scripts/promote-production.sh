#!/usr/bin/env bash
# 운영 반영 (REV-005 5항). 사용자 본인이 자기 PC에서, 본인 Vercel·GitHub 로그인으로 실행한다.
# 저장소·CI·자동화에는 운영 배포 권한이 없다. 이 스크립트 실행 = 사용자 승인.
#
# 사용: bash scripts/promote-production.sh <검수 배포 URL> <커밋 40자리> <검수 문서 번호>
# 필요: gh(로그인), vercel CLI(로그인, 프로젝트 link 완료)
#
# 확인 순서
#   1) 그 커밋·검수 번호로 실행한 release-check가 성공했는가 (GitHub)
#   2) 승격할 검수 배포가 정말 그 커밋으로 만든 것인가 (Vercel이 GitHub에 남긴 배포 기록)
#   3) 사용자가 화면에서 직접 'yes' 입력
#   4) vercel promote → 운영 빌드는 운영 환경변수로 다시 빌드된다(Vercel 동작)
#
# [첫 사용 시 확인] Vercel GitHub 연동이 남기는 배포 기록의 environment 이름·URL 형식
set -euo pipefail
URL="${1:?preview deployment URL}"
SHA="${2:?commit sha (40 hex)}"
REVIEW="${3:?review id, e.g. FIDEON-PM-REV-006}"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "invalid sha"; exit 1; }
[[ "$REVIEW" =~ ^FIDEON-PM-REV-[0-9]{3,}$ ]] || { echo "invalid review id"; exit 1; }
HOST=$(printf '%s' "$URL" | sed -E 's#^https?://##; s#/.*$##')

echo "1) release-check 성공 기록 확인"
ok=$(gh run list --workflow release-check.yml --status success --limit 50 \
       --json displayTitle --jq "[.[] | select(.displayTitle == \"release-check $SHA $REVIEW\")] | length")
[ "$ok" -ge 1 ] || { echo "STOP: '$SHA $REVIEW' 에 대한 성공한 release-check가 없다"; exit 1; }

echo "2) 검수 배포가 이 커밋으로 만들어졌는지 확인"
repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
found=$(gh api "repos/$repo/deployments?sha=$SHA&per_page=50" --jq '.[].id' | while read -r id; do
  gh api "repos/$repo/deployments/$id/statuses" --jq '.[].environment_url // empty, .[].target_url // empty'
done | grep -c "$HOST" || true)
[ "$found" -ge 1 ] || { echo "STOP: $HOST 는 커밋 $SHA 의 배포 기록에 없다"; exit 1; }

echo "3) 확인"
echo "   커밋   $SHA"
echo "   검수   $REVIEW"
echo "   배포   $URL"
read -r -p "운영에 반영하려면 yes 입력: " answer
[ "$answer" = "yes" ] || { echo "취소"; exit 1; }

echo "4) 승격"
vercel promote "$URL"
echo "완료. 기록: $(date -u +%FT%TZ) $SHA $REVIEW $URL by $(gh api user --jq .login)" | tee -a "$HOME/.fideon-promotions.log"
