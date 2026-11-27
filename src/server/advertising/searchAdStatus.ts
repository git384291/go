import 'server-only';
// 검색광고 캠페인 상태 조회 응답 → 내부 상태 매핑 — 순수 함수 (PM 7042419085).
// - 근거: PM이 공식 Swagger(GET /api/ncc/campaigns/{campaignId} → Campaign)에서 발췌한 필드만 쓴다. status ELIGIBLE|PAUSED|DELETED,
//   userLock boolean(true=노출 중지 설정), statusReason CAMPAIGN_PAUSED|CAMPAIGN_PENDING|CAMPAIGN_ENDED|CAMPAIGN_LIMITED_BY_BUDGET.
//   그 밖의 필드는 추정하지 않고 읽지 않는다. 이 환경에서는 원문을 직접 열람하지 못했다(발췌 기준).
// - 매체가 계산한 상태(status·statusReason)와 사용자 설정(userLock)을 따로 보존한다. ELIGIBLE은 "노출 가능 상태"일 뿐 실제 게재 증거가 아니다.
//   그래서 countsAsDelivery는 항상 false다.
// - 누락·미지 값은 던지지 않고 UNKNOWN으로 보존한다(원문 값은 짧게 걸러 보관). 충돌(ELIGIBLE인데 userLock true 등)은 검토 필요로 표시한다.
// - 네트워크·DB·환경변수·로그·타이머가 없다. 화면·API에 연결하지 않았다.
export type MediaStatus = 'ELIGIBLE' | 'PAUSED' | 'DELETED' | 'UNKNOWN';
export type MediaReason = 'CAMPAIGN_PAUSED' | 'CAMPAIGN_PENDING' | 'CAMPAIGN_ENDED' | 'CAMPAIGN_LIMITED_BY_BUDGET' | 'UNKNOWN' | 'NONE';
export type UserSetting = 'LOCKED' | 'UNLOCKED' | 'UNKNOWN';
export type InternalState = 'ELIGIBLE_NOT_DELIVERY_PROOF' | 'PAUSED' | 'DELETED' | 'NEEDS_REVIEW';
export type Origin = 'SYNTHETIC_FIXTURE' | 'UNVERIFIED_RESPONSE';

export type MappedStatus = {
  readonly origin: Origin;
  readonly media: { readonly status: MediaStatus; readonly rawStatus: string | null; readonly reason: MediaReason; readonly rawReason: string | null };
  readonly userSetting: UserSetting;
  readonly internal: InternalState;
  readonly conflict: boolean;
  readonly countsAsDelivery: false;
};
export type MapResult = { readonly ok: true; readonly value: MappedStatus } | { readonly ok: false; readonly error: 'INVALID_INPUT' };

const STATUSES = ['ELIGIBLE', 'PAUSED', 'DELETED'] as const;
const REASONS = ['CAMPAIGN_PAUSED', 'CAMPAIGN_PENDING', 'CAMPAIGN_ENDED', 'CAMPAIGN_LIMITED_BY_BUDGET'] as const;
const RAW = /^[A-Za-z0-9_]{1,40}$/;
const INVALID: MapResult = Object.freeze({ ok: false, error: 'INVALID_INPUT' });
const raw = (v: unknown): string | null => (typeof v === 'string' && RAW.test(v) ? v : null);

export function mapCampaignStatus(input: unknown, origin: Origin): MapResult {
  try {
    if (origin !== 'SYNTHETIC_FIXTURE' && origin !== 'UNVERIFIED_RESPONSE') return INVALID;
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return INVALID;
    const o = input as Record<string, unknown>;
    const st = o.status, rs = o.statusReason, ul = o.userLock;
    const status: MediaStatus = (STATUSES as readonly unknown[]).includes(st) ? (st as MediaStatus) : 'UNKNOWN';
    const reason: MediaReason = rs === undefined || rs === null ? 'NONE' : (REASONS as readonly unknown[]).includes(rs) ? (rs as MediaReason) : 'UNKNOWN';
    const userSetting: UserSetting = ul === true ? 'LOCKED' : ul === false ? 'UNLOCKED' : 'UNKNOWN';
    const conflict = (status === 'ELIGIBLE' && userSetting === 'LOCKED') || (status === 'PAUSED' && userSetting === 'UNLOCKED' && reason === 'NONE');
    let internal: InternalState;
    if (status === 'UNKNOWN' || userSetting === 'UNKNOWN' || reason === 'UNKNOWN' || conflict) internal = 'NEEDS_REVIEW';
    else if (status === 'DELETED') internal = 'DELETED';
    else if (status === 'PAUSED') internal = 'PAUSED';
    else internal = 'ELIGIBLE_NOT_DELIVERY_PROOF';
    return Object.freeze({
      ok: true,
      value: Object.freeze({
        origin,
        media: Object.freeze({ status, rawStatus: status === 'UNKNOWN' ? raw(st) : status, reason, rawReason: reason === 'UNKNOWN' ? raw(rs) : reason === 'NONE' ? null : reason }),
        userSetting, internal, conflict, countsAsDelivery: false as const,
      }),
    });
  } catch {
    return INVALID;
  }
}
