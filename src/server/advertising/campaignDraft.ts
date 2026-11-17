import 'server-only';
// 광고 캠페인 초안 생성·검증 — 순수 함수 (PM 6943038907). **미게시 초안만 만든다. 집행·예약·게시·과금 기능은 없다.**
//
// - 입력은 알려진 소재 ID, 상품 internet-tv, 예산 정수(일·총액)뿐이다. 자유 문구·URL·고객정보는 받지 않는다(추가 키는 거부).
// - 출력은 허용 목록 DTO다. 실제 목적지 URL·계정은 내보내지 않고 목적지는 UNSET이다.
// - executionAllowed는 항상 false다. 예산이 한도 안이어도 집행 가능을 반환하지 않는다.
//   네이버 공식 근거상 하루예산·소액 충전·자동 OFF는 엄격 상한 보장 수단이 아니므로(AD-LAUNCH-PACK N7·N8·4-1) CAP_NOT_VERIFIED를 유지한다.
// - 계정·업종·목적지·귀속·개인정보·심사 blocker도 고정이다. 체크박스·reviewRef 같은 입력으로 승인을 만들 수 없다.
// - 네트워크·DB·환경변수·로그·저장·타이머를 쓰지 않는다. 화면·API에 연결하지 않았다.
import { AD_DRAFT_IDS, AD_DRAFTS, codePointLength, type AdDraftId } from '@/content/adDrafts';

/** 사용자 승인 상한(세금·수수료 포함). 승인된 상한의 표현일 뿐, 매체에서 강제된다는 뜻이 아니다 */
export const AD_DAILY_CAP_KRW = 10_000;
export const AD_FIRST3DAYS_CAP_KRW = 30_000;

export const CAMPAIGN_BLOCKERS = Object.freeze([
  'CAP_NOT_VERIFIED',
  'ACCOUNT_NOT_VERIFIED',
  'INDUSTRY_ELIGIBILITY_NOT_VERIFIED',
  'DESTINATION_NOT_SET',
  'ATTRIBUTION_NOT_VERIFIED',
  'PRIVACY_ROLE_NOT_VERIFIED',
  'MEDIA_REVIEW_NOT_PASSED',
] as const);
export type CampaignBlocker = (typeof CAMPAIGN_BLOCKERS)[number];

export type CampaignDraft = {
  readonly status: 'DRAFT_UNPUBLISHED';
  readonly draftId: AdDraftId;
  readonly product: 'internet-tv';
  readonly situation: string;
  readonly title: string;
  readonly titleLength: number;
  readonly description: string;
  readonly descriptionLength: number;
  readonly cta: 'UNSET';
  readonly destination: 'UNSET';
  readonly budget: {
    readonly dailyKrw: number;
    readonly totalKrw: number;
    readonly dailyCapKrw: number;
    readonly first3DaysCapKrw: number;
    readonly taxAndFeesIncluded: true;
    readonly capEnforcement: 'NOT_VERIFIED';
  };
  readonly blockers: readonly CampaignBlocker[];
  readonly executionAllowed: false;
};

export type CampaignDraftResult = { readonly ok: true; readonly draft: CampaignDraft } | { readonly ok: false; readonly error: 'INVALID_INPUT' };

const INVALID: CampaignDraftResult = Object.freeze({ ok: false, error: 'INVALID_INPUT' });
const KEYS = ['draftId', 'product', 'dailyBudgetKrw', 'totalBudgetKrw'];

const isWon = (v: unknown, max: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= max;

/** 미게시 캠페인 초안. 이상 입력은 고정 INVALID_INPUT(원문·예외 메시지를 돌려주지 않음) */
export function buildCampaignDraft(input: unknown): CampaignDraftResult {
  try {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return INVALID;
    const proto = Object.getPrototypeOf(input);
    if (proto !== Object.prototype && proto !== null) return INVALID;
    const keys = Object.keys(input);
    if (keys.length !== KEYS.length || !KEYS.every((k) => keys.includes(k))) return INVALID;
    const { draftId, product, dailyBudgetKrw, totalBudgetKrw } = input as Record<string, unknown>;
    if (typeof draftId !== 'string' || !(AD_DRAFT_IDS as readonly string[]).includes(draftId)) return INVALID;
    if (product !== 'internet-tv') return INVALID;
    if (!isWon(dailyBudgetKrw, AD_DAILY_CAP_KRW) || !isWon(totalBudgetKrw, AD_FIRST3DAYS_CAP_KRW)) return INVALID;
    if (totalBudgetKrw < dailyBudgetKrw || totalBudgetKrw > dailyBudgetKrw * 3) return INVALID;
    const d = AD_DRAFTS[draftId as AdDraftId];
    const draft: CampaignDraft = Object.freeze({
      status: 'DRAFT_UNPUBLISHED',
      draftId: d.id,
      product: 'internet-tv',
      situation: d.situation,
      title: d.title,
      titleLength: codePointLength(d.title),
      description: d.description,
      descriptionLength: codePointLength(d.description),
      cta: 'UNSET',
      destination: 'UNSET',
      budget: Object.freeze({
        dailyKrw: dailyBudgetKrw,
        totalKrw: totalBudgetKrw,
        dailyCapKrw: AD_DAILY_CAP_KRW,
        first3DaysCapKrw: AD_FIRST3DAYS_CAP_KRW,
        taxAndFeesIncluded: true,
        capEnforcement: 'NOT_VERIFIED',
      }),
      blockers: CAMPAIGN_BLOCKERS,
      executionAllowed: false,
    });
    return Object.freeze({ ok: true, draft });
  } catch {
    return INVALID;
  }
}
