// 총판 공식 접수 경로 연결 — 순수 검증·판정 모듈 (PM 6920265190 / 6920404685).
//
// 이 파일에는 실제 목적지·활성 스위치가 없다. 실제 값은 서버 전용 설정(src/server/intake/officialIntakeConfig.ts)에만 있고,
// 현재 등록부는 비어 있으며 활성 기본값은 false다. 이 모듈은 "주어진 설정이 공개해도 되는 형태인가"만 판정한다.
//
// 원칙
// - 목적지는 서버 코드의 명시 등록부에서만 온다. URL query·고객 입력·환경변수로 목적지를 주입하는 입력은 받지 않는다.
// - 하나라도 이상한 항목이 있으면 등록부 전체를 거부한다(fail closed). 꺼짐·비어 있음·무효 → 링크를 만들지 않는다.
// - https 고정 주소만 허용한다. IP·localhost·내부/예약 도메인·자격증명·비표준 포트·query·fragment·퍼센트 인코딩·IDN(xn--)은 거부한다.
//   총판 실적 귀속 파라미터가 필요하면 query 허용을 여기서 넓히지 않고, 비식별 허용 코드 구체안을 먼저 검수한다.
// - 형식 검사는 그 주소가 "공식"이거나 안전하다는 증명이 아니다. 공식성·처리 주체는 등록 전 사람이 확인하고 PM이 검수한다.
import type { ProductSlug } from './products';

export type OfficialIntakeEntry = {
  /** 등록 식별자(소문자·숫자·하이픈 3~32자) */
  readonly id: string;
  /** 화면 표시용 접수처 이름(2~24자, 주소·특수기호 불가) */
  readonly label: string;
  /** https 고정 목적지 */
  readonly url: string;
  /** 이 접수처로 연결할 상품. 현재 1단계는 internet-tv만 허용 */
  readonly products: readonly ProductSlug[];
  /** 등록을 검수한 PM 코멘트 번호(예: PM-6920265190). 검수 근거 없는 항목은 거부 */
  readonly reviewRef: string;
};

export type OfficialIntakeLink = { readonly id: string; readonly label: string; readonly href: string; readonly host: string };

export type OfficialIntakeOffReason = 'DISABLED' | 'EMPTY' | 'INVALID' | 'NO_MATCH';
export type OfficialIntakeResult =
  | { readonly state: 'on'; readonly links: readonly OfficialIntakeLink[] }
  | { readonly state: 'off'; readonly reason: OfficialIntakeOffReason };

export type UrlCheck =
  | { readonly ok: true; readonly href: string; readonly host: string }
  | { readonly ok: false; readonly code: string };

/** 1단계에서 공식 접수 연결을 허용하는 상품(활성 상품 중에서도 명시한 것만) */
export const OFFICIAL_INTAKE_PRODUCTS: readonly ProductSlug[] = Object.freeze(['internet-tv'] as const);
export const OFFICIAL_INTAKE_MAX_ENTRIES = 4;
const MAX_URL = 512;

// 공개 인터넷 목적지로 쓰면 안 되는 최상위·접미 도메인(내부망·예약·특수 용도)
const BLOCKED_SUFFIXES = [
  'localhost', 'localdomain', 'local', 'internal', 'intranet', 'private', 'lan', 'home', 'corp', 'test', 'invalid', 'example',
  'onion', 'arpa', 'home.arpa',
];

/** 고정 https 목적지 검증. 정상화 결과가 원문과 완전히 같아야 통과한다(해석 차이로 우회 방지). */
export function validateOfficialIntakeUrl(raw: unknown): UrlCheck {
  if (typeof raw !== 'string') return { ok: false, code: 'TYPE' };
  if (raw.length === 0 || raw.length > MAX_URL) return { ok: false, code: 'LENGTH' };
  if (!/^[\x21-\x7e]+$/.test(raw)) return { ok: false, code: 'CHARSET' }; // 공백·제어문자·비ASCII 거부
  if (!raw.startsWith('https://')) return { ok: false, code: 'SCHEME' };
  if (raw.includes('@')) return { ok: false, code: 'CREDENTIALS' };
  if (raw.includes('?')) return { ok: false, code: 'QUERY' };
  if (raw.includes('#')) return { ok: false, code: 'FRAGMENT' };
  if (raw.includes('%')) return { ok: false, code: 'ENCODING' };
  if (raw.includes('\\')) return { ok: false, code: 'BACKSLASH' };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, code: 'PARSE' };
  }
  if (u.protocol !== 'https:') return { ok: false, code: 'SCHEME' };
  if (u.username !== '' || u.password !== '') return { ok: false, code: 'CREDENTIALS' };
  if (u.port !== '' || /^https:\/\/[^/]*:/.test(raw)) return { ok: false, code: 'PORT' };
  if (u.search !== '') return { ok: false, code: 'QUERY' };
  if (u.hash !== '') return { ok: false, code: 'FRAGMENT' };
  const host = u.hostname;
  if (host.length > 253 || host.startsWith('[')) return { ok: false, code: 'HOST' };
  const labels = host.split('.');
  if (labels.length < 2) return { ok: false, code: 'HOST' };
  for (const l of labels) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l)) return { ok: false, code: 'HOST' };
    if (l.startsWith('xn--')) return { ok: false, code: 'IDN' };
  }
  const tld = labels[labels.length - 1]!;
  if (!/^[a-z]{2,63}$/.test(tld)) return { ok: false, code: 'IP_OR_TLD' }; // 숫자 TLD(IPv4 포함) 거부
  const lowerHost = host.toLowerCase();
  if (BLOCKED_SUFFIXES.some((s) => lowerHost === s || lowerHost.endsWith('.' + s))) return { ok: false, code: 'RESERVED_HOST' };
  const path = u.pathname;
  if (!/^\/[A-Za-z0-9/_.~-]*$/.test(path)) return { ok: false, code: 'PATH' };
  if (path.includes('//') || /(^|\/)\.{1,2}(\/|$)/.test(path)) return { ok: false, code: 'PATH' };
  if (u.href !== raw) return { ok: false, code: 'NOT_CANONICAL' };
  return { ok: true, href: u.href, host };
}

const ENTRY_KEYS = ['id', 'label', 'url', 'products', 'reviewRef'];

function validEntry(e: unknown): e is OfficialIntakeEntry {
  if (e === null || typeof e !== 'object' || Array.isArray(e)) return false;
  const keys = Object.keys(e);
  if (keys.length !== ENTRY_KEYS.length || !keys.every((k) => ENTRY_KEYS.includes(k))) return false;
  const o = e as Record<string, unknown>;
  if (typeof o.id !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/.test(o.id)) return false;
  // 표시 이름: 한글·영문·숫자·공백·괄호만. 주소·연락처처럼 보이는 문자(., :, /, @, -)는 받지 않는다.
  if (typeof o.label !== 'string' || !/^[가-힣A-Za-z0-9 ()]{2,24}$/.test(o.label) || o.label.trim() !== o.label) return false;
  if (typeof o.reviewRef !== 'string' || !/^PM-[0-9]{6,12}$/.test(o.reviewRef)) return false;
  if (!Array.isArray(o.products) || o.products.length === 0 || o.products.length > OFFICIAL_INTAKE_PRODUCTS.length) return false;
  if (new Set(o.products).size !== o.products.length) return false;
  if (!o.products.every((p) => typeof p === 'string' && (OFFICIAL_INTAKE_PRODUCTS as readonly string[]).includes(p))) return false;
  return validateOfficialIntakeUrl(o.url).ok;
}

/**
 * 설정(활성 스위치·등록부)과 상품만으로 공개 링크를 판정한다. 요청·고객 입력은 받지 않는다.
 * - enabled가 정확히 true가 아니면 꺼짐
 * - 등록부가 비었으면 꺼짐, 항목 하나라도 무효·중복이면 전체 꺼짐(INVALID)
 * - 해당 상품에 연결된 항목이 없으면 꺼짐(NO_MATCH)
 */
export function resolveOfficialIntake(input: { enabled: unknown; registry: unknown; slug: ProductSlug }): OfficialIntakeResult {
  if (input.enabled !== true) return { state: 'off', reason: 'DISABLED' };
  const reg = input.registry;
  if (!Array.isArray(reg)) return { state: 'off', reason: 'INVALID' };
  if (reg.length === 0) return { state: 'off', reason: 'EMPTY' };
  if (reg.length > OFFICIAL_INTAKE_MAX_ENTRIES) return { state: 'off', reason: 'INVALID' };
  if (!reg.every(validEntry)) return { state: 'off', reason: 'INVALID' };
  const entries = reg as readonly OfficialIntakeEntry[];
  if (new Set(entries.map((e) => e.id)).size !== entries.length) return { state: 'off', reason: 'INVALID' };
  if (new Set(entries.map((e) => e.url)).size !== entries.length) return { state: 'off', reason: 'INVALID' };
  if (!(OFFICIAL_INTAKE_PRODUCTS as readonly string[]).includes(input.slug)) return { state: 'off', reason: 'NO_MATCH' };
  const links = entries
    .filter((e) => e.products.includes(input.slug))
    .map((e) => {
      const c = validateOfficialIntakeUrl(e.url) as Extract<UrlCheck, { ok: true }>;
      return Object.freeze({ id: e.id, label: e.label, href: c.href, host: c.host });
    });
  if (links.length === 0) return { state: 'off', reason: 'NO_MATCH' };
  return { state: 'on', links: Object.freeze(links) };
}
