# 미해결 과제

현재 진행 상태와 검증 근거는 [PHASE 1 진행 기록](PHASE1-STATUS.md)을 기준으로 확인한다.
아래 상태는 `ff3c47c`의 GitHub CI 실행 #43711855021과 현재 코드 확인 결과를 반영한다.

| 번호 | 내용 | 원인 | 해결 방법 | 상태 |
|---|---|---|---|---|
| OI-001 | package-lock.json이 없어 `npm ci` 실패 | 과거 개발 환경에서 npm 저장소 접속이 막힘 | 현재 브랜치에 lockfile 존재. `ff3c47c` CI의 `npm ci`, 타입 검사, lint, 빌드 성공 확인 | 해결 |
| OI-002 | 관리자 로그인 → TOTP → DB 세션 등록 흐름이 코드에 연결되지 않음 | 로그인 화면이 미리보기 상태, `openStaffSession` 호출부 없음 | Supabase 개발 프로젝트 준비 후 구현·검증 | 미해결 |
| OI-003 | Supabase 개발 환경의 DB 역할·권한·연결 풀러 호환 미검증 | 현재 검증은 로컬 가상 PostgreSQL 기준 | 가상 데이터 전용 개발 프로젝트에서 역할 로그인·RLS·서버 서명·풀러 호환 검증 | 미해결 |
| OI-004 | Vercel 검수 배포에서 IP 위조 방어 미검증 | 실제 검수 배포 검증 기록 없음 | 검수 배포에서 `scripts/verify-ip-spoofing.sh` 실행 후 진단 설정 제거 | 미해결 |

OI-002 서버 기초 보강: `requireStaff`는 DB `whoami` 확인을 요구하고, `openStaffSession`은 같은 트랜잭션에서 등록 후 유효성을 확인하도록 수정했다. [변경과 검증 범위](AUTH-SESSION-FOUNDATION.md)를 참고한다. 로그인 UI·TOTP·로그아웃·실제 Supabase 검증은 아직 미완료다.
