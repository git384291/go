import 'server-only';
import { isActiveInterest } from '../../content/catalog';
import type { StaffIdentity } from '../auth/staffSession';

/**
 * 관리자 상담 목록 — 실제 DB 조회용 마스킹 어댑터 (PM 6908711385). **비활성·미배선.**
 * - 기존 DB 함수 `api.list_leads(actor, session, token, limit, offset)`를 바인딩 파라미터로 호출한다.
 * - DB 실행기는 호출자가 반드시 주입한다. 이 모듈은 import·생성만으로 DB에 연결하지 않고,
 *   환경 변수·URL·키를 읽지 않으며, 기본 실행기(withRole 등)를 스스로 부르지 않는다.
 * - 현재 어떤 HTTP API·페이지도 이 모듈을 import하지 않는다(실제 배선은 별도 승인 범위).
 *
 * 역할 범위(서버 모듈 기준. DB 함수는 reviewer 전체 조회도 허용하므로 여기서 더 좁힌다 — DB 권한 변경이 아니다)
 * - owner: 전체(미배정 포함)
 * - counselor: 본인 배정만. DB 결과도 다시 확인하고, 범위 밖 행이 오면 누락시키지 않고 전체 실패로 닫는다
 * - reviewer·policy_editor·알 수 없는 역할: 실행기 호출 전에 거부
 *
 * 반환 DTO는 허용 목록 필드만 새로 만든다. contact_time·utm_source(자유 입력이 섞일 수 있음),
 * 암호문·원문·HMAC·주소·메모·키·세션·서명·DB 오류 원문은 넣지 않는다. 연락처 열람(reveal)·복호화·상태 변경 없음.
 */

/** 바인딩 파라미터 태그드 템플릿(postgres.js 트랜잭션과 호환되는 최소 형태). 문자열 조립 SQL은 쓰지 않는다 */
export type SqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => PromiseLike<readonly unknown[]>;
/** 호출자가 주입하는 트랜잭션 실행기(예: 검수 후 별도 배선에서 `(fn) => withRole('staff', fn)`) */
export type TxRunner = <T>(fn: (tx: SqlTag) => Promise<T>) => Promise<T>;

export type LeadsReadDeps = {
  /** 실제 조회 스위치. false면 아무 것도 실행하지 않는다 */
  enabled: () => boolean;
  runInTransaction: TxRunner;
};

export const LEAD_STATUSES = ['new', 'contacting', 'consulted', 'no_answer', 'declined', 'converted'] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export type MaskedLead = Readonly<{
  id: string;
  createdAt: string; // ISO 8601(UTC)
  nameMasked: string;
  phoneMasked: string; // 010-****-1234
  interest: string; // 활성 상품 키만
  status: LeadStatus;
  assignedTo: string | null;
}>;

export type ReadErrorCode = 'DISABLED' | 'FORBIDDEN' | 'INVALID_PAGE' | 'UNAVAILABLE' | 'INVALID_DATA' | 'SCOPE_VIOLATION';
export type ListResult = Readonly<{ ok: true; items: readonly MaskedLead[] }> | Readonly<{ ok: false; code: ReadErrorCode }>;

export const PAGE_LIMIT_MAX = 200; // DB 함수의 상한과 같다
export const PAGE_OFFSET_MAX = 100_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// maskName(src/server/security/piiCrypto.ts) 생산 규칙과 같은 모양만 허용한다(모양 검증일 뿐, 개인정보 완전 제거 보증이 아니다):
//   1글자 → '*', 2글자 → '가*', 3글자 이상 → 첫 글자 + '*'(1~18개) + 끝 글자. 끝 글자는 한글·영문(입력은 trim됨), 전체 20자 이하
const NAME_MASKED_RE = /^(?:\*|[가-힣A-Za-z]\*|[가-힣A-Za-z]\*{1,18}[가-힣A-Za-z])$/u;
const PHONE_MASKED_RE = /^010-\*{4}-\d{4}$/;

const fail = (code: ReadErrorCode): ListResult => Object.freeze({ ok: false as const, code });

class RowInvalid extends Error {}
class ScopeViolation extends Error {}

function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

type ListRole = 'owner' | 'counselor';
/** 서버가 검증한 직원 컨텍스트만 받는다. 형태가 틀리거나 허용 역할이 아니면 null */
function listRole(identity: unknown): { actor: string; session: string; token: string; role: ListRole } | null {
  if (identity === null || typeof identity !== 'object') return null;
  const i = identity as Partial<Record<keyof StaffIdentity, unknown>>;
  if (!isUuid(i.actor) || !isUuid(i.session)) return null;
  if (typeof i.token !== 'string' || i.token.length === 0 || i.token.length > 4096) return null;
  if (i.role !== 'owner' && i.role !== 'counselor') return null;
  return { actor: i.actor, session: i.session, token: i.token, role: i.role };
}

function parsePage(page: unknown): { limit: number; offset: number } | null {
  if (page === undefined) return { limit: 50, offset: 0 };
  if (page === null || typeof page !== 'object' || Array.isArray(page)) return null;
  const p = page as { limit?: unknown; offset?: unknown };
  const limit = p.limit === undefined ? 50 : p.limit;
  const offset = p.offset === undefined ? 0 : p.offset;
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_LIMIT_MAX) return null;
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || offset > PAGE_OFFSET_MAX) return null;
  return { limit, offset };
}

const INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|([+-])(\d{2})(?::?(\d{2}))?)$/;

const daysInMonth = (y: number, m: number) =>
  m === 2 ? ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31;

/**
 * 생성 시각: 유효한 Date 객체 또는 시간대가 있는 엄격 ISO/PostgreSQL 문자열만. Date 정규화(2/31 → 3/3)에 맡기지 않는다.
 * 달력·윤년·시분초(24시·60분·60초 거부)·offset(±14:00 이내, 분 59 이하)을 직접 검사한다. 원본 Date는 바꾸지 않는다.
 */
function isoInstant(v: unknown): string {
  if (v instanceof Date) {
    const t = v.getTime();
    if (!Number.isFinite(t)) throw new RowInvalid();
    return new Date(t).toISOString();
  }
  if (typeof v !== 'string') throw new RowInvalid();
  const m = INSTANT_RE.exec(v);
  if (!m) throw new RowInvalid();
  const [y, mo, d, h, mi, se] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number);
  if (y < 1000 || mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo) || h > 23 || mi > 59 || se > 59) throw new RowInvalid();
  let offsetMin = 0;
  if (m[8] !== 'Z') {
    const oh = Number(m[10]);
    const om = m[11] === undefined ? 0 : Number(m[11]);
    if (om > 59 || oh > 14 || (oh === 14 && om !== 0)) throw new RowInvalid();
    offsetMin = (m[9] === '-' ? -1 : 1) * (oh * 60 + om);
  }
  const ms = m[7] === undefined ? 0 : Math.floor(Number(`0.${m[7]}`) * 1000);
  const t = Date.UTC(y, mo - 1, d, h, mi, se, ms) - offsetMin * 60_000;
  if (!Number.isFinite(t)) throw new RowInvalid();
  return new Date(t).toISOString();
}

function maskedLead(row: unknown, scope: { role: ListRole; actor: string }): MaskedLead {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) throw new RowInvalid();
  const r = row as Record<string, unknown>;
  if (!isUuid(r.lead_id)) throw new RowInvalid();
  const createdAt = isoInstant(r.created_at);
  const name = r.name_masked;
  // 별표 포함만으로 인정하지 않는다(원문+별표 등). 다시 마스킹해 정상화하지 않고 전체 실패로 닫는다
  if (typeof name !== 'string' || !NAME_MASKED_RE.test(name)) throw new RowInvalid();
  const phone = r.phone_masked;
  if (typeof phone !== 'string' || !PHONE_MASKED_RE.test(phone)) throw new RowInvalid();
  if (typeof r.interest !== 'string' || !isActiveInterest(r.interest)) throw new RowInvalid();
  const status = r.status;
  if (typeof status !== 'string' || !(LEAD_STATUSES as readonly string[]).includes(status)) throw new RowInvalid();
  const assigned = r.assigned_to;
  if (assigned !== null && !isUuid(assigned)) throw new RowInvalid();
  if (scope.role === 'counselor' && assigned !== scope.actor) throw new ScopeViolation();
  return Object.freeze({
    id: r.lead_id,
    createdAt,
    nameMasked: name,
    phoneMasked: phone,
    interest: r.interest,
    status: status as LeadStatus,
    assignedTo: assigned,
  });
}

const ISO_OUT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/**
 * 이 모듈이 만든 마스킹 DTO 계약(7키) 확인. HTTP 조합 단계가 같은 규칙으로 다시 확인할 때 쓴다(규칙 복제 방지).
 * 접근 중 예외(getter 등)는 false로 처리한다.
 */
export function isMaskedLeadDto(x: unknown): x is MaskedLead {
  try {
    if (x === null || typeof x !== 'object' || Array.isArray(x)) return false;
    const r = x as Record<string, unknown>;
    if (!isUuid(r.id)) return false;
    if (typeof r.createdAt !== 'string' || !ISO_OUT_RE.test(r.createdAt)) return false;
    const t = Date.parse(r.createdAt);
    if (!Number.isFinite(t) || new Date(t).toISOString() !== r.createdAt) return false;
    if (typeof r.nameMasked !== 'string' || !NAME_MASKED_RE.test(r.nameMasked)) return false;
    if (typeof r.phoneMasked !== 'string' || !PHONE_MASKED_RE.test(r.phoneMasked)) return false;
    if (typeof r.interest !== 'string' || !isActiveInterest(r.interest)) return false;
    if (typeof r.status !== 'string' || !(LEAD_STATUSES as readonly string[]).includes(r.status)) return false;
    return r.assignedTo === null || isUuid(r.assignedTo);
  } catch {
    return false;
  }
}

/** DB 오류는 고정 코드로만 바꾼다(원문·쿼리·파라미터·cause를 로그·반환에 싣지 않는다) */
function dbErrorCode(e: unknown): ReadErrorCode {
  const code = e !== null && typeof e === 'object' ? (e as { code?: unknown }).code : undefined;
  return code === '42501' ? 'FORBIDDEN' : 'UNAVAILABLE';
}

/**
 * 마스킹 목록 조회. 순서: 비활성 확인 → 직원 컨텍스트·역할 → 페이지 인자 → (여기서만) 실행기 호출 → 행 검증·DTO.
 * identity는 서버가 검증한 값(requireStaff 결과)만 넘긴다. 브라우저·query·body 값을 넣지 않는다.
 */
export async function listMaskedLeads(deps: LeadsReadDeps, identity: StaffIdentity, page?: unknown): Promise<ListResult> {
  let on = false;
  try {
    on = deps.enabled() === true;
  } catch {
    on = false;
  }
  if (!on) return fail('DISABLED');
  const who = listRole(identity);
  if (!who) return fail('FORBIDDEN');
  const p = parsePage(page);
  if (!p) return fail('INVALID_PAGE');

  let rows: readonly unknown[];
  try {
    rows = await deps.runInTransaction(async (tx) => {
      const res = await tx`select lead_id, created_at, name_masked, phone_masked, interest, status, assigned_to
                           from api.list_leads(${who.actor}::uuid, ${who.session}::uuid, ${who.token}, ${p.limit}::int, ${p.offset}::int)`;
      return res;
    });
  } catch (e) {
    console.error('LEADLIST_DIAG', (e as { code?: string })?.code, String((e as Error)?.message).slice(0, 120)); // TEMP 진단
    return fail(dbErrorCode(e));
  }
  if (!Array.isArray(rows) || rows.length > p.limit) return fail('INVALID_DATA');
  try {
    const items = rows.map((row) => maskedLead(row, who));
    return Object.freeze({ ok: true as const, items: Object.freeze(items) });
  } catch (e) {
    console.error('LEADLIST_DIAG2 row-invalid', (e as Error)?.constructor?.name, JSON.stringify(rows.map((r) => (r as Record<string, unknown>)?.interest))); // TEMP 진단
    return fail(e instanceof ScopeViolation ? 'SCOPE_VIOLATION' : 'INVALID_DATA');
  }
}
