import 'server-only';
import type { AdminAuthMode } from '../auth/adminAuthMode';
import { StaffAuthError } from '../auth/staffAssertion';
import type { StaffIdentity } from '../auth/staffSession';
import { buildDealerPacket, validateApplication, type Application, type PacketQuote } from '../../content/applicationForm';
import { noticeReadiness, sameNoticeKeys, type NoticeConfig } from '../../content/requiredNotices';
import { dbReadReady } from './leadsSource';
import type { TxRunner } from './policyAdmin';

/**
 * 총판 전달용 신청서 열람·복사·전달 이력 (PM 11/22). 의존성은 인자로만 받는다.
 * - MVP: 대표(owner)만(DB가 최종 판정). 열람 사유는 고정 코드, 열람·복사·전달은 추가 전용 이력과 감사 로그에 남고 감사에는 개인정보 원문(이름·연락처·주소·자유 문장)을 넣지 않는다.
 * - 이름·연락처·신청서 본문은 서버에서만 복호화해 응답한다. 응답은 no-store.
 * - 요금·사은품 문구는 quoteFor가 만든 '승인·게시 정책' 안내만 쓴다(실패·미게시는 담당자 확인 안내).
 * - 주민번호·자동이체·계좌는 수집하지 않으므로 packet에는 '총판 별도 확인' 항목으로만 나온다.
 */
type Env = Readonly<Record<string, string | undefined>>;
export type DealerPacketDeps = {
  env: () => Env;
  mode: () => AdminAuthMode;
  requireStaff: () => Promise<StaffIdentity>;
  runInTransaction: TxRunner;
  decrypt: (stored: string) => string;
  quoteFor: (app: Application | null) => Promise<PacketQuote>;
  notices: () => NoticeConfig;
  privacyVersion: () => string;
  now: () => Date;
};

const HEADERS = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Type': 'application/json; charset=utf-8' } as const;
const json = (b: unknown, s: number) => new Response(JSON.stringify(b), { status: s, headers: HEADERS });
const fail = (c: string, s: number) => json({ ok: false, code: c }, s);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLES = ['owner'] as const; // MVP 최소 권한
const REASONS = new Set(['dealer_handoff', 'content_check', 'correction']);
const DEALER_NOTE = /^[가-힣A-Za-z0-9 ·()_-]{2,30}$/;

function noticeReady(deps: DealerPacketDeps, version: unknown, keys: unknown): boolean {
  try {
    const cfg = deps.notices();
    if (!noticeReadiness(cfg, deps.privacyVersion()).ready) return false;
    return typeof version === 'string' && version === cfg.version && Array.isArray(keys) && sameNoticeKeys(cfg, keys.map(String));
  } catch { return false; }
}

async function gate(deps: DealerPacketDeps, id: string, roles: readonly string[]): Promise<StaffIdentity | Response> {
  let ready = false;
  try { ready = dbReadReady(deps.env()); } catch { ready = false; }
  if (!ready) return fail('DEALER_PACKET_DISABLED', 503);
  if (deps.mode() !== 'supabase') return fail('ADMIN_AUTH_DISABLED', 503);
  if (!UUID.test(id)) return fail('INVALID_ID', 400);
  let who: StaffIdentity;
  try { who = await deps.requireStaff(); } catch (e) {
    if (e instanceof StaffAuthError) return fail(e.status === 401 ? 'UNAUTHENTICATED' : 'FORBIDDEN', e.status === 401 ? 401 : 403);
    return fail('AUTH_UNAVAILABLE', 503);
  }
  if (!roles.includes(who.role)) return fail('FORBIDDEN', 403);
  return who;
}

const DB_CODES = new Set(['REASON_REQUIRED', 'PACKET_NOT_VIEWED', 'INVALID_EVENT', 'NOTE_REQUIRED', 'INVALID_INPUT', 'REVEAL_RATE_LIMITED']);
function dbError(e: unknown): Response {
  const err = (e ?? {}) as { code?: unknown; message?: unknown };
  if (err.code === '42501') return fail('FORBIDDEN', 403);
  if (err.code === '54000') return fail('REVEAL_RATE_LIMITED', 429);
  if (err.code === '22023' && typeof err.message === 'string' && DB_CODES.has(err.message)) return fail(err.message, 400);
  if (typeof err.message === 'string' && DB_CODES.has(err.message)) return fail(err.message, 409);
  return fail('UNAVAILABLE', 503);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** POST: {reason} → 복호화한 총판 전달용 자료. 열람 이력('viewed')·감사 로그가 같이 남는다 */
export async function dealerPacketGet(deps: DealerPacketDeps, id: string, body: unknown): Promise<Response> {
  const g = await gate(deps, id, ROLES);
  if (g instanceof Response) return g;
  if (!isObj(body) || typeof body.reason !== 'string' || Object.keys(body).length !== 1) return fail('INVALID_INPUT', 400);
  const reason = body.reason;
  if (!REASONS.has(reason)) return fail('REASON_REQUIRED', 400);
  try {
    const rows = (await deps.runInTransaction(async (tx) =>
      tx`select name_enc, phone_enc, payload_enc, summary, interest, contact_time, created_at, notice_version, notice_keys
         from api.dealer_packet_get(${g.actor}::uuid, ${g.session}::uuid, ${g.token}, ${id}::uuid, ${reason})`)) as readonly Record<string, unknown>[];
    if (!Array.isArray(rows) || rows.length !== 1) return fail('FORBIDDEN', 403);
    const r = rows[0];
    let app: Application | null = null;
    let name: string, phone: string;
    try {
      name = deps.decrypt(String(r.name_enc));
      phone = deps.decrypt(String(r.phone_enc));
      if (typeof r.payload_enc === 'string' && r.payload_enc !== '') {
        const v = validateApplication(JSON.parse(deps.decrypt(r.payload_enc)));
        if (!v.ok) return fail('INVALID_DATA', 502);
        app = v.value;
      }
    } catch { return fail('DECRYPT_FAILED', 502); }
    let quote: PacketQuote | null = null;
    try { quote = await deps.quoteFor(app); } catch { quote = null; }
    const created = r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at);
    const packet = buildDealerPacket({
      lead: { name, phone, interest: String(r.interest), contactTime: r.contact_time == null ? null : String(r.contact_time), createdAt: created },
      app, quote, noticeReady: noticeReady(deps, r.notice_version, r.notice_keys), generatedAt: deps.now().toISOString(),
    });
    return json({ ok: true, hasApplication: app !== null, packet }, 200);
  } catch (e) { return dbError(e); }
}

/** POST: {event:'copied'|'sent', note?} → 이력 추가 */
export async function handoffRecord(deps: DealerPacketDeps, id: string, body: unknown): Promise<Response> {
  const g = await gate(deps, id, ROLES);
  if (g instanceof Response) return g;
  if (!isObj(body) || (body.event !== 'copied' && body.event !== 'sent')) return fail('INVALID_INPUT', 400);
  if (Object.keys(body).some((k) => k !== 'event' && k !== 'note') || (body.note !== undefined && typeof body.note !== 'string')) return fail('INVALID_INPUT', 400);
  const note = typeof body.note === 'string' ? body.note.trim() : '';
  if (note !== '' && (!DEALER_NOTE.test(note) || /\d{4,}/.test(note))) return fail('INVALID_INPUT', 400); // 총판 이름 정도만(긴 숫자·이메일·기호 거부)
  if (body.event === 'sent' && note === '') return fail('REASON_REQUIRED', 400); // 전달한 총판 이름 필수
  try {
    if (body.event === 'sent') {
      // 전달 완료는 '준비 완료'인 건만: 개인정보 없이 요약의 누락 목록과 고지 노출 기록을 다시 확인한다
      const st = (await deps.runInTransaction(async (tx) =>
        tx`select summary, notice_version, notice_keys from api.dealer_packet_status(${g.actor}::uuid, ${g.session}::uuid, ${g.token}, ${id}::uuid)`)) as readonly Record<string, unknown>[];
      const sum = st[0]?.summary as { missing?: unknown } | null | undefined;
      const complete = !!sum && Array.isArray(sum.missing) && sum.missing.length === 0;
      if (!complete || !noticeReady(deps, st[0]?.notice_version, st[0]?.notice_keys)) return fail('PACKET_NOT_READY', 409);
    }
    await deps.runInTransaction(async (tx) =>
      tx`select api.handoff_record(${g.actor}::uuid, ${g.session}::uuid, ${g.token}, ${id}::uuid, ${body.event as string}, ${note === '' ? null : note})`);
    return json({ ok: true }, 200);
  } catch (e) { return dbError(e); }
}

/** GET: 전달 이력(대표만) */
export async function handoffList(deps: DealerPacketDeps, id: string): Promise<Response> {
  const g = await gate(deps, id, ROLES);
  if (g instanceof Response) return g;
  try {
    const rows = (await deps.runInTransaction(async (tx) =>
      tx`select event, note, actor_id, created_at from api.handoff_list(${g.actor}::uuid, ${g.session}::uuid, ${g.token}, ${id}::uuid)`)) as readonly Record<string, unknown>[];
    if (!Array.isArray(rows) || rows.length > 500) return fail('INVALID_DATA', 502);
    return json({ ok: true, items: rows.map((r) => ({ event: r.event, note: r.note ?? null, actorId: r.actor_id, createdAt: r.created_at })) }, 200);
  } catch (e) { return dbError(e); }
}
