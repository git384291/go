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

## K. 접수 직전 서버 고지 게이트 (기준 7fb9299 이후)
- 접수 API(`submitLead`)는 `api.create_lead` 직전에 같은 트랜잭션에서 `api.notice_intake_gate(버전, 서버 상수의 항목별 문구 sha256)`을 호출한다. 하나라도 어긋나면 **저장하지 않고 503 + 사유 코드**로 닫는다(문구·개인정보는 응답·로그에 없음).
  `NOTICE_VERSION_MISMATCH`(접수 문서 버전 ≠ `privacy_policy_version` 설정) · `NOTICE_NOT_FOUND`(DB 문구 없음) · `NOTICE_KEYS_MISMATCH`(DB 항목 키 집합 ≠ 서버 상수) · `NOTICE_HASH_MISMATCH`(DB 문구 해시 ≠ 서버 상수 해시) · `NOTICE_NOT_APPROVED`(최신 검수 기록이 승인이 아님 — 기록 없음 또는 이후 반려 = 승인 취소) · `NOTICE_CHANGED`(승인 뒤 문구가 추가됨) · `NOTICE_SELF_APPROVED`(승인자가 문구 작성자 — 직접 삽입 우회 방어) · `NOTICE_INVALID`.
- 순서: 서버 상수가 미확정이면 DB를 부르기 전에 `NOTICE_NOT_CONFIRMED`로 먼저 막힌다(현재 상태). 상수 확정 후에도 DB 게이트가 한 번 더 막는다. 변경·승인 취소·버전 불일치는 **다음 접수부터 즉시** 반영된다(요청마다 DB 조회, 캐시 없음).
- 작성자·승인자 분리: 검수 승인 함수(`notice_review_add`)가 작성자 승인을 거부하고, 게이트가 승인 기록 자체를 다시 대조한다.
- 통합·E2E용 가상 승인은 `db/seed/test_notice_review.sql`(테스트 DB 전용). 시험용 고지 본문은 `db/seed/test_notices.sql`과 글자까지 같아야 한다.
- 롤백: `db/rollback/0016_down.sql`은 게이트 함수만 제거한다. 접수 코드가 이 함수를 부르므로, 롤백 시 접수 코드도 이전 커밋으로 함께 되돌린다(함수만 빼면 접수가 SERVICE_NOT_READY로 막힘).

## L. 총판 전달용 신청서 (0017, PM 11/22) — 검수용, 운영 반영 금지

- **흐름**: 고객 화면의 'AI 신청서 도우미'(고정 질문, AI 모델은 답을 보지 않음) → `/api/leads` 본문 `application` → 서버가 형식·민감정보 검사 → 본문 AES-256-GCM 암호화(`pii.lead_applications.payload_enc`), 범주형 요약만 평문 → **같은 트랜잭션**에서 `notice_intake_gate` → `create_lead` → `application_save`. 어느 단계든 실패하면 접수 전체가 롤백된다(고지 승인 검증과 접수 저장이 한 트랜잭션).
- **수집하지 않음**: 주민등록번호·자동이체·계좌정보. 입력이 닿으면 서버(`SENSITIVE_INPUT`)와 화면 모두 거부하고, 총판 전달 자료에는 '총판 별도 확인' 항목으로만 나온다.
- **관리자**: `/admin/leads/[id]/packet` (대표·배정 상담원). 열람 사유 필수 → 복호화 표시 → 복사·전달 완료 기록. 열람은 시간당 30회 제한(기존 연락처 열람과 공용)·감사('pii.reveal', via=dealer_packet), 이력은 `core.dealer_handoffs`(추가 전용, 수정·삭제·TRUNCATE 차단). 요금·사은품 안내는 게시된 승인 정책만, 없으면 '담당자 확인'.
- **롤백(서버 코드와 함께)**: 순서는 ① 서버 코드(submitLead·intake·화면)를 0016/0017 이전 커밋으로 되돌림 → ② `db/rollback/0017_down.sql`(함수 4개만 제거, 테이블·이력·감사 보존) → ③ 필요 시 0016.
  - DB만 먼저 되돌리면: 0017 함수 없음 → `application_save` 호출 실패 → 접수 전체 실패(500, 저장 안 됨, 단위 시험 SG6). 0016 게이트 함수 없음 → 같은 방식으로 닫힌 채 실패. 즉 어느 쪽이든 **고지 미검증 접수가 저장되는 경로는 없다**(서버 코드만 되돌리고 DB를 유지하는 경우는 `application` 필드를 받지 않을 뿐 안전).
  - `db-test.sh` M17: 0017 적용 → down → 함수 제거·테이블 유지 확인 → 재적용.
- **미확정·주의**: ① 실제 총판 신청서 양식 미수신 — 항목 매핑은 내부 임시안(`src/content/applicationForm.ts`), 양식 수신 시 교체. ② 설치 주소·주거 형태 등 새 수집 항목은 **개인정보 처리방침·고지 문구에 반영 필요**(문구 미확정이므로 접수 차단 유지, 임의 작성 안 함). ③ 중복 문의(중복 방지 구간)로 `create_lead`가 새 접수를 만들지 않은 경우 신청서는 'skipped'로 저장되지 않는다. ④ 접수는 여전히 코드 상수 `REQUIRED_NOTICES` 미확정으로 차단된다.

## M. 총판 전달 양식 매핑·최소 권한 (기준 d1aa9ac 이후, PM 11/22) — 검수용
- **출력 순서(17항목)**: 고객명 → 주민번호(총판 별도 확인) → 설치주소 → 연락처 / 통신사 → 이메일 → 자동이체(총판 별도 확인) → 사은품계좌(총판 별도 확인) → 가입 통신사 → 신청상품 → 월요금 → 설치비(기사출동비) → 설치희망일 / 빠른 날짜 → 상품권 → 이전통신사 → 기타: 기존회선 12개월 유지 안내 → 기존회선 확인 → 약정 3년 및 설치비 안내·확인. (`buildDealerPacket`, 단위 AF5·route DP3·E2E AP2/AP7가 순서를 고정)
- **해석(PM 확인 필요)**: '연락처 / 통신사'는 접수 연락처 + 고객이 고른 **휴대폰** 통신사로, '가입 통신사'는 가입할 인터넷 통신사(상담 선택), '이전통신사'는 현재 쓰는 인터넷 통신사로 매핑했다. 월요금·설치비·상품권은 게시된 승인 정책(견적 판정 통과)에서만 채우고, 없으면 "총판 확인".
- **고객 추가 질문**: 필수 8항목(설치주소·휴대폰 통신사·이메일·이전통신사·설치희망일/빠른 날짜·기존회선 확인·기존회선 12개월 유지 안내 확인·약정 3년 및 설치비 안내 확인) + '희망일 지정'을 고르면 날짜. 빠진 항목은 도우미가 순서대로 다시 묻고, 누락이 있으면 제출이 막힌다. 안내 두 건의 **문구는 총판 확정 전이라 쓰지 않았고** 고객은 "확인했습니다"만 표시한다(문구 확정 시 교체 필요).
- **금지 유지**: 주민번호·자동이체·사은품계좌는 질문·저장·AI 전달 모두 없음(입력이 닿으면 SENSITIVE_INPUT, 총판 별도 확인으로만 표시).
- **'총판 전달 준비 완료'**: 고객 정보 누락 0 **그리고** 필수 고지 확인 완료(서버 고지 상수 확정·처리방침 버전 일치·접수 때 남은 고객별 노출 기록의 버전·항목 키가 상수와 일치)일 때만. 아니면 `incomplete`/`notice_pending`으로 표시하고 "총판 전달 완료" 기록은 서버가 409(PACKET_NOT_READY)로 막는다. 현재 상수가 미확정이라 실제 환경에서는 항상 notice_pending이다.
- **최소 권한(MVP)**: 열람·복사·전달 완료·이력 조회 모두 대표(owner)만. 상담원·검토자·정책 담당은 DB와 서버 모두 거부(배정돼도 불가).
- **감사 로그에 개인정보 원문 없음**: 열람 사유는 고정 코드(dealer_handoff·content_check·correction)만 받고, 전달 메모는 총판 이름(30자, 4자리 이상 숫자·이메일·기호 거부)만 이력 테이블에 두며 감사 로그에는 이벤트 종류만 남긴다(DB 시험 HO10·E2E AP5).
- **0017 수정**: 아직 병합·배포 전이라 0017을 제자리에서 고쳤다(`dealer_packet_get` 반환 컬럼 추가·owner 전용, `dealer_packet_status` 추가). 이미 d1aa9ac의 0017을 적용한 시험 DB는 `0017_down.sql` 후 재적용한다. 롤백은 함수 5개 제거, 테이블·이력·감사 보존(M17).
- **고객 화면 문구**: 개인정보 처리방침·수집 항목 문구는 임의로 바꾸지 않았다(미확정 유지). 새 수집 항목(이메일 등)과 기존 문구("주소 등은 상담 후 따로 받습니다")가 어긋나므로 확정 문구가 나올 때 함께 정리해야 한다. 접수는 상수 미확정으로 계속 차단.

## N. AI 상담 → 고지/동의 → 접수 경계 (기준 0937288 이후, PM 11/22) — 검수용
- **구조 유지**: ConsultAiFlow·ApplicationAssistant·기존 `notice_intake_gate`를 그대로 쓴다(별도 고지 게이트 없음).
- **접수 준비 표시**: 필수 일반 가입정보가 모두 채워져도 고지 상수가 확정·버전 일치가 아니면 채팅은 "접수는 아직 받을 수 없습니다", 도우미 아래 상태는 "접수 대기", 접수 양식은 고지 체크박스 없이 차단 안내만 보인다(가짜 체크박스·동의 없음). 관리자 쪽 "총판 전달 준비 완료"는 기존대로 `notice_pending`.
- **고객이 본 문구 = 접수 때 검증하는 문구**: 접수 본문에 `noticeVersion`·`noticeKeys`와 함께 `noticeHashes`(항목별 sha256, 본문 trim·UTF-8)를 싣는다. 서버(`buildCreateLeadArgs`)가 자기 상수 해시와 정확히 비교하고(다르면 503 `NOTICE_HASH_MISMATCH`, DB 호출 없음), 이어서 같은 상수 해시를 DB 게이트가 승인된 DB 문구와 대조한다. 따라서 화면 문구 = 서버 상수 = DB 승인 문구가 한 사슬로 묶인다. 승인 취소·문구 변경·버전 변경·해시 불일치는 다음 접수부터 즉시 차단(E2E G1~G7).
  - 영향: `/api/leads` 본문에 `noticeHashes`가 필수가 되었다. 이전 화면 번들(배포 직전 열려 있던 탭)은 400(INVALID_INPUT)으로 거부되므로 새로고침 안내가 필요하다. `crypto.subtle`은 https·localhost에서만 동작한다(운영은 https).
- **실제 고지 문구 미작성**: '기존회선 12개월 유지'·'약정 3년·설치비' 안내 문구와 처리방침 문구는 쓰지 않았다.
- **중간 실패 원자성**: gate → create_lead → application_save가 한 트랜잭션이다. 신청서 저장 실패 시 리드·고객·동의·고지 노출·신청서·저장 감사가 모두 취소됨을 실제 DB로 확인(E2E G8). 정상 접수는 함께 증가(G9).
- **롤백 영향**: DB 변경 없음. 서버 코드만 이전 커밋(0937288)으로 되돌리면 `noticeHashes`를 받지 않는 서버와 보내는 화면이 섞일 수 있다(스키마가 strict라 새 화면의 접수는 400). 서버와 화면은 같은 배포 단위로 함께 되돌린다.

## O. 실제 브라우저 단일 흐름 E2E (PM 11/22)
- `scripts/next-e2e/browser-flow.mjs`(check.mjs가 호출, BF0~BF18): AI 상담 → 신청서 정보 수집 → 고지·동의 → 접수 → 관리자 목록 → 총판 신청서 출력을 실제 브라우저 한 흐름으로 검증한다.
- 실제 상수(REQUIRED_NOTICES)는 미확정 그대로다. 고지 확정은 **임시 앱 사본**(src 복사 + 상수만 승인된 시험 fixture로 치환)을 두 번째 `next dev`(3139)로 띄워 같은 폐기 DB에서만 쓴다. 저장소 소스·운영 설정은 바뀌지 않는다.
- 구버전 화면(고지 해시 미전송·오래된 해시)은 서버 503(NOTICE_HASH_MISMATCH)으로 닫히고 화면은 "새로 고친 뒤 고지를 다시 확인"을 안내한다. 해시 필드 누락은 입력 오류(400)가 아니라 같은 코드로 닫는다.
- Web Crypto(https·localhost 아님) 불가 시 접수 요청을 만들지 않고 "보안 연결(https)" 안내만 보인다(개인정보 전송·저장 없음).
- 롤백: 화면 문구 2종(`stale`, `secure_context`)과 해시 누락 코드 분류만 바뀌었다. DB 변경 없음.
