// 최초 owner 인증 등록 — 비활성 순수 참조 모델 (PM 6919806262, 설계: docs/design/STAFF-ENROLLMENT-BOOTSTRAP.md 9절)
// - 가상 상태·주입 시각·서버가 검증했다고 가정한 컨텍스트만 다룬다. 파일·DB·네트워크·env·키·SDK 접근 없음.
// - 앱 코드에서 import하지 않는다. 통과는 실제 JWT 검증·RLS·PG 동시성·Auth 원자성·실계정 복구 통과가 아니다.
// - 모든 함수는 입력 상태를 바꾸지 않는다. 거부(rollback 의미)는 입력 상태를 그대로 돌려준다.
//   상태를 남기는 결과(만료·failed·멱등 재응답)는 새 상태를 돌려준다(commit 의미).

export type GrantState = 'issued' | 'reserved' | 'enrolling' | 'bound' | 'failed' | 'expired' | 'revoked';
const OPEN: readonly GrantState[] = ['issued', 'reserved', 'enrolling'];

export type Grant = Readonly<{
  id: string;
  userId: string;
  purpose: 'totp_enroll';
  codeHash: string;
  via: 'project_owner_sql' | 'owner';
  expiresAt: number;
  state: GrantState;
  revision: number;
  authSession: string | null;
  opId: string | null;
  beginDigest: string | null;
  factorId: string | null;
}>;
export type Staff = Readonly<{ userId: string; role: 'owner' | 'counselor'; active: boolean; factorId: string | null }>;
export type Audit = Readonly<{ op: string; userId: string; grantId?: string; from?: GrantState; to?: GrantState; reason?: string }>;
export type World = Readonly<{
  staff: Readonly<Record<string, Staff>>;
  grants: readonly Grant[];
  sessions: Readonly<Record<string, Readonly<{ userId: string; revoked: boolean }>>>;
  audit: readonly Audit[];
  seq: number;
}>;

/** 서버가 Auth 클레임(getClaims)·서명으로 확인했다고 가정한 컨텍스트(가상) */
export type Ctx = Readonly<{ actor: string; authSession: string; aal: 'aal1' | 'aal2'; now: number }>;
export type Result = Readonly<{ world: World; code: string; ok: boolean; opId?: string; revision?: number; action?: string; cleanup?: readonly string[] }>;

const TTL = 15 * 60_000;
const reject = (world: World, code: string): Result => ({ world, code, ok: false });
const digestOf = (g: Grant, authSession: string, opId: string) => `d:${g.id}|${g.userId}|${authSession}|${opId}|${g.purpose}|${g.codeHash}`;

function withGrant(w: World, g: Grant, audit?: Audit, extra: Partial<World> = {}): World {
  return Object.freeze({
    ...w,
    ...extra,
    grants: Object.freeze(w.grants.map((x) => (x.id === g.id ? Object.freeze(g) : x))),
    audit: audit ? Object.freeze([...w.audit, Object.freeze(audit)]) : w.audit,
  });
}
const transition = (w: World, g: Grant, to: GrantState, patch: Partial<Grant>, op: string, reason?: string): World =>
  withGrant(w, { ...g, ...patch, state: to, revision: g.revision + 1 }, { op, userId: g.userId, grantId: g.id, from: g.state, to, ...(reason ? { reason } : {}) });

const boundOwners = (w: World) => Object.values(w.staff).filter((s) => s.role === 'owner' && s.factorId !== null).length;
const openGrant = (w: World, userId: string) => w.grants.find((g) => g.userId === userId && OPEN.includes(g.state));

/** 만료가 지난 미종료 grant를 expired로(commit). 반환: 갱신된 world와 만료 여부 */
function expireIfDue(w: World, g: Grant, now: number): { world: World; grant: Grant; expired: boolean } {
  if (!OPEN.includes(g.state) || now < g.expiresAt) return { world: w, grant: g, expired: false };
  const world = transition(w, g, 'expired', {}, 'enroll.expired');
  return { world, grant: world.grants.find((x) => x.id === g.id)!, expired: true };
}

export function emptyWorld(staff: Staff[] = []): World {
  return Object.freeze({ staff: Object.freeze(Object.fromEntries(staff.map((s) => [s.userId, Object.freeze(s)]))), grants: Object.freeze([]), sessions: Object.freeze({}), audit: Object.freeze([]), seq: 0 });
}

/** 프로젝트 소유자 SQL 전용(전역 락 가정). bound owner 0명 + 미종료 bootstrap grant 0건일 때만 */
export function bootstrapIssue(w: World, userId: string, codeHash: string, now: number): Result {
  const st = w.staff[userId];
  if (!st || st.role !== 'owner' || !st.active || st.factorId !== null) return reject(w, 'NOT_ELIGIBLE');
  if (boundOwners(w) > 0) return reject(w, 'OWNER_ALREADY_BOUND');
  let world = w;
  for (const g of w.grants.filter((x) => OPEN.includes(x.state))) world = expireIfDue(world, g, now).world; // 점유 해소(commit)
  if (world.grants.some((x) => OPEN.includes(x.state) && (x.userId === userId || x.via === 'project_owner_sql'))) {
    return { world, code: 'GRANT_PENDING', ok: false };
  }
  const id = `g${world.seq + 1}`;
  const g: Grant = Object.freeze({ id, userId, purpose: 'totp_enroll', codeHash, via: 'project_owner_sql', expiresAt: now + TTL, state: 'issued', revision: 0, authSession: null, opId: null, beginDigest: null, factorId: null });
  return { world: Object.freeze({ ...world, seq: world.seq + 1, grants: Object.freeze([...world.grants, g]), audit: Object.freeze([...world.audit, Object.freeze({ op: 'enroll.bootstrap_issue', userId, grantId: id })]) }), code: 'ISSUED', ok: true };
}

/** begin: 같은 actor·세션·코드면 같은 operation 재응답(감사 없음). DB가 opId 생성 */
export function begin(w: World, c: Ctx, codeHash: string): Result {
  if (c.aal !== 'aal1') return reject(w, 'AAL_MISMATCH');
  const st = w.staff[c.actor];
  if (!st || st.role !== 'owner' || !st.active) return reject(w, 'NOT_ELIGIBLE');
  if (st.factorId !== null) return reject(w, 'ALREADY_BOUND');
  const g0 = openGrant(w, c.actor);
  if (!g0) return reject(w, w.grants.some((g) => g.userId === c.actor && g.codeHash === codeHash) ? 'GRANT_CLOSED' : 'NO_GRANT');
  const e = expireIfDue(w, g0, c.now);
  if (e.expired) return { world: e.world, code: 'EXPIRED', ok: false };
  const g = e.grant;
  if (g.codeHash !== codeHash) return reject(w, 'CODE_MISMATCH');
  if (g.state !== 'issued') {
    if (g.authSession !== c.authSession) return reject(w, 'SESSION_MISMATCH');
    return { world: w, code: 'RETRY_SAME_OPERATION', ok: true, opId: g.opId!, revision: g.revision };
  }
  const opId = `op${w.seq + 1}`;
  const world = transition({ ...w, seq: w.seq + 1 } as World, g, 'reserved', { authSession: c.authSession, opId, beginDigest: digestOf(g, c.authSession, opId) }, 'enroll.begin');
  return { world, code: 'RESERVED', ok: true, opId, revision: g.revision + 1 };
}

/** 서버가 단계 전에 DB에서 operation을 복원한다(브라우저 값 아님) */
export function status(w: World, c: Ctx): Result {
  const g = openGrant(w, c.actor);
  if (!g || g.authSession !== c.authSession) return reject(w, 'NO_OPERATION');
  return { world: w, code: g.state.toUpperCase(), ok: true, opId: g.opId ?? undefined, revision: g.revision };
}

type OpArgs = Readonly<{ opId: string; beginDigest: string; expectedRevision: number }>;
function checkOp(w: World, c: Ctx, a: OpArgs, want: GrantState): { g: Grant } | { r: Result } {
  const st = w.staff[c.actor];
  if (!st || st.role !== 'owner' || !st.active) return { r: reject(w, 'NOT_ELIGIBLE') };
  const g = w.grants.find((x) => x.userId === c.actor && x.opId === a.opId);
  if (!g) return { r: reject(w, 'OP_NOT_FOUND') };
  const e = expireIfDue(w, g, c.now);
  if (e.expired) return { r: { world: e.world, code: 'EXPIRED', ok: false } };
  if (g.authSession !== c.authSession) return { r: reject(w, 'SESSION_MISMATCH') };
  if (g.beginDigest !== a.beginDigest) return { r: reject(w, 'DIGEST_MISMATCH') };
  if (g.state !== want) return { r: reject(w, 'STATE_MISMATCH') };
  if (g.revision !== a.expectedRevision) return { r: reject(w, 'STALE_REVISION') };
  return { g };
}

export function recordFactor(w: World, c: Ctx, a: OpArgs & { factorId: string }): Result {
  if (c.aal !== 'aal1') return reject(w, 'AAL_MISMATCH');
  const g0 = w.grants.find((x) => x.userId === c.actor && x.opId === a.opId);
  // 같은 요청 재시도: 이미 같은 factor로 enrolling이면 같은 결과(감사 없음)
  if (g0 && g0.state === 'enrolling' && g0.factorId === a.factorId && g0.authSession === c.authSession && g0.beginDigest === a.beginDigest && g0.revision === a.expectedRevision + 1) {
    return { world: w, code: 'RETRY_SAME', ok: true, revision: g0.revision };
  }
  const chk = checkOp(w, c, a, 'reserved');
  if ('r' in chk) return chk.r;
  const world = transition(w, chk.g, 'enrolling', { factorId: a.factorId }, 'enroll.record_factor');
  return { world, code: 'ENROLLING', ok: true, revision: chk.g.revision + 1 };
}

/**
 * 재진입 판정(9-3): operation이 소유한 factor F 기준. verifiedIds·unverifiedIds는 서버가 listFactors로 얻은 값(가상).
 * 정리 대상은 이 operation의 F가 unverified일 때 F 하나뿐. 다른 unverified는 지우지 않는다.
 */
export function decideReentry(g: Grant, verifiedIds: readonly string[], unverifiedIds: readonly string[]): Readonly<{ action: string; cleanup: readonly string[] }> {
  if (g.state === 'reserved') {
    return verifiedIds.length > 0 ? { action: 'STOP_VERIFIED_EXISTS', cleanup: [] } : { action: 'ENROLL', cleanup: [] };
  }
  if (g.state !== 'enrolling' || !g.factorId) return { action: 'NONE', cleanup: [] };
  const F = g.factorId;
  const foreignVerified = verifiedIds.filter((id) => id !== F);
  if (foreignVerified.length > 0) return { action: 'FAIL_FOREIGN_VERIFIED', cleanup: [] };
  if (verifiedIds.length === 1 && verifiedIds[0] === F) return { action: 'BIND', cleanup: [] };
  if (unverifiedIds.includes(F)) return { action: 'RETRY_VERIFY', cleanup: [] };
  return { action: 'FAIL_FACTOR_MISSING', cleanup: [] };
}
/** 실패로 끝낼 때 정리 대상: 이 operation의 F가 unverified일 때만 F */
export const cleanupOnFail = (g: Grant, unverifiedIds: readonly string[]): readonly string[] => (g.factorId && unverifiedIds.includes(g.factorId) ? [g.factorId] : []);

export function bind(w: World, c: Ctx, a: OpArgs & { factorId: string; verifiedIds: readonly string[] }): Result {
  if (c.aal !== 'aal2') return reject(w, 'AAL_MISMATCH');
  const st = w.staff[c.actor];
  const g0 = w.grants.find((x) => x.userId === c.actor && x.opId === a.opId);
  if (g0 && g0.state === 'bound' && g0.factorId === a.factorId && g0.authSession === c.authSession && st?.factorId === a.factorId) {
    return { world: w, code: 'RETRY_SAME', ok: true, revision: g0.revision }; // 같은 요청 재시도: 감사 1회 유지
  }
  const chk = checkOp(w, c, a, 'enrolling');
  if ('r' in chk) return chk.r;
  const g = chk.g;
  if (g.factorId !== a.factorId) return reject(w, 'FACTOR_MISMATCH');
  if (!(a.verifiedIds.length === 1 && a.verifiedIds[0] === a.factorId)) return reject(w, 'VERIFIED_NOT_EXACTLY_ONE');
  if (st!.factorId !== null) return reject(w, 'ALREADY_BOUND');
  if (g.via === 'project_owner_sql' && boundOwners(w) > 0) return reject(w, 'OWNER_ALREADY_BOUND'); // 전역 불변식
  const staff = Object.freeze({ ...w.staff, [c.actor]: Object.freeze({ ...st!, factorId: a.factorId }) });
  const world = transition({ ...w, staff } as World, g, 'bound', {}, 'enroll.bind');
  return { world, code: 'BOUND', ok: true, revision: g.revision + 1 };
}

const REASONS = new Set(['ENROLL_FAILED', 'VERIFIED_EXISTS', 'FOREIGN_VERIFIED', 'FACTOR_MISSING', 'DB_RECORD_FAILED']);
export function fail(w: World, c: Ctx, a: OpArgs, reason: string): Result {
  if (!REASONS.has(reason)) return reject(w, 'REASON_INVALID');
  const g = w.grants.find((x) => x.userId === c.actor && x.opId === a.opId);
  if (!g) return reject(w, 'OP_NOT_FOUND');
  if (g.state === 'failed') return { world: w, code: 'RETRY_SAME', ok: true, revision: g.revision };
  if (g.state !== 'reserved' && g.state !== 'enrolling') return reject(w, 'STATE_MISMATCH');
  if (g.authSession !== c.authSession || g.beginDigest !== a.beginDigest) return reject(w, 'SESSION_MISMATCH');
  if (g.revision !== a.expectedRevision) return reject(w, 'STALE_REVISION');
  return { world: transition(w, g, 'failed', {}, 'enroll.failed', reason), code: 'FAILED', ok: true, revision: g.revision + 1 };
}

/** 프로젝트 소유자 SQL 전용 최후 owner 복구(9-4) */
export function ownerRecoveryReset(w: World, userId: string): Result {
  const st = w.staff[userId];
  if (!st || st.role !== 'owner') return reject(w, 'NOT_OWNER');
  const sessions = Object.freeze(Object.fromEntries(Object.entries(w.sessions).map(([k, v]) => [k, v.userId === userId ? Object.freeze({ ...v, revoked: true }) : v])));
  const grants = Object.freeze(w.grants.map((g) => (g.userId === userId && OPEN.includes(g.state) ? Object.freeze({ ...g, state: 'revoked' as const, revision: g.revision + 1 }) : g)));
  const staff = Object.freeze({ ...w.staff, [userId]: Object.freeze({ ...st, active: false, factorId: null }) });
  return { world: Object.freeze({ ...w, staff, sessions, grants, audit: Object.freeze([...w.audit, Object.freeze({ op: 'owner.recovery_reset', userId })]) }), code: 'RESET', ok: true };
}
export function ownerRecoveryReactivate(w: World, userId: string): Result {
  const st = w.staff[userId];
  if (!st || st.role !== 'owner' || st.factorId !== null) return reject(w, 'NOT_ELIGIBLE');
  const staff = Object.freeze({ ...w.staff, [userId]: Object.freeze({ ...st, active: true }) });
  return { world: Object.freeze({ ...w, staff, audit: Object.freeze([...w.audit, Object.freeze({ op: 'owner.recovery_reactivate', userId })]) }), code: 'REACTIVATED', ok: true };
}

/** 세션 개설(변경 후 staff_session_open): 등록된 factor와 정확히 같아야. NULL이면 항상 거부(aal2-only 우회 없음) */
export function sessionOpen(w: World, c: Ctx, sessionId: string, factorId: string | null): Result {
  const st = w.staff[c.actor];
  if (c.aal !== 'aal2' || !st || !st.active || st.factorId === null || factorId !== st.factorId) return reject(w, 'FORBIDDEN');
  return { world: Object.freeze({ ...w, sessions: Object.freeze({ ...w.sessions, [sessionId]: Object.freeze({ userId: c.actor, revoked: false }) }) }), code: 'OPENED', ok: true };
}
