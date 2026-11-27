# Claude 검토 연결

## 현재 상태

- 사용자 제공 Mac 터미널 기록에서 Claude Code `Login successful.`을 확인했다.
- 사용자가 Actions secret `CLAUDE_CODE_OAUTH_TOKEN` 등록과 `FIDEON_CLAUDE_REVIEW_ENABLED` 변수 생성 성공 기록을 제공했다. 토큰 값은 채팅이나 이 Cloud 환경으로 전달받지 않았다.
- **GitHub를 통한 Claude 검토 연결 검증 완료**: 커밋 `02073a1332277463f6b16e0e56eaa51b73916a89`의 [Claude 검토 실행 #43718427835](https://github.com/git384291/go/actions/runs/43718427835) 성공과 [실제 검토 댓글](https://github.com/git384291/go/pull/1#issuecomment-6894926805)을 확인했다. 같은 커밋의 [기존 CI #43718410549](https://github.com/git384291/go/actions/runs/43718410549)도 통과했다.
- Secrets/변수 관리 API는 현재 연결에서 403이므로 등록·변경은 사용자가 Mac에서 수행했다. 검토 요청과 실행 결과 확인은 이 환경에서 처리한다.
- 이전 `@claude` 댓글 방식 대신 아래 라벨 방식을 사용한다. Mac 원격 조작과 Claude의 코드 자동 수정은 이번 연결 범위에 포함되지 않는다.

## 검토 결과와 다음 작업

검토 대상은 위 커밋이며 이후 커밋을 검토한 것으로 간주하지 않는다. 현재 연결 성공은 FIDEON의 실제 관리자 인증 구현 완료를 의미하지 않는다.

- 직접 재확인한 누락: `requireStaff`와 `openStaffSession`이 정의되어 있으나 앱 호출부가 없으며, 비밀번호 로그인·TOTP·로그아웃 경로가 연결되지 않았다(OI-002).
- 다음 구현 순서: 비활성 기본 스위치 아래에서 관리자 로그인 → TOTP → DB 세션 열기 → `whoami` 확인, 세션 폐기 → Auth 로그아웃, 인증 실패·만료·다른 사용자 세션에 대한 시험.
- Claude의 구현 제안은 검토 자료다. DB 함수·Supabase SDK 동작과 대조한 후 작은 변경으로 구현·검증한다. preview의 가상 데이터 화면이나 향후 쿠키 쓰기 문제를 실제 고객정보 유출 사고로 단정하지 않는다.
- 실제 Supabase 개발 프로젝트·풀러·인증 검증은 연결 환경이 필요하며 아직 미완료다. 실제 고객정보 수집과 운영 배포는 계속 꺼 둔다.
- 초기 검토 실행은 Git 재조회 인증 누락으로 실패했다. 읽기 토큰을 실행 중 유지하도록 수정한 뒤 위 재실행이 성공했다. 검토 댓글의 과거 실패 언급은 현재 실행 실패를 의미하지 않는다.

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

- 이 워크플로가 직접 호출하는 checkout·Claude Action은 성공한 실행의 실제 SHA와 대조해 커밋으로 고정한다. 외부 태그 변경만으로 이 두 Action의 코드가 바뀌지 않게 한다. Action 내부의 패키지·도구 의존성 전체를 고정했다는 의미는 아니다.
- GitHub 토큰: 코드 읽기·CI 읽기·PR/이슈 응답. 코드 쓰기·병합·배포 권한은 부여하지 않는다.
- Claude Action의 비공개 저장소 재조회에 필요한 Git 읽기 인증을 실행 중에 유지한다. 토큰은 `contents: read`이며 checkout의 post 단계에서 정리한다.
- Claude 기본 도구는 Read·Glob·Grep만 제공하며 셸·편집 도구는 금지한다. 진행 댓글은 Action의 GitHub 연동으로 작성한다.
- 최대 16턴·15분으로 제한한다. 이번 인증 변경 파일에 검토 범위를 한정한다. 실행 시 Claude 구독 사용량과 GitHub Actions 사용량이 발생할 수 있다.
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
