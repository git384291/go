// Google Ads 테스트 계정 read-back 검증(PM 11/22 107c497 지시 2). 로컬에서 사람이 직접 실행한다 — CI·서버는 실행하지 않는다.
// 확인 항목: test_account · KRW · Asia/Seoul · end_date_time read-back · budget read-back · pause 응답.
// - 실행 조건: GOOGLE_ADS_PROBE_READBACK=test-account-only 를 명시했을 때만. 계정이 test_account=true·manager 아님·KRW·Asia/Seoul일 때만 변경 호출.
//   Google 공식: 테스트 계정은 "Can't serve ads" · "don't ... charge your account"(광고비 0원). 운영 계정이면 변경 호출 0회로 끝난다.
// - 변경은 운영 어댑터(createGoogleAdsPlatform)의 launch(캠페인·광고 그룹·반응형 검색광고 모두 PAUSED 생성, 키워드 없음) 1회 + pause 1회뿐. 재시도 없음.
// - 출력은 단계·불리언·HTTP 상태뿐. credential·토큰·고객 ID·캠페인 ID·오류 원문은 출력하지 않는다. 만든 PAUSED 캠페인은 테스트 계정에 남는다.
import { randomUUID } from 'node:crypto';
import { boundedRequest, parseJsonSafe, type BodyTransport } from '../../src/server/advertising/boundedHttp';
import { approvedRsaCreative, landingUrlFrom } from '../../src/server/advertising/googleAdsCreative';
import { ACCOUNT_TIME_ZONE, createGoogleAdsPlatform, GOOGLE_ADS_DEFAULT_API_VERSION, GOOGLE_ADS_ENV_NAMES, googleAdsConfigFromEnv } from '../../src/server/advertising/googleAdsPlatform';
import { PlatformError } from '../../src/server/advertising/platform';

export type ReadbackLine = Record<string, string | number | boolean | string[] | null>;
export const READBACK_FLAG = 'GOOGLE_ADS_PROBE_READBACK';
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const enc = new TextEncoder();
/** KST 기준 내일(YYYY-MM-DD). 종료일을 짧게 둔다 */
export const kstTomorrow = (now: Date) => new Date(now.getTime() + 9 * 3_600_000 + 86_400_000).toISOString().slice(0, 10);

/** 종료 코드: 0 전부 확인, 2 설정·실행 플래그 없음, 3 인증·조회 실패, 4 조건 불충족(변경 호출 안 함), 5 launch 실패, 6 read-back 불일치, 7 pause 실패 */
export async function runReadback(env: Readonly<Record<string, string | undefined>>, transport: BodyTransport, log: (l: ReadbackLine) => void, now: () => Date = () => new Date()): Promise<number> {
  const v = (k: string) => (typeof env[k] === 'string' && env[k]!.trim() !== '' ? env[k]!.trim() : null);
  const missing = GOOGLE_ADS_ENV_NAMES.filter((k) => v(k) === null);
  const armed = v(READBACK_FLAG) === 'test-account-only';
  log({ step: 'env', ok: missing.length === 0 && armed, missing: [...missing], armed });
  if (missing.length > 0 || !armed) return 2;
  // 11/23 C: launch가 광고 그룹·반응형 검색광고(모두 PAUSED)까지 만들므로 검수 소재와 최종 URL(AD_LANDING_URL)이 필요하다
  const cfg = { ...googleAdsConfigFromEnv(env, transport), initialStatus: 'PAUSED' as const, validateOnly: false, creative: approvedRsaCreative(), landingUrl: landingUrlFrom(env.AD_LANDING_URL) };
  const platform = createGoogleAdsPlatform(cfg);
  if (!platform || !cfg.customerId) { log({ step: 'config', ok: false }); return 2; }
  const deadline = () => Date.now() + 15_000; // 요청 시간 제한은 실제 시계(종료일 계산용 now와 분리)

  // ① 읽기 전용: 토큰 → 계정 정보(test_account·manager·통화·시간대)
  const tk = await boundedRequest(transport, 'https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: enc.encode(`grant_type=refresh_token&client_id=${encodeURIComponent(cfg.clientId!)}&client_secret=${encodeURIComponent(cfg.clientSecret!)}&refresh_token=${encodeURIComponent(cfg.refreshToken!)}`),
  }, { deadlineAt: deadline(), maxResponseBytes: 64 * 1024 });
  const tj = tk.kind === 'ok' ? parseJsonSafe(tk.text) : null;
  const token = tk.kind === 'ok' && tk.status === 200 && isObj(tj) && typeof tj.access_token === 'string' ? tj.access_token : null;
  log({ step: 'oauth', ok: token !== null, http: tk.kind === 'ok' || tk.kind === 'http' ? tk.status : 0 });
  if (!token) return 3;
  const version = cfg.apiVersion ?? GOOGLE_ADS_DEFAULT_API_VERSION;
  const rd = await boundedRequest(transport, `https://googleads.googleapis.com/${version}/customers/${cfg.customerId}/googleAds:search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(cfg.loginCustomerId ? { 'login-customer-id': cfg.loginCustomerId } : {}), ...(cfg.legacyDeveloperToken ? { 'developer-token': cfg.legacyDeveloperToken } : {}) },
    body: enc.encode(JSON.stringify({ query: 'SELECT customer.currency_code, customer.test_account, customer.manager, customer.time_zone FROM customer' })),
  }, { deadlineAt: deadline(), maxResponseBytes: 64 * 1024 });
  const rj = rd.kind === 'ok' ? parseJsonSafe(rd.text) : null;
  const row = isObj(rj) && Array.isArray(rj.results) && rj.results.length === 1 && isObj(rj.results[0]) && isObj(rj.results[0].customer) ? rj.results[0].customer : null;
  const testAccount = row?.testAccount === true;
  const manager = row?.manager === true;
  const krw = row?.currencyCode === 'KRW';
  const seoul = row?.timeZone === ACCOUNT_TIME_ZONE;
  log({ step: 'account_read', ok: row !== null, http: rd.kind === 'ok' || rd.kind === 'http' ? rd.status : 0, testAccount, manager, krw, seoul });
  if (!row) return 3;
  if (!testAccount || manager || !krw || !seoul) {
    log({ step: 'launch', skipped: true, reason: !testAccount ? 'NOT_TEST_ACCOUNT' : manager ? 'MANAGER_ACCOUNT' : !krw ? 'NOT_KRW' : 'NOT_ASIA_SEOUL' });
    return 4;
  }

  // ② 운영 어댑터 그대로: 예산 1,000원(승인 2,000원의 ÷2) + PAUSED 캠페인(종료일 KST 내일 23:59:59) → read-back
  const endDate = kstTomorrow(now());
  let externalId: string;
  try {
    const r = await platform.launch({ campaign: 'readback-probe', amountKrw: 2000, platformDailyBudgetKrw: 1000, requestKey: randomUUID(), endDate, deadlineAt: deadline() });
    externalId = r.externalId;
    const budgetOk = r.dailyBudgetKrw === 1000;
    log({ step: 'launch', ok: true, campaignStatus: 'PAUSED', budgetReadBack: budgetOk, endDateTimeReadBack: r.endVerified, endDate });
    if (!budgetOk || !r.endVerified) {
      // 불일치여도 pause 응답은 확인한다(어댑터의 즉시 중지 경로와 같음)
      const p = await platform.pause({ campaign: 'readback-probe', externalId }, { deadlineAt: deadline() }).catch(() => ({ paused: false }));
      log({ step: 'pause', ok: p.paused === true });
      return 6;
    }
  } catch (e) {
    log({ step: 'launch', ok: false, state: e instanceof PlatformError ? e.outcome : 'error', code: e instanceof PlatformError ? e.code : null });
    return 5;
  }
  // ③ pause 응답(이미 PAUSED여도 같은 응답이어야 한다 — 서버의 '이미 중지돼 있어도 안전' 전제)
  try {
    const p = await platform.pause({ campaign: 'readback-probe', externalId }, { deadlineAt: deadline() });
    log({ step: 'pause', ok: p.paused === true });
    return p.paused === true ? 0 : 7;
  } catch (e) {
    log({ step: 'pause', ok: false, state: e instanceof PlatformError ? e.outcome : 'error', code: e instanceof PlatformError ? e.code : null });
    return 7;
  }
}
