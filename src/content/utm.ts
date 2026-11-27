/**
 * UTM 허용 목록(운영자가 미리 등록한 비식별 캠페인 코드 조합만 통과).
 *
 * 정규식만으로는 영문 이름·개인 식별 코드·주소를 판별할 수 없다(예: 'john.smith'는 형식상 통과).
 * 그래서 형식 검사로 개인정보 제거를 보장한다고 하지 않는다. 대신 '등록된 조합과 정확히 일치'하는 값만 남기고
 * 나머지는 전부 버린다. 등록부는 캠페인 단위로만 쓰며 고객·개인별 코드를 등록하지 않는다(개수 상한으로도 제한).
 * 실제 수집·저장·외부 전송은 꺼져 있다(PHASE 1). URL 원문을 로그에 남기지 않는다.
 */
export type UtmCode = { source: string; medium: string; campaign: string; content?: string };
export type UtmRegistry = readonly UtmCode[];

/** 현재 등록된 캠페인 없음(광고 미집행). 등록은 PM 검수 후 이 파일 변경으로만 한다 */
export const UTM_REGISTRY: UtmRegistry = [];

export const MAX_REGISTRY_SIZE = 50;
const CODE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export class UtmRegistryError extends Error {}

/** 등록부 자체 검증: 형식·개수·중복. 고객별 코드 대량 등록을 막기 위해 상한을 둔다 */
export function validateRegistry(reg: unknown): UtmRegistry {
  if (!Array.isArray(reg) || reg.length > MAX_REGISTRY_SIZE) throw new UtmRegistryError('REGISTRY_SIZE');
  const seen = new Set<string>();
  for (const e of reg) {
    if (typeof e !== 'object' || e === null) throw new UtmRegistryError('ENTRY_INVALID');
    const { source, medium, campaign, content, ...rest } = e as Record<string, unknown>;
    if (Object.keys(rest).length) throw new UtmRegistryError('ENTRY_INVALID');
    for (const v of [source, medium, campaign]) if (typeof v !== 'string' || !CODE.test(v)) throw new UtmRegistryError('CODE_INVALID');
    if (content !== undefined && (typeof content !== 'string' || !CODE.test(content))) throw new UtmRegistryError('CODE_INVALID');
    const key = `${source}|${medium}|${campaign}|${content ?? ''}`;
    if (seen.has(key)) throw new UtmRegistryError('DUPLICATE');
    seen.add(key);
  }
  return reg as UtmRegistry;
}

/**
 * 받은 값이 등록된 조합과 정확히 일치할 때만 그 조합을 돌려준다. 아니면 빈 객체(전부 버림).
 * 비교 전 정규화는 앞뒤 공백 제거만 한다(대소문자를 바꿔 미등록 값을 등록 값으로 만들지 않음).
 */
export function matchUtm(params: Record<string, unknown>, registry: UtmRegistry = UTM_REGISTRY): Partial<Record<'utm_source' | 'utm_medium' | 'utm_campaign' | 'utm_content', string>> {
  const reg = validateRegistry(registry);
  const get = (k: string) => (typeof params[k] === 'string' ? (params[k] as string).trim() : undefined);
  const source = get('utm_source'), medium = get('utm_medium'), campaign = get('utm_campaign'), content = get('utm_content');
  if (!source || !medium || !campaign) return {};
  const hit = reg.find((e) => e.source === source && e.medium === medium && e.campaign === campaign && (e.content ?? undefined) === (content || undefined));
  if (!hit) return {};
  return { utm_source: hit.source, utm_medium: hit.medium, utm_campaign: hit.campaign, ...(hit.content ? { utm_content: hit.content } : {}) };
}
