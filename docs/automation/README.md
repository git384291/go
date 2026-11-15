# Claude 검토 연결

## 현재 상태

- 사용자 제공 Mac 터미널 기록에서 Claude Code `Login successful.`을 확인했다.
- Mac 로그인과 GitHub Actions 인증은 별개다. GitHub에는 Actions secret `CLAUDE_CODE_OAUTH_TOKEN`을 등록한다.
- 현재 연결의 GitHub Secrets 목록 조회는 403으로 거부돼 등록 여부를 단정할 수 없다.
- 이전 `@claude` 시험 댓글에 대한 응답은 확인되지 않았다. 아래 라벨 방식으로 새 검토를 시작한다.

## 검토 실행 방식

`.github/workflows/claude-review.yml`은 `pull_request: labeled` 이벤트를 사용한다. 기능 브랜치의 Draft PR에서 동작하도록 구성해 `main` 변경을 요구하지 않는다.

아래 조건이 모두 맞을 때만 검토한다.

- 저장소 `git384291/go`, Draft PR #1
- 같은 저장소의 `phase1-product-scope` 브랜치
- 저장소 소유자가 `claude-review` 라벨을 새로 추가
- 저장소 변수 `FIDEON_CLAUDE_REVIEW_ENABLED=true`
- Actions secret `CLAUDE_CODE_OAUTH_TOKEN` 등록 완료

정확한 검토 대상은 라벨 이벤트 시점의 head 커밋이다. push나 댓글만으로 매번 Claude를 호출하지 않는다. 재검토는 라벨을 제거한 뒤 다시 추가한다.

## 권한과 제한

- GitHub 토큰: 코드 읽기·CI 읽기·PR/이슈 응답. 코드 쓰기·병합·배포 권한은 부여하지 않는다.
- 체크아웃한 Git 자격 증명은 유지하지 않는다.
- Claude 기본 도구는 Read·Glob·Grep만 제공하며 셸·편집 도구는 금지한다. 진행 댓글은 Action의 GitHub 연동으로 작성한다.
- 최대 10턴·15분으로 제한한다. 실행 시 Claude 구독 사용량과 GitHub Actions 사용량이 발생할 수 있다.
- `main` 병합, 운영 배포, PHASE 2 활성화, 실제 고객정보 수집은 계속 보류한다.

## Mac에서 한 번 필요한 인증 등록

공식 Action은 Pro/Max 사용자의 `claude setup-token` OAuth 토큰을 지원한다. 계정이 지원하지 않으면 중단하고 결과를 확인한다. 별도 유료 API 방식으로 자동 전환하지 않는다.

1. Mac 터미널에서 다음 명령을 실행하고 공식 브라우저 인증을 완료한다.

   ```bash
   npx --yes --package @anthropic-ai/claude-code claude setup-token
   ```

2. 생성된 토큰은 Mac에서만 복사한다. 채팅·스크린샷·저장소·댓글에 보내지 않는다.
3. 아래 명령을 실행하고 `Paste your secret` 입력란에 토큰을 붙여넣어 제출한다. 셸 명령 인자에 토큰을 직접 넣지 않는다. GitHub CLI가 없거나 로그인이 필요하면 해당 오류부터 확인한다.

   ```bash
   gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo git384291/go
   ```

4. 등록 성공 후 아래 명령으로 검토 스위치를 켠다.

   ```bash
   gh variable set FIDEON_CLAUDE_REVIEW_ENABLED --repo git384291/go --body true
   ```

인증 정보는 이 Cloud 환경으로 복사하지 않는다. Claude 검토는 GitHub 실행기에서 수행한다.

## 연결 검증과 중지

인증 등록 후 PR #1에 `claude-review` 라벨을 추가하고, 해당 워크플로 성공과 실제 Claude 응답을 모두 확인한다. 둘 다 확인하기 전에는 연결 완료로 보고하지 않는다. CI 성공은 Claude 인증 성공을 대신하지 않는다.

중지는 활성화 변수를 `false`로 바꾼다. 진행 중인 작업은 별도로 취소해야 한다. 토큰 폐기 시에는 GitHub secret과 Claude 계정의 토큰 관리도 함께 확인한다.

## 공식 근거

- [Claude Code Action 설정](https://github.com/anthropics/claude-code-action/blob/main/docs/setup.md)
- [Action 입력값](https://github.com/anthropics/claude-code-action/blob/main/action.yml)
- [GitHub pull_request 이벤트](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request)
