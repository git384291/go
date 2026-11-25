# 미해결 과제

| 번호 | 내용 | 원인 | 해결 방법 | 상태 |
|---|---|---|---|---|
| OI-001 | package-lock.json이 없어 `npm ci` 실패 | 개발 작업 환경에서 npm 저장소 접속이 막혀 lockfile을 만들지 못함. 추측으로 만든 lockfile은 무결성 해시가 틀려 쓰지 않음 | 패키지 설치가 되는 환경(GitHub Actions 또는 개발 PC)에서 `npm install`로 생성 → 커밋 → `npm ci` 재검증 | 미해결 |
| OI-002 | 관리자 로그인 → TOTP → DB 세션 등록 흐름이 코드에 연결되지 않음 | 로그인 화면이 미리보기 상태, `openStaffSession` 호출부 없음 | Supabase 개발 프로젝트 준비 후 구현·검증 | 미해결 |
| OI-003 | 정책 작성·승인·게시(0004)는 로컬 가상 DB 검증만 완료(143건 통과, TS 서명 대조는 zod 미설치로 생략). 실제 개발 Supabase(fideon-dev) 화면·API·DB 검증 미실시 | 작업 세션에 개발 Supabase 접속 정보 없음, 관리자 로그인 화면 미연결(OI-002) | fideon-dev 접속 정보를 세션 환경변수로 제공 → 0004 적용 → 같은 9단계를 실제 DB로 재실행 | 미해결 |
