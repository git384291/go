/**
 * 유입 출처 판정(UTM → 접수 귀속). 순수 함수만: 쿠키·픽셀·외부 전송·서버 저장 없음.
 * - 광고 링크의 utm_source/utm_medium/utm_campaign만 읽는다. 소문자 영숫자·`_.-` 64자 이내가 아니면 버린다(오류로 거부하지 않음).
 * - 첫 유입 우선(first-touch): 같은 탭 세션에서 먼저 확인된 출처를 유지한다. 저장은 sessionStorage 한 칸이고 실패해도 접수는 막지 않는다.
 * - 값은 접수 요청의 기존 필드(utmSource/utmMedium/utmCampaign)로만 간다. 개인정보와 섞지 않는다.
 * - gclid(0027, 광고 사전검증 8번): Google 광고 클릭 식별값. utm 없이도 읽고(자동 태그), 첫 유입 값을 따로 보존한다.
 *   영문·숫자·'_'·'-' 10~200자, 영문 1자 이상, 숫자 9자리 이상 연속 금지(전화번호 혼입 차단), gclid가 2개 이상이면 버린다(모호).
 *   서버 전송(접수 요청 gclid 필드)까지만 하고 외부(Google)로 보내지 않는다.
 */
export type Attribution = { utmSource?: string; utmMedium?: string; utmCampaign?: string; gclid?: string };

export const ATTRIBUTION_STORAGE_KEY = 'fideon_attr_v1';
const CODE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
/** 캠페인 키는 광고 성과·상담 집계·DB(core.ad_performance·consult_events)와 같은 형식(점 불가). 다르면 퍼널에서 접수가 다른 캠페인으로 갈라진다 */
export const CAMPAIGN_KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** gclid 형식(DB pii.lead_clicks 검사와 같음) */
export function cleanGclid(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  return /^[A-Za-z0-9_-]{10,200}$/.test(v) && /[A-Za-z]/.test(v) && !/[0-9]{9}/.test(v) ? v : undefined;
}

/** 숫자 7자리 이상 연속은 전화번호 등 개인정보일 수 있어 출처 코드로 쓰지 않는다 */
const LOOKS_PERSONAL = /\d[\s_.-]?(?:\d[\s_.-]?){6,}/;

const clean = (v: string | null): string | undefined => {
  if (v === null) return undefined;
  const s = v.trim().toLowerCase();
  return CODE.test(s) && !LOOKS_PERSONAL.test(s) ? s : undefined;
};

/** 쿼리 문자열에서 유효한 출처만 뽑는다. utm_source가 없으면 빈 객체(매체·캠페인만으로는 귀속하지 않음) */
export function parseAttribution(search: string): Attribution {
  let p: URLSearchParams;
  try { p = new URLSearchParams(typeof search === 'string' ? search : ''); } catch { return {}; }
  const all = p.getAll('gclid');
  const gclid = all.length === 1 ? cleanGclid(all[0]) : undefined;
  const utmSource = clean(p.get('utm_source'));
  if (!utmSource) return gclid ? { gclid } : {};
  const out: Attribution = gclid ? { utmSource, gclid } : { utmSource };
  const utmMedium = clean(p.get('utm_medium'));
  const c = clean(p.get('utm_campaign'));
  const utmCampaign = c !== undefined && CAMPAIGN_KEY.test(c) ? c : undefined;
  if (utmMedium) out.utmMedium = utmMedium;
  if (utmCampaign) out.utmCampaign = utmCampaign;
  return out;
}

type Store = Pick<Storage, 'getItem' | 'setItem'>;

function readStored(store: Store | null): Attribution {
  try {
    const raw = store?.getItem(ATTRIBUTION_STORAGE_KEY);
    if (!raw) return {};
    const v: unknown = JSON.parse(raw);
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return {};
    const o = v as Record<string, unknown>;
    // 저장값도 다시 검증한다(변조·구버전 대비)
    return parseAttribution(new URLSearchParams({
      utm_source: typeof o.utmSource === 'string' ? o.utmSource : '',
      utm_medium: typeof o.utmMedium === 'string' ? o.utmMedium : '',
      utm_campaign: typeof o.utmCampaign === 'string' ? o.utmCampaign : '',
      ...(typeof o.gclid === 'string' ? { gclid: o.gclid } : {}),
    }).toString());
  } catch { return {}; }
}

/** 첫 유입 우선으로 현재 출처를 정한다. 저장소가 없거나 막혀도 현재 URL 값으로 동작한다 */
export function resolveAttribution(search: string, store: Store | null): Attribution {
  const stored = readStored(store);
  const current = parseAttribution(search);
  // UTM은 기존 규칙 그대로(저장된 출처가 있으면 그것), gclid는 따로 첫 유입 우선(저장값이 있으면 새 값으로 덮지 않음)
  const src = stored.utmSource ? stored : current;
  const utm: Attribution = {};
  if (src.utmSource) utm.utmSource = src.utmSource;
  if (src.utmMedium) utm.utmMedium = src.utmMedium;
  if (src.utmCampaign) utm.utmCampaign = src.utmCampaign;
  const gclid = stored.gclid ?? current.gclid;
  const out: Attribution = gclid ? { ...utm, gclid } : utm;
  if ((!stored.utmSource && current.utmSource) || (!stored.gclid && current.gclid)) {
    try { store?.setItem(ATTRIBUTION_STORAGE_KEY, JSON.stringify(out)); } catch { /* 저장 실패는 무시 */ }
  }
  return out;
}
