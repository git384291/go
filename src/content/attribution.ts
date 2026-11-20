/**
 * 유입 출처 판정(UTM → 접수 귀속). 순수 함수만: 쿠키·픽셀·외부 전송·서버 저장 없음.
 * - 광고 링크의 utm_source/utm_medium/utm_campaign만 읽는다. 소문자 영숫자·`_.-` 64자 이내가 아니면 버린다(오류로 거부하지 않음).
 * - 첫 유입 우선(first-touch): 같은 탭 세션에서 먼저 확인된 출처를 유지한다. 저장은 sessionStorage 한 칸이고 실패해도 접수는 막지 않는다.
 * - 값은 접수 요청의 기존 필드(utmSource/utmMedium/utmCampaign)로만 간다. 개인정보와 섞지 않는다.
 */
export type Attribution = { utmSource?: string; utmMedium?: string; utmCampaign?: string };

export const ATTRIBUTION_STORAGE_KEY = 'fideon_attr_v1';
const CODE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

const clean = (v: string | null): string | undefined => {
  if (v === null) return undefined;
  const s = v.trim().toLowerCase();
  return CODE.test(s) ? s : undefined;
};

/** 쿼리 문자열에서 유효한 출처만 뽑는다. utm_source가 없으면 빈 객체(매체·캠페인만으로는 귀속하지 않음) */
export function parseAttribution(search: string): Attribution {
  let p: URLSearchParams;
  try { p = new URLSearchParams(typeof search === 'string' ? search : ''); } catch { return {}; }
  const utmSource = clean(p.get('utm_source'));
  if (!utmSource) return {};
  const out: Attribution = { utmSource };
  const utmMedium = clean(p.get('utm_medium'));
  const utmCampaign = clean(p.get('utm_campaign'));
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
    }).toString());
  } catch { return {}; }
}

/** 첫 유입 우선으로 현재 출처를 정한다. 저장소가 없거나 막혀도 현재 URL 값으로 동작한다 */
export function resolveAttribution(search: string, store: Store | null): Attribution {
  const stored = readStored(store);
  if (stored.utmSource) return stored;
  const current = parseAttribution(search);
  if (current.utmSource) {
    try { store?.setItem(ATTRIBUTION_STORAGE_KEY, JSON.stringify(current)); } catch { /* 저장 실패는 무시 */ }
  }
  return current;
}
