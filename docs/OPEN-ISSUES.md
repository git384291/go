# 미해결 과제

| 번호 | 내용 | 원인 | 해결 방법 | 상태 |
|---|---|---|---|---|
| OI-001 | package-lock.json이 없어 `npm ci` 실패 | 개발 작업 환경에서 npm 저장소 접속이 막혀 lockfile을 만들지 못함. 추측으로 만든 lockfile은 무결성 해시가 틀려 쓰지 않음 | 패키지 설치가 되는 환경(GitHub Actions 또는 개발 PC)에서 `npm install`로 생성 → 커밋 → `npm ci` 재검증 | 미해결 |
| OI-002 | 관리자 로그인 → TOTP → DB 세션 등록 흐름이 코드에 연결되지 않음 | 로그인 화면이 미리보기 상태, `openStaffSession` 호출부 없음 | Supabase 개발 프로젝트 준비 후 구현·검증 | 미해결 |
