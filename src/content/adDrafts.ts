// 광고 소재 초안 — 고정 데이터 (PM 6943038907). **미게시 사전 작성 초안이다. 생성형 AI 실행 결과가 아니다.**
//
// - 출처: docs/REVENUE-FIRST-LAUNCH.md 3-1(이사·약정 종료·일반 비교 3안), docs/AD-LAUNCH-PACK.md 2절(N6 길이 맞춤 대안 A).
// - 길이 기준: 네이버 파워링크 첫 후보 제목 ≤15자, 설명 20~45자(AD-LAUNCH-PACK N6, PM 확인 공개 근거).
//   여기 길이는 Unicode 코드포인트 수다. 매체 입력 화면의 실제 집계·심사 통과를 증명하지 않는다.
// - 고객 상황은 가설이다(인터뷰·검색량·CPC 미조회). 가격·사은품 금액·최대·당일·최저가·무중단·후기·실측·공식 지위 주장은 넣지 않는다.
// - CTA와 목적지는 실제 접수 경로가 검수되기 전까지 미확정(UNSET)이다.
// - 이 데이터는 화면·API·광고 계정 어디에도 연결하지 않았다.

export const AD_DRAFT_IDS = Object.freeze(['moving', 'contract_end', 'general_compare'] as const);
export type AdDraftId = (typeof AD_DRAFT_IDS)[number];

export const AD_TITLE_MAX = 15;
export const AD_DESC_MIN = 20;
export const AD_DESC_MAX = 45;

export type AdDraft = {
  readonly id: AdDraftId;
  /** 고객 상황 가설(검증 안 됨) */
  readonly situation: string;
  readonly title: string;
  readonly description: string;
  /** 목적지 확정 전에는 문구를 정하지 않는다 */
  readonly cta: 'UNSET';
  /** 근거 상태: 고객군은 가설, 요금·혜택·설치 조건은 미확인 */
  readonly evidence: 'HYPOTHESIS_UNVERIFIED';
};

/** Unicode 코드포인트 기준 글자 수(매체 실제 집계와 다를 수 있음) */
export const codePointLength = (s: string): number => Array.from(s).length;

const draft = (d: AdDraft): AdDraft => Object.freeze({ ...d });

export const AD_DRAFTS: Readonly<Record<AdDraftId, AdDraft>> = Object.freeze({
  moving: draft({
    id: 'moving',
    situation: '이사 일정이 잡혀 새집 인터넷·TV를 알아보는 중',
    title: '이사 전 인터넷·TV 확인',
    description: '새집 인터넷·TV 조건을 확인하세요. 설치 가능 여부는 별도 확인이 필요합니다.',
    cta: 'UNSET',
    evidence: 'HYPOTHESIS_UNVERIFIED',
  }),
  contract_end: draft({
    id: 'contract_end',
    situation: '기존 인터넷·TV 약정이 곧 끝나 재약정과 변경을 비교하는 중',
    title: '약정 만료 전 인터넷·TV',
    description: '약정 종료일과 결합 조건을 함께 비교하세요. 해지 비용은 신청 전 확인합니다.',
    cta: 'UNSET',
    evidence: 'HYPOTHESIS_UNVERIFIED',
  }),
  general_compare: draft({
    id: 'general_compare',
    situation: '특정 계기 없이 인터넷+TV 결합을 비교해 보고 싶음',
    title: '우리 집 인터넷·TV 비교',
    description: '기기와 시청 패턴에 맞는 구성을 확인하세요. 요금·혜택은 확정 조건만 안내합니다.',
    cta: 'UNSET',
    evidence: 'HYPOTHESIS_UNVERIFIED',
  }),
});

/** 소재에 넣지 않는 미확인 주장(검사용 목록) */
export const AD_FORBIDDEN_CLAIMS = Object.freeze([
  '원', '최저', '최대', '무료', '당일', '현금', '사은품 지급', '법정', '무중단', '끊김 없', '배 빠른', '후기', '만족도', '공식', '본사', '직영',
  'KT', 'SK', 'LG', '100%', '보장', '무조건',
] as const);
