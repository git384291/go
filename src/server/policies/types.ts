import 'server-only';

/**
 * 일일 정책 견적 모델(PHASE 1: 비활성, 화면·API·자동 상담 미연결). 계약: docs/POLICY-QUOTING-CONTRACT.md
 * - 공급처(총판)·고객군·통신사·상품·정책 버전을 섞지 않는다.
 * - Known<T>: 확인된 값과 '모름'을 구분한다. 모름은 0이 아니다.
 * - internal 필드(내부 수수료·원문 참조)는 고객 견적에 절대 나가지 않는다.
 */
export type Segment = 'household' | 'soho' | 'sme';
export type SourceKind =
  | 'official_policy_sheet'   // 공급처가 발행한 당일 정책표
  | 'distributor_notice'      // 공급처 공지(정책 변경 안내)
  | 'training_material'       // 교육 자료 — 견적 근거 불가
  | 'past_promotion'          // 과거 프로모션 — 견적 근거 불가
  | 'unverified_screenshot';  // 확인 안 된 화면 캡처 — 견적 근거 불가
export type ReviewStatus = 'draft' | 'approved' | 'rejected' | 'superseded';
export type Vat = 'included' | 'excluded';

export type Known<T> = { readonly known: true; readonly value: T } | { readonly known: false };
export type Krw = { readonly amountKrw: number; readonly vat: Vat };

export type CustomerBenefit = {
  readonly amountKrw: number; // 0 = 혜택 없음(확인된 0)
  readonly form: 'gift_card' | 'cash' | 'bill_discount' | 'none';
  readonly payoutCondition: Known<string>;   // 지급 시점·조건
  readonly cancellationCondition: Known<string>; // 해지·환수 조건(고객 안내 문구)
};

export type PolicyRecord = {
  readonly supplierId: string;          // 공급처(총판) 코드 — 고객에게 내보내지 않음
  readonly segment: Segment;
  readonly carrier: string;             // 통신사 코드
  readonly productId: string;           // 공급처 정책상의 상품 ID
  readonly productLabel: string;        // 고객 안내용 상품명
  readonly category: string;            // 카탈로그 키(content/catalog.ts). 활성 상품만 견적 가능
  readonly version: string;             // 정책 버전 — 내부용
  readonly sourceKind: SourceKind;
  readonly reviewStatus: ReviewStatus;  // 향후 서버의 검수 저장소에서만 채워지는 값(이 모듈은 보안 승인 주체가 아님)
  readonly confirmedAt: string | null;  // 정책 확인 시각(ISO, 오프셋 필수)
  readonly validFrom: string;           // 유효 시작(ISO, 오프셋 필수)
  readonly validUntil: Known<string>;   // 유효 종료(ISO, 오프셋 필수). 모르면 확정 견적 불가
  readonly monthlyFee: Known<Krw>;
  readonly contractMonths: Known<number>;
  readonly equipmentMonthlyFee: Known<Krw>; // 공유기·셋톱박스 등 월 임대료(0 = 확인된 무료)
  readonly installFee: Known<Krw>;
  readonly bundlePrerequisites: Known<readonly string[]>; // 결합 전제 코드([] = 확인된 전제 없음)
  readonly regionScope: Known<readonly string[] | 'nationwide'>;
  readonly customerBenefit: Known<CustomerBenefit>;
  readonly internal: {
    readonly commissionKrw: number | null; // 내부 수수료 — 고객 견적·혜택 계산에 쓰지 않음
    readonly sourceRef: string | null;     // 원문 위치 — 고객에게 내보내지 않음
  };
};

export type QuoteRequest = {
  readonly supplierId: string;
  readonly segment: Segment;
  readonly carrier: string;
  readonly productId: string;
  readonly regionCode: string | null;                     // 상담에서 확인한 설치 지역 코드
  readonly confirmedBundles: Known<readonly string[]>;    // 상담에서 확인한 고객의 결합 자격
};

export type ReasonCode =
  | 'INPUT_INVALID' | 'NO_POLICY' | 'NOT_APPROVED' | 'SOURCE_NOT_QUOTABLE' | 'CONFIRMED_AT_UNKNOWN' | 'CONFIRMED_IN_FUTURE'
  | 'TIME_FORMAT_INVALID' | 'TIME_ORDER_INVALID' | 'NOT_YET_VALID' | 'EXPIRED' | 'VALIDITY_UNKNOWN' | 'CONFLICTING_VERSIONS'
  | 'PRODUCT_NOT_ACTIVE' | 'MONTHLY_FEE_UNKNOWN' | 'CONTRACT_UNKNOWN' | 'EQUIPMENT_FEE_UNKNOWN'
  | 'INSTALL_FEE_UNKNOWN' | 'BUNDLE_TERMS_UNKNOWN' | 'BUNDLE_UNCONFIRMED' | 'REGION_TERMS_UNKNOWN'
  | 'REGION_UNCONFIRMED' | 'REGION_NOT_COVERED' | 'BENEFIT_UNKNOWN' | 'BENEFIT_CONDITIONS_UNKNOWN';

/** 고객에게 보낼 수 있는 견적(허용 목록 필드만). 공급처·버전·수수료·원문 없음 */
export type CustomerQuote = {
  readonly carrier: string;
  readonly productLabel: string;
  readonly monthlyFee: Krw;
  readonly contractMonths: number;
  readonly equipmentMonthlyFee: Krw;
  readonly installFee: Krw;
  readonly bundlePrerequisites: readonly string[];
  readonly benefit: { readonly amountKrw: number; readonly form: CustomerBenefit['form']; readonly payoutCondition: string | null; readonly cancellationCondition: string | null };
  readonly policyConfirmedAt: string;  // 정책 기준 시각
  readonly policyValidUntil: string;
  readonly generatedAt: string;        // 견적 생성 시각(정책 기준 시각과 다름)
  readonly notices: readonly string[];
};

export type QuoteResult =
  | { readonly status: 'quote'; readonly quote: CustomerQuote }
  | { readonly status: 'needs_review'; readonly reasons: readonly ReasonCode[]; readonly guidance: string };
