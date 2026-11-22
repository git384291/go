// 핵심 타깃 광고 문안 5종 — 고정 데이터(PM 11/22 4c7f269 지시 5). **미게시 사전 작성 초안. 어떤 화면·API·광고 계정에도 연결하지 않았다.**
// - 길이·금지 주장 기준은 adDrafts.ts(네이버 파워링크 첫 후보: 제목 ≤15자, 설명 20~45자, 코드포인트)와 같다.
// - 브랜드명 없음(바른통신 상호·상표 확인 전), 가격·사은품·할인 금액 없음. 고객 상황·검색어는 가설(검색량·CPC 미조회).
// - 검색광고는 약정 만료일을 직접 타깃할 수 없어, 만료 시점을 말하는 검색어·문안으로 의도를 잡는다.
// - 기존 상황 ID(adDrafts)·영상·캠페인 모듈과의 연결은 별도 승인 작업이다.
export const AD_TARGET_IDS = Object.freeze(['contract_2m', 'contract_soon', 'moving', 'move_in', 'carrier_change'] as const);
export type AdTargetId = (typeof AD_TARGET_IDS)[number];
export type AdTargetCopy = {
  readonly id: AdTargetId;
  readonly situation: string;
  readonly title: string;
  readonly description: string;
  /** 검색어 후보(가설, 미검증) */
  readonly keywords: readonly string[];
  readonly cta: 'UNSET';
  readonly evidence: 'HYPOTHESIS_UNVERIFIED';
};
const c = (x: AdTargetCopy): AdTargetCopy => Object.freeze({ ...x, keywords: Object.freeze([...x.keywords]) });
export const AD_TARGET_COPY: Readonly<Record<AdTargetId, AdTargetCopy>> = Object.freeze({
  contract_2m: c({ id: 'contract_2m', situation: '약정 만료까지 약 2개월 남아 미리 알아보는 중', title: '약정 만료 2개월 전 점검', description: '만료일·해지 비용·결합 조건을 미리 확인하고 비교 상담하세요', keywords: ['인터넷 약정 만료', '인터넷 약정 끝나면'], cta: 'UNSET', evidence: 'HYPOTHESIS_UNVERIFIED' }),
  contract_soon: c({ id: 'contract_soon', situation: '약정 만료가 며칠~1개월 남음', title: '약정 끝나기 전 확인', description: '만료가 가까우면 재약정과 변경 조건을 함께 비교해 보세요', keywords: ['인터넷 재약정', '약정 만료 인터넷 변경'], cta: 'UNSET', evidence: 'HYPOTHESIS_UNVERIFIED' }),
  moving: c({ id: 'moving', situation: '이사 날짜가 정해져 새집 인터넷을 준비하는 중', title: '이사 전 인터넷 신청', description: '이사 날짜에 맞춰 설치 일정과 이전 조건을 먼저 확인하세요', keywords: ['이사 인터넷 설치', '이사 인터넷 이전'], cta: 'UNSET', evidence: 'HYPOTHESIS_UNVERIFIED' }),
  move_in: c({ id: 'move_in', situation: '전입 직후 새 주소에서 인터넷이 필요함', title: '전입 후 인터넷 설치', description: '새 주소에서 쓸 인터넷·TV 구성과 설치 가능일을 확인하세요', keywords: ['전입 인터넷 신청', '새집 인터넷'], cta: 'UNSET', evidence: 'HYPOTHESIS_UNVERIFIED' }),
  carrier_change: c({ id: 'carrier_change', situation: '다른 통신사로 바꾸려고 비교하는 중', title: '통신사 변경 전 확인', description: '위약금·설치 조건·결합 할인 적용 여부를 신청 전에 확인하세요', keywords: ['인터넷 통신사 변경', '인터넷 갈아타기'], cta: 'UNSET', evidence: 'HYPOTHESIS_UNVERIFIED' }),
});
