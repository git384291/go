# 실제 Supabase·Cloudflare 연결 및 배포 전 점검표 (기준 9d845ea)

이 표는 **연결 승인 뒤** 사람이 따라 하는 순서다. 현재는 모두 미연결·접수 차단 상태이며, 병합·운영 배포·광고 집행은 별도 승인 전 금지.
자동 점검: `npm run preflight:launch`(값·URL·키 비출력, 네트워크 호출 없음). 아래 "자동" 열이 가리키는 ID가 그 결과의 항목이다.

## A. 환경 변수 (Vercel → Settings → Environment Variables, 환경별 분리)
| 변수 | 위치·종류 | 자동 | 규칙 |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | 공개 | A2, A4 | https 프로젝트 원본, 쿼리·경로 없음 |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | 공개 | A2, S1 | publishable 키만(service_role 금지) |
| `FIDEON_STAFF_SIGNING_KEY`, `FIDEON_LEAD_SIGNING_KEY` | 서버 | A2, A3 | `<id>:<base64 32바이트+>`, DB `security.server_keys`와 같은 값 |
| `DATABASE_URL`, `SUPABASE_DB_CA_CERT` | 서버 | D1, D2 | 풀러(트랜잭션 모드) + CA 인증서 |
| `PII_ENC_KEYS`, `PII_ENC_CURRENT`, `PII_HMAC_KEY`, `PII_IP_HASH_KEY` | 서버 | S5 | 암호화 키 32바이트, 현재 버전 존재 |
| `CONSULT_SESSION_KEY` | 서버 | S6 | base64 32바이트+ (없으면 AI 상담 닫힘) |
| `TURNSTILE_SECRET_KEY` | 서버 | T1 | Cloudflare 비밀 키 |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | 공개 | T2 | 사이트 키 |
| `PUBLIC_HOSTNAME` | 서버 | T3 | 호스트명만(스킴·경로·포트 없음), Cloudflare가 돌려주는 hostname과 동일 |
| `PUBLIC_SITE_ORIGIN`, `LAUNCH_INTAKE_DESTINATION` | 서버 | P1, P3 | 승인된 공식 주소·목적지 |
| `ADMIN_AUTH_MODE=supabase` | 서버 | A1 | **운영(VERCEL_ENV=production)에서는 코드가 항상 꺼짐 — 운영 활성화는 별도 승인 시 코드 변경** |

**두지 않는 변수(있으면 점검이 실패·경고)**: `TURNSTILE_VERIFY_URL_TEST`(T4), `ADMIN_LEADS_SOURCE`·`ADMIN_POLICY_SOURCE`·`ADMIN_AD_SOURCE`=db(R:*), `NEXT_PUBLIC_*`에 SECRET/TOKEN/API_KEY(S1), `AD_EXECUTION_ENABLED=true`(S3), `LEAD_INTAKE_MODE=local`(P6).

## B. Supabase 대시보드 (확인 불가 항목 — 사람이 확인하고 기록)
가입 차단, TOTP 필수(aal2), 세션 time-box, 비밀번호 정책, redirect URL 허용 목록, JWT 서명 키(비대칭), 직원 계정 생성·`core.staff` 등록. (A5, 체크리스트 D3~D8)

## C. Cloudflare Turnstile 대시보드 (T5)
허용 호스트명 = `PUBLIC_HOSTNAME`, 위젯 action = `lead_form`, 모드(Managed), 사이트 키·비밀 키 발급.

## D. DB·복구 (코드로 자동 확인됨 — CI의 DB 시험·Restore drill)
마이그레이션 0001~0013 + `zz_grants.sql` 적용 순서, RLS 강제, 감사 로그 추가 전용, 롤백·복구 훈련(M1~M13), 백업은 Supabase 백업 + `restore-drill.sh` 절차. 운영 DB에서 롤백 스크립트 실행 전 보관본 확인.

## E. AI·광고 실제 연동 시 필요한 것(승인 후) — `docs/API-READINESS.md`
어댑터 구현(`ChatModel`, `AdPlatform`), 서버 전용 키(`CONSULT_AI_API_KEY`, 광고 매체 키), 매체 계정·권한(광고 계정 접근·예산 한도 강제는 매체 쪽 설정), AI 월 한도(관리자 화면 `/admin/ai-budget`, 기본 0원), 광고 승인(`/admin/ads`)과 `AD_EXECUTION_ENABLED=true`. 첫 실행은 소액 상한(일 10,000원)으로.

## F. 접수 개방 전 마지막 확인 (모두 승인 필요)
1. 실제 필수 고지 문구·버전 확정(`NOTICE_NOT_CONFIRMED`가 풀리는 유일한 조건) 2. 개인정보 처리 주체·목적·보존·제공 동의 법적 검토(P9) 3. `npm run test:next-e2e`·CI 전체 통과 4. `LEAD_INTAKE_MODE`·`NEXT_PUBLIC_LEAD_FORM_ENABLED` 개방 승인.

## G. 정책 게시 스위치·필수 고지 (기준 b54a27c 이후)
- 정책 **게시**는 DB 스위치 `policy_publish`(기본 OFF, 대표만 `api.set_feature_flag`로 변경·감사 기록)다. 승인만으로는 상담에 금액이 나가지 않는다. 운영은 OFF 유지, 켜는 것은 검수용 환경에서만(자동 검증: next-e2e Q11~Q16).
- 필수 고지: 코드 상수 `REQUIRED_NOTICES`(현재 미확정 → 접수 차단)와 DB `core.notice_texts`에 **같은 버전·같은 문구**를 넣어야 한다. 대조는 `compareNoticeTexts`(preflight N1~N3, next-e2e N15). 문구는 임의로 만들지 않는다.

## H. 정책 게시 ON/OFF · 필수 고지 입력 화면 (기준 9c29a74 이후)
- **게시 스위치**: `/admin/policies`의 "정책 게시 스위치" 패널 → `POST /api/admin/policies/publish` `{enabled, reason}`. **대표(owner)만 변경**, 편집자·검토자는 현재 상태만 조회. 사유 2~500자 필수. 변경마다 감사 기록(`policy.publish_on` / `policy.publish_off`, 이전·이후 값). 운영 기본값은 **OFF** 유지 — 켜는 것은 별도 승인 뒤 대표가 직접.
- **반영 시점**: 상담 답변은 요청마다 DB 게시 상태를 읽으므로 ON/OFF가 즉시 반영된다(Next E2E PB4·PB5).
- **필수 고지 입력**: `/admin/notices`(대표 입력, 검토자 조회). `POST /api/admin/notices` `{version,key,body,reason}`. 같은 버전·항목은 다시 입력 불가(덮어쓰기·삭제 없음, 새 버전으로 입력), 감사 기록에는 본문 대신 해시만 남는다.
- **접수 차단은 그대로**: DB에 문구를 넣어도 접수는 열리지 않는다. 열리려면 `src/content/requiredNotices.ts`의 상수가 확정(버전·항목 문구)으로 바뀌고 DB와 일치해야 하며, 이는 별도 검수·승인·배포 사항이다(Next E2E NA6, `/admin/notices`의 "접수 차단 유지" 표시).
- **실제 문구는 이 저장소에 없다**: 대표·PM이 확정한 문구를 화면에서 입력한다. 시험 문구는 "[검수용 … 실제 고지 아님]"으로 표시된다.
- **복구**: `db/rollback/0014_down.sql`은 함수 4개만 제거하고 게시 값·고지 문구·감사 기록은 보존(M14 복구 시험).
