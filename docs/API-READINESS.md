# 실제 AI·광고 API 연동 준비 점검 (PM 11/21, 기준 474f1a2)

실제 호출·집행은 별도 승인 전까지 금지. 아래는 "무엇이 닫혀 있고, 연결하려면 무엇이 필요한가"다.

| 항목 | 현재 상태 | 연결에 필요한 것(승인 후) |
|---|---|---|
| 상담 AI 모델 | 무료 모의만. `CONSULT_AI_MODEL`이 `mock`이 아니면 모델 없음 → 안전 안내문 | 모델 어댑터 구현(`ChatModel`), `CONSULT_AI_API_KEY`(서버 환경변수), 월 한도를 0원보다 크게(관리자 화면) |
| AI 사용료 | DB 예약→확정/취소, 기본 월 0원, 정산 3회 재시도 | 실제 단가 반영, 한도 승인 |
| 광고 플랫폼 | 모의만(`live=false`). 알 수 없는 `AD_PLATFORM`은 어댑터 없음 | 플랫폼별 `AdPlatform` 어댑터, `AD_EXECUTION_ENABLED=true` + DB 예산 승인 |
| 광고 문구 생성기 | `openAiAdGenerator.ts`(주입형 전송)는 있으나 앱 경로 어디에서도 불러 쓰지 않음 | 연결 승인·키·검수 흐름 |
| 봇 확인(Turnstile) | 코드 연동 완료. 시험은 로컬 가상 확인 서버로 대체 | 운영 사이트 키·`PUBLIC_HOSTNAME` |
| 관리자 로그인 | Supabase JWT 서명·MFA(aal2)·DB 세션 검증 연동. 시험은 가상 인증 서버 | 실제 Supabase 프로젝트·키·직원 계정 |
| 필수 고지 | 실제 문구 미확정 → 접수 차단 유지 | 확정 문구·버전 |

자동 검증: `tests/route/api-readiness.test.ts`(RD1~RD3), `scripts/next-e2e`(N8~N13).
