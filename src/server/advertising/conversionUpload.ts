// 광고 전환 업로드(PM 11/25 승인: 개발·Mock 시험만). **실제 Google 전송 0회 — 기본 transport·서버 연결·스케줄 없음.**
// - 대상 API: Google Data Manager API `POST https://datamanager.googleapis.com/v1/events:ingest` (scope auth/datamanager).
//   Google Ads API UploadClickConversions는 신규 사용자에게 막혀 있다(공식 deprecations: 2026-06-15 이후 CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE, Data Manager API로 이전 안내).
//   필드 대응(공식 field-mappings): conversion_action → destinations[].productDestinationId, customer_id → operatingAccount.accountId,
//   gclid → events[].adIdentifiers.gclid, conversion_date_time → eventTimestamp(RFC 3339), order_id → transactionId, currency_code → currency, encoding 필수.
// - 개인정보: 전화·이름·주소·리드 ID 원문은 보내지 않는다. 보내는 값은 gclid·접수 시각·거래 ID(리드 ID의 HMAC 앞 32자)·전환값·통화뿐.
//   userData(해시 연락처)는 만들지 않는다. 오류·결과에는 고정 코드와 개수만 남긴다(응답 원문·gclid·ID 반사 없음).
// - 중복 집계 방지: ① 같은 리드는 같은 거래 ID(HMAC, 결정적) ② 한 묶음 안 같은 리드·같은 gclid는 1건만 ③ 이미 보낸 리드(alreadySent)는 제외.
//   ③의 원장(DB)은 아직 없다 — 운영 전 별도 마이그레이션·PM 승인 필요.
// - 계정 통화 KRW가 아니면(또는 모르면) 보내지 않는다(전환값 단위 어긋남). 클릭 후 90일이 지난 gclid는 보내지 않는다.
// - validateOnly는 항상 true(Google이 검증만, 기록 없음). false로 바꾸는 경로는 없다 — 실전송은 PM·사용자 승인 뒤 별도 변경.
import { createHmac } from 'node:crypto';

export const DATA_MANAGER_INGEST_URL = 'https://datamanager.googleapis.com/v1/events:ingest';
/** Google: 클릭 후 90일 안의 전환만 업로드 가능 */
export const CONVERSION_MAX_AGE_DAYS = 90;
/** 한 요청 최대 이벤트 수(서버 보수 상한) */
export const CONVERSION_BATCH_MAX = 200;
const GCLID = /^[A-Za-z0-9_-]{10,200}$/;
const ID10 = /^\d{10}$/;
const ACTION_ID = /^\d{1,20}$/;
const DAY_MS = 86_400_000;

export type ConversionLead = { readonly leadId: string; readonly gclid: string; readonly clickAt: Date; readonly convertedAt: Date };
export type ConversionTransport = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string }) => Promise<{ status: number; text: string }>;
export type ConversionConfig = {
  readonly customerId: string;
  readonly conversionActionId: string;
  readonly accountCurrency: string | null;
  readonly valueKrw: number;
  readonly hmacKey: string;
};
export type SkipCode = 'GCLID_INVALID' | 'TOO_OLD' | 'FUTURE_TIME' | 'DUPLICATE_LEAD' | 'DUPLICATE_GCLID' | 'ALREADY_SENT';
export type PlanResult =
  | { readonly ok: false; readonly code: 'CONFIG_INVALID' | 'CURRENCY_NOT_KRW' | 'BATCH_TOO_LARGE' }
  | { readonly ok: true; readonly body: Record<string, unknown>; readonly transactionIds: readonly string[]; readonly skipped: Readonly<Record<SkipCode, number>> };

/** 리드 ID → 거래 ID(결정적, 원문 비노출). 같은 리드는 언제 보내도 같은 값 → Google 쪽 중복 제거 기준 */
export function transactionIdFor(leadId: string, hmacKey: string): string {
  return createHmac('sha256', hmacKey).update(`conv:${leadId}`).digest('hex').slice(0, 32);
}

/** 순수 함수: 보낼 요청 본문을 만든다(전송 없음) */
export function planConversionUpload(leads: readonly ConversionLead[], cfg: ConversionConfig, now: Date, alreadySent: ReadonlySet<string> = new Set()): PlanResult {
  if (!ID10.test(cfg.customerId) || !ACTION_ID.test(cfg.conversionActionId) || !Number.isSafeInteger(cfg.valueKrw) || cfg.valueKrw < 0 || cfg.valueKrw > 10_000_000
    || typeof cfg.hmacKey !== 'string' || cfg.hmacKey.length < 32) return { ok: false, code: 'CONFIG_INVALID' };
  if (cfg.accountCurrency !== 'KRW') return { ok: false, code: 'CURRENCY_NOT_KRW' };
  if (leads.length > CONVERSION_BATCH_MAX) return { ok: false, code: 'BATCH_TOO_LARGE' };
  const skipped: Record<SkipCode, number> = { GCLID_INVALID: 0, TOO_OLD: 0, FUTURE_TIME: 0, DUPLICATE_LEAD: 0, DUPLICATE_GCLID: 0, ALREADY_SENT: 0 };
  const seenLead = new Set<string>(); const seenGclid = new Set<string>();
  const events: Record<string, unknown>[] = []; const tids: string[] = [];
  for (const l of leads) {
    if (typeof l.gclid !== 'string' || !GCLID.test(l.gclid) || !/[A-Za-z]/.test(l.gclid) || /[0-9]{9}/.test(l.gclid)) { skipped.GCLID_INVALID++; continue; }
    const click = l.clickAt.getTime(), conv = l.convertedAt.getTime();
    if (!Number.isFinite(click) || !Number.isFinite(conv) || conv > now.getTime() || click > conv) { skipped.FUTURE_TIME++; continue; }
    if (now.getTime() - click > CONVERSION_MAX_AGE_DAYS * DAY_MS) { skipped.TOO_OLD++; continue; }
    const tid = transactionIdFor(l.leadId, cfg.hmacKey);
    if (alreadySent.has(tid)) { skipped.ALREADY_SENT++; continue; }
    if (seenLead.has(tid)) { skipped.DUPLICATE_LEAD++; continue; }
    if (seenGclid.has(l.gclid)) { skipped.DUPLICATE_GCLID++; continue; }
    seenLead.add(tid); seenGclid.add(l.gclid); tids.push(tid);
    events.push({ adIdentifiers: { gclid: l.gclid }, eventTimestamp: l.convertedAt.toISOString(), transactionId: tid, conversionValue: cfg.valueKrw, currency: 'KRW' });
  }
  const body = {
    destinations: [{ operatingAccount: { accountType: 'GOOGLE_ADS', accountId: cfg.customerId }, productDestinationId: cfg.conversionActionId }],
    events,
    encoding: 'HEX',
    validateOnly: true,
  };
  return { ok: true, body, transactionIds: tids, skipped };
}

export type UploadResult = { readonly ok: boolean; readonly code: 'VALIDATED' | 'NOTHING_TO_SEND' | 'CONFIG_INVALID' | 'CURRENCY_NOT_KRW' | 'BATCH_TOO_LARGE' | 'AUTH_ERROR' | 'REJECTED' | 'UNKNOWN';
  readonly sent: number; readonly skipped: Readonly<Record<SkipCode, number>> | null };

/** 검증 전송(validateOnly=true 고정). transport는 필수 주입 — 기본 fetch 없음. 실패·불명은 성공으로 세지 않는다 */
export async function validateConversionUpload(leads: readonly ConversionLead[], cfg: ConversionConfig, deps: { transport: ConversionTransport; accessToken: string; now: Date; alreadySent?: ReadonlySet<string> }): Promise<UploadResult> {
  const plan = planConversionUpload(leads, cfg, deps.now, deps.alreadySent);
  if (!plan.ok) return { ok: false, code: plan.code, sent: 0, skipped: null };
  const events = plan.body.events as unknown[];
  if (events.length === 0) return { ok: true, code: 'NOTHING_TO_SEND', sent: 0, skipped: plan.skipped };
  if (plan.body.validateOnly !== true) return { ok: false, code: 'CONFIG_INVALID', sent: 0, skipped: plan.skipped }; // 방어: 실기록 금지
  let r: { status: number; text: string };
  try {
    r = await deps.transport(DATA_MANAGER_INGEST_URL, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${deps.accessToken}` }, body: JSON.stringify(plan.body) });
  } catch { return { ok: false, code: 'UNKNOWN', sent: 0, skipped: plan.skipped }; }
  if (r.status === 401 || r.status === 403) return { ok: false, code: 'AUTH_ERROR', sent: 0, skipped: plan.skipped };
  if (r.status >= 400 && r.status < 500) return { ok: false, code: 'REJECTED', sent: 0, skipped: plan.skipped };
  if (r.status !== 200) return { ok: false, code: 'UNKNOWN', sent: 0, skipped: plan.skipped };
  let j: unknown; try { j = JSON.parse(r.text); } catch { j = null; }
  if (typeof j !== 'object' || j === null || typeof (j as { requestId?: unknown }).requestId !== 'string') return { ok: false, code: 'UNKNOWN', sent: 0, skipped: plan.skipped };
  return { ok: true, code: 'VALIDATED', sent: events.length, skipped: plan.skipped };
}

/** 접수 ↔ 전환 대조: 광고 귀속 접수 수 = 보낸 수 + 건너뛴 수(사유별). 어긋나면 false(조용히 빠진 건 없음 확인) */
export function reconcile(totalLeads: number, r: UploadResult): boolean {
  if (!r.skipped || (r.code !== 'VALIDATED' && r.code !== 'NOTHING_TO_SEND')) return false;
  const skippedSum = Object.values(r.skipped).reduce((a, b) => a + b, 0);
  return r.sent + skippedSum === totalLeads;
}
