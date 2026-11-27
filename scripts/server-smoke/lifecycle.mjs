// server smoke 서버 수명 관리(PM 6917234887). run.mjs가 실제로 쓰는 함수이며, 단위 시험이 가짜 자식·시계로 같은 함수를 실행한다.
// 규칙
// - spawn 직후 자식을 등록한다(준비 대기 전). 신호·시간 초과·검사 실패 모두 같은 stop()을 거친다.
// - stop()은 멱등·직렬: 동시에 여러 번 불러도 SIGTERM은 한 번, 결과는 같다.
// - 종료 이벤트를 확인하지 못하면 핸들을 버리지 않고(current 유지) broken으로 표시한다. 이후 start()는 새 서버를 띄우지 않는다.
// - 준비 대기 중 stop()이 불리면 대기를 즉시 끝낸다.

/**
 * @param {{
 *   spawnChild: (extra: Record<string,string>) => { kill: (sig: string) => void, onExit: (cb: () => void) => void },
 *   probe: (handle: object) => Promise<boolean>,
 *   sleep: (ms: number) => Promise<void>,
 *   now: () => number,
 *   readyMs: number,
 *   termWaitMs?: number,
 *   killWaitMs?: number,
 *   pollMs?: number,
 * }} deps
 */
export function createServerManager(deps) {
  const termWaitMs = deps.termWaitMs ?? 5_000;
  const killWaitMs = deps.killWaitMs ?? 5_000;
  const pollMs = deps.pollMs ?? 300;
  let current = null;
  let stopping = null;
  let broken = false;
  let spawned = 0;

  const waitExit = (h, ms) => Promise.race([h.exitPromise.then(() => true), deps.sleep(ms).then(() => h.exited)]);

  async function start(extra = {}) {
    if (broken) return { ok: false, reason: 'previous_stop_failed', ready: false };
    if (current) return { ok: false, reason: 'already_running', ready: false };
    const child = deps.spawnChild(extra);
    spawned += 1;
    const h = { child, exited: false, abort: false };
    h.exitPromise = new Promise((resolve) => child.onExit(() => { h.exited = true; resolve(); }));
    current = h; // 준비 대기 전에 등록: 이 시점부터 신호·시간 초과 정리 대상
    const t0 = deps.now();
    let ready = false;
    while (deps.now() - t0 < deps.readyMs && !h.exited && !h.abort) {
      let ok = false;
      try { ok = await deps.probe(h); } catch { ok = false; }
      if (ok) { ready = true; break; }
      await deps.sleep(pollMs);
    }
    if (h.abort) ready = false;
    return { ok: true, ready, exited: h.exited, handle: h };
  }

  function stop() {
    if (stopping) return stopping;
    stopping = (async () => {
      const h = current;
      if (!h) return true;
      h.abort = true;
      if (!h.exited) {
        try { h.child.kill('SIGTERM'); } catch { /* 이미 종료 */ }
        if (!(await waitExit(h, termWaitMs))) {
          try { h.child.kill('SIGKILL'); } catch { /* 이미 종료 */ }
          await waitExit(h, killWaitMs);
        }
      }
      if (h.exited) {
        current = null;
        return true;
      }
      broken = true; // 종료 미확인: 핸들을 유지하고 새 서버를 띄우지 않는다
      return false;
    })();
    const p = stopping;
    p.finally(() => { if (stopping === p) stopping = null; });
    return p;
  }

  return {
    start,
    stop,
    get current() { return current; },
    get broken() { return broken; },
    get spawned() { return spawned; },
  };
}

/**
 * 신호·전체 시간 초과용 중단 처리(멱등). 서버 종료를 확인했을 때만 격리 루트를 정리하고, 결과와 관계없이 실패로 끝낸다.
 * @param {{ manager: ReturnType<typeof createServerManager>, report: (name: string, ok: boolean, note?: string) => void,
 *           cleanupRoot: () => void, finish: (code: number, status: string) => void }} deps
 */
export function createAbortHandler(deps) {
  let running = null;
  return (reason) => {
    if (running) return running;
    running = (async () => {
      deps.report(reason, false);
      const ok = await deps.manager.stop();
      deps.report('서버 정리(종료 이벤트 확인)', ok, ok ? '' : '종료 미확인');
      if (ok) deps.cleanupRoot();
      else deps.report('격리 루트 정리', false, '서버 종료 미확인으로 보류');
      deps.finish(1, `실패(${reason})`);
    })();
    return running;
  };
}

/** 마지막 정리: 종료 확인 시에만 루트 정리. 정리 실패는 원래 성공이어도 실패로 만든다 */
export async function finalCleanup({ manager, report, cleanupRoot }) {
  const had = manager.current !== null;
  const ok = await manager.stop();
  if (had) report('서버 정리(종료 이벤트 확인)', ok, ok ? '' : '종료 미확인');
  if (ok) cleanupRoot();
  else report('격리 루트 정리', false, '서버 종료 미확인으로 보류');
  return ok;
}
