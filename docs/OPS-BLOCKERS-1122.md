# 운영 차단요인 정리 (PM 11/22, 기준 107c497)

코드 미완료와 외부 준비 미완료를 나눠 적는다. **P0가 남아 있으므로 1번·2번 모두 운영 개시 불가.** 병합·운영 배포·실광고 집행 없음.

## 1. AI 자동광고

### 1-1. 감시 스케줄러 실제 등록 전제조건 (외부)
상세 설계는 `docs/AD-MONITOR-SCHEDULER.md`. 등록 전에 아래가 모두 확정돼야 한다.
1. 방식 결정: Supabase Cron(+pg_net POST) 또는 Vercel Pro Cron. Vercel Hobby는 하루 1회라 30분 간격 불가(공식 문서).
2. Supabase 플랜 확인: Free는 1주 비활동 시 프로젝트 정지(정지되면 감시·앱 모두 멈춤) → Pro 권장. Free에서 Cron 제공 여부는 공식 문구 미확인.
3. 운영 비밀: `AD_MONITOR_SECRET`(32자 이상)을 Vercel 환경변수와 스케줄러 쪽(Supabase Vault 등)에 같은 값으로 저장. 값은 대표가 직접 생성·입력.
4. DB 역할 `app_ad_monitor` 연결 정보가 운영 서버에 설정돼 있어야 함(`src/server/db/client.ts`의 adMonitor 역할).
5. 호출 주소: 운영 도메인의 `/api/internal/ad-monitor`(POST, `Authorization: Bearer`). pg_net 대기 시간 5초 이상.
6. 운영 배포 승인(대표·PM). 등록 전까지는 `MONITOR_STALE`로 신규 집행이 계속 막힌다(안전 방향).

### 1-2. Google 테스트 계정 검증 도구 (코드 완료, 실행은 외부)
- **상태: 미검증.** 테스트 계정이 없어 한 번도 실행하지 않았다. 실행 전까지 실제 Google 응답 형식(종료일·예산·시간대 read-back, pause)은 확인되지 않은 것으로 본다.
- `scripts/google-ads-probe/readback.mts` — 로컬 PC에서 사람이 직접 실행. CI·서버는 실행하지 않는다.
- 확인 항목: test_account · KRW · Asia/Seoul · end_date_time read-back · budget read-back · pause 응답.
- 안전: `GOOGLE_ADS_PROBE_READBACK=test-account-only`를 명시해야 실행. 테스트 계정·KRW·Asia/Seoul·비관리자일 때만 변경 호출. 캠페인은 PAUSED로 생성, 광고 그룹·소재 없음, 예산 1,000원 표기(테스트 계정은 광고 게재·과금 없음 — Google 공식 "Can't serve ads", "don't ... charge your account").
- 운영 어댑터(`createGoogleAdsPlatform`)의 launch·pause를 그대로 호출하므로, 통과하면 운영 코드의 read-back 판정이 실제 응답 형식과 맞는다는 근거가 된다.
- 종료 코드: 0 전부 확인 / 2 설정·플래그 없음 / 3 인증·조회 실패 / 4 조건 불충족(변경 0회) / 5 생성 실패 / 6 read-back 불일치 / 7 pause 실패.
- 출력: 단계·불리언·HTTP 상태만(비밀·고객 ID·캠페인 ID 없음). 만든 PAUSED 캠페인은 테스트 계정에 남는다.
- 기존 `run.mts`(validateOnly 진단)는 그대로 둔다.

### 1-3. 네이버
실제 집행 연결은 별도 작업으로 분리(현재 상태 조회·중지 판정 순수 함수만 있음).

### 1-4. 타깃 문안 설계 (설계만 — 코드·광고 계정 미반영, 브랜드명 미포함)
네이버 파워링크 길이 기준(제목 ≤15자, 설명 20~45자, 코드포인트) 충족. 가격·사은품·할인 금액·최저가·1위·무조건 없음. 고객군·검색어는 가설(검색량·CPC 미조회).
검색광고는 '약정 만료일'을 직접 타깃할 수 없다 → 만료 시점을 말하는 검색어·문안으로 의도를 잡는다.

| 타깃 | 제목 | 설명 | 검색어 후보(미검증) |
|---|---|---|---|
| 약정 만료 2개월 전 | 약정 만료 2개월 전 점검 (14) | 만료일·해지 비용·결합 조건을 미리 확인하고 비교 상담하세요 (33) | 인터넷 약정 만료, 인터넷 약정 끝나면 |
| 약정 만료 임박(며칠~1개월) | 약정 끝나기 전 확인 (11) | 만료가 가까우면 재약정과 변경 조건을 함께 비교해 보세요 (31) | 인터넷 재약정, 약정 만료 인터넷 변경 |
| 이사 | 이사 전 인터넷 신청 (11) | 이사 날짜에 맞춰 설치 일정과 이전 조건을 먼저 확인하세요 (32) | 이사 인터넷 설치, 이사 인터넷 이전 |
| 전입 | 전입 후 인터넷 설치 (11) | 새 주소에서 쓸 인터넷·TV 구성과 설치 가능일을 확인하세요 (33) | 전입 인터넷 신청, 새집 인터넷 |
| 통신사 변경 | 통신사 변경 전 확인 (11) | 위약금·설치 조건·결합 할인 적용 여부를 신청 전에 확인하세요 (34) | 인터넷 통신사 변경, 인터넷 갈아타기 |

고정 데이터로 준비: `src/content/adTargetCopy.ts`(시험 AT1~AT3, 어디에도 연결 안 함). 기존 상황 ID·영상·캠페인 모듈 연결은 PM 승인 후 별도 작업.

## 2. AI 24시간 상담·가입접수

### 2-1. leadIntakeGate 운영 개방에 필요한 SEC-01~03 재검수 범위 (REV-004 기준 + 이후 추가분)
| 항목 | 검수 범위 | 현재 근거 |
|---|---|---|
| SEC-01 관리자 인증 | Supabase Auth aal2(2단계 인증) 필수, (사용자·세션) 서버 서명 5분, DB 자체 세션 테이블(12시간·취소), 로그인 직후 세션 등록·로그아웃 즉시 무효화, 서명 키 교체 절차 | 시험 A1~A21. **운영 Supabase 프로젝트에서 실제 로그인·TOTP 미검증** |
| SEC-02 상담 신청 API | 서버 전용 암호화(AES-256-GCM)·HMAC, 15개 필드 서명·DB 재검증, 동의·처리방침 버전 이중 확인, 동시·중복 직렬화, IP 위조 방지·횟수 제한, 고지 해시 게이트(0016), 신청서(0017)·변경 요청(0019)·**대표 연락 동의(0023)** | 시험 I·L·C·T·Z·AP·AM·FU, 통합 E2·E10·E13·E16 |
| SEC-03 DB 권한 | 모든 테이블 RLS+FORCE, 앱 역할 테이블 권한 0, EXECUTE 허용 목록(V5), search_path 고정, 함수 본문 고정(V13), 대표 전용 함수, 감사 로그 원문 없음 | `db/audit/catalog_audit.sql` V1~V15, G1~G9 |
| 공통(운영) | 운영 DB에서 `scripts/db-audit.sh`(release_auditor) 통과, 키 3종(암호화·HMAC·서명) 운영 생성·보관, 백업·복구 훈련 | 로컬·CI만 통과, 운영 DB 미실행 |

재검수 통과 + 고지문·처리방침 확정 후에만 `leadIntakeGate`를 운영용으로 바꾸는 **별도 코드 변경**을 한다(지금은 로컬 가상 DB만 허용 — 의도된 차단).

### 2-2. CONSULT_CHAT_ENABLED 활성화 전 조건
1. 보안: `CONSULT_SESSION_KEY` 서명 키(운영 생성, 없으면 상담 경로 503), IP 횟수 제한(분당 10회·새 세션 시간당 5개 — 서버 인스턴스별 메모리라 다중 인스턴스에선 합산 안 됨), 응답 no-store.
2. 정책: 승인·게시된 정책(`policy_publish` ON)과 `QUOTE_SUPPLIER_ID`. 없으면 모든 답이 '담당자 확인' + 대표 연락 동의 질문.
3. AI 모델: **현재 실제 모델 어댑터 없음**(`CONSULT_AI_MODEL=mock` 무료 모의만). 켜도 '승인 정책 문장 + 안전 안내' 응답이다. 실제 모델 연결은 비용 승인(AI 월 한도, 기본 0원)과 별도 개발 필요.
4. 고지: AI 상담 안내 문구 노출(현재 있음), 상담창에 개인정보 입력 금지 안내(있음, 서버 가림 처리도 있음).
5. 접수 연결: 상담창은 화면 아래 신청 양식으로 안내한다. 접수가 닫혀 있으면 양식이 접수를 받지 않으므로, 상담만 열고 접수를 닫은 상태의 고객 안내 문구를 함께 확인해야 한다(미검증).

### 2-3. 유지 확인
- 대표 연락 동의 → 후속 연락 목록 → 대표 전용 열람·완료: DB FU0~FU22, 통합 E16.
- 상담 → 고지 → 동의 → 접수 → 총판 packet: 통합 E2·E10·E13·E16, route DP1~DP-FU.

## 3. 브랜드 (FIDEON → 바른통신): 고객에게 보이는 위치만, 변경은 PM 승인·상표 확인 후

| 위치 | 내용 | 비고 |
|---|---|---|
| `src/components/Site.tsx` 9·11·26행 | 헤더 로고 글자·aria-label, 푸터 | 전 페이지 |
| `src/app/layout.tsx` 7행 | 브라우저 탭 제목·제목 꼬리 | 전 페이지 |
| `src/content/seo.ts` 11·18·28·33행 | 사이트 이름, 검색 설명 3개 | 검색 노출 |
| `src/components/OfficialIntakeCta.tsx` 29행 | 공식 접수처 안내 문장 | |
| `src/content/productGuide.ts` 72행 | 상품 안내 문장 | |
| `src/server/advertising/video/explainerStoryboard.ts` 319행 | 광고 영상 브랜드 장면 글자 | 영상 재생성 필요 |
| `src/components/ConsultPreviewChat.tsx` 145행 | 상담 미리보기 화면 | 미리보기 전용 |
| 게시 패키지 v2(대화로 전달한 파일) | 원고·이미지 전체 | 재생성 필요 |

변경하지 않는 내부 식별자(PM 지시 13): 환경변수 `FIDEON_*_SIGNING_KEY`, 서명 문자열 접두어 `fideon|`, 브라우저 저장 키 `fideon_attr_v1`, Turnstile 속성 `data-fideon-turnstile`, 임시 파일 접두어, 캠페인 이름 접두어 `fideon-`(광고 계정 내부), 시험 DB 이름, 관리자 화면(직원 전용 11곳)·문서·스크립트.
바꾸면 관련 시험(SEO·미리보기·영상 스토리보드) 기대값도 함께 바뀐다. 상표 확인 전 외부 게시 금지.

## 4. SEC-01~03 보안 검수 결과 (코드 기준, 4c7f269 이후)

검수 방법: 코드 열람 + 자동 시험(CI) 결과. 운영 환경(실제 Supabase·운영 DB·운영 키)은 검수하지 못했다.

| 항목 | 결과 | 근거 |
|---|---|---|
| SEC-01 관리자 2단계 인증 | 통과(코드) | `staffAssertion.ts`에서 aal2가 아니면 403 MFA_REQUIRED, (사용자·세션) 서버 서명, DB 세션 테이블 확인. 관리자 경로 전부 직원 확인(시험 admin-guard). 새 경로 `/api/admin/leads/followups`도 대표만 |
| SEC-01 운영 로그인 | **미검증(외부)** | 운영 Supabase에서 실제 로그인·TOTP·세션 등록·로그아웃 미실행 |
| SEC-02 접수 API | 통과(코드) | 서버 전용 암호화·HMAC·전체 필드 서명(DB 재검증), Turnstile 필수(비밀 키 없으면 거부), 본문 4KB 상한, 신뢰 헤더 순서로 IP, 고지 해시 게이트, 동의·처리방침 버전 이중 확인 |
| SEC-02 대표 연락 동의(0023) | 통과(코드) | 서명 필수·연락처 원문 없음·추가 전용·대표만 열람(FU0~FU22, E16) |
| SEC-03 DB 권한 | 통과(CI) | V1~V15(RLS+FORCE, 실행 허용 목록, search_path 고정, 함수 본문 고정), G1~G9. 0023 함수 3개 허용 목록 반영 |
| SEC-03 운영 DB | **미검증(외부)** | `scripts/db-audit.sh`(release_auditor)를 운영 DB에서 실행한 적 없음 |
| 보안 헤더 | 통과(코드) | HSTS, X-Frame-Options DENY, CSP frame-ancestors 'none' (`next.config.ts`) |

발견 사항:
- **F1 (P1, 코드)** 상담 채팅 `/api/consult/chat`은 봇 확인(Turnstile)이 없고, 횟수 제한이 서버 인스턴스 메모리라 인스턴스가 여러 개거나 재시작되면 합산되지 않는다. 지금은 모의 모델(0원)이라 비용 위험은 없고 DB 월 한도(기본 0원)가 실제 모델 비용을 막지만, 실제 모델 연결 전에 보완 필요.
- **F2 (P1, 외부)** 운영 키(암호화·HMAC·서명 3종) 생성·보관과 교체 절차(`docs/ADMIN-AUTH-OPERATIONS.md`) 실행 기록 없음.
- **F3 (P0, 외부)** 운영 DB 점검·운영 로그인 미검증(위 표).

### 4-1. 운영 접수 gate 최소 수정안 (구현하지 않음 — PM 승인 후)
현재 `leadIntakeGate`는 `LEAD_INTAKE_MODE=local` + 로컬 DB만 허용한다. 제안: `LEAD_INTAKE_MODE=live`를 추가하되 아래를 **모두** 만족할 때만 연다(하나라도 어긋나면 지금처럼 503).
1. `VERCEL_ENV=production`(검수 환경 preview는 계속 차단).
2. `DATABASE_URL` 호스트가 별도 환경변수 `LEAD_INTAKE_DB_HOST`와 정확히 일치(엉뚱한 DB로 수집 방지).
3. 필수 고지 `REQUIRED_NOTICES.confirmed === true`이고 `PRIVACY_POLICY_VERSION`이 비어 있지 않음(지금 미확정 → 계속 차단).
4. 서명·암호화·HMAC 키와 `TURNSTILE_SECRET_KEY`가 모두 있음.
5. DB 쪽 기존 차단 유지: `lead_form` 스위치, 고지 승인 게이트(0016), 보유기간·처리방침 버전.
변경 파일은 `src/server/leads/intake.ts`(gate 함수)와 시험만. 시험: live 조건 하나씩 빠질 때마다 차단, preview·원격 DB 불일치·고지 미확정 차단, local 기존 동작 유지.
