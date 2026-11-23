// Google Ads 테스트 계정 전용 진단(PM 11/22). 로컬에서 사람이 직접 실행한다 — CI·서버는 실행하지 않는다.
// 순서: ① 필수 환경변수 확인(이름만 출력) → ② OAuth 토큰(읽기) → ③ 계정 조회(통화·test_account·manager, 읽기 전용)
//       → ④ test_account=true이고 manager가 아닐 때만 googleAds:mutate validateOnly=true 1회(예산+캠페인 묶음 검증, 아무것도 만들지 않음).
// - 변경 API는 ④의 validateOnly 1회뿐이다. 실제 캠페인 생성·광고비 지출 경로가 없다. 재시도 없음.
// - 출력은 단계·HTTP 상태·Google 오류코드(enum 이름)·통화·불리언뿐. credential·토큰·고객 ID·오류 메시지 원문은 출력하지 않는다.
// - 요청 본문은 어댑터와 같은 생성 본문(budgetCreatePayload·campaignCreatePayload)을 쓴다.
import { budgetCreatePayload, campaignCreatePayload, GOOGLE_ADS_DEFAULT_API_VERSION, GOOGLE_ADS_ENV_NAMES } from '../../src/server/advertising/googleAdsPlatform';

export type ProbeTransport = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string }) => Promise<{ status: number; text: string }>;
export type ProbeLine = Record<string, string | number | boolean | string[] | null>;

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://googleads.googleapis.com';
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const parse = (t: string): unknown => { try { return JSON.parse(t); } catch { return null; } };

/** Google 오류 응답에서 오류코드 enum 이름만 뽑는다(메시지·트리거 값·위치는 버림) */
export function googleErrorCodes(text: string): string[] {
  const j = parse(text);
  const out: string[] = [];
  const err = isObj(j) && isObj(j.error) ? j.error : null;
  if (err && typeof err.status === 'string' && /^[A-Z_]{2,40}$/.test(err.status)) out.push(err.status);
  // OAuth 오류 형식: {"error":"invalid_grant"}
  if (isObj(j) && typeof j.error === 'string' && /^[a-z_]{2,40}$/.test(j.error)) out.push(`oauth.${j.error}`);
  for (const d of err && Array.isArray(err.details) ? err.details : []) {
    for (const e of isObj(d) && Array.isArray(d.errors) ? d.errors : []) {
      const code = isObj(e) && isObj(e.errorCode) ? e.errorCode : null;
      for (const [k, v] of Object.entries(code ?? {})) if (/^[A-Za-z]{2,60}$/.test(k) && typeof v === 'string' && /^[A-Z_]{2,80}$/.test(v)) out.push(`${k}.${v}`);
    }
  }
  return [...new Set(out)].slice(0, 10);
}

/** 종료 코드: 0 검증 통과(읽기 전용 모드면 ③ 계정 읽기 성공까지), 2 설정 없음, 3 인증·조회 실패, 4 테스트 계정 아님(변경 호출 안 함), 5 validateOnly 거부 */
export async function runProbe(env: Readonly<Record<string, string | undefined>>, transport: ProbeTransport, log: (l: ProbeLine) => void): Promise<number> {
  const v = (k: string) => (typeof env[k] === 'string' && env[k]!.trim() !== '' ? env[k]!.trim() : null);
  const missing = GOOGLE_ADS_ENV_NAMES.filter((k) => v(k) === null);
  const cid = (v('GOOGLE_ADS_CUSTOMER_ID') ?? '').replace(/-/g, '');
  const login = (v('GOOGLE_ADS_LOGIN_CUSTOMER_ID') ?? '').replace(/-/g, '');
  const version = v('GOOGLE_ADS_API_VERSION') ?? GOOGLE_ADS_DEFAULT_API_VERSION;
  const bad: string[] = [];
  if (cid && !/^\d{10}$/.test(cid)) bad.push('GOOGLE_ADS_CUSTOMER_ID');
  if (login && !/^\d{10}$/.test(login)) bad.push('GOOGLE_ADS_LOGIN_CUSTOMER_ID');
  if (!/^v\d{2}$/.test(version)) bad.push('GOOGLE_ADS_API_VERSION');
  log({ step: 'env', ok: missing.length === 0 && bad.length === 0, missing: [...missing], invalid: bad, apiVersion: /^v\d{2}$/.test(version) ? version : null, loginCustomerId: login !== '', legacyDeveloperToken: v('GOOGLE_ADS_DEVELOPER_TOKEN') !== null });
  if (missing.length > 0 || bad.length > 0) return 2;

  const tk = await transport(TOKEN_URL, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `grant_type=refresh_token&client_id=${encodeURIComponent(v('GOOGLE_ADS_CLIENT_ID')!)}&client_secret=${encodeURIComponent(v('GOOGLE_ADS_CLIENT_SECRET')!)}&refresh_token=${encodeURIComponent(v('GOOGLE_ADS_REFRESH_TOKEN')!)}`,
  });
  const tj = parse(tk.text);
  const token = tk.status === 200 && isObj(tj) && typeof tj.access_token === 'string' ? tj.access_token : null;
  log({ step: 'oauth', ok: token !== null, http: tk.status, googleErrorCodes: token ? [] : googleErrorCodes(tk.text) });
  if (!token) return 3;
  const headers: Record<string, string> = {
    'content-type': 'application/json', authorization: `Bearer ${token}`,
    ...(login ? { 'login-customer-id': login } : {}), ...(v('GOOGLE_ADS_DEVELOPER_TOKEN') ? { 'developer-token': v('GOOGLE_ADS_DEVELOPER_TOKEN')! } : {}),
  };
  const base = `${API}/${version}/customers/${cid}`;

  // ③ 읽기 전용 조회: 통화·테스트 계정 여부. 성공 = 이 Cloud 프로젝트가 이 계정을 읽을 수 있음(접근 수준 이름은 API로 직접 나오지 않음)
  const rd = await transport(`${base}/googleAds:search`, { method: 'POST', headers, body: JSON.stringify({ query: 'SELECT customer.currency_code, customer.test_account, customer.manager FROM customer' }) });
  const row = rd.status === 200 ? (parse(rd.text) as { results?: { customer?: Record<string, unknown> }[] } | null)?.results?.[0]?.customer : undefined;
  const currency = typeof row?.currencyCode === 'string' && /^[A-Z]{3}$/.test(row.currencyCode) ? row.currencyCode : null;
  const testAccount = row?.testAccount === true;
  const manager = row?.manager === true;
  log({ step: 'account_read', ok: rd.status === 200 && isObj(row), http: rd.status, googleErrorCodes: rd.status === 200 ? [] : googleErrorCodes(rd.text), currency, krw: currency === 'KRW', testAccount, manager });
  if (rd.status !== 200 || !isObj(row)) return 3;
  // 읽기 전용 모드(PM 11/23: 실계정 연결 확인은 읽기만): ④ validateOnly도 보내지 않고 여기서 끝낸다(변경 API 0회)
  if (v('GOOGLE_ADS_PROBE_READ_ONLY') === 'true') {
    log({ step: 'validate_only', skipped: true, reason: 'READ_ONLY' });
    return 0;
  }
  if (!testAccount || manager) {
    log({ step: 'validate_only', skipped: true, reason: !testAccount ? 'NOT_TEST_ACCOUNT' : 'MANAGER_ACCOUNT' });
    return 4;
  }

  // ④ 테스트 계정에서만: 예산+캠페인 묶음 validateOnly(임시 리소스 이름 -1, 실행 안 됨). 금액은 1,000(계정 통화 단위)
  const tmp = `customers/${cid}/campaignBudgets/-1`;
  const name = 'fideon-probe-validate-only';
  const body = {
    mutateOperations: [
      { campaignBudgetOperation: { create: { resourceName: tmp, ...budgetCreatePayload(name, 1000) } } },
      { campaignOperation: { create: campaignCreatePayload(name, 'PAUSED', tmp) } },
    ],
    validateOnly: true,
  };
  const vo = await transport(`${base}/googleAds:mutate`, { method: 'POST', headers, body: JSON.stringify(body) });
  log({ step: 'validate_only', ok: vo.status === 200, http: vo.status, googleErrorCodes: vo.status === 200 ? [] : googleErrorCodes(vo.text), executed: false });
  return vo.status === 200 ? 0 : 5;
}
