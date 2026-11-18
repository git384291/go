import 'server-only';
// 30초 설명형 **무음 화면 시안** renderer (PM 6983216833). 생성·음성·업로드·외부 접속 없음.
//
// - 입력은 정확히 { variant: 'general_internet_v1' }. 계획은 explainerStoryboard의 고정 상수를 검증한 스냅샷만 쓴다.
// - 실행 규칙은 18초 renderer(ffmpegRenderer)와 같다: 같은 boundedProcess, 같은 격리 접두(unshare -n + prlimit, 주소 공간만 2GiB — EX_LIMITS),
//   같은 고정 실행 파일, 같은 폰트 파일 크기·SHA-256 확인, 같은 실측 폭 판정, 같은 정리 규칙. 18초 renderer 동작은 바꾸지 않았다.
// - 그래픽: 각 그림(sprite)은 고정 도형 목록을 geq 한 번으로 1프레임 그린 뒤 loop로 반복한다. 외부 이미지·폰트·음원 입력 0.
// - 문구는 자기 임시 디렉터리의 e<i>.txt로만 넘긴다(drawtext textfile·expansion=none·reload=0). 인자·필터에 문구 0.
// - 결과는 '내부 검토용 무음 화면 시안'이다. 음성·음성 동기·판매용 완성 판정이 아니다.
import { lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProcessOwner, type ProcessDeps } from './boundedProcess';
import {
  CleanupStop, FONT_BYTES, FONT_FILE, FONT_SHA256, LIMITS, MAX_FRAME_BYTES, MAX_TOTAL_MS, MIN_TOTAL_MS, SAFE_DIR, Stop, TMP_PREFIX, TOOLS,
  need, onlyLoopback, parseBbox, readOwnFile, realFs, writeOwnFile,
  type FrameImage, type RenderCode, type RendererFs,
} from './ffmpegRenderer';
import { buildExplainerStoryboard, EX_DURATION_SEC, EX_FPS, EX_FRAMES, EX_HEIGHT, EX_WIDTH, PAL, type ExplainerPlan, type Prim, type Sprite, type TextItem } from './explainerStoryboard';
import { isFastStart, MAX_VIDEO_BYTES, probeExplainerVideo, type ProbeReject, type ProbeReport } from './videoProbe';

/**
 * 30초 시안 전용 자원 제한. 18초 renderer의 WRAP_ARGS·LIMITS는 그대로 두고, 주소 공간만 2GiB로 둔다.
 * 근거(Claude 세션 실측): 문구 33개를 그리는 drawtext가 각자 폰트를 열어 가상 메모리 최대 약 1.5GiB(filter_complex_threads 1)를
 * 쓴다. 1GiB에서는 측정 단계부터 메모리 할당 실패. 실제 상주 메모리는 약 0.6GiB. CPU 60초·파일 16MiB·프로세스 64는 같다.
 */
export const EX_LIMITS = Object.freeze({ ...LIMITS, addressSpace: 2 * 1024 * 1024 * 1024 });
export const EX_WRAP_ARGS: readonly string[] = Object.freeze([
  '-n', '--', TOOLS.prlimit,
  `--as=${EX_LIMITS.addressSpace}`, `--cpu=${EX_LIMITS.cpuSeconds}`, `--fsize=${EX_LIMITS.fileSize}`, `--nproc=${EX_LIMITS.nproc}`, '--',
]);
/** /proc/self/limits에 EX_LIMITS가 soft·hard 모두 적용됐는지 */
export function exLimitsApplied(text: string): boolean {
  const want: [string, number][] = [
    ['Max cpu time', EX_LIMITS.cpuSeconds], ['Max file size', EX_LIMITS.fileSize], ['Max processes', EX_LIMITS.nproc], ['Max address space', EX_LIMITS.addressSpace],
  ];
  return want.every(([name, v]) => new RegExp(`^${name}\\s+${v}\\s+${v}\\s`, 'm').test(text));
}

const FADE_IN = 0.4;
const FADE_OUT = 0.35;
const SLIDE = 0.6;
/** 대표 프레임: 장면마다 1장(모션이 끝난 뒤) */
export const EX_FRAME_TIMES = Object.freeze([3.2, 9.6, 16.4, 23.6, 28.6]);
const EX_FRAME_WIDTHS = Object.freeze([720, 390, 320]);

export type TextMeasure = { readonly id: string; readonly width: number; readonly height: number; readonly maxW: number };

export type ExplainerResult =
  | {
      readonly ok: true;
      readonly code: 'RENDERED';
      readonly kind: 'silent_visual_draft';
      readonly video: Uint8Array;
      readonly probe: ProbeReport;
      readonly faststart: true;
      readonly texts: readonly TextMeasure[];
      readonly frames: readonly FrameImage[];
      readonly cleanup: 'OK';
      readonly spawned: number;
    }
  | {
      readonly ok: false;
      readonly code: Exclude<RenderCode, 'RENDERED'> | 'INVALID_PLAN';
      readonly reason?: ProbeReject;
      readonly primary?: Exclude<RenderCode, 'RENDERED' | 'CLEANUP_FAILED'>;
      readonly cleanup: 'OK' | 'FAILED' | 'NOT_NEEDED';
      readonly spawned: number;
    };

export type ExplainerDeps = ProcessDeps & {
  readonly fs?: Partial<RendererFs>;
  readonly totalTimeoutMs: number;
  readonly frames?: boolean;
};

// ── 필터 조립(순수) ──
const int = (n: number) => {
  if (!Number.isSafeInteger(n) || Math.abs(n) > 100_000) throw new Error('layout');
  return String(n);
};
/** 시간(초) 문자열: 소수 둘째 자리까지 */
const sec = (n: number) => {
  if (!Number.isFinite(n) || n < 0 || n > 31) throw new Error('time');
  return String(Math.round(n * 100) / 100);
};
const COLOR_RE = /^0x[0-9a-f]{6}$/;
const rgb = (c: string): [number, number, number] => {
  if (!COLOR_RE.test(c)) throw new Error('color');
  const v = Number.parseInt(c.slice(2), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};
/** 필터 값 인용: 작은따옴표로 묶고 쉼표는 \, (18초 renderer의 enable 표기와 같은 규칙) */
const q = (expr: string) => {
  if (/['\\:[\]]/.test(expr)) throw new Error('expr');
  return `'${expr.replace(/,/g, '\\,')}'`;
};

const PX = '(X+0.5)';
const PY = '(Y+0.5)';
/** 부호 거리(음수=안쪽) */
function sdf(p: Prim): string {
  switch (p.k) {
    case 'rect':
    case 'outline': {
      const hw = p.w / 2 - p.r;
      const hh = p.h / 2 - p.r;
      const qx = `(abs(${PX}-${p.x + p.w / 2})-${hw})`;
      const qy = `(abs(${PY}-${p.y + p.h / 2})-${hh})`;
      const d = `(hypot(max(${qx},0),max(${qy},0))+min(max(${qx},${qy}),0)-${p.r})`;
      return p.k === 'rect' ? d : `(abs(${d}+${p.t / 2})-${p.t / 2})`;
    }
    case 'circle':
      return `(hypot(${PX}-${p.cx},${PY}-${p.cy})-${p.r})`;
    case 'ring':
    case 'arc':
      return `(abs(hypot(${PX}-${p.cx},${PY}-${p.cy})-${p.r})-${p.t / 2})`;
    case 'line': {
      const vx = p.x2 - p.x1;
      const vy = p.y2 - p.y1;
      const l2 = vx * vx + vy * vy || 1;
      const h = `clip(((${PX}-${p.x1})*${vx}+(${PY}-${p.y1})*${vy})/${l2},0,1)`;
      return `(hypot(${PX}-${p.x1}-${h}*${vx},${PY}-${p.y1}-${h}*${vy})-${p.t / 2})`;
    }
  }
}
/** 덮임 비율 0~1(가장자리 1px 부드럽게) × 불투명도 */
function coverage(p: Prim): string {
  let c = `clip(0.5-${sdf(p)},0,1)`;
  if (p.k === 'arc') c += `*clip(${p.cy}-${PY}-abs(${PX}-${p.cx})+0.5,0,1)`; // 위쪽 90° 부채꼴만
  const o = p.o ?? 100;
  return o === 100 ? c : `${c}*${o / 100}`;
}
/** 한 sprite의 geq 4면 식: 도형을 순서대로 겹쳐 칠한다(premultiplied over) */
export function spriteGeq(sp: Sprite): { r: string; g: string; b: string; a: string } {
  const covs = sp.prims.map(coverage);
  const plane = (ch: 0 | 1 | 2 | 3) => {
    const parts = ['st(0,0)', 'st(1,0)'];
    sp.prims.forEach((p, i) => {
      parts.push(`st(2,${covs[i]})`);
      if (ch !== 3) parts.push(`st(0,${rgb(p.c)[ch]}*ld(2)+ld(0)*(1-ld(2)))`);
      parts.push('st(1,ld(2)+ld(1)*(1-ld(2)))');
    });
    parts.push(ch < 3 ? 'if(gt(ld(1),0),ld(0)/ld(1),0)' : 'ld(1)*255');
    return parts.join(';');
  };
  return { r: plane(0), g: plane(1), b: plane(2), a: plane(3) };
}

const ease = (tin: number) => `pow(1-clip((t-${sec(tin)})/${SLIDE},0,1),3)`;
const visible = (tin: number, tout: number) => `between(t,${sec(tin)},${sec(Math.min(EX_DURATION_SEC, tout + FADE_OUT))})`;

/** 렌더 filter_complex. 입력 [0:v]=고정 lavfi 배경. 문구는 e<i>.txt */
export function buildExplainerFilter(plan: ExplainerPlan): { graph: string; files: { name: string; text: string }[] } {
  const chains: string[] = [];
  let last = '0:v';
  plan.sprites.forEach((sp, i) => {
    const g = spriteGeq(sp);
    const fades = [`fade=t=in:st=${sec(sp.tin)}:d=${FADE_IN}:alpha=1`];
    if (sp.tout < EX_DURATION_SEC) fades.push(`fade=t=out:st=${sec(sp.tout)}:d=${FADE_OUT}:alpha=1`);
    chains.push(
      `color=c=black@0:s=${int(sp.w)}x${int(sp.h)}:r=${EX_FPS},trim=end_frame=1,format=rgba,` +
        `geq=r=${q(g.r)}:g=${q(g.g)}:b=${q(g.b)}:a=${q(g.a)},` +
        `loop=loop=${EX_FRAMES - 1}:size=1,setpts=N/${EX_FPS}/TB,${fades.join(',')}[s${i}]`,
    );
    const x = sp.dx ? `${sp.x}+${sp.dx}*${ease(sp.tin)}` : String(int(sp.x));
    let y = sp.dy ? `${sp.y}+${sp.dy}*${ease(sp.tin)}` : String(int(sp.y));
    if (sp.bob) y += `+${sp.bob}*sin(2*PI*(t-${sec(sp.tin)})/2.4)`;
    const out = `v${i}`;
    chains.push(`[${last}][s${i}]overlay=x=${q(x)}:y=${q(y)}:enable=${q(visible(sp.tin, sp.tout))}:eval=frame[${out}]`);
    last = out;
  });
  const files: { name: string; text: string }[] = [];
  const dt = plan.texts.map((tx, i) => {
    const name = `e${i}.txt`;
    files.push({ name, text: tx.text });
    const x = tx.x === -1 ? '(w-text_w)/2' : String(int(tx.x));
    const y = tx.dy ? `${tx.y}+${tx.dy}*${ease(tx.tin)}` : String(int(tx.y));
    const fadeOut = tx.tout < EX_DURATION_SEC ? `*clip((${sec(tx.tout + FADE_OUT)}-t)/${FADE_OUT},0,1)` : '';
    const alpha = `clip((t-${sec(tx.tin)})/${FADE_IN},0,1)${fadeOut}`;
    rgb(tx.c);
    return `drawtext=fontfile=${FONT_FILE}:textfile=${name}:expansion=none:reload=0:fontsize=${int(tx.size)}:fontcolor=${tx.c}` +
      `:x=${q(x)}:y=${q(y)}:alpha=${q(alpha)}:enable=${q(visible(tx.tin, tx.tout))}`;
  });
  chains.push(`[${last}]${dt.join(',')},format=yuv420p[vout]`);
  return { graph: chains.join(';'), files };
}

/** 측정 필터: 프레임 i에 문구 i만 그리고 bbox로 실제 폭·높이를 기록 */
export function buildExplainerMeasure(plan: ExplainerPlan): { filter: string; files: { name: string; text: string }[] } {
  const files: { name: string; text: string }[] = [];
  const parts = plan.texts.map((tx, i) => {
    const name = `x${i}.txt`;
    files.push({ name, text: tx.text });
    return `drawtext=fontfile=${FONT_FILE}:textfile=${name}:expansion=none:reload=0:fontsize=${int(tx.size)}:fontcolor=white:x=100:y=40:enable='eq(n\\,${int(i)})'`;
  });
  parts.push('bbox=min_val=128');
  return { filter: parts.join(','), files };
}

type Fail = Extract<ExplainerResult, { ok: false }>;
const fail = (code: Fail['code'], spawned: number, cleanup: Fail['cleanup'], reason?: ProbeReject): ExplainerResult =>
  Object.freeze(reason ? { ok: false, code, reason, cleanup, spawned } : { ok: false, code, cleanup, spawned });

export async function renderExplainerVideo(input: unknown, deps: ExplainerDeps): Promise<ExplainerResult> {
  let total: number;
  let wantFrames: boolean;
  let fs: RendererFs;
  let pdeps: ProcessDeps;
  try {
    total = deps.totalTimeoutMs;
    wantFrames = deps.frames === true;
    fs = { ...realFs, ...(deps.fs ?? {}) };
    pdeps = { spawn: deps.spawn, killGroup: deps.killGroup, now: deps.now, setTimer: deps.setTimer, clearTimer: deps.clearTimer, killWaitMs: deps.killWaitMs };
    if (typeof total !== 'number' || !Number.isFinite(total) || total < MIN_TOTAL_MS || total > MAX_TOTAL_MS) return fail('INVALID_INPUT', 0, 'NOT_NEEDED');
    if (typeof pdeps.spawn !== 'function' || typeof pdeps.killGroup !== 'function' || typeof pdeps.now !== 'function') return fail('INVALID_INPUT', 0, 'NOT_NEEDED');
    if (typeof pdeps.killWaitMs !== 'number' || !(pdeps.killWaitMs > 0 && pdeps.killWaitMs <= 10_000)) return fail('INVALID_INPUT', 0, 'NOT_NEEDED');
  } catch {
    return fail('INVALID_INPUT', 0, 'NOT_NEEDED');
  }
  const deadlineAt = pdeps.now() + total;

  const sb = buildExplainerStoryboard(input);
  if (!sb.ok) return fail(sb.error, 0, 'NOT_NEEDED');
  const plan = sb.plan;
  let graph: { graph: string; files: { name: string; text: string }[] };
  let measure: { filter: string; files: { name: string; text: string }[] };
  try {
    graph = buildExplainerFilter(plan);
    measure = buildExplainerMeasure(plan);
  } catch {
    return fail('INVALID_PLAN', 0, 'NOT_NEEDED');
  }

  for (const t of Object.values(TOOLS)) {
    if (!(await fs.checkExecutable(t))) return fail('NOT_AVAILABLE', 0, 'NOT_NEEDED');
  }
  if (!(pdeps.now() < deadlineAt)) return fail('TIMEOUT', 0, 'NOT_NEEDED');

  const owner = new ProcessOwner(pdeps);
  let dir: string | null = null;
  let primary: Exclude<RenderCode, 'RENDERED' | 'CLEANUP_FAILED'> | null = null;
  let reason: ProbeReject | undefined;
  let success: Omit<Extract<ExplainerResult, { ok: true }>, 'cleanup' | 'spawned'> | null = null;
  let cleanupStopped = false;

  try {
    const base = tmpdir();
    if (!SAFE_DIR.test(base)) throw new Stop('RENDER_FAILED');
    const created = await fs.mkdtemp(path.join(base, TMP_PREFIX));
    if (typeof created !== 'string' || !SAFE_DIR.test(created) || created.includes('..') || path.dirname(created) !== base || !path.basename(created).startsWith(TMP_PREFIX)) {
      throw new Stop('RENDER_FAILED');
    }
    dir = created;
    const cwd = created;
    const run = (tool: string, args: readonly string[], maxStdout: number, maxStderr: number) =>
      owner.run({ file: TOOLS.unshare, args: [...EX_WRAP_ARGS, tool, ...args], cwd, deadlineAt, maxStdout, maxStderr });

    // 준비 확인(18초 renderer와 같은 순서·기준)
    const iso = await run(TOOLS.cat, ['/proc/self/limits', '/proc/net/dev'], 16 * 1024, 2048);
    if (iso.kind === 'exit' && iso.code !== 0) throw new Stop('NETWORK_ISOLATION_UNAVAILABLE');
    const isoOut = new TextDecoder().decode(need(iso, 'NETWORK_ISOLATION_UNAVAILABLE').stdout);
    if (!onlyLoopback(isoOut)) throw new Stop('NETWORK_ISOLATION_UNAVAILABLE');
    if (!exLimitsApplied(isoOut)) throw new Stop('LIMITS_UNAVAILABLE');
    if ((await fs.fontDigest(FONT_FILE, FONT_BYTES)) !== FONT_SHA256) throw new Stop('FONT_UNAVAILABLE');
    if (!(pdeps.now() < deadlineAt)) throw new Stop('TIMEOUT');
    const filt = need(await run(TOOLS.ffmpeg, ['-hide_banner', '-nostdin', '-filters'], 256 * 1024, 4096), 'UNSUPPORTED');
    const enc = need(await run(TOOLS.ffmpeg, ['-hide_banner', '-nostdin', '-encoders'], 256 * 1024, 4096), 'UNSUPPORTED');
    const ft = new TextDecoder().decode(filt.stdout);
    const et = new TextDecoder().decode(enc.stdout);
    const needFilters = ['drawtext', 'bbox', 'geq', 'overlay', 'loop', 'fade', 'trim', 'color', 'setpts', 'format'];
    if (filt.code !== 0 || enc.code !== 0 || !needFilters.every((f) => new RegExp(`^\\s*\\S+\\s+${f}\\s`, 'm').test(ft)) || !/^\s*V\S*\s+libx264\s/m.test(et)) {
      throw new Stop('UNSUPPORTED');
    }

    // 실제 폰트 측정: 각 문구 폭 ≤ maxW, 높이 ≤ 글자 크기 × 1.4
    for (const f of measure.files) await writeOwnFile(cwd, f.name, f.text);
    const n = plan.texts.length;
    const mr = need(
      await run(TOOLS.ffmpeg, [
        '-hide_banner', '-nostdin', '-nostats', '-loglevel', 'info', '-threads', '2', '-filter_threads', '1',
        '-protocol_whitelist', 'file', '-f', 'lavfi', '-i', `color=c=black:s=1600x240:r=1:d=${int(n)}`,
        '-vf', measure.filter, '-frames:v', int(n), '-f', 'null', '-',
      ], 4096, 128 * 1024),
      'RENDER_FAILED',
    );
    if (mr.code !== 0) throw new Stop('RENDER_FAILED');
    const sizes = parseBbox(mr.stderr, n);
    if (!sizes) throw new Stop('RENDER_FAILED');
    const texts: TextMeasure[] = sizes.map((s, i) => Object.freeze({ id: plan.texts[i]!.id, width: s.w, height: s.h, maxW: plan.texts[i]!.maxW }));
    if (texts.some((m, i) => m.width > m.maxW || m.height > Math.round(plan.texts[i]!.size * 1.4))) throw new Stop('LAYOUT_OVERFLOW');

    // 렌더
    for (const f of graph.files) await writeOwnFile(cwd, f.name, f.text);
    const rr = need(
      await run(TOOLS.ffmpeg, [
        '-hide_banner', '-nostdin', '-nostats', '-loglevel', 'error', '-threads', '2', '-filter_threads', '1', '-filter_complex_threads', '1',
        '-protocol_whitelist', 'file',
        '-f', 'lavfi', '-i', `color=c=${PAL.bg}:s=${int(EX_WIDTH)}x${int(EX_HEIGHT)}:r=${int(EX_FPS)}:d=${int(EX_DURATION_SEC)}`,
        '-filter_complex', graph.graph, '-map', '[vout]',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-r', int(EX_FPS),
        '-t', int(EX_DURATION_SEC), '-an', '-movflags', '+faststart', '-protocol_whitelist', 'file', '-f', 'mp4', 'file:out.mp4',
      ], 4096, 2048),
      'RENDER_FAILED',
    );
    if (rr.code !== 0) throw new Stop('RENDER_FAILED');

    // 실제 파일 검사
    const outPath = path.join(cwd, 'out.mp4');
    const st = await lstat(outPath);
    if (!st.isFile()) throw new Stop('RENDER_FAILED');
    if (st.size > MAX_VIDEO_BYTES) throw new Stop('TOO_LARGE');
    const dec = need(await run(TOOLS.ffmpeg, ['-hide_banner', '-nostdin', '-nostats', '-v', 'error', '-protocol_whitelist', 'file', '-i', 'file:out.mp4', '-map', '0', '-f', 'null', '-'], 4096, 2048), 'DECODE_FAILED');
    if (dec.code !== 0 || dec.stderr.length > 0) throw new Stop('DECODE_FAILED');
    const pr = await probeExplainerVideo(owner, { wrapFile: TOOLS.unshare, wrapArgs: [...EX_WRAP_ARGS, TOOLS.ffprobe], cwd, deadlineAt, actualBytes: st.size });
    if (!pr.ok) {
      if (pr.code === 'CLEANUP_FAILED') throw new CleanupStop();
      throw new Stop(pr.code, pr.reason);
    }
    const video = await readOwnFile(outPath, st.size, MAX_VIDEO_BYTES);
    if (!video) throw new Stop('RENDER_FAILED');
    if (!isFastStart(video)) throw new Stop('PROBE_REJECTED', 'FORMAT');

    // 대표 프레임(선택)
    const frames: FrameImage[] = [];
    if (wantFrames) {
      for (const [ti, at] of EX_FRAME_TIMES.entries()) {
        const outs = EX_FRAME_WIDTHS.map((w) => ({ w, name: `f${ti}_${w}.png` }));
        const fc = `[0:v]split=${outs.length}${outs.map((_, i) => `[s${i}]`).join('')};` + outs.map((o, i) => `[s${i}]scale=${int(o.w)}:-2[o${i}]`).join(';');
        const args = ['-hide_banner', '-nostdin', '-nostats', '-v', 'error', '-protocol_whitelist', 'file', '-ss', String(at), '-i', 'file:out.mp4', '-filter_complex', fc];
        outs.forEach((o, i) => args.push('-map', `[o${i}]`, '-frames:v', '1', '-update', '1', '-protocol_whitelist', 'file', `file:${o.name}`));
        const fr = need(await run(TOOLS.ffmpeg, args, 4096, 2048), 'RENDER_FAILED');
        if (fr.code !== 0 || fr.stderr.length > 0) throw new Stop('RENDER_FAILED');
        for (const o of outs) {
          const p = path.join(cwd, o.name);
          const fst = await lstat(p);
          if (!fst.isFile()) throw new Stop('RENDER_FAILED');
          const png = await readOwnFile(p, fst.size, MAX_FRAME_BYTES);
          if (!png) throw new Stop('RENDER_FAILED');
          frames.push(Object.freeze({ atSec: at, width: o.w, png }));
        }
      }
    }
    success = { ok: true, code: 'RENDERED', kind: 'silent_visual_draft', video, probe: pr.report, faststart: true, texts: Object.freeze(texts), frames: Object.freeze(frames) };
  } catch (e) {
    if (e instanceof Stop) {
      primary = e.code;
      reason = e.reason;
    } else if (e instanceof CleanupStop) {
      cleanupStopped = true;
    } else {
      primary = 'RENDER_FAILED';
    }
  }

  // 정리(18초 renderer와 같은 규칙)
  let cleanOk = await owner.settleAll();
  if (cleanupStopped) cleanOk = false;
  if (dir !== null && owner.liveCount === 0) {
    try {
      await fs.removeDir(dir);
      if (await fs.exists(dir)) cleanOk = false;
    } catch {
      cleanOk = false;
    }
  } else if (dir !== null) {
    cleanOk = false;
  }
  const spawned = owner.spawnCount;
  if (!cleanOk) {
    return Object.freeze(primary ? { ok: false, code: 'CLEANUP_FAILED', primary, cleanup: 'FAILED', spawned } : { ok: false, code: 'CLEANUP_FAILED', cleanup: 'FAILED', spawned });
  }
  if (primary) return fail(primary, spawned, 'OK', reason);
  if (!success) return fail('RENDER_FAILED', spawned, 'OK');
  return Object.freeze({ ...success, cleanup: 'OK', spawned });
}
