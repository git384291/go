// 대표 전용 진행판(/admin/progress) 경로 시험. 실제 렌더 결정 함수(render.tsx)를 판정 주입으로 실행한다.
// 거부 결과의 요소 트리 전체(자식·props 재귀)에 스냅샷 문자열이 없어야 한다 → HTML·RSC 응답에 실릴 수 없음.
// P7은 실제 page.tsx(인증 기본값)를 호출한다(next 미설치 시 SKIP, 통과로 세지 않음).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { ReactElement } from 'react';
import { renderProgress } from '../../src/app/admin/progress/render';
import { ProgressLocked, ProgressView } from '../../src/app/admin/progress/ProgressView';
import { StaffAuthError } from '../../src/server/auth/staffAssertion';
import { StaffSessionUnavailable, type StaffIdentity } from '../../src/server/auth/staffSession';
import { isStale, type ProgressSnapshot } from '../../src/content/progress';

const MARK = 'SNAPSHOT-MARKER-7f3a';
const SNAP: ProgressSnapshot = {
  checkedAt: '2026-11-16T02:03:00+09:00', staleAfterHours: 24, stage: `단계 ${MARK}`,
  recentDone: [`완료 ${MARK}`], next: [`다음 ${MARK}`], checks: [{ name: `검사 ${MARK}`, passed: true }], sales: { label: `실적 ${MARK}`, value: null },
};
const who = (role: StaffIdentity['role']): StaffIdentity => ({ actor: '00000000-0000-4000-8000-000000000001', session: '10000000-0000-4000-8000-000000000001', token: 't', role });

function deps(identity: StaffIdentity | Error, mode: 'supabase' | 'disabled' = 'supabase') {
  const n = { staff: 0, snap: 0 };
  return {
    n,
    d: {
      mode: () => mode,
      requireStaff: async () => { n.staff++; if (identity instanceof Error) throw identity; return identity; },
      loadSnapshot: async () => { n.snap++; return SNAP; },
      now: () => new Date('2026-11-16T03:00:00+09:00'),
    },
  };
}

/** 요소 트리의 모든 문자열(자식·props·중첩 객체) */
function strings(node: unknown, out: string[] = [], seen = new Set<unknown>()): string[] {
  if (node == null || typeof node === 'boolean') return out;
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
  if (typeof node !== 'object' || seen.has(node)) return out;
  seen.add(node);
  if (Array.isArray(node)) { for (const x of node) strings(x, out, seen); return out; }
  const el = node as { type?: unknown; props?: unknown };
  if ('props' in el && 'type' in el) {
    if (typeof el.type === 'function') {
      // 서버 컴포넌트를 실제로 펼쳐 렌더 결과까지 확인한다
      strings((el.type as (p: unknown) => unknown)(el.props), out, seen);
    }
    strings(el.props, out, seen);
    return out;
  }
  for (const v of Object.values(node)) strings(v, out, seen);
  return out;
}
const element = (r: Awaited<ReturnType<typeof renderProgress>>) => { assert.ok('element' in r); return r.element as ReactElement; };

test('P1 인증 꺼짐: 판정·스냅샷 호출 없이 잠금, 상태 내용 없음', async () => {
  const x = deps(who('owner'), 'disabled');
  const el = element(await renderProgress(x.d));
  assert.equal(el.type, ProgressLocked);
  assert.deepEqual(x.n, { staff: 0, snap: 0 });
  assert.ok(!strings(el).join(' ').includes(MARK));
});

test('P2 미인증 → 로그인으로(스냅샷 미로딩)', async () => {
  const x = deps(new StaffAuthError(401, 'UNAUTHENTICATED'));
  assert.deepEqual(await renderProgress(x.d), { redirect: '/admin/login' });
  assert.equal(x.n.snap, 0);
});

test('P3 owner 외 역할·MFA 미완료·DB 거부·장애: 거부 화면, 스냅샷 미로딩·미포함, 원문 오류 없음', async () => {
  const cases: (StaffIdentity | Error)[] = [
    who('counselor'), who('reviewer'), who('policy_editor'),
    new StaffAuthError(403, 'MFA_REQUIRED'), new StaffAuthError(403, 'FORBIDDEN'),
    new StaffSessionUnavailable(), new Error('private-db-detail'),
  ];
  for (const c of cases) {
    const x = deps(c);
    const el = element(await renderProgress(x.d));
    assert.equal(el.type, ProgressLocked, String(c));
    assert.equal(x.n.snap, 0);
    const text = strings(el).join(' ');
    assert.ok(!text.includes(MARK) && !text.includes('private-db-detail'), text);
  }
});

test('P4 owner만 정상 표시: 단계·완료·다음·검사·실적 미확인·확인 시각(실시간 아님)', async () => {
  const x = deps(who('owner'));
  const el = element(await renderProgress(x.d));
  assert.equal(el.type, ProgressView);
  assert.equal(x.n.snap, 1);
  const text = strings(el).join(' ');
  for (const s of [`단계 ${MARK}`, `완료 ${MARK}`, `다음 ${MARK}`, `검사 ${MARK}`, '통과', '미확인', '실시간 아님', '02:03']) assert.ok(text.includes(s), s);
  assert.ok(!text.includes('갱신 안 됨'));
});

test('P5 오래된 스냅샷은 갱신 안 됨 표시, 미래·형식 오류 시각도 오래된 것으로', () => {
  const now = new Date('2026-11-18T03:00:00+09:00');
  assert.equal(isStale(SNAP, now), true);
  assert.equal(isStale(SNAP, new Date('2026-11-16T03:00:00+09:00')), false);
  assert.equal(isStale({ ...SNAP, checkedAt: '2026-12-01T00:00:00+09:00' }, now), true);
  assert.equal(isStale({ ...SNAP, checkedAt: 'not-a-date' }, now), true);
  const text = strings({ type: ProgressView, props: { snapshot: SNAP, now } }).join(' ');
  assert.ok(text.includes('24시간 넘게 갱신 안 됨'));
});

test('P6 실제 스냅샷 파일: 내부 정보 형식(커밋 해시·URL·토큰·키·금액) 미포함, 실적은 미확인', async () => {
  const req = createRequire(import.meta.url);
  let snap: ProgressSnapshot;
  try { req.resolve('server-only'); snap = (await import('../../src/server/admin/progressSnapshot')).PROGRESS_SNAPSHOT; } catch {
    // server-only 미설치 환경: 파일을 정적으로 읽어 같은 검사를 한다
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/server/admin/progressSnapshot.ts', 'utf8');
    for (const bad of [/\b[0-9a-f]{7,40}\b/, /https?:\/\//, /github|supabase\.co|postgres:/i, /원\b|₩|수수료|매출/]) {
      assert.ok(!bad.test(src.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')), String(bad));
    }
    return;
  }
  const text = JSON.stringify(snap);
  for (const bad of [/\b[0-9a-f]{7,40}\b/, /https?:\/\//, /github|supabase\.co|postgres:/i, /원\b|₩|수수료|매출/]) assert.ok(!bad.test(text), String(bad));
  assert.equal(snap.sales.value, null);
});

let realNext = true;
try { createRequire(import.meta.url).resolve('next/package.json'); } catch { realNext = false; }

test('P7 실제 page.tsx: 인증 기본값(꺼짐)이면 잠금 요소, 스냅샷 문자열 없음', { skip: realNext ? false : 'next 미설치 — CI·Mac에서 실행' }, async () => {
  const saved = process.env.ADMIN_AUTH_MODE;
  delete process.env.ADMIN_AUTH_MODE;
  try {
    const page = await import('../../src/app/admin/progress/page');
    const el = (await page.default()) as ReactElement;
    assert.equal(el.type, ProgressLocked);
    const real = (await import('../../src/server/admin/progressSnapshot')).PROGRESS_SNAPSHOT;
    const text = strings(el).join(' ');
    assert.ok(!text.includes(real.stage) && !real.recentDone.some((t) => text.includes(t)));
    assert.deepEqual(page.metadata.robots, { index: false, follow: false, nocache: true });
    assert.equal(page.dynamic, 'force-dynamic');
  } finally {
    if (saved !== undefined) process.env.ADMIN_AUTH_MODE = saved;
  }
});
