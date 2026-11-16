// PM 6919806262: 최초 owner 등록 참조 모델(docs/design/staff-enrollment/model.ts) 시험. 가상 상태·주입 시각만.
// 통과는 실제 JWT 검증·RLS·PG 동시성·Auth 원자성·실계정 복구 통과가 아니다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  begin, bind, bootstrapIssue, cleanupOnFail, decideReentry, emptyWorld, fail, ownerRecoveryReactivate, ownerRecoveryReset,
  recordFactor, sessionOpen, status, type Ctx, type World,
} from '../../docs/design/staff-enrollment/model';

const U = 'owner-1';
const T0 = 1_000_000;
const c1 = (now = T0 + 1000, authSession = 'auth-s1'): Ctx => ({ actor: U, authSession, aal: 'aal1', now });
const c2 = (now = T0 + 2000, authSession = 'auth-s1'): Ctx => ({ actor: U, authSession, aal: 'aal2', now });
const fresh = () => bootstrapIssue(emptyWorld([{ userId: U, role: 'owner', active: true, factorId: null }]), U, 'h-code', T0).world;
const snap = (w: World) => JSON.stringify(w);

function toEnrolling() {
  const w0 = fresh();
  const b = begin(w0, c1(), 'h-code');
  const g = b.world.grants[0];
  const r = recordFactor(b.world, c1(), { opId: b.opId!, beginDigest: g.beginDigest!, expectedRevision: b.revision!, factorId: 'F1' });
  return { w: r.world, opId: b.opId!, digest: g.beginDigest!, rev: r.revision! };
}

test('E1 정상: 발급→예약→기록→결합→세션 개설(등록 factor만), 감사 순서', () => {
  const { w, opId, digest, rev } = toEnrolling();
  const b = bind(w, c2(), { opId, beginDigest: digest, expectedRevision: rev, factorId: 'F1', verifiedIds: ['F1'] });
  assert.equal(b.code, 'BOUND');
  assert.equal(b.world.staff[U].factorId, 'F1');
  assert.deepEqual(b.world.audit.map((a) => a.op), ['enroll.bootstrap_issue', 'enroll.begin', 'enroll.record_factor', 'enroll.bind']);
  assert.equal(sessionOpen(b.world, c2(), 's-db-1', 'F1').code, 'OPENED');
  assert.equal(sessionOpen(b.world, c2(), 's-db-2', 'F2').code, 'FORBIDDEN', '다른 factor 거부');
  assert.equal(sessionOpen(b.world, c1(), 's-db-3', 'F1').code, 'FORBIDDEN', 'aal1 거부');
});

test('E2 안정 operation: 같은 actor·세션·코드 재시도는 같은 opId·감사 추가 0, 다른 세션·코드는 거부(원본 불변)', () => {
  const w0 = fresh();
  const b = begin(w0, c1(), 'h-code');
  const again = begin(b.world, c1(T0 + 1500), 'h-code');
  assert.deepEqual([again.code, again.opId, again.world.audit.length], ['RETRY_SAME_OPERATION', b.opId, b.world.audit.length]);
  for (const [ctx, code, expect] of [[c1(T0 + 1500, 'auth-s2'), 'h-code', 'SESSION_MISMATCH'], [c1(), 'h-other', 'CODE_MISMATCH'], [c2(), 'h-code', 'AAL_MISMATCH']] as const) {
    const before = snap(b.world);
    const r = begin(b.world, ctx, code);
    assert.equal(r.code, expect);
    assert.equal(snap(r.world), before, `${expect}: 원본 불변`);
  }
  const st = status(b.world, c1());
  assert.deepEqual([st.code, st.opId], ['RESERVED', b.opId], '서버는 DB에서 operation 복원');
  assert.equal(status(b.world, c1(T0, 'auth-s2')).code, 'NO_OPERATION');
});

test('E3 다른 op·세션·내용·factor·stale revision 거부, 같은 요청 재시도는 감사 1회', () => {
  const { w, opId, digest, rev } = toEnrolling();
  const base = { opId, beginDigest: digest, expectedRevision: rev, factorId: 'F1', verifiedIds: ['F1'] };
  const cases: [string, Ctx, typeof base, string][] = [
    ['다른 op', c2(), { ...base, opId: 'op-x' }, 'OP_NOT_FOUND'],
    ['다른 세션', c2(T0 + 2000, 'auth-s2'), base, 'SESSION_MISMATCH'],
    ['다른 내용', c2(), { ...base, beginDigest: 'd:other' }, 'DIGEST_MISMATCH'],
    ['다른 factor', c2(), { ...base, factorId: 'F2', verifiedIds: ['F2'] }, 'FACTOR_MISMATCH'],
    ['stale revision', c2(), { ...base, expectedRevision: rev - 1 }, 'STALE_REVISION'],
    ['verified 2개', c2(), { ...base, verifiedIds: ['F1', 'F9'] }, 'VERIFIED_NOT_EXACTLY_ONE'],
    ['다른 actor', { ...c2(), actor: 'other' }, base, 'NOT_ELIGIBLE'],
  ];
  for (const [label, ctx, a, code] of cases) {
    const before = snap(w);
    const r = bind(w, ctx, a);
    assert.equal(r.code, code, label);
    assert.equal(snap(r.world), before, `${label}: 원본 불변`);
  }
  const ok = bind(w, c2(), base);
  const retry = bind(ok.world, c2(T0 + 2500), base);
  assert.equal(retry.code, 'RETRY_SAME');
  assert.equal(retry.world.audit.filter((x) => x.op === 'enroll.bind').length, 1, '감사 1회');
  const rf = recordFactor(w, c1(), { opId, beginDigest: digest, expectedRevision: rev - 1, factorId: 'F1' });
  assert.equal(rf.code, 'RETRY_SAME', 'record_factor 같은 요청 재시도');
});

test('E4 verify 응답 유실 재진입: 복원 후 이 operation의 F가 verified 1개면 결합(VERIFIED_EXISTS로 막지 않음), 다른 unverified는 지우지 않음', () => {
  const { w } = toEnrolling();
  const g = w.grants[0];
  assert.deepEqual(decideReentry(g, ['F1'], ['X-unknown']), { action: 'BIND', cleanup: [] });
  assert.deepEqual(decideReentry(g, [], ['F1', 'X-unknown']), { action: 'RETRY_VERIFY', cleanup: [] });
  assert.deepEqual(decideReentry(g, ['F1', 'F9'], []), { action: 'FAIL_FOREIGN_VERIFIED', cleanup: [] });
  assert.deepEqual(decideReentry(g, [], ['X-unknown']), { action: 'FAIL_FACTOR_MISSING', cleanup: [] });
  assert.deepEqual(cleanupOnFail(g, ['F1', 'X-unknown']), ['F1'], '정리는 이 operation의 F 하나뿐');
  assert.deepEqual(cleanupOnFail(g, ['X-unknown']), [], '출처 불명 unverified는 지우지 않음');
  const reserved = begin(fresh(), c1(), 'h-code').world.grants[0];
  assert.equal(decideReentry(reserved, ['V-old'], []).action, 'STOP_VERIFIED_EXISTS', 'factor 소유 전에만 VERIFIED_EXISTS');
});

test('E5 만료: 상태를 남기는 결과(expired commit + 감사), 만료·세션 변경 뒤 자동 결합 없음', () => {
  const { w, opId, digest, rev } = toEnrolling();
  const late = bind(w, c2(T0 + 16 * 60_000), { opId, beginDigest: digest, expectedRevision: rev, factorId: 'F1', verifiedIds: ['F1'] });
  assert.equal(late.code, 'EXPIRED');
  assert.equal(late.world.grants[0].state, 'expired');
  assert.equal(late.world.audit[late.world.audit.length - 1]?.op, 'enroll.expired');
  assert.equal(late.world.staff[U].factorId, null, '자동 결합 없음');
  const again = bind(late.world, c2(T0 + 17 * 60_000), { opId, beginDigest: digest, expectedRevision: rev + 1, factorId: 'F1', verifiedIds: ['F1'] });
  assert.equal(again.ok, false);
  assert.equal(begin(late.world, c1(T0 + 17 * 60_000), 'h-code').code, 'GRANT_CLOSED', '종료 grant 코드는 새 발급 필요');
});

test('E6 DB 기록 실패로 reserved 점유: 만료 전 새 발급 거부, 만료 뒤 발급 시 먼저 expired로 비우고 발급', () => {
  const b = begin(fresh(), c1(), 'h-code');
  const early = bootstrapIssue(b.world, U, 'h-new', T0 + 5 * 60_000);
  assert.equal(early.code, 'GRANT_PENDING');
  const later = bootstrapIssue(b.world, U, 'h-new', T0 + 16 * 60_000);
  assert.equal(later.code, 'ISSUED');
  assert.deepEqual(later.world.grants.map((g) => g.state), ['expired', 'issued']);
  const f = fail(b.world, c1(), { opId: b.opId!, beginDigest: b.world.grants[0].beginDigest!, expectedRevision: b.revision! }, 'DB_RECORD_FAILED');
  assert.equal(f.code, 'FAILED');
  assert.equal(fail(f.world, c1(), { opId: b.opId!, beginDigest: b.world.grants[0].beginDigest!, expectedRevision: b.revision! }, 'DB_RECORD_FAILED').code, 'RETRY_SAME');
  assert.equal(fail(b.world, c1(), { opId: b.opId!, beginDigest: 'x', expectedRevision: b.revision! }, 'FREE TEXT').code, 'REASON_INVALID');
});

test('E7 전역 불변식: bound owner가 있으면 bootstrap 발급·결합 거부(동시 2명 불가)', () => {
  const two = emptyWorld([{ userId: U, role: 'owner', active: true, factorId: null }, { userId: 'owner-2', role: 'owner', active: true, factorId: null }]);
  const i1 = bootstrapIssue(two, U, 'h1', T0);
  assert.equal(bootstrapIssue(i1.world, 'owner-2', 'h2', T0).code, 'GRANT_PENDING', '미종료 bootstrap grant 1건만');
  const { w, opId, digest, rev } = toEnrolling();
  const bound = bind(w, c2(), { opId, beginDigest: digest, expectedRevision: rev, factorId: 'F1', verifiedIds: ['F1'] }).world;
  const withSecond = { ...bound, staff: { ...bound.staff, 'owner-2': { userId: 'owner-2', role: 'owner' as const, active: true, factorId: null } } } as World;
  assert.equal(bootstrapIssue(withSecond, 'owner-2', 'h2', T0 + 3000).code, 'OWNER_ALREADY_BOUND');
});

test('E8 마지막 owner 복구(소유자 SQL 전용): 비활성·결합 해제·세션·grant 폐기 → 재활성 → aal2-only 로그인 불가 → 새 등록', () => {
  const { w, opId, digest, rev } = toEnrolling();
  const bound = bind(w, c2(), { opId, beginDigest: digest, expectedRevision: rev, factorId: 'F1', verifiedIds: ['F1'] }).world;
  const opened = sessionOpen(bound, c2(), 's-db-1', 'F1').world;
  const reset = ownerRecoveryReset(opened, U).world;
  assert.deepEqual([reset.staff[U].active, reset.staff[U].factorId, reset.sessions['s-db-1'].revoked], [false, null, true]);
  assert.equal(sessionOpen(reset, c2(), 's-db-2', 'F1').code, 'FORBIDDEN');
  const re = ownerRecoveryReactivate(reset, U).world;
  assert.equal(re.staff[U].active, true);
  assert.equal(sessionOpen(re, c2(), 's-db-3', null).code, 'FORBIDDEN', 'factor 없이 aal2만으로 세션 불가(우회 없음)');
  assert.equal(sessionOpen(re, c2(), 's-db-3', 'F1').code, 'FORBIDDEN', '예전 factor로도 불가');
  const again = bootstrapIssue(re, U, 'h-new', T0 + 60_000);
  assert.equal(again.code, 'ISSUED', '새 1회 코드로 재등록');
  assert.equal(ownerRecoveryReactivate(bound, U).code, 'NOT_ELIGIBLE', '결합 해제 전 재활성 불가');
});

test('E9 직원 비활성화 중에는 begin·bind 거부, 모델은 앱·서버 코드에서 import되지 않음', () => {
  const { w, opId, digest, rev } = toEnrolling();
  const off = { ...w, staff: { ...w.staff, [U]: { ...w.staff[U], active: false } } } as World;
  assert.equal(bind(off, c2(), { opId, beginDigest: digest, expectedRevision: rev, factorId: 'F1', verifiedIds: ['F1'] }).code, 'NOT_ELIGIBLE');
  assert.equal(begin(off, c1(), 'h-code').code, 'NOT_ELIGIBLE');
  const root = path.resolve(__dirname, '../../src');
  const files: string[] = [];
  const walk = (d: string) => { for (const n of readdirSync(d)) { const p = path.join(d, n); if (statSync(p).isDirectory()) walk(p); else files.push(p); } };
  walk(root);
  assert.deepEqual(files.filter((f) => /staff-enrollment\/model/.test(readFileSync(f, 'utf8'))), []);
  const src = readFileSync(path.resolve(__dirname, '../../docs/design/staff-enrollment/model.ts'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.ok(!/from ['"]|require\(|process\.|fetch\(|Date\.now/.test(src), '외부 import·환경·네트워크·실시각 없음');
});
