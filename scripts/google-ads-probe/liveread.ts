// Google Ads 실계정 읽기 전용 점검(PM 11/25: 바른통신 미완료 ①~④). 로컬 Mac mini에서 사람이 직접 실행 — CI·서버는 실행하지 않는다.
// 하는 일(모두 읽기): 인증 → 계정(통화·시간대·테스트 여부) → 캠페인 상태·예산·입찰 방식 → 최근 30일 노출·클릭·비용·전환(일별 중복·합계 대조)
//                    → 키워드 플래너 과거 지표(후보 키워드별 월 검색량·경쟁도·상단 입찰가 범위) → 월 하드 한도 기준 권장 하루예산·예상 클릭.
// 하지 않는 일: 생성·수정·일시정지·활성화(mutate) 0회. 허용 주소 3곳(토큰·search·generateKeywordHistoricalMetrics) 밖은 보내지 않는다.
// 출력: 단계·불리언·숫자·Google 오류코드뿐. credential·토큰·고객 ID·캠페인 ID·오류 원문은 출력하지 않는다. 실적 0이면 0 그대로.
import { googleErrorCodes, type ProbeLine, type ProbeTransport } from './core';
import { GOOGLE_ADS_DEFAULT_API_VERSION, GOOGLE_ADS_ENV_NAMES } from '../../src/server/advertising/googleAdsPlatform';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://googleads.googleapis.com';
/** PM 11/25 개발·테스트용 승인 후보 10개(인터넷+TV 결합, EXACT 집행 기준, 통신사 상표 없음). 운영 승인 전 — 집행에 쓰지 않는다 */
export const CANDIDATE_KEYWORDS = Object.freeze(['인터넷 TV 약정 만료', '인터넷 TV 약정 끝나면', '인터넷 TV 재약정', '약정 만료 인터넷 TV 변경', '이사 인터넷 TV 설치', '이사 인터넷 TV 이전', '전입 인터넷 TV 신청', '새집 인터넷 TV', '인터넷 TV 통신사 변경', '인터넷 TV 갈아타기']);
const KO = 'languageConstants/1012';
const KR = 'geoTargetConstants/2410';
/** Google: 한 달 청구는 평균 하루예산 × 30.4를 넘지 않는다(월 청구 한도). 하드 한도 → 하루예산 = 한도 ÷ 30.4(내림) */
export const MONTH_FACTOR = 30.4;
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const parse = (t: string): unknown => { try { return JSON.parse(t); } catch { return null; } };
const int = (x: unknown): number | null => { const n = typeof x === 'string' ? Number(x) : x; return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null; };

/** 권장 CPC(최소 비용): 키워드 플래너 "페이지 상단 입찰가 하한"을 10원 단위로 올림. 하한이 없으면 null(추정하지 않음) */
export function recommendCpc(lowMicros: number | null): number | null {
  return lowMicros === null || lowMicros <= 0 ? null : Math.ceil(lowMicros / 1e6 / 10) * 10;
}
/** 월 하드 한도(원) → 권장 하루예산(원)·예상 최대 클릭. 한도가 없거나 이상하면 null(= 집행 차단) */
export function capPlan(capKrw: number | null, cpcKrw: number | null): { dailyBudgetKrw: number; maxClicksPerMonth: number | null } | null {
  if (capKrw === null || !Number.isSafeInteger(capKrw) || capKrw < 1000) return null;
  const daily = Math.floor(capKrw / MONTH_FACTOR);
  return { dailyBudgetKrw: daily, maxClicksPerMonth: cpcKrw ? Math.floor(capKrw / cpcKrw) : null };
}

/** 종료 코드: 0 확인 완료, 2 설정 없음, 3 인증·조회 실패, 5 ENABLED 캠페인 발견(변경하지 않고 보고), 6 집계 불일치·중복, 7 계정 통화 KRW 아님(PM 11/25) */
export async function runLiveRead(env: Readonly<Record<string, string | undefined>>, raw: ProbeTransport, log: (l: ProbeLine) => void): Promise<number> {
  const v = (k: string) => (typeof env[k] === 'string' && env[k]!.trim() !== '' ? env[k]!.trim() : null);
  const missing = GOOGLE_ADS_ENV_NAMES.filter((k) => v(k) === null);
  const cid = (v('GOOGLE_ADS_CUSTOMER_ID') ?? '').replace(/-/g, '');
  const login = (v('GOOGLE_ADS_LOGIN_CUSTOMER_ID') ?? '').replace(/-/g, '');
  const version = v('GOOGLE_ADS_API_VERSION') ?? GOOGLE_ADS_DEFAULT_API_VERSION;
  const capRaw = v('GOOGLE_ADS_MONTHLY_CAP_KRW');
  const cap = capRaw !== null && /^\d{1,9}$/.test(capRaw) ? Number(capRaw) : null;
  const bad = [cid && !/^\d{10}$/.test(cid) ? 'GOOGLE_ADS_CUSTOMER_ID' : '', login && !/^\d{10}$/.test(login) ? 'GOOGLE_ADS_LOGIN_CUSTOMER_ID' : '', /^v\d{2}$/.test(version) ? '' : 'GOOGLE_ADS_API_VERSION'].filter(Boolean);
  log({ step: 'env', ok: missing.length === 0 && bad.length === 0, missing: [...missing], invalid: bad, monthlyCapSet: cap !== null });
  if (missing.length > 0 || bad.length > 0) return 2;
  const base = `${API}/${version}/customers/${cid}`;
  const ALLOWED = new Set([TOKEN_URL, `${base}/googleAds:search`, `${base}:generateKeywordHistoricalMetrics`]);
  // 읽기 전용 강제: 허용 주소 3곳, 본문에 mutate·validateOnly 없음. 어기면 보내지 않는다(status 0)
  const transport: ProbeTransport = async (url, init) => (ALLOWED.has(url) && !/mutate|validateOnly/i.test(init.body) ? raw(url, init) : { status: 0, text: '' });

  const tk = await transport(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `grant_type=refresh_token&client_id=${encodeURIComponent(v('GOOGLE_ADS_CLIENT_ID')!)}&client_secret=${encodeURIComponent(v('GOOGLE_ADS_CLIENT_SECRET')!)}&refresh_token=${encodeURIComponent(v('GOOGLE_ADS_REFRESH_TOKEN')!)}` });
  const tj = parse(tk.text);
  const token = tk.status === 200 && isObj(tj) && typeof tj.access_token === 'string' ? tj.access_token : null;
  log({ step: 'oauth', ok: token !== null, http: tk.status, googleErrorCodes: token ? [] : googleErrorCodes(tk.text) });
  if (!token) return 3;
  const headers: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(login ? { 'login-customer-id': login } : {}),
    ...(v('GOOGLE_ADS_DEVELOPER_TOKEN') ? { 'developer-token': v('GOOGLE_ADS_DEVELOPER_TOKEN')! } : {}) };
  /** search 전체 페이지(최대 20쪽). 실패면 null */
  const search = async (step: string, query: string): Promise<Record<string, unknown>[] | null> => {
    const out: Record<string, unknown>[] = []; let page: string | undefined;
    for (let i = 0; i < 20; i++) {
      const r = await transport(`${base}/googleAds:search`, { method: 'POST', headers, body: JSON.stringify(page ? { query, pageToken: page } : { query }) });
      const j = parse(r.text);
      if (r.status !== 200 || !isObj(j)) { log({ step, ok: false, http: r.status, googleErrorCodes: googleErrorCodes(r.text) }); return null; }
      for (const x of Array.isArray(j.results) ? j.results : []) if (isObj(x)) out.push(x);
      page = typeof j.nextPageToken === 'string' && j.nextPageToken !== '' ? j.nextPageToken : undefined;
      if (!page) return out;
    }
    log({ step, ok: false, reason: 'TOO_MANY_PAGES' }); return null;
  };

  // ② 계정
  const acc = await search('account', 'SELECT customer.currency_code, customer.time_zone, customer.test_account, customer.manager, customer.status FROM customer');
  if (!acc) return 3;
  const c = (acc[0]?.customer ?? {}) as Record<string, unknown>;
  log({ step: 'account', ok: true, currency: typeof c.currencyCode === 'string' ? c.currencyCode : null, timeZone: typeof c.timeZone === 'string' ? c.timeZone : null,
    testAccount: c.testAccount === true, manager: c.manager === true, status: typeof c.status === 'string' ? c.status : null });

  // 계정 통화가 KRW가 아니면 아래 원화 계산(비용·CPC·하루예산)이 틀린다 → 여기서 멈춤(읽기만, 변경 없음). PM 11/25 KRW 검사
  if (c.currencyCode !== 'KRW') { log({ step: 'currency', ok: false, reason: 'CURRENCY_NOT_KRW' }); return 7; }

  // ③ 캠페인·예산·상태
  const camps = await search('campaigns', "SELECT campaign.id, campaign.status, campaign.serving_status, campaign.bidding_strategy_type, campaign_budget.amount_micros FROM campaign WHERE campaign.status != 'REMOVED'");
  if (!camps) return 3;
  const st = (s: string) => camps.filter((x) => (x.campaign as Record<string, unknown> | undefined)?.status === s).length;
  const budgets = camps.map((x) => int((x.campaignBudget as Record<string, unknown> | undefined)?.amountMicros)).filter((n): n is number => n !== null);
  const enabled = st('ENABLED');
  log({ step: 'campaigns', ok: true, total: camps.length, paused: st('PAUSED'), enabled, dailyBudgetsKrw: budgets.map((m) => Math.round(m / 1e6)).sort((a, b) => a - b).map(String), // 출력 형식(ProbeLine)이 문자열 배열만 허용
    biddingTypes: [...new Set(camps.map((x) => String((x.campaign as Record<string, unknown> | undefined)?.biddingStrategyType ?? '')).filter((s) => /^[A-Z_]{2,40}$/.test(s)))] });

  // ④ 최근 30일 실적: 일별(날짜·캠페인 중복 검사) 합계 = 계정 합계
  const daily = await search('metrics_daily', 'SELECT segments.date, campaign.id, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM campaign WHERE segments.date DURING LAST_30_DAYS');
  const total = await search('metrics_total', 'SELECT metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM customer WHERE segments.date DURING LAST_30_DAYS');
  if (!daily || !total) return 3;
  const keys = daily.map((x) => `${(x.segments as Record<string, unknown> | undefined)?.date}|${(x.campaign as Record<string, unknown> | undefined)?.id}`);
  const dup = keys.length - new Set(keys).size;
  const m = (x: Record<string, unknown>, k: string) => int((x.metrics as Record<string, unknown> | undefined)?.[k]) ?? 0;
  const sum = (rows: Record<string, unknown>[], k: string) => rows.reduce((s, x) => s + m(x, k), 0);
  const d = { impressions: sum(daily, 'impressions'), clicks: sum(daily, 'clicks'), costMicros: sum(daily, 'costMicros'), conversions: Math.round(sum(daily, 'conversions') * 100) / 100 };
  const t = { impressions: sum(total, 'impressions'), clicks: sum(total, 'clicks'), costMicros: sum(total, 'costMicros'), conversions: Math.round(sum(total, 'conversions') * 100) / 100 };
  const match = d.impressions === t.impressions && d.clicks === t.clicks && d.costMicros === t.costMicros && d.conversions === t.conversions;
  const dates = keys.map((k) => k.split('|')[0]!).filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s)).sort();
  log({ step: 'metrics_30d', ok: dup === 0 && match, rows: daily.length, duplicateRows: dup, totalsMatch: match, impressions: t.impressions, clicks: t.clicks,
    costKrw: Math.round(t.costMicros / 1e6), conversions: t.conversions, firstDate: dates[0] ?? null, lastDate: dates.at(-1) ?? null });

  // ① 키워드 과거 지표(키워드 플래너 GenerateKeywordHistoricalMetrics, 읽기). Google은 가까운 변형을 한 결과로 합친다(요청 수보다 결과가 적을 수 있음).
  //    키워드마다 EXACT(자기 결과, 합쳐진 다른 후보 없음) / COMBINED(자기 결과지만 다른 후보와 합산) / MERGED(다른 결과에 합쳐짐) / MISSING(결과 없음)으로 따로 표시.
  //    권장 CPC는 EXACT만 계산한다(합산·누락은 추측하지 않음). 이 지표는 검색어 기준이며 매치 유형별 값이 아니다.
  const kr = await transport(`${base}:generateKeywordHistoricalMetrics`, { method: 'POST', headers,
    body: JSON.stringify({ keywords: [...CANDIDATE_KEYWORDS], language: KO, geoTargetConstants: [KR], keywordPlanNetwork: 'GOOGLE_SEARCH', historicalMetricsOptions: { includeAverageCpc: true } }) });
  const kj = parse(kr.text);
  if (kr.status !== 200 || !isObj(kj)) log({ step: 'keyword_cpc', ok: false, http: kr.status, googleErrorCodes: googleErrorCodes(kr.text) });
  else {
    const results = (Array.isArray(kj.results) ? kj.results : []).filter(isObj);
    const variants = (x: Record<string, unknown>) => (Array.isArray(x.closeVariants) ? x.closeVariants.filter((v): v is string => typeof v === 'string') : []);
    for (const kw of CANDIDATE_KEYWORDS) {
      const own = results.find((x) => x.text === kw);
      const into = own ? undefined : results.find((x) => variants(x).includes(kw));
      const others = own ? CANDIDATE_KEYWORDS.filter((k) => k !== kw && variants(own).includes(k)) : [];
      const kwMatch: 'EXACT' | 'COMBINED' | 'MERGED' | 'MISSING' = own ? (others.length > 0 ? 'COMBINED' : 'EXACT') : into ? 'MERGED' : 'MISSING';
      const km = (own?.keywordMetrics ?? {}) as Record<string, unknown>;
      const low = int(km.lowTopOfPageBidMicros); const high = int(km.highTopOfPageBidMicros); const avg = int(km.averageCpcMicros);
      const cpc = kwMatch === 'EXACT' ? recommendCpc(low) : null;
      log({ step: 'keyword_cpc', ok: kwMatch === 'EXACT', keyword: kw, match: kwMatch, mergedInto: into && typeof into.text === 'string' ? into.text : null, combinedWith: [...others],
        avgMonthlySearches: own ? int(km.avgMonthlySearches) : null, competition: own && typeof km.competition === 'string' ? km.competition : null,
        lowTopBidKrw: low === null ? null : Math.round(low / 1e6), highTopBidKrw: high === null ? null : Math.round(high / 1e6), avgCpcKrw: avg === null ? null : Math.round(avg / 1e6),
        recommendedCpcKrw: cpc, maxClicksPerMonthAtCap: capPlan(cap, cpc)?.maxClicksPerMonth ?? null });
    }
  }
  log({ step: 'cap', ok: cap !== null, monthlyCapKrw: cap, dailyBudgetKrw: cap === null ? null : Math.floor(cap / MONTH_FACTOR), launchBlocked: cap === null || enabled > 0 });
  if (enabled > 0) return 5;
  return dup === 0 && match ? 0 : 6;
}
