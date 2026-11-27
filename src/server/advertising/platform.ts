/**
 * 광고 플랫폼 교체형 인터페이스(PM 11/21, 11/22 P1 보강). 실제 광고 API 어댑터는 만들지 않았다 — 지금은 무료 모의 어댑터만 있다.
 * - live=false(모의): 아무 곳에도 과금·집행하지 않는다. 집행·성과는 가상 값이다.
 * - live=true인 어댑터가 생기면 서버가 AD_EXECUTION_ENABLED=true(기본 꺼짐)와 DB 예산 승인 둘 다 통과해야만 launch를 부른다.
 * - 키·토큰은 서버 환경변수에서만 읽는 자리이며 이 인터페이스의 입출력에 나오지 않는다.
 *
 * 실제 어댑터가 반드시 지켜야 할 계약(어댑터 시험 규약):
 *  1) 예산 보호: launch는 플랫폼 쪽 일 예산을 req.platformDailyBudgetKrw(= 승인액 ÷ 2, Google 2배 지출 규칙 반영) 이하로 설정하고, 실제 설정값을 dailyBudgetKrw로 돌려준다.
 *     설정할 수 없으면 집행하지 말고 PlatformError('failed')를 던진다. 서버는 돌려받은 값이 상한을 넘으면 즉시 중지·경고한다(pause가 실패해도 플랫폼 상한이 추가 피해를 제한한다).
 *  2) 시간 제한: 모든 호출은 opts.deadlineAt(절대 시각 ms)까지 끝내야 하며 HTTP는 boundedHttp.boundedRequest로 보낸다. 서버도 같은 시간 뒤에 결과를 버린다(callPlatform).
 *  3) 오류 구분: 요청이 플랫폼에 닿지 않았거나 집행이 일어나지 않았음이 확실하면 PlatformError('failed'), 그 밖(시간 초과·응답 유실·5xx 등 집행 여부 불명)은
 *     PlatformError('unknown') 또는 일반 예외(= unknown). launch가 unknown이면 서버는 자동 재launch를 하지 않고 사람이 확인(ad_launch_resolve)할 때까지 막는다.
 *  4) pause·fetchPerformance는 서버가 저장한 externalId(ref.externalId)로 호출된다. 키·토큰·URL은 오류에 담지 않는다.
 */
export const AD_CALL_TIMEOUT_MS = 10_000;
/** Google Ads: 특정일 지출은 평균 일예산의 최대 2배까지 나갈 수 있다(월 30.4배 이내). PM 11/22 P1 */
export const GOOGLE_MAX_DAY_MULTIPLIER = 2;
/** 매체에 설정할 일예산 = 승인액 ÷ 2(내림). 2배 지출이 나가도 하루 최악값이 승인액 이하가 된다. 1원 미만이면 0(집행 불가) */
export const platformDailyBudgetFor = (approvedKrw: number): number =>
  Number.isSafeInteger(approvedKrw) && approvedKrw > 0 ? Math.floor(approvedKrw / GOOGLE_MAX_DAY_MULTIPLIER) : 0;

export type LaunchRequest = {
  readonly campaign: string;
  readonly amountKrw: number;
  readonly requestKey: string;
  /** 플랫폼 쪽 일 예산 상한(원). 어댑터는 이 값 이하로 설정해야 한다 */
  readonly platformDailyBudgetKrw: number;
  /** 매체 종료일(YYYY-MM-DD, 계정 시간대 Asia/Seoul). DB가 승인 만료 전으로 정한 값. 어댑터는 end_date_time = 이 날 23:59:59로 설정한다 */
  readonly endDate: string;
  readonly deadlineAt: number;
};
/** endVerified: 매체에서 다시 읽은 종료일·계정 시간대가 요청과 정확히 같을 때만 true. 아니면 서버가 즉시 중지·집행 금지 */
export type LaunchResult = { readonly externalId: string; readonly dailyBudgetKrw: number; readonly endVerified: boolean };
export type PlatformRef = { readonly campaign: string; readonly externalId: string | null };
export type CallOpts = { readonly deadlineAt: number };
export type AdPlatform = {
  readonly name: string;
  readonly live: boolean;
  launch(req: LaunchRequest): Promise<LaunchResult>;
  /** 캠페인 노출 중지. 초과 감지·수동 중지 때 서버가 부른다(이미 중지돼 있어도 안전해야 한다) */
  pause(ref: PlatformRef, opts: CallOpts): Promise<{ readonly paused: boolean }>;
  /** 계정에서 지금 노출 가능한(ENABLED) 캠페인 수. 집행 전 확인 — 1 이상이거나 조회 실패면 서버는 집행하지 않는다(fail-closed) */
  activeCampaignCount(opts: CallOpts): Promise<number>;
  /** 광고 계정 시간대(IANA). 집행 전·정기 감시마다 확인 — Asia/Seoul이 아니거나 조회 실패면 서버는 집행하지 않는다(종료일·날짜 경계가 KST 기준) */
  accountTimeZone(opts: CallOpts): Promise<string>;
  /** 광고 계정 통화(ISO 4217). 집행 전·정기 감시마다 확인 — KRW가 아니거나 조회 실패면 서버는 집행하지 않는다(예산·한도·CPC가 원화 기준) */
  accountCurrency(opts: CallOpts): Promise<string>;
  /** 하루치 성과. 보고가 아직 없으면 costKrw를 null(UNKNOWN)로 돌려준다. 형식 검증은 호출측(서버)이 한다 — 어댑터 값은 믿지 않는다 */
  fetchPerformance(ref: PlatformRef, day: string, opts: CallOpts): Promise<unknown>;
  /**
   * (선택, PM 11/25 ③) 캠페인 상태 다시 읽기: { status: 'PAUSED' | 'ENABLED' | ... }. 형식 검증은 서버가 한다.
   * 활성화 전후 확인에 쓴다. 없으면 자동 활성화는 실행되지 않는다(닫힘).
   */
  campaignStatus?(ref: PlatformRef, opts: CallOpts): Promise<unknown>;
  /**
   * (선택, PM 11/25 ③) PAUSED → ENABLED 전환. 지금은 모의 어댑터만 구현한다. 실제(Google Ads) 어댑터에는 만들지 않는다 — 실제 ENABLED 호출 금지.
   * 서버(adScheduler)도 live 어댑터면 이 함수를 부르지 않는다(이중 차단).
   */
  enable?(ref: PlatformRef, opts: CallOpts): Promise<unknown>;
};

/** 어댑터가 결과를 분명히 알릴 때 쓰는 오류. outcome이 failed면 '집행·변경이 일어나지 않았음이 확실'하다는 뜻이다 */
export class PlatformError extends Error {
  constructor(readonly outcome: 'failed' | 'unknown', readonly code: string = 'PLATFORM_ERROR') {
    super(code);
    this.name = 'PlatformError';
  }
}

export type CallOutcome<T> =
  | { readonly status: 'success'; readonly value: T }
  | { readonly status: 'failed'; readonly code: string }
  | { readonly status: 'unknown'; readonly code: string };

const SAFE_CODE = /^[A-Z_]{2,40}$/;

/** 플랫폼 호출을 시간 제한으로 감싸 success / failed / unknown으로 나눈다. 예외 원문은 돌려주지 않는다(고정 코드만) */
export async function callPlatform<T>(fn: (deadlineAt: number) => Promise<T>, ms: number = AD_CALL_TIMEOUT_MS): Promise<CallOutcome<T>> {
  const deadlineAt = Date.now() + ms;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), ms); });
  try {
    const r = await Promise.race([Promise.resolve().then(() => fn(deadlineAt)), timeout]);
    if (r === 'timeout') return { status: 'unknown', code: 'TIMEOUT' };
    return { status: 'success', value: r as T };
  } catch (e) {
    if (e instanceof PlatformError) return { status: e.outcome, code: SAFE_CODE.test(e.code) ? e.code : 'PLATFORM_ERROR' };
    return { status: 'unknown', code: 'PLATFORM_ERROR' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const hash = (s: string) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0; return h; };

/** 모의 캠페인 상태(메모리). 모의 launch는 PAUSED로 만든 것으로 본다. 과금·외부 호출 없음 */
const mockStatus = new Map<string, 'PAUSED' | 'ENABLED'>();
export const mockPlatform: AdPlatform = Object.freeze({
  name: 'mock',
  live: false,
  async launch(req) { return { externalId: `mock-${hash(req.campaign + req.requestKey).toString(16)}`, dailyBudgetKrw: req.platformDailyBudgetKrw, endVerified: true }; },
  async pause(ref) { if (ref.externalId) mockStatus.set(ref.externalId, 'PAUSED'); return { paused: true }; },
  async campaignStatus(ref) { return { status: (ref.externalId && mockStatus.get(ref.externalId)) || 'PAUSED' }; },
  async enable(ref) { if (!ref.externalId) throw new PlatformError('failed', 'NO_EXTERNAL_ID'); mockStatus.set(ref.externalId, 'ENABLED'); return { enabled: true }; },
  async activeCampaignCount() { return 0; },
  async accountTimeZone() { return 'Asia/Seoul'; },
  async accountCurrency() { return 'KRW'; },
  async fetchPerformance(ref, day) {
    const h = hash(`${ref.campaign}:${day}`);
    const impressions = 500 + (h % 2000);
    const clicks = Math.floor(impressions * (0.01 + ((h >>> 8) % 40) / 1000));
    return { impressions, clicks, costKrw: clicks * 10 };
  },
});

export function createPlatform(env: Readonly<Record<string, string | undefined>>): AdPlatform | null {
  return env.AD_PLATFORM === 'mock' ? mockPlatform : null;
}
