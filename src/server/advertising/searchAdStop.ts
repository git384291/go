import 'server-only';
// 검색광고 캠페인 중단 요청→재조회 판정 — 순수 함수 (PM 7042822412). **요청을 보내지 않는다. 요청 서술과 응답 판정만 한다.**
// - 근거(PM 발췌, 원문 직접 열람 불가): PUT /api/ncc/campaigns/{campaignId}{?fields} — campaignId 필수, fields=userLock 지원, 본문 CampaignRequest 필수,
//   200은 Campaign, 201은 본문 스키마 미지정, 401·403·404 명시. 본문 CampaignRequest의 필드 구성은 확인하지 못해 userLock 외에는 넣지 않고 UNVERIFIED로 표시한다.
// - 요청 성공(HTTP)과 중단 확인(재조회 결과가 PAUSED이고 userLock true)을 구분한다. PUT 응답 본문만으로는 중단을 확인하지 않는다.
// - 응답 누락·상태 불일치·미지 HTTP 코드는 확인으로 세지 않는다. 재시도는 최대 3회 시도까지, 중단 요청은 같은 값(userLock true)이라 반복해도 같은 목표 상태다.
// - 네트워크·DB·환경변수·로그·타이머가 없다. 화면·API에 연결하지 않았다.
import { mapCampaignStatus, type MappedStatus, type Origin } from './searchAdStatus';

export const MAX_STOP_ATTEMPTS = 3;
const ID = /^[A-Za-z0-9_-]{1,50}$/;

export type StopRequest = {
  readonly method: 'PUT';
  readonly path: string;
  readonly fields: 'userLock';
  readonly body: { readonly userLock: true };
  readonly bodySchema: 'UNVERIFIED';
  readonly sendable: false;
};
export function buildStopRequest(campaignId: unknown): { readonly ok: true; readonly request: StopRequest } | { readonly ok: false; readonly error: 'INVALID_INPUT' } {
  if (typeof campaignId !== 'string' || !ID.test(campaignId)) return Object.freeze({ ok: false, error: 'INVALID_INPUT' });
  return Object.freeze({ ok: true, request: Object.freeze({ method: 'PUT', path: `/api/ncc/campaigns/${campaignId}`, fields: 'userLock', body: Object.freeze({ userLock: true as const }), bodySchema: 'UNVERIFIED', sendable: false as const }) });
}

export type HttpLike = { readonly httpStatus: number; readonly body?: unknown } | null | undefined;
export type RequestOutcome = 'ACCEPTED_200' | 'ACCEPTED_201_BODY_UNSPECIFIED' | 'REJECTED_401' | 'REJECTED_403' | 'REJECTED_404' | 'NO_RESPONSE' | 'UNKNOWN_HTTP';
export type Confirmation = 'CONFIRMED_PAUSED' | 'NOT_CONFIRMED' | 'MISMATCH' | 'REFETCH_MISSING' | 'REFETCH_UNKNOWN';
export type StopVerdict = 'STOP_CONFIRMED' | 'REQUEST_OK_NOT_CONFIRMED' | 'REQUEST_REJECTED' | 'NEEDS_REVIEW';
export type StopEvaluation = {
  readonly request: RequestOutcome;
  readonly confirmation: Confirmation;
  readonly verdict: StopVerdict;
  readonly retry: 'NONE' | 'RETRY' | 'ESCALATE';
  readonly refetched: MappedStatus | null;
  readonly attempt: number;
};

const status = (r: HttpLike): number | null => (r && typeof r === 'object' && Number.isSafeInteger(r.httpStatus) ? r.httpStatus : null);

/** put: 중단 요청 응답(없으면 null), refetch: 재조회 응답(없으면 null). attempt: 1부터 시작하는 시도 번호 */
export function evaluateStop(put: HttpLike, refetch: HttpLike, attempt: unknown, origin: Origin): StopEvaluation | { readonly ok: false; readonly error: 'INVALID_INPUT' } {
  try {
    if (typeof attempt !== 'number' || !Number.isSafeInteger(attempt) || attempt < 1 || attempt > MAX_STOP_ATTEMPTS) return Object.freeze({ ok: false, error: 'INVALID_INPUT' });
    const ps = status(put);
    const request: RequestOutcome = ps === 200 ? 'ACCEPTED_200' : ps === 201 ? 'ACCEPTED_201_BODY_UNSPECIFIED' : ps === 401 ? 'REJECTED_401' : ps === 403 ? 'REJECTED_403' : ps === 404 ? 'REJECTED_404' : ps === null ? 'NO_RESPONSE' : 'UNKNOWN_HTTP';
    const rejected = request.startsWith('REJECTED');
    let refetched: MappedStatus | null = null;
    let confirmation: Confirmation;
    if (status(refetch) !== 200 || !refetch || typeof refetch.body !== 'object' || refetch.body === null) confirmation = 'REFETCH_MISSING';
    else {
      const m = mapCampaignStatus(refetch.body, origin);
      if (!m.ok) confirmation = 'REFETCH_UNKNOWN';
      else {
        refetched = m.value;
        if (m.value.internal === 'PAUSED' && m.value.userSetting === 'LOCKED') confirmation = 'CONFIRMED_PAUSED';
        else if (m.value.internal === 'NEEDS_REVIEW') confirmation = 'REFETCH_UNKNOWN';
        else if (m.value.internal === 'DELETED') confirmation = 'NOT_CONFIRMED';
        else if (m.value.userSetting === 'UNLOCKED' || m.value.internal === 'ELIGIBLE_NOT_DELIVERY_PROOF') confirmation = 'MISMATCH';
        else confirmation = 'NOT_CONFIRMED';
      }
    }
    const accepted = request === 'ACCEPTED_200' || request === 'ACCEPTED_201_BODY_UNSPECIFIED';
    let verdict: StopVerdict;
    if (rejected) verdict = 'REQUEST_REJECTED';
    else if (confirmation === 'CONFIRMED_PAUSED') verdict = accepted ? 'STOP_CONFIRMED' : 'NEEDS_REVIEW'; // 요청 성공 응답 없이 PAUSED만 보이면 우리 요청의 결과인지 알 수 없다
    else if (accepted) verdict = 'REQUEST_OK_NOT_CONFIRMED';
    else verdict = 'NEEDS_REVIEW';
    const retry: StopEvaluation['retry'] = verdict === 'STOP_CONFIRMED' || verdict === 'REQUEST_REJECTED' ? 'NONE' : attempt < MAX_STOP_ATTEMPTS ? 'RETRY' : 'ESCALATE';
    return Object.freeze({ request, confirmation, verdict, retry, refetched, attempt });
  } catch {
    return Object.freeze({ ok: false, error: 'INVALID_INPUT' });
  }
}
