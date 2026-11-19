// PM 6917234887: server smoke 수명 관리(scripts/server-smoke/lifecycle.mjs) 실패 경로 시험.
// run.mjs가 실제로 쓰는 함수를 가짜 자식·시계로 실행한다(실제 프로세스·DB·네트워크 없음). 기능 검사 36행과 별도 집계.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAbortHandler, createServerManager, finalCleanup } from '../../scripts/server-smoke/lifecycle.mjs';

type Mode = 'term' | 'kill' | 'never';
function fakeWorld(opts: { modes?: Mode[]; readyAfter?: number | null } = {}) {
  let clock = 0;
  const kills: string[] = [];
  const children: { exit: () => void }[] = [];
  let probes = 0;
  const manager = createServerManager({
    spawnChild: () => {
      const mode = opts.modes?.[children.length] ?? 'term';
      let cb: (() => void) | null = null;
      let done = false;
      const exit = () => {
        if (done) return;
        done = true;
        queueMicrotask(() => cb?.());
      };
      children.push({ exit });
      return {
        kill: (sig: string) => {
          kills.push(sig);
          if ((mode === 'term' && sig === 'SIGTERM') || (mode !== 'never' && sig === 'SIGKILL')) exit();
        },
        onExit: (f: () => void) => { cb = f; },
      };
    },
    probe: async () => {
      probes++;
      return opts.readyAfter != null && probes >= opts.readyAfter;
    },
    sleep: (ms: number) => new Promise<void>((r) => setImmediate(() => { clock += ms; r(); })),
    now: () => clock,
    readyMs: 30_000,
  });
  return { manager, kills, children, probes: () => probes };
}

test('M1 정상 순차: 시작→준비→종료(SIGTERM 1회)→다음 시작→종료', async () => {
  const w = fakeWorld({ readyAfter: 2 });
  const a = await w.manager.start();
  assert.deepEqual([a.ok, a.ready], [true, true]);
  assert.equal(await w.manager.stop(), true);
  assert.equal(w.manager.current, null);
  const b = await w.manager.start();
  assert.equal(b.ready, true);
  assert.equal(await w.manager.stop(), true);
  assert.deepEqual([w.manager.spawned, w.kills.join(',')], [2, 'SIGTERM,SIGTERM']);
});

test('M2 spawn 직후 등록: 준비 대기 중 중단 신호 → 자식 종료(kill 1), 대기 즉시 종료, 루트 정리 1회', async () => {
  const w = fakeWorld({ readyAfter: null });
  const pending = w.manager.start();
  await new Promise((r) => setImmediate(r));
  assert.notEqual(w.manager.current, null, '준비 전에도 정리 대상');
  let cleanups = 0;
  const finished: number[] = [];
  const rows: [string, boolean][] = [];
  const abort = createAbortHandler({ manager: w.manager, report: (n: string, ok: boolean) => rows.push([n, ok]), cleanupRoot: () => { cleanups++; }, finish: (c: number) => finished.push(c) });
  await Promise.all([abort('신호 SIGTERM'), abort('신호 SIGINT')]); // 중복 신호
  const s = await pending;
  assert.equal(s.ready, false);
  assert.deepEqual([w.manager.spawned, w.kills.length, cleanups, finished.join()], [1, 1, 1, '1']);
  assert.ok(rows.some(([n, ok]) => n.startsWith('서버 정리') && ok));
});

test('M3 SIGTERM 무시 → SIGKILL로 종료 확인', async () => {
  const w = fakeWorld({ modes: ['kill'], readyAfter: 1 });
  await w.manager.start();
  assert.equal(await w.manager.stop(), true);
  assert.equal(w.kills.join(','), 'SIGTERM,SIGKILL');
});

test('M4 종료 실패: 핸들 유지·broken, 후속 기동 0, 다시 stop해도 성공으로 바뀌지 않음, 루트 정리 보류', async () => {
  const w = fakeWorld({ modes: ['never'], readyAfter: 1 });
  await w.manager.start();
  assert.equal(await w.manager.stop(), false);
  assert.notEqual(w.manager.current, null, '핸들을 버리지 않음');
  assert.equal(w.manager.broken, true);
  const next = await w.manager.start();
  assert.deepEqual([next.ok, next.reason, w.manager.spawned], [false, 'previous_stop_failed', 1]);
  let cleanups = 0;
  const rows: [string, boolean, string?][] = [];
  const ok = await finalCleanup({ manager: w.manager, report: (n: string, k: boolean, note?: string) => rows.push([n, k, note]), cleanupRoot: () => { cleanups++; } });
  assert.equal(ok, false);
  assert.equal(cleanups, 0, '종료 미확인이면 루트 정리 안 함');
  assert.ok(rows.some(([n, k]) => n === '격리 루트 정리' && k === false));
  assert.ok(rows.every(([, k]) => k === false), '정리 성공으로 기록하지 않음');
});

test('M5 동시 stop은 직렬·멱등(SIGTERM 1회, 같은 결과), 시간 초과 중단도 같은 경로', async () => {
  const w = fakeWorld({ readyAfter: 1 });
  await w.manager.start();
  const [a, b, c] = await Promise.all([w.manager.stop(), w.manager.stop(), w.manager.stop()]);
  assert.deepEqual([a, b, c, w.kills.length], [true, true, true, 1]);
  const t = fakeWorld({ modes: ['never'], readyAfter: 1 });
  await t.manager.start();
  let cleanups = 0;
  const codes: number[] = [];
  const abort = createAbortHandler({ manager: t.manager, report: () => {}, cleanupRoot: () => { cleanups++; }, finish: (code: number) => codes.push(code) });
  await abort('전체 시간 제한 300초 초과');
  await abort('신호 SIGINT');
  assert.deepEqual([codes.join(), cleanups], ['1', 0], '종료 미확인 → 실패 1회, 루트 정리 보류');
});

test('M6 run.mjs가 이 모듈을 실제로 사용하고, 헤더의 전체 제한 설명이 300초와 일치', () => {
  const src = readFileSync(new URL('../../scripts/server-smoke/run.mjs', import.meta.url), 'utf8');
  assert.match(src, /from '\.\/lifecycle\.mjs'/);
  assert.match(src, /createServerManager\(/);
  assert.match(src, /createAbortHandler\(/);
  assert.match(src, /finalCleanup\(/);
  assert.ok(!/\bspawn\([^)]*\)[\s\S]{0,200}server\.kill/.test(src), '자체 kill 경로 없음');
  assert.match(src, /const TOTAL_MS = 300_000/);
  assert.match(src, /전체 300초 제한/);
  assert.ok(!/전체 120초/.test(src));
});
