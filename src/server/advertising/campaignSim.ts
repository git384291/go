import 'server-only';
// 광고 캠페인 모의 수명주기 — 생성→상태조회→중단→성과 확인 (PM 7040572928). **모의 전용. 매체 호출·실게재·청구가 없다.**
//
// - 입력은 미게시 초안 DTO의 구조만 확인한다(상태 DRAFT_UNPUBLISHED, executionAllowed false, blocker 유지). 초안 모듈을 직접 가져오지 않는다.
// - 시작·중단은 멱등키로 재시도해도 한 번만 처리한다(중복 이벤트·중복 상태 변경 없음).
// - 모든 캠페인은 mode SIMULATION, 실게재 0, 청구 0, 외부 호출 0 고정이다. 성과는 가상 표본(source 'sample')으로 계산한다.
// - 네트워크·DB·환경변수·로그·타이머를 쓰지 않는다. 메모리 저장소는 호출자가 만든 인스턴스에만 있다. 화면·API에 연결하지 않았다.
import { computeMetrics, type Metrics } from '@/content/adMetrics';

export type SimStatus = 'SIM_RUNNING' | 'SIM_STOPPED';
export type SimEvent = { readonly seq: number; readonly type: 'SIM_STARTED' | 'SIM_STOPPED' };
export type SimCampaign = {
  readonly simId: string;
  readonly mode: 'SIMULATION';
  readonly draftId: string;
  readonly status: SimStatus;
  readonly liveDelivery: false;
  readonly billedKrw: 0;
  readonly externalCalls: 0;
  readonly blockers: readonly string[];
  readonly events: readonly SimEvent[];
};
export type SimError = 'INVALID_INPUT' | 'NOT_FOUND';
export type SimResult<T> = { readonly ok: true; readonly value: T; readonly replayed: boolean } | { readonly ok: false; readonly error: SimError };

const KEY = /^[A-Za-z0-9_-]{1,40}$/;
const fail = (error: SimError): SimResult<never> => Object.freeze({ ok: false, error });
const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

export function createSimStore() {
  const byKey = new Map<string, string>();
  const byId = new Map<string, SimCampaign>();
  let n = 0;
  const put = (c: SimCampaign) => { byId.set(c.simId, Object.freeze(c)); return byId.get(c.simId) as SimCampaign; };
  const get = (id: unknown): SimCampaign | null => (typeof id === 'string' ? byId.get(id) ?? null : null);

  return Object.freeze({
    /** 모의 캠페인 생성. 같은 simKey 재시도는 기존 캠페인을 그대로 돌려준다 */
    start(draft: unknown, simKey: unknown): SimResult<SimCampaign> {
      if (typeof simKey !== 'string' || !KEY.test(simKey)) return fail('INVALID_INPUT');
      const prior = byKey.get(simKey);
      if (prior) return Object.freeze({ ok: true, value: get(prior) as SimCampaign, replayed: true });
      if (!isRec(draft) || draft.status !== 'DRAFT_UNPUBLISHED' || draft.executionAllowed !== false) return fail('INVALID_INPUT');
      if (typeof draft.draftId !== 'string' || !Array.isArray(draft.blockers) || draft.blockers.length < 1 || !draft.blockers.every((b) => typeof b === 'string')) return fail('INVALID_INPUT');
      n += 1;
      const simId = `sim-${n}`;
      byKey.set(simKey, simId);
      const c = put({ simId, mode: 'SIMULATION', draftId: draft.draftId, status: 'SIM_RUNNING', liveDelivery: false, billedKrw: 0, externalCalls: 0, blockers: Object.freeze([...(draft.blockers as string[])]), events: Object.freeze([{ seq: 1, type: 'SIM_STARTED' }]) });
      return Object.freeze({ ok: true, value: c, replayed: false });
    },
    status(simId: unknown): SimResult<SimCampaign> {
      const c = get(simId);
      return c ? Object.freeze({ ok: true, value: c, replayed: false }) : fail('NOT_FOUND');
    },
    /** 중단. 이미 중단됐으면 이벤트를 더하지 않고 같은 결과(replayed true)를 돌려준다 */
    stop(simId: unknown): SimResult<SimCampaign> {
      const c = get(simId);
      if (!c) return fail('NOT_FOUND');
      if (c.status === 'SIM_STOPPED') return Object.freeze({ ok: true, value: c, replayed: true });
      const next = put({ ...c, status: 'SIM_STOPPED', events: Object.freeze([...c.events, { seq: c.events.length + 1, type: 'SIM_STOPPED' as const }]) });
      return Object.freeze({ ok: true, value: next, replayed: false });
    },
    /** 성과: 가상 표본 입력(노출·클릭·지출 0)으로 지표 계산. 실제 실적이 아니다 */
    report(simId: unknown): SimResult<{ readonly sample: true; readonly spendKrw: 0; readonly metrics: Metrics }> {
      const c = get(simId);
      if (!c) return fail('NOT_FOUND');
      const metrics = computeMetrics({
        model: 'cohort', period: { from: '2026-11-17', to: '2026-11-23' }, windowDays: 30, source: 'sample', traffic: 'paid', format: 'search',
        spendKrw: 0, spendIncludesVat: false, impressions: 0, clicks: 0, visits: 0, conversions: { consult_request: 0 }, recognizedRevenueKrw: null,
      });
      return Object.freeze({ ok: true, value: Object.freeze({ sample: true as const, spendKrw: 0 as const, metrics }), replayed: false });
    },
  });
}
