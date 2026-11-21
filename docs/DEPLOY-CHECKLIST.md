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

## I. 총판 고지 원문 대조 · 고객 화면 표시 검증 (기준 39a7acb 이후)
- `/admin/notices`의 "총판 고지 원문 대조"(대표·검토자): 총판이 준 원문을 붙여 넣으면 저장된 해당 버전·항목 문구와 비교해 **일치 / 공백·줄바꿈만 다름 / 내용이 다름(첫 차이 글자 위치) / DB에 항목 없음**을 보여 준다. 브라우저 안에서만 비교하며 서버 전송·저장·접수 개방과 무관하다(`verifyNoticeSource`, 단위 RN9, E2E NA7, 화면 S1–S4).
- 승인 전 점검 순서(사람): ① 총판 원문 확보 → ② `/admin/notices`에서 대표가 버전·항목별 입력 → ③ 같은 화면에서 원문 대조가 모두 "일치"인지 확인 → ④ 적용 조건(버전·항목 키 집합·유효 기간 등 총판 조건)을 사람이 원문과 대조 → ⑤ PM·대표 승인 후 `requiredNotices.ts` 상수 확정(별도 배포). 상수가 확정되기 전에는 접수가 계속 차단된다.
- 고객 화면 표시 시험(`notice-display-interaction.mjs` D1–D7): 확정 설정을 끼운 시험 화면에서 제목·본문이 글자 그대로(줄바꿈·공백·특수문자 포함, HTML 해석 없음) 표시되고, 미확정(실제 설정)에서는 문구·체크박스 없이 차단 안내만 보이며 제출해도 서버 요청이 0건임을 확인한다. 본문은 `white-space: pre-wrap`으로 줄바꿈을 보존한다.

## J. 총판 고지 조건 관리자 검수 절차 (기준 9fc2fd6 이후)
- 화면: `/admin/notices`의 "총판 고지 조건 검수"(대표·검토자) → `POST /api/admin/notices/review` `{version, decision: approved|rejected, checks, reason}`. 이력은 같은 화면·`GET`으로 조회(대표·검토자).
- 승인 조건(DB가 판정): ① 5개 확인(원문 일치·버전 일치·항목 키 완전·**총판 적용 조건 대조**·고객 화면 확인)이 모두 true ② 그 버전 문구가 DB에 있음 ③ **그 버전 문구를 직접 입력한 사람은 승인할 수 없음**(대표가 입력 → 검토자가 승인). 반려는 확인 항목과 무관하게 기록 가능. 검수 기록은 추가 전용(수정·삭제·비우기 불가), 감사 `notice.review_approved/rejected`.
- 승인은 검수 시점의 문구 묶음 해시를 함께 저장한다. 이후 같은 버전에 문구가 더 추가되면 이전 승인은 화면에서 "최신 아님"으로 표시되며 다시 검수해야 한다(Y9b, E2E RV8).
- **검수 승인은 접수를 열지 않는다.** 접수는 `requiredNotices.ts` 상수 확정(별도 승인·배포)으로만 열리며, 현재 미확정이라 계속 차단된다(E2E RV9). 상수 확정 전에 사람이 확인할 것: 해당 버전의 최신 승인 1건 이상(is_current), 처리방침 버전과 같은 버전, 원문 대조 모두 "일치".
- 복구: `db/rollback/0015_down.sql`은 함수 2개만 제거하고 검수 기록·감사는 보존(M15 복구 시험).
- 확정 이후 전체 흐름 시험(E2E FL1–FL4): DB의 승인된 문구로 화면 설정을 구성 → 동의·고지 키 → 접수(암호화) → 고객별 노출 기록 해시가 승인 문구 해시와 같음 → Next 관리자 목록에 마스킹되어 조회. 실제 상수가 확정되면 같은 시험을 실제 문구로 다시 돌린다.
- **버전 3곳 일치**: 접수 직전 DB가 `core.settings.privacy_policy_version`과 접수 문서 버전의 일치를 다시 검사한다. 고지 버전을 바꾸는 배포는 ① DB 고지 문구(`/admin/notices`) ② `requiredNotices.ts` 상수 ③ DB `privacy_policy_version` 설정(+환경변수 `PRIVACY_POLICY_VERSION`)을 함께 같은 값으로 맞춰야 한다. 하나라도 다르면 접수는 거부된다(E2E FL1은 설정을 시험 버전으로 바꿨다가 복구해 이 경로를 확인).
