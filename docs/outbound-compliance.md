# 광고성 전화(아웃바운드) 합법성 게이트

> ⚠ **법률 자문 전 운영 금지.** 실제 발신·두낫콜 조회·통신사 연동·계정·키·비용은 모두 승인 전 금지(코드는 닫힌 Mock만). 기준일 2026-11-27.
>
> **상태 기준(두 가지를 구분)**
> - **병합된 main·운영**: 이 기능 전부 미병합·미적용. 운영에는 Mock조차 연결되지 않음.
> - **PR 스택(#47 → #48 → #49)**: 0070 DB 표·함수 + `OUTBOUND_PERSISTENCE=db`로 고르는 서버 조립 팩토리까지 준비·시험. 실제 업무 호출자(route·worker·스케줄러)는 0개.

## 공식 근거 (국가법령정보센터)
- 정보통신망법 제50조(영리목적의 광고성 정보 전송 제한): https://www.law.go.kr/법령/정보통신망이용촉진및정보보호등에관한법률/제50조
  - 1항 명시적 사전동의 원칙 / 예외: ① 거래관계 예외(이 코드에서 **미구현 — 법률 검토 필요**) ② 방문판매법상 전화권유판매자가 **육성으로 개인정보 수집출처를 고지**하고 권유
  - 2항 수신거부·동의철회 시 전송 금지 / 3항 21:00~08:00 별도 사전동의 / 4항 전송자 명칭·연락처·수신거부 방법 표시
  - 5항 금지: 수신거부 회피·방해, **숫자·부호·문자 조합으로 연락처 자동 생성**, **광고 목적 전화번호 자동 등록**, 신원·출처 은폐, 기만 회신 유도
  - 6항 수신거부·철회 비용을 수신자가 부담하지 않게 할 것(무료 수신거부 수단 — **운영 전 별도 확인 필요**)
- 방문판매법 제5조(방문판매업자 등의 신고: 전화권유판매업 신고): https://www.law.go.kr/법령/방문판매등에관한법률/제5조
- 방문판매법 제42조(수신거부 의사 등록시스템 = 두낫콜 확인·등록자 발신 금지): https://www.law.go.kr/법령/방문판매등에관한법률/제42조

## 코드 (src/server/outbound)
| 규칙 | 구현 | 시험 |
|---|---|---|
| 번호 생성 금지 | 생성 기능 없음. 출처 `generated`·`sequential`·`external_auto_import`·`unknown`은 항상 차단. '무작위'는 적법 목록 안 **순서만** 섞기(`planDialOrder`, 출력 ⊆ 입력) | OB6·OB11·OB14 |
| ARS 광고 | 명시적 사전동의 증거(전화 채널·증거 ID·철회 없음)만. 육성 예외 없음 | OB4 |
| 육성 예외 | 신고 확인 + 신고번호 + 적법 수집출처(기록 ID·라벨) + 통화 시작 고지(상호·목적·수집출처) + 두낫콜 24시간 내 '등록 안 됨' + 내부 수신거부 없음 + 사람 상담원 배정·대기(humanAgentReady) — 하나라도 미확인이면 차단 | OB1·OB2·OB3 |
| PDS(예측발신) | 육성 모드 + 발신 전 상담원 예약 확인만(무응답 끊김·자동음성 방지) | OB5 |
| 시간 | KST 08:00~20:59만. 야간 별도 동의 기능은 열지 않음 | OB7 |
| 표시 | 발신번호·상호 표시 필수 | OB8 |
| 수신거부 | 저장소 조회 결과(5분 이내 clear)만 통과, blocked·unknown·error·오래된 조회 차단. 저장소는 `ClosedMockSuppressionStore`(메모리, 시험용) 또는 `DbSuppressionStore`(0070, PR #48·#49에서 `OUTBOUND_PERSISTENCE=db`로 선택) | OB9·OB17 |
| 재시도 | 대상당 3회, 24시간 간격, 중복 1건 | OB10·OB11 |
| 감사 | HMAC·사유·근거만(전화번호 원문·이름 없음) | OB12 |
| 연동 | `selectDncChecker`·`selectSuppressionStore`·`selectOutboundDialer`: 기본 닫힌 Mock, 그 밖 선택은 `LIVE_OUTBOUND_NOT_APPROVED` | OB13·OB17 |
| 동의 범위 | 동의 시각 ≤ 지금, 광고 목적(purposeId)·동의받은 사업자(granteeBusinessId)가 이번 발신과 일치해야 근거 | OB16 |
| 런타임 검사 | 출처는 허용 목록(customer_inquiry·consent_form·existing_customer)만, 형태 이상·Invalid Date는 예외 없이 INVALID_INPUT | OB6·OB15 |
| 발신 경로 | `placeOutboundCall`만: 서버 Clock 시각(호출자 now 무시)으로 두낫콜·수신거부 새로 조회 → 판정 → 통과 시 dial. 예외 없음(형태 불량·동기 throw·발신 실패 → 차단 결과) | OB17~OB19·OB-ORCH |
| dial 계약 | live_agent: 자동음성 금지, 응답 시 배정된 사람 상담원에게만 연결(없으면 무음 종료). PDS는 agentReserved도 필수 | OB5·OB20 |

두낫콜 24시간 기준은 법정 주기가 아니라 **내부 운영 기준(더 엄격)**이다.

## 녹취·문자변환 연결 경계 (중복 개발 금지)
발신이 허용된 통화의 기록은 기존 경로만 쓴다: 수신 기록 `src/server/calls/ingest.ts`(api.call_ingest, 연락처 HMAC) → 녹취 암호화 `recording.ts` → 변환 `stt.ts`(현재 Mock, live 거부) → 요약 `summary.ts`.
이 모듈은 '걸어도 되는가'만 판정하고, 통화 데이터 저장은 하지 않는다. 발신 판정 감사는 PR #48의 `core.outbound_decisions`(0070)에 남긴다(main 미병합).

## DB 영구화 (0070, PR feat/outbound-persistence)
| 표(core, 추가 전용·RLS enable+force·fideon_api만) | 내용 |
|---|---|
| `outbound_suppressions` | (사업자 ID, 연락처 HMAC) 1행. 동시 기록 멱등, 해제·수정·삭제 없음 |
| `outbound_attempts` · `outbound_attempt_results` | 목적·모드·발신기·시각 / 결과 코드(placed·dial_failed)만 |
| `outbound_decisions` | 허용·근거·사유 코드·시각만(원문 번호·이름·고지문·금액 없음) |
함수 6개(api, SECURITY DEFINER·search_path 고정·입력 검증)는 기존 통화 작업자 역할 `app_call`만 실행. 누적 3회·24시간·수신거부는 `api.outbound_attempt_begin`이 DB 시각으로 직접 확인(advisory lock).
서버 어댑터 `src/server/outbound/db.ts`(DbSuppressionStore·DbOutboundLedger, 사업자 ID 생성 때 고정): 조회 실패·형태 불량 → error(clear로 보지 않음).
오케스트레이터 순서: 앱 차단 → 차단 판정 기록 / 앱 허용 → 시도 시작(DB 재확인) → 거부 시 정확한 사유의 차단 판정 기록 → 수신거부 재조회 → 허용 판정 기록 성공 시에만 dial. 어느 기록이든 실패하면 발신 0회.
수신거부 기록과 시도 시작은 같은 advisory lock(OP42). 함수는 생성 직후 모든 역할 실행 권한 회수 → zz_grants가 app_call에만 부여(OP43).
롤백 `db/rollback/0070_down.sql`: 함수만 제거, 기록·추가 전용 트리거 보존. DB 선택은 PR #49의 `assemble.ts`(`OUTBOUND_PERSISTENCE=db`)로 가능. `selectSuppressionStore`는 Mock 전용으로 남김. 실제 업무 호출자는 0개.

## ⚠ 위험·미완료
- 🟡 내부 수신거부 지속 저장: 0070 DB 표·함수·어댑터와 선택 팩토리 준비(PR 스택, 병합·DB 적용 전). 메모리 Mock은 기본값·시험용.
- 🔴 지속 저장이 생겨도 운영 전 **법률 자문·전화권유판매업 신고·두낫콜 실제 커넥터·발신번호 사전등록**은 여전히 필수(미완료).
- 🟡 **남은 경쟁 위험**: 발신 직전 수신거부 재조회와 실제 통신망 연결 사이의 짧은 틈은 원자적으로 막을 수 없다(외부 통신망). live 발신기 금지 유지, live 구현 시 업체 측 차단 확인·통화 시작 직후 수신거부 처리 절차를 별도 검토.
- 🟢 **서버 조립 팩토리 준비·시험**(PR feat/outbound-server-wiring): `src/server/outbound/service.ts`(server-only, app_call 트랜잭션·사업자 고정) → `assemble.ts`.
  기본은 닫힌 Mock, `OUTBOUND_PERSISTENCE=db`일 때만 수신거부·원장이 DB. 트랜잭션·사업자 없음·0070 함수 실행 불가·조회 실패 → 닫힘(dial 0회). 실제 PostgreSQL 통합 시험 OBI1~5(고정 서버 Clock: 낮 허용·밤 차단 모두 항상 실행).
- 🟡 **실제 업무 호출 경로 미연결(의도적)**: route·worker·스케줄러·번호 원문 입력 API가 0개. 팩토리를 부르는 업무 코드가 없으므로 운영 상태는 'DB 어댑터 연결 완료'가 아니다.
- 수신거부 DB 조회의 신선도 시각은 조회를 실행한 서버 Clock 값(판정·감사와 같은 시계). DB의 checked_at은 형태만 검사.
- 🔴 **DB 어댑터가 연결돼도 live 발신은 금지**: 발신기·두낫콜은 Mock만(그 밖은 LIVE_OUTBOUND_NOT_APPROVED).
- 🟡 `OutboundDialer.dial`은 인터페이스라 직접 부를 수 있다 → 시험 OB-ORCH가 src 전체에서 `.dial(` 호출을 `placeOutboundCall` 한 곳으로 제한. live 발신기도 이 경로만 사용.

## 교체 가능성·격리 (언제든 교체)
- 외부 연동은 모두 인터페이스 뒤: `DncChecker`(두낫콜) · `OutboundDialer`(통신사) · `SuppressionStore`(수신거부 저장소) · `OutboundLedger`(판정·시도 원장). 구현을 바꿔도 판정(`decideOutbound`)·발신 경로(`placeOutboundCall`)는 그대로.
- 기본값은 모두 닫힌 Mock, 그 밖 선택은 `LIVE_OUTBOUND_NOT_APPROVED`(시험 OB13·OSW-ISO). 설정 오류는 서비스 전체가 닫힘(OSW2).
- import 경계: outbound 모듈은 자기 폴더와 DB 배선(service.ts의 `@/server/db/client`)만 가져오고, 다른 기능(광고·상담·CRM·화면·공개 route)은 outbound를 가져오지 않는다(OSW-ISO·OSW-BUNDLE). 그래서 이 모듈을 바꾸거나 빼도 다른 기능이 깨지지 않는다.
- 회귀: CI verify가 매 커밋마다 전체(타입·린트·단위·경로·DB 1300+·통합·E2E)를 실행한다.

## 남은 법률·업체 의존 (운영 전 필수)
- 전화권유판매업 신고 완료·신고번호 확보(방문판매법 제5조). 정부24 안내: 사업자등록 전에도 신청 가능, 등록 후 즉시 통보
- 거래관계 예외 적용 여부·기간 — 법률 자문
- 두낫콜(공정위) 조회 방식·계정·비용 — 업체/기관 확인
- 통신사·발신 업체 선정, 발신번호 사전등록, 무료 수신거부 수단(제50조 6항) — 업체 확인
- 수집출처 고지 문구·통화 시작 멘트 — 법률 자문
