import 'server-only';
import { boundedRequest, parseJsonSafe, type BodyTransport, type BoundedResult } from './boundedHttp';
import { CAMPAIGN_KEY } from '../../content/attribution';
import { adGroupAdCreatePayload, adGroupCreatePayload, adGroupCriterionCreatePayload, finalUrlSuffixFor, isApprovedKeywordSet, type KeywordSet, type RsaCreative } from './googleAdsCreative';
import { GOOGLE_MAX_DAY_MULTIPLIER, PlatformError, type AdPlatform, type CallOpts, type LaunchRequest, type LaunchResult, type PlatformRef } from './platform';

// Google Ads 어댑터 (PM 11/22 지시, 11/23 B·C 승인으로 서버 연결·광고 그룹·반응형 검색광고 추가). **실계정 검증 없음(모의 transport 시험만).**
// - 기존 AdPlatform 계약(platform.ts 1~4항)과 0018 launch 상태 구조를 그대로 쓴다. 서버는 platformSelect(AD_PLATFORM=google_ads + 설정 전부)로만 이 어댑터를 받는다.
// - launch 순서: 예산 → 캠페인(PAUSED) → 광고 그룹(PAUSED, SEARCH_STANDARD) → 키워드(PAUSED, EXACT만, 1요청) → 반응형 검색광고(PAUSED) → 다시 읽어 확인. 캠페인이 생긴 뒤의 실패는 전부 unknown(사람 확인, 자동 재시도 없음).
// - transport(boundedHttp 주입형)·OAuth credential 4종(client ID·client secret·refresh token·customer ID)은 **필수 주입**이다. 기본 fetch·process.env·SDK·재시도·키 저장 없음.
//   credential은 호출자가 환경변수에서 읽어 넘긴다(GOOGLE_ADS_ENV_NAMES). 이 파일·DB·로그·오류에 값이 남지 않는다.
//   설정이 하나라도 비면 createGoogleAdsPlatform은 null(= 닫힘). 기본 transport 연결·AD_PLATFORM 선택은 제이님 승인 뒤 별도 단계다.
// - developer token은 필수가 아니다(공식 정책 페이지: 2026-09-09 폐지, 헤더는 선택이며 서버가 무시, 장차 한 major 버전부터 거부 예정). 접근 수준은 OAuth credential을 만든
//   Google Cloud 프로젝트가 정한다(신규는 Test access; v25+에서 Test 프로젝트로 운영 계정 호출 시 CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION). legacyDeveloperToken을 주입한 때만 헤더로 보낸다.
// - API 버전: 요청은 major(vNN)로만 보낸다. 공식 versioning 문서: minor(v26.2 등)는 같은 endpoint가 제자리에서 갱신되며 minor를 지정해 호출할 수 없다. 기본 v26, 'v26.2' 같은 minor 문자열은 거부(null).
//   v26 sunset은 2027-11 추정(공식 일정 글). 바꿀 때는 GOOGLE_ADS_API_VERSION(major)만 바꾼다.
// - 범위: 예산(CampaignBudget)+캠페인(Campaign)+광고 그룹(AdGroup)+키워드(AdGroupCriterion, 승인 목록의 EXACT만, PM 11/24)+반응형 검색광고(AdGroupAd) 생성·중지·성과 조회. 이미지·영상은 만들지 않는다.
//   키워드가 없거나(비어 있음) 승인 목록 밖이면 어댑터가 없다(닫힘) — 키워드 없는 광고는 만들지 않는다. 입찰가(CPC)는 정하지 않는다(Keyword Planner 실데이터·승인 전 확정 금지).
//   키워드도 PAUSED로 만들고, 다시 읽어 개수·EXACT·PAUSED·승인 문구가 모두 맞을 때만 확인 완료(아니면 서버가 즉시 중지).
//   캠페인은 항상 PAUSED로 만든다(ENABLED로 생성하는 설정·경로 없음, 11/26 보안 수정). 켜는 일은 사람이 Google Ads 화면에서만.
// - 예산 보호: 일 예산은 원화를 micros로 바꿔 req.platformDailyBudgetKrw 이하로만 설정하고, 만든 뒤 다시 읽어(read-back) 실제 값을 돌려준다.
//   읽기에 실패하거나 값이 다르면 dailyBudgetKrw=0(미확인)을 돌려 서버가 즉시 중지·경고하게 한다(fail-closed). 계정 통화는 KRW여야 한다(아니면 예산 단위가 어긋난다). 서버가 집행 전·정기 감시마다 accountCurrency로 확인해 KRW가 아니면 차단·중지한다(모의 시험만, 실계정 미확인).
// - 오류 구분(응답 본문은 읽지 않는다 — 반사 금지): 요청 거부(400·401·403·404·429)는 집행 안 됨이 확실 → failed(코드 BAD_REQUEST·AUTH_ERROR·NOT_FOUND·RATE_LIMITED),
//   마감·전송 오류·5xx·2xx 판독 실패는 집행 여부 불명 → unknown. 예산 값 오류는 전송 전 BUDGET_INVALID(failed), 읽기 값 불일치는 BUDGET_MISMATCH.
// - 캠페인 이름에 requestKey를 넣어 사람이 구글 광고 화면에서 unknown 건을 찾아 대조할 수 있게 한다(자동 재시도 없음).
// - validateOnly=true면 구글에 검증만 요청하고(아무것도 만들지 않음) PlatformError('failed','VALIDATE_ONLY')로 끝낸다. 공식 reference상 validate_only 지원: MutateCampaignBudgetsRequest(v26 확인)·
//   MutateCampaignsRequest(v25 확인, v26 페이지는 열람 불가)·SearchGoogleAdsRequest(v26 확인). 이 어댑터는 campaignBudgets:mutate(생성)에만 적용한다 — 캠페인은 아직 없는 예산을 참조해 이어 검증할 수 없고,
//   campaigns:mutate(생성·중지)와 조회에는 쓰지 않는다. 검색에는 page_size를 보내지 않는다(설정하면 PAGE_SIZE_NOT_SUPPORTED 오류, 공식 reference).

/** 실제 필요한 credential(필수). developer token은 더 이상 필수가 아니다 */
export const GOOGLE_ADS_ENV_NAMES = Object.freeze([
  'GOOGLE_ADS_CLIENT_ID', 'GOOGLE_ADS_CLIENT_SECRET', 'GOOGLE_ADS_REFRESH_TOKEN', 'GOOGLE_ADS_CUSTOMER_ID',
] as const);
/** 선택: 관리자 계정 경유 시 login customer ID, major 버전 지정, 기존 developer token(legacy, 있어도 서버가 무시) */
export const GOOGLE_ADS_OPTIONAL_ENV_NAMES = Object.freeze(['GOOGLE_ADS_LOGIN_CUSTOMER_ID', 'GOOGLE_ADS_API_VERSION', 'GOOGLE_ADS_DEVELOPER_TOKEN'] as const);
export const GOOGLE_ADS_DEFAULT_API_VERSION = 'v26';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_BASE = 'https://googleads.googleapis.com';
const MAX_BYTES = 64 * 1024;
const MICROS = 1_000_000;
const ID = /^\d{1,20}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const VERSION = /^v\d{2}$/;

export type GoogleAdsConfig = {
  readonly transport: BodyTransport | null;
  /** major만(예: 'v26'). 비우면 기본 v26. 'v26.2' 같은 minor는 거부 */
  readonly apiVersion?: string | null;
  /** legacy(선택): 주입한 때만 developer-token 헤더로 보낸다. 신규 연동은 필요 없음 */
  readonly legacyDeveloperToken?: string | null;
  readonly clientId: string | null;
  readonly clientSecret: string | null;
  readonly refreshToken: string | null;
  /** 하이픈 없는 10자리 고객 ID */
  readonly customerId: string | null;
  readonly loginCustomerId?: string | null;
  readonly validateOnly?: boolean;
  /** 반응형 검색광고 소재(googleAdsCreative.buildRsaCreative 결과만). 없으면 어댑터 없음(닫힘) */
  readonly creative?: RsaCreative | null;
  /** 최종 URL(googleAdsCreative.landingUrlFrom 통과값). 없으면 어댑터 없음(닫힘) */
  readonly landingUrl?: string | null;
  /** 승인된 EXACT 키워드(googleAdsCreative.approvedKeywords 결과만). 비어 있거나 승인 목록 밖이면 어댑터 없음(닫힘) */
  readonly keywords?: KeywordSet | null;
};

/** 환경변수 객체에서 설정을 만든다(값은 읽기만, 저장·출력 없음). transport는 호출자가 넣는다 */
export function googleAdsConfigFromEnv(env: Readonly<Record<string, string | undefined>>, transport: BodyTransport | null): GoogleAdsConfig {
  const v = (k: string) => (typeof env[k] === 'string' && env[k]!.trim() !== '' ? env[k]!.trim() : null);
  return {
    transport, apiVersion: v('GOOGLE_ADS_API_VERSION'), legacyDeveloperToken: v('GOOGLE_ADS_DEVELOPER_TOKEN'), clientId: v('GOOGLE_ADS_CLIENT_ID'),
    clientSecret: v('GOOGLE_ADS_CLIENT_SECRET'), refreshToken: v('GOOGLE_ADS_REFRESH_TOKEN'), customerId: (v('GOOGLE_ADS_CUSTOMER_ID') ?? '').replace(/-/g, '') || null,
    loginCustomerId: (v('GOOGLE_ADS_LOGIN_CUSTOMER_ID') ?? '').replace(/-/g, '') || null,
  };
}

const enc = new TextEncoder();
/** 예산·캠페인 생성 본문(어댑터와 테스트 계정 진단 스크립트가 같은 값을 쓰게 공유). 광고 그룹·소재 없음 */
export const budgetCreatePayload = (name: string, krw: number) => ({ name, amountMicros: String(krw * MICROS), deliveryMethod: 'STANDARD', explicitlyShared: false });
export const campaignCreatePayload = (name: string, status: 'PAUSED', budget: string, endDateTime?: string) =>
  ({ name, status, campaignBudget: budget, advertisingChannelType: 'SEARCH', manualCpc: {}, containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING', ...(endDateTime ? { endDateTime } : {}) });
/** Google Ads API v23+ Campaign.end_date_time: "yyyy-MM-dd HH:mm:ss", 고객 계정 시간대. 일 단위는 23:59:59(검색 캠페인은 시간 단위 미지원) */
export const campaignEndDateTime = (day: string) => `${day} 23:59:59`;
export const ACCOUNT_TIME_ZONE = 'Asia/Seoul';
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** 요청 거부(집행 안 됨이 확실)와 집행 여부 불명을 나눈다 */
function classify(r: BoundedResult): PlatformError {
  if (r.kind === 'http') {
    if (r.status === 401 || r.status === 403) return new PlatformError('failed', 'AUTH_ERROR');
    if (r.status === 400) return new PlatformError('failed', 'BAD_REQUEST');
    if (r.status === 404) return new PlatformError('failed', 'NOT_FOUND');
    if (r.status === 429) return new PlatformError('failed', 'RATE_LIMITED');
    return new PlatformError('unknown', 'HTTP_ERROR');
  }
  if (r.kind === 'error') return r.sent ? new PlatformError('unknown', r.code === 'TIMEOUT' ? 'TIMEOUT' : 'TRANSPORT_ERROR') : new PlatformError('failed', r.code === 'TIMEOUT' ? 'TIMEOUT' : 'NOT_SENT');
  return new PlatformError('unknown', 'BAD_RESPONSE');
}

export function createGoogleAdsPlatform(cfg: GoogleAdsConfig): AdPlatform | null {
  const { transport, clientId, clientSecret, refreshToken, customerId } = cfg;
  const apiVersion = cfg.apiVersion == null || cfg.apiVersion === '' ? GOOGLE_ADS_DEFAULT_API_VERSION : cfg.apiVersion;
  const legacyToken = cfg.legacyDeveloperToken && cfg.legacyDeveloperToken.trim() !== '' ? cfg.legacyDeveloperToken.trim() : null;
  if (!transport || !VERSION.test(apiVersion) || !clientId || !clientSecret || !refreshToken || !customerId || !ID.test(customerId)) return null;
  if (cfg.loginCustomerId != null && cfg.loginCustomerId !== '' && !ID.test(cfg.loginCustomerId)) return null;
  const creative = cfg.creative ?? null;
  const landingUrl = cfg.landingUrl ?? null;
  if (!creative || !landingUrl || !/^https:\/\//.test(landingUrl)) return null;
  const keywords = cfg.keywords ?? null;
  if (!keywords || !isApprovedKeywordSet(keywords)) return null;
  const status = 'PAUSED' as const;  // 설정으로 바꿀 수 없음(11/26 보안 수정)
  const base = `${API_BASE}/${apiVersion}/customers/${customerId}`;

  const accessToken = async (deadlineAt: number): Promise<string> => {
    const body = `grant_type=refresh_token&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}&refresh_token=${encodeURIComponent(refreshToken)}`;
    const r = await boundedRequest(transport, TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: enc.encode(body) }, { deadlineAt, maxResponseBytes: MAX_BYTES });
    // 토큰 발급은 아무것도 바꾸지 않으므로 실패·불명 모두 '집행 안 됨'(failed)
    if (r.kind !== 'ok') throw new PlatformError('failed', r.kind === 'http' && (r.status === 400 || r.status === 401) ? 'AUTH_ERROR' : 'TOKEN_ERROR');
    const j = parseJsonSafe(r.text);
    const t = isObj(j) ? j.access_token : undefined;
    if (typeof t !== 'string' || t.length < 10 || t.length > 4096) throw new PlatformError('failed', 'TOKEN_ERROR');
    return t;
  };
  const headers = (token: string): Record<string, string> => ({
    'content-type': 'application/json', authorization: `Bearer ${token}`, ...(legacyToken ? { 'developer-token': legacyToken } : {}),
    ...(cfg.loginCustomerId ? { 'login-customer-id': cfg.loginCustomerId } : {}),
  });
  /** 요청 1회(변경·조회 공통). 응답 판독 실패는 mutating이면 unknown, 조회면 failed */
  const call = async (path: string, payload: unknown, token: string, deadlineAt: number, mutating: boolean): Promise<unknown> => {
    const r = await boundedRequest(transport, `${base}/${path}`, { method: 'POST', headers: headers(token), body: enc.encode(JSON.stringify(payload)) }, { deadlineAt, maxResponseBytes: MAX_BYTES });
    if (r.kind !== 'ok') throw classify(r);
    const j = parseJsonSafe(r.text);
    if (!isObj(j)) throw new PlatformError(mutating ? 'unknown' : 'failed', 'BAD_RESPONSE');
    return j;
  };
  const resourceOf = (j: unknown): string | null => {
    const res = isObj(j) && Array.isArray(j.results) && isObj(j.results[0]) ? j.results[0].resourceName : null;
    return typeof res === 'string' ? res : null;
  };

  return Object.freeze({
    name: 'google_ads',
    live: true,
    async launch(req: LaunchRequest): Promise<LaunchResult> {
      const krw = req.platformDailyBudgetKrw;
      if (typeof req.endDate !== 'string' || !DAY.test(req.endDate)) throw new PlatformError('failed', 'END_DATE_INVALID');
      if (!Number.isInteger(krw) || krw < 1 || krw * GOOGLE_MAX_DAY_MULTIPLIER > req.amountKrw || !CAMPAIGN_KEY.test(req.campaign) || !/^[A-Za-z0-9-]{16,64}$/.test(req.requestKey)) throw new PlatformError('failed', 'BUDGET_INVALID');
      const token = await accessToken(req.deadlineAt);
      const name = `fideon-${req.campaign}-${req.requestKey}`.slice(0, 128);
      const validateOnly = cfg.validateOnly === true;
      // 1) 일 예산(승인 금액 이하). 아직 캠페인이 없으므로 여기서의 거부·불명은 집행 영향 없음(예산만 있으면 지출 없음)
      let budgetRes: string | null;
      try {
        budgetRes = resourceOf(await call('campaignBudgets:mutate', { operations: [{ create: budgetCreatePayload(name, krw) }], validateOnly }, token, req.deadlineAt, false));
      } catch (e) {
        if (e instanceof PlatformError) throw new PlatformError('failed', e.code === 'TIMEOUT' || e.code === 'BAD_RESPONSE' ? 'BUDGET_CREATE_FAILED' : e.code);
        throw e;
      }
      if (validateOnly) throw new PlatformError('failed', 'VALIDATE_ONLY');
      if (!budgetRes) throw new PlatformError('failed', 'BAD_RESPONSE');
      // 2) 캠페인(광고 그룹·소재 없음). 여기서 불명이면 캠페인이 생겼는지 모른다 → unknown(자동 재시도 금지)
      const endDateTime = campaignEndDateTime(req.endDate);
      const campRes = resourceOf(await call('campaigns:mutate', { operations: [{ create: campaignCreatePayload(name, status, budgetRes, endDateTime) }] }, token, req.deadlineAt, true));
      const m = campRes?.match(/\/campaigns\/(\d{1,20})$/);
      if (!m) throw new PlatformError('unknown', 'BAD_RESPONSE');
      const externalId = m[1]!;
      // 3) 광고 그룹(PAUSED) → 4) 반응형 검색광고(PAUSED). 캠페인이 이미 있으므로 여기서의 거부·불명은 모두 unknown(사람이 requestKey 이름으로 확인)
      const suffix = finalUrlSuffixFor(req.campaign);
      if (!suffix) throw new PlatformError('unknown', 'AD_SUFFIX_INVALID');
      const groupRes = await call('adGroups:mutate', { operations: [{ create: adGroupCreatePayload(name, campRes!) }] }, token, req.deadlineAt, true)
        .then(resourceOf, (e) => { throw new PlatformError('unknown', e instanceof PlatformError ? `AD_GROUP_${e.code}`.slice(0, 40) : 'AD_GROUP_FAILED'); });
      if (!groupRes || !new RegExp(`^customers/${customerId}/adGroups/\\d{1,20}$`).test(groupRes)) throw new PlatformError('unknown', 'AD_GROUP_BAD_RESPONSE');
      // 3-1) 키워드(PAUSED·EXACT, 1요청: 일부만 만들어지지 않게 전체 실패 처리). 실패·불명은 모두 unknown, 광고 요청 없음
      const kwRes = await call('adGroupCriteria:mutate', { operations: keywords.map((k) => ({ create: adGroupCriterionCreatePayload(groupRes, k) })) }, token, req.deadlineAt, true)
        .then((j) => (isObj(j) && Array.isArray(j.results) ? j.results.map((r) => (isObj(r) && typeof r.resourceName === 'string' ? r.resourceName : null)) : null),
          (e) => { throw new PlatformError('unknown', e instanceof PlatformError ? `KEYWORD_${e.code}`.slice(0, 40) : 'KEYWORD_FAILED'); });
      const kwPattern = new RegExp(`^customers/${customerId}/adGroupCriteria/\\d{1,20}~\\d{1,20}$`);
      if (!kwRes || kwRes.length !== keywords.length || !kwRes.every((r) => typeof r === 'string' && kwPattern.test(r))) throw new PlatformError('unknown', 'KEYWORD_BAD_RESPONSE');
      const adRes = await call('adGroupAds:mutate', { operations: [{ create: adGroupAdCreatePayload(groupRes, creative, landingUrl, suffix) }] }, token, req.deadlineAt, true)
        .then(resourceOf, (e) => { throw new PlatformError('unknown', e instanceof PlatformError ? `AD_${e.code}`.slice(0, 40) : 'AD_FAILED'); });
      if (!adRes || !new RegExp(`^customers/${customerId}/adGroupAds/\\d{1,20}~\\d{1,20}$`).test(adRes)) throw new PlatformError('unknown', 'AD_BAD_RESPONSE');
      // 5) 읽어서 확인(read-back): 예산·종료일·계정 시간대. 실패·불일치는 0/false(미확인)로 알려 서버가 즉시 중지·집행 금지하게 한다(캠페인 ID는 이미 돌려준다)
      let verified = 0;
      let endVerified = false;
      try {
        const j = await call('googleAds:search', { query: `SELECT campaign_budget.amount_micros, campaign.end_date_time, customer.time_zone FROM campaign WHERE campaign.id = ${externalId}` }, token, req.deadlineAt, false);
        const row = isObj(j) && Array.isArray(j.results) && j.results.length === 1 && isObj(j.results[0]) ? j.results[0] : null;
        const micros = isObj(row?.campaignBudget) ? Number((row!.campaignBudget as Record<string, unknown>).amountMicros) : NaN;
        if (Number.isSafeInteger(micros) && micros >= MICROS && micros % MICROS === 0 && micros / MICROS <= krw) verified = micros / MICROS;
        const end = isObj(row?.campaign) ? (row!.campaign as Record<string, unknown>).endDateTime : undefined;
        const tz = isObj(row?.customer) ? (row!.customer as Record<string, unknown>).timeZone : undefined;
        endVerified = end === endDateTime && tz === ACCOUNT_TIME_ZONE;
        // 캠페인·광고 그룹·광고가 정확히 1세트이고 상태가 요청과 같아야 확인 완료(아니면 endVerified=false → 서버가 즉시 중지·집행 금지)
        const s = await call('googleAds:search', { query: `SELECT campaign.status, ad_group.status, ad_group_ad.status FROM ad_group_ad WHERE campaign.id = ${externalId}` }, token, req.deadlineAt, false);
        const rows = isObj(s) && Array.isArray(s.results) ? s.results : [];
        const st = (r: unknown, k: string) => (isObj(r) && isObj(r[k]) ? (r[k] as Record<string, unknown>).status : undefined);
        const one = rows.length === 1 ? rows[0] : null;
        if (!(st(one, 'campaign') === status && st(one, 'adGroup') === 'PAUSED' && st(one, 'adGroupAd') === 'PAUSED')) endVerified = false;
        // 키워드: 승인된 문구가 정확히 한 번씩, 모두 EXACT·PAUSED여야 한다(BROAD·ENABLED·추가·누락·중복이면 미확인 → 서버가 즉시 중지)
        const kw = await call('googleAds:search', { query: `SELECT ad_group_criterion.status, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type FROM ad_group_criterion WHERE campaign.id = ${externalId} AND ad_group_criterion.type = 'KEYWORD'` }, token, req.deadlineAt, false);
        const kwRows = isObj(kw) && Array.isArray(kw.results) ? kw.results : [];
        const texts = new Set<string>();
        const kwOk = kwRows.length === keywords.length && kwRows.every((r) => {
          const c = isObj(r) && isObj(r.adGroupCriterion) ? r.adGroupCriterion : null;
          const k = c && isObj(c.keyword) ? c.keyword : null;
          if (!c || !k || c.status !== 'PAUSED' || k.matchType !== 'EXACT' || typeof k.text !== 'string' || texts.has(k.text)) return false;
          texts.add(k.text);
          return keywords.some((x) => x.text === k.text);
        });
        if (!kwOk) endVerified = false;
      } catch { verified = 0; endVerified = false; }
      return { externalId, dailyBudgetKrw: verified, endVerified };
    },
    async pause(ref: PlatformRef, opts: CallOpts) {
      if (!ref.externalId || !ID.test(ref.externalId)) throw new PlatformError('failed', 'NO_EXTERNAL_ID');
      const token = await accessToken(opts.deadlineAt);
      const j = await call('campaigns:mutate', { operations: [{ update: { resourceName: `customers/${customerId}/campaigns/${ref.externalId}`, status: 'PAUSED' }, updateMask: 'status' }] }, token, opts.deadlineAt, true);
      return { paused: resourceOf(j) === `customers/${customerId}/campaigns/${ref.externalId}` };
    },
    async activeCampaignCount(opts: CallOpts) {
      // 계정 전체에서 ENABLED 캠페인 수(FIDEON 외부에서 만든 것 포함). 응답 형식이 이상하면 조회 실패(failed) → 서버가 집행 차단
      const token = await accessToken(opts.deadlineAt);
      const j = await call('googleAds:search', { query: "SELECT campaign.id FROM campaign WHERE campaign.status = 'ENABLED'" }, token, opts.deadlineAt, false);
      if (!isObj(j)) throw new PlatformError('failed', 'BAD_RESPONSE');
      if (j.results === undefined) return 0;
      if (!Array.isArray(j.results) || j.results.length > 10_000) throw new PlatformError('failed', 'BAD_RESPONSE');
      return j.results.length;
    },
    async accountTimeZone(opts: CallOpts) {
      const token = await accessToken(opts.deadlineAt);
      const j = await call('googleAds:search', { query: 'SELECT customer.time_zone FROM customer' }, token, opts.deadlineAt, false);
      const row = isObj(j) && Array.isArray(j.results) && j.results.length === 1 && isObj(j.results[0]) ? j.results[0] : null;
      const tz = isObj(row?.customer) ? (row!.customer as Record<string, unknown>).timeZone : undefined;
      if (typeof tz !== 'string' || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2}$/.test(tz)) throw new PlatformError('failed', 'BAD_RESPONSE');
      return tz;
    },
    async accountCurrency(opts: CallOpts) {
      const token = await accessToken(opts.deadlineAt);
      const j = await call('googleAds:search', { query: 'SELECT customer.currency_code FROM customer' }, token, opts.deadlineAt, false);
      const row = isObj(j) && Array.isArray(j.results) && j.results.length === 1 && isObj(j.results[0]) ? j.results[0] : null;
      const cur = isObj(row?.customer) ? (row!.customer as Record<string, unknown>).currencyCode : undefined;
      if (typeof cur !== 'string' || !/^[A-Z]{3}$/.test(cur)) throw new PlatformError('failed', 'BAD_RESPONSE');
      return cur;
    },
    async fetchPerformance(ref: PlatformRef, day: string, opts: CallOpts) {
      if (!ref.externalId || !ID.test(ref.externalId)) throw new PlatformError('failed', 'NO_EXTERNAL_ID');
      if (!DAY.test(day)) throw new PlatformError('failed', 'BAD_REQUEST');
      const token = await accessToken(opts.deadlineAt);
      const j = await call('googleAds:search', { query: `SELECT metrics.impressions, metrics.clicks, metrics.cost_micros FROM campaign WHERE campaign.id = ${ref.externalId} AND segments.date = '${day}'` }, token, opts.deadlineAt, false);
      const row = isObj(j) && Array.isArray(j.results) && isObj(j.results[0]) ? j.results[0] : null;
      // 행이 없으면 보고 지연일 수 있다 → 0으로 보지 않고 UNKNOWN(null). 값은 서버가 다시 검증한다(믿지 않음)
      if (!row || !isObj(row.metrics)) return { impressions: null, clicks: null, costKrw: null };
      const mt = row.metrics;
      const num = (v: unknown) => (v === undefined ? 0 : Number(v));
      return { impressions: num(mt.impressions), clicks: num(mt.clicks), costKrw: Math.round(num(mt.costMicros) / MICROS) };
    },
  });
}
