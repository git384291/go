import 'server-only';
// 로컬 도구 실행 helper (PM 6954300094 3·4절). 영상 renderer와 probe가 같이 쓰는 **유일한 프로세스 실행 경로**다.
//
// 역할(작은 내부 helper로 둔 이유): ffmpeg·ffprobe·fc-match·cat을 같은 소유권·마감·정리 규칙으로 실행해야 하므로
// renderer와 probe에 같은 코드를 두 벌 두지 않는다. 명령 조립은 하지 않는다(호출자가 고정 인자 배열을 넘긴다).
//
// - 실행: spawn(고정 실행 파일, 인자 배열, {shell:false, detached:true, stdin ignore, 최소 고정 env, 자기 cwd}).
// - 소유권: spawn 직후 이 Owner에 등록한다. 종료(exit/close)를 확인하기 전에는 등록을 지우지 않는다.
// - 마감: 호출자의 **절대 마감**(deadlineAt)만 쓴다. 단계마다 새 시간을 주지 않는다. 마감이 지났으면 spawn 0.
// - 중단(시간 초과·출력 한도 초과·정리): 자기 프로세스 그룹에만 SIGKILL을 1회 보낸다(PID 전체 검색 kill 없음).
//   그 뒤 killWaitMs 안에 종료가 확인되지 않으면 CLEANUP_FAILED이고, 이 Owner는 **새 기동을 거부**한다.
//   늦게 도착한 종료는 등록에서 지워 정리에 반영하지만, 이미 정한 실패 결과를 성공으로 바꾸지 않는다.
// - 출력: stdout·stderr를 각각 상한까지만 모은다. 초과하면 즉시 중단한다. stderr 원문은 호출자 내부 판정용이며
//   이 모듈은 고정 코드만 실패 사유로 돌려준다.
// - 환경: process.env를 읽거나 상속하지 않는다(키·DB URL·프록시·인증 설정 비상속).

/** 최소 고정 env. 실제 환경을 상속하지 않는다 */
export const FIXED_CHILD_ENV: Readonly<Record<string, string>> = Object.freeze({ LC_ALL: 'C.UTF-8' });

export type FixedSpawnOptions = {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly shell: false;
  readonly detached: true;
  readonly stdio: readonly ['ignore', 'pipe', 'pipe'];
  readonly windowsHide: true;
};

type DataSource = { on(ev: 'data', l: (chunk: Uint8Array) => void): unknown };

/** spawn이 돌려주는 자식(실제 ChildProcess 또는 시험용 가짜)의 최소 형태 */
export type ChildLike = {
  readonly pid?: number | undefined;
  readonly stdout: DataSource | null;
  readonly stderr: DataSource | null;
  on(ev: 'exit', l: (code: number | null, signal: string | null) => void): unknown;
  on(ev: 'error', l: (e: unknown) => void): unknown;
};

export type ProcessDeps = {
  readonly spawn: (file: string, args: readonly string[], opts: FixedSpawnOptions) => ChildLike;
  /** 자기 프로세스 그룹(-pid)에 SIGKILL. 그룹이 이미 없으면(ESRCH) 조용히 끝나야 한다 */
  readonly killGroup: (pid: number) => void;
  readonly now: () => number;
  readonly setTimer: (fn: () => void, ms: number) => unknown;
  readonly clearTimer: (h: unknown) => void;
  /** 종료 신호 뒤 종료 확인을 기다리는 별도 한도(ms) */
  readonly killWaitMs: number;
};

export type RunFailure = 'BLOCKED' | 'TIMEOUT' | 'SPAWN_FAILED' | 'STDIO_TOO_LARGE' | 'CLEANUP_FAILED';

export type RunOutcome =
  | { readonly kind: 'exit'; readonly code: number | null; readonly signal: string | null; readonly stdout: Uint8Array; readonly stderr: string }
  | { readonly kind: 'fail'; readonly reason: RunFailure };

export type RunSpec = {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly deadlineAt: number;
  readonly maxStdout: number;
  readonly maxStderr: number;
};

type Rec = {
  readonly pid: number | undefined;
  exited: boolean;
  killSent: boolean;
  reason: RunFailure | null;
  readonly waiters: Array<() => void>;
};

/**
 * 한 작업(렌더 1회)이 소유하는 자식 프로세스 묶음.
 * - spawnCount: 실제 spawn 호출 수(시험·증거용)
 * - blocked: 종료를 확인하지 못한 자식이 있었으면 true. 이후 run은 spawn 없이 BLOCKED
 */
export class ProcessOwner {
  private readonly live = new Set<Rec>();
  spawnCount = 0;
  killCalls = 0;
  blocked = false;

  constructor(private readonly deps: ProcessDeps) {}

  /** 아직 종료가 확인되지 않은 자식 수 */
  get liveCount(): number {
    return this.live.size;
  }

  async run(spec: RunSpec): Promise<RunOutcome> {
    const d = this.deps;
    if (this.blocked) return { kind: 'fail', reason: 'BLOCKED' };
    if (!(d.now() < spec.deadlineAt)) return { kind: 'fail', reason: 'TIMEOUT' }; // 마감 뒤 새 process 0
    const opts: FixedSpawnOptions = Object.freeze({
      cwd: spec.cwd, env: FIXED_CHILD_ENV, shell: false, detached: true, stdio: Object.freeze(['ignore', 'pipe', 'pipe'] as const), windowsHide: true,
    });
    let child: ChildLike;
    this.spawnCount++;
    try {
      child = d.spawn(spec.file, Object.freeze([...spec.args]), opts);
    } catch {
      return { kind: 'fail', reason: 'SPAWN_FAILED' };
    }
    let pid: number | undefined;
    try {
      pid = typeof child.pid === 'number' && Number.isSafeInteger(child.pid) && child.pid > 0 ? child.pid : undefined;
    } catch {
      pid = undefined;
    }
    // spawn 직후 등록(준비 대기·출력 수집보다 먼저)
    const rec: Rec = { pid, exited: false, killSent: false, reason: null, waiters: [] };
    this.live.add(rec);

    const out: Uint8Array[] = [];
    const err: Uint8Array[] = [];
    let outN = 0;
    let errN = 0;
    let exitCode: number | null = null;
    let exitSignal: string | null = null;
    let spawnError = false;

    const markExited = () => {
      if (rec.exited) return;
      rec.exited = true;
      this.live.delete(rec);
      for (const w of rec.waiters.splice(0)) w();
    };
    try {
      child.stdout?.on('data', (c) => {
        if (rec.reason) return;
        outN += c.byteLength;
        if (outN > spec.maxStdout) this.terminate(rec, 'STDIO_TOO_LARGE');
        else out.push(c);
      });
      child.stderr?.on('data', (c) => {
        if (rec.reason) return;
        errN += c.byteLength;
        if (errN > spec.maxStderr) this.terminate(rec, 'STDIO_TOO_LARGE');
        else err.push(c);
      });
      child.on('exit', (code, signal) => {
        exitCode = typeof code === 'number' ? code : null;
        exitSignal = typeof signal === 'string' ? signal : null;
        markExited();
      });
      child.on('error', () => {
        // pid가 없으면 실행되지 않은 것(ENOENT 등)이다. pid가 있으면 exit를 계속 기다린다
        if (rec.pid === undefined) {
          spawnError = true;
          markExited();
        }
      });
    } catch {
      this.terminate(rec, 'SPAWN_FAILED');
    }

    const timer = d.setTimer(() => this.terminate(rec, 'TIMEOUT'), Math.max(0, spec.deadlineAt - d.now()));
    try {
      await this.waitExitOrKillWindow(rec);
    } finally {
      d.clearTimer(timer);
    }

    if (!rec.exited) {
      // 종료 확인 실패: 핸들은 live에 남겨 두고(늦은 종료 반영), 이 Owner는 새 기동을 거부한다
      this.blocked = true;
      return { kind: 'fail', reason: 'CLEANUP_FAILED' };
    }
    if (rec.reason) return { kind: 'fail', reason: rec.reason };
    if (spawnError) return { kind: 'fail', reason: 'SPAWN_FAILED' };
    return {
      kind: 'exit',
      code: exitCode,
      signal: exitSignal,
      stdout: concat(out, outN),
      stderr: new TextDecoder('utf-8', { fatal: false }).decode(concat(err, errN)),
    };
  }

  /** 자기 그룹에만 SIGKILL 1회(멱등). 실패해도 다른 PID를 찾지 않는다 */
  private terminate(rec: Rec, reason: RunFailure): void {
    if (rec.exited) return;
    if (!rec.reason) rec.reason = reason;
    if (rec.killSent) return;
    rec.killSent = true;
    const wake = rec.waiters.slice();
    if (rec.pid !== undefined) {
      this.killCalls++;
      try {
        this.deps.killGroup(rec.pid);
      } catch {
        // 신호 실패: 종료 확인 대기에서 걸러진다(성공으로 보지 않음)
      }
    }
    for (const w of wake) w();
  }

  /** exit 또는 (중단 신호 뒤) killWaitMs 경과까지 기다린다 */
  private waitExitOrKillWindow(rec: Rec): Promise<void> {
    return new Promise<void>((resolve) => {
      let killTimer: unknown = null;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (killTimer !== null) this.deps.clearTimer(killTimer);
        resolve();
      };
      const check = () => {
        if (settled) return;
        if (rec.exited) return finish();
        if (rec.killSent && killTimer === null) {
          killTimer = this.deps.setTimer(finish, this.deps.killWaitMs);
          rec.waiters.push(finish);
          return;
        }
        rec.waiters.push(check);
      };
      check();
    });
  }

  /**
   * 정리: 남은 자식 전부에 중단을 보내고 종료 확인을 기다린다(멱등, 직렬).
   * 모두 종료가 확인되면 true. 하나라도 남으면 false(정리 완료로 주장하지 않는다)
   */
  async settleAll(): Promise<boolean> {
    for (const rec of [...this.live]) {
      this.terminate(rec, 'CLEANUP_FAILED');
      await this.waitExitOrKillWindow(rec);
    }
    if (this.live.size > 0) this.blocked = true;
    return this.live.size === 0;
  }
}

function concat(parts: Uint8Array[], n: number): Uint8Array {
  const b = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    b.set(p, o);
    o += p.byteLength;
  }
  return b;
}
