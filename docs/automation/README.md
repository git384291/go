# Claude 연결 준비

## 현재 상태

- 사용자는 Claude 웹사이트를 사용했다. 기존 웹 대화는 이 환경에서 자동으로 이어지지 않는다.
- GitHub에 Claude 앱 이름의 check suite가 있지만, 실제 자동 실행 설정·응답은 확인되지 않았다.
- [PR #1의 연결 시험 요청](https://github.com/git384291/go/pull/1#issuecomment-6894210826)을 보냈다. 요청 댓글 작성 성공은 Claude 실행 성공을 의미하지 않는다.
- 현재 연결의 GitHub Secrets 조회는 403으로 거부됐다. 인증 정보의 존재 여부를 단정할 수 없다.

## 준비한 설정

`claude-review.yml.example`은 **실행되지 않는 검토용 초안**이다. 저장소 소유자가 PR #1에 `@claude`를 작성할 때 읽기 전용 검토를 요청하는 방식이다.

- 기본 스위치 꺼짐: `FIDEON_CLAUDE_REVIEW_ENABLED=true`가 없으면 실행하지 않는다.
- 현재 기능 브랜치의 열린 Draft PR #1만 허용한다.
- GitHub 토큰은 코드 읽기와 PR·이슈 응답에 한정한다. 코드 쓰기·병합·배포 권한은 부여하지 않는다.
- Claude에는 코드 편집·셸 실행 도구를 금지한다. 개발 자동화 전체가 아니라 우선 검토 응답부터 연결한다.
- 실행 시에는 Claude 사용량과 GitHub Actions 사용량이 발생할 수 있다. 현재 초안은 이를 발생시키지 않는다.

## 실제 연결 전에 필요한 일

1. 사용자가 Claude 인증 방식을 선택한다. 공식 안내상 Pro/Max의 Claude Code OAuth 토큰 또는 별도 Anthropic API 키를 사용할 수 있다. 웹 로그인만으로 GitHub Actions 인증이 완료되지는 않는다.
2. 현재 초안은 OAuth 방식이다. 사용자 기기에 Claude Code가 준비되면 `claude setup-token`으로 생성한 값을 저장소 **Settings → Secrets and variables → Actions**에 `CLAUDE_CODE_OAUTH_TOKEN`이라는 이름으로 등록한다. 토큰은 채팅·코드·댓글로 보내지 않는다. API 방식을 선택하면 입력을 `anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}`로 바꾸고 별도 API 이용 조건·비용을 확인한다.
3. `issue_comment` 워크플로는 기본 브랜치에 있어야 동작한다. 따라서 이 파일을 기능 브랜치에 준비하는 것만으로 활성화되지 않는다. **main 병합 금지가 유지되는 동안 기본 브랜치에 설치하지 않는다.** 실제 설치는 별도 승인 범위로 검토한다.
4. 인증과 설치가 승인·완료된 뒤 활성화 변수를 설정하고, 새 `@claude` 댓글로 응답을 확인한다. 예전에 작성한 댓글이 자동으로 재실행된다고 가정하지 않는다.
5. 실제 응답과 권한 제한을 확인하기 전에는 연결 완료로 보고하지 않는다. 끌 때는 활성화 변수를 `false`로 바꾼다.

이 초안은 구조와 제한을 검토하기 위한 것이며, 실제 Claude 인증·응답 검증은 미완료다.

## 공식 근거

- [Claude Code Action 설정 안내](https://github.com/anthropics/claude-code-action/blob/main/docs/setup.md)
- [공식 워크플로 예시](https://github.com/anthropics/claude-code-action/blob/main/examples/claude.yml)
- [GitHub issue_comment 이벤트의 기본 브랜치 조건](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#issue_comment)
