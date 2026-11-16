# 일일 정책 견적 계약 (PM 6904597105)

**상태: 비활성.** 서버 전용 모델과 순수 판정 모듈만 있다.
- 화면·API·자동 상담·LLM·정책 자동 업데이트·업로드·수집에 연결하지 않았다.
- DB·스키마·키 목적·권한·workflow·`.env` 변경은 없다.
- PHASE 2 활성화가 아니다.
- 실제 공급처 파일·수수료·연락처·로그인 정보는 저장소에 없다. 시험은 가상 공급처 코드와 숫자만 쓴다.

| 파일 | 내용 |
|---|---|
| `src/server/policies/types.ts` | 정책 레코드·요청·이유 코드·고객 견적 형태 |
| `src/server/policies/quote.ts` | `quotePolicy(records, request, now)` 순수 판정 |
| `src/server/policies/index.ts` | 진입점 |
| `tests/route/policy-quote.test.ts` | Q1~Q10 |

모든 런타임 파일의 첫 줄은 `import 'server-only'`이다. 클라이언트 파일은 이 모듈을 import하지 않고, 아직 어떤 화면·API도 연결하지 않는다(Q10이 확인).

## 1. 정책 레코드 — 섞지 않는 구분값
| 필드 | 뜻 |
|---|---|
| `supplierId` | 공급처(총판) 코드. 가정용 총판과 SOHO 총판은 다른 공급처다 |
| `segment` | `household` / `soho` / `sme` |
| `carrier` · `productId` · `productLabel` · `category` | `category`는 `content/catalog.ts` 키. **활성 상품(현재 인터넷+TV)만** 견적 가능 |
| `version` | 정책 버전(내부용) |
| `sourceKind` | `official_policy_sheet`·`distributor_notice`만 견적 근거. `training_material`·`past_promotion`·`unverified_screenshot`은 불가 |
| `reviewStatus` | `draft` / `approved` / `rejected` / `superseded` |
| `confirmedAt` · `validFrom` · `validUntil` | ISO 시각, **오프셋 필수**(Z 또는 ±hh:mm) |

- 견적은 **같은 키(공급처·고객군·통신사·상품)**의 레코드만 본다.
- 같은 통신사라도 다른 공급처·고객군의 정책은 합치지 않는다.
- 내부 수수료가 큰 쪽을 자동으로 고르거나 추천하지 않는다.
- 같은 키에 유효·승인 버전이 둘 이상이면, 값이 같더라도 `CONFLICTING_VERSIONS`로 사람 확인을 요구한다.

## 2. 금액·조건 — 분리하고 "모름"과 0을 구분
- `Known<T>` = `{known:true, value}` 또는 `{known:false}`이다. **모름은 0이 아니다.** 확인된 0(설치비 0원, 혜택 없음)은 견적할 수 있다.
- 분리 항목
  - 월요금(금액 + VAT 포함·별도)
  - 약정 개월
  - 장비 월 임대료
  - 설치비
  - 결합 전제 코드(`[]` = 확인된 전제 없음)
  - 지역 범위(`nationwide` 또는 코드 목록)
  - 고객 혜택(금액·형태·지급 조건·해지/환수 조건)
- **혜택이 0보다 크면** 지급 조건과 해지·환수 조건이 모두 확인돼야 한다.
- 내부 수수료(`internal.commissionKrw`)와 원문 참조(`internal.sourceRef`)는 판정·견적 계산에 쓰지 않는다. 고객 혜택에 수수료를 더하지 않는다.

## 3. 판정 (fail-closed)
현재 시각 `now`는 호출자가 주입한다. 시각은 오프셋이 있는 절대 시각으로 비교한다. 오프셋 없는 날짜·시각은 `TIME_FORMAT_INVALID`이다. 하루 끝이나 새 정책일을 임의로 만들지 않는다.

| 이유 코드 | 조건 |
|---|---|
| `INPUT_INVALID` | 요청 형식 오류, 잘못된 `now` |
| `NO_POLICY` | 같은 키 레코드 없음 |
| `NOT_APPROVED` | draft·rejected·superseded |
| `SOURCE_NOT_QUOTABLE` | 교육자료·과거 프로모션·미확인 캡처 |
| `CONFIRMED_AT_UNKNOWN` · `TIME_FORMAT_INVALID` | 확인 시각 미상, 오프셋 없는 시각 |
| `NOT_YET_VALID` · `EXPIRED` · `VALIDITY_UNKNOWN` | `now < validFrom`, `now ≥ validUntil`, 종료 미상 |
| `CONFLICTING_VERSIONS` | 같은 키에 유효·승인 레코드 2개 이상 |
| `PRODUCT_NOT_ACTIVE` | 활성 상품이 아님 |
| `MONTHLY_FEE_UNKNOWN` · `CONTRACT_UNKNOWN` · `EQUIPMENT_FEE_UNKNOWN` · `INSTALL_FEE_UNKNOWN` | 금액·VAT·약정 미상 또는 형식 오류 |
| `BUNDLE_TERMS_UNKNOWN` · `BUNDLE_UNCONFIRMED` | 결합 전제 미상, 고객 결합 자격 미확인·불충족 |
| `REGION_TERMS_UNKNOWN` · `REGION_UNCONFIRMED` · `REGION_NOT_COVERED` | 지역 범위 미상, 상담 지역 미확인, 범위 밖 |
| `BENEFIT_UNKNOWN` · `BENEFIT_CONDITIONS_UNKNOWN` | 혜택 미상, 지급·환수 조건 미상 |

- 거부 결과는 `{status:'needs_review', reasons, guidance}`뿐이다. guidance는 고정 문구 "담당자가 당일 정책과 조건을 직접 확인한 뒤 안내합니다…"이다.
- 금액·공급처·수수료·원문은 거부 결과에 넣지 않는다.

## 4. 고객 견적 DTO (허용 목록)

**포함하는 필드:** `carrier`, `productLabel`, `monthlyFee{amountKrw,vat}`, `contractMonths`, `equipmentMonthlyFee`, `installFee`, `bundlePrerequisites`, `benefit{amountKrw,form,payoutCondition,cancellationCondition}`, `policyConfirmedAt`, `policyValidUntil`, `generatedAt`, `notices`

**제외하는 필드:** 공급처 ID, 정책 버전, 내부 수수료, 원문 참조, 개인 연락처, 키, 원문 오류

**기타 규칙**
- 새 객체로 만들고 깊게 동결한다. 입력 레코드·요청은 바꾸지 않는다(Q2).
- `policyConfirmedAt`(정책 기준 시각)과 `generatedAt`(견적 생성 시각)은 다른 값이다.
- 고정 안내: "설치 가능 여부와 장비 재고는 주소 확인 후 통신사가 최종 확정합니다." / "요금·혜택은 표시된 정책 기준 시각의 조건이며, 신청 시점에 다시 확인합니다." 이 모듈은 실제 설치 가능 여부·재고를 조회하지 않는다.

## 5. 검수 상태는 보안 승인이 아니다
- `reviewStatus`는 **향후 서버의 검수된 정책 저장소**에서만 채워지는 값이다. 그 저장소는 직원 권한(owner·policy_editor)과 변경 감사 기록을 갖춰야 하며, 별도 설계·승인이 필요하다.
- 이 모듈은 받은 값을 판정할 뿐 승인 주체가 아니다. 지금은 가짜 fixture로만 판정한다.
- `approved`를 설정하는 API·화면·사용자 입력·AI 경로는 만들지 않았다(Q10이 정책 모듈 안에 검수 상태 대입 코드가 없음을 확인).
- 실제 정책 자동 업데이트, LLM 호출, 유료 API, 파일 업로드는 연결하지 않았다.

## 6. 시험 (`npm run test:route`, react-server 조건)
| # | 내용 |
|---|---|
| Q1 | 확정된 유효 fixture만 견적, DTO 키 허용 목록, 내부 수수료·공급처·버전·원문 미포함, 동결 |
| Q2 | 정책 기준 시각 ≠ 생성 시각, 깊게 동결한 원본 입력 불변 |
| Q3 | 다른 공급처·고객군의 같은 통신사 정책 미혼합, 수수료로 고르지 않음 |
| Q4 | 만료(종료 = 지금 포함)·미래·기간 미상·오프셋 없는 시각·확인 시각 미상, 시각 주입에 따른 경계 |
| Q5 | 교육·과거·미확인 출처, 미검수·반려·대체 거부. 대체 + 승인 공존 시 승인만 사용 |
| Q6 | 동일 키 복수 유효 버전(같은 값 포함) 거부 |
| Q7 | 확인된 0은 견적, 각 항목 모름·VAT 미상·음수·혜택 조건 미상 거부 |
| Q8 | 결합 전제 미확인·지역 미확인·범위 밖 거부, 충족 시 견적 |
| Q9 | 비활성 상품 분류, 잘못된 요청·시각 거부, 거부 결과 형태와 원문 비노출 |
| Q10 | server-only 경계, 클라이언트·화면·API 미연결, 검수 상태 대입 코드 없음 |
