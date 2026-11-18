import 'server-only';
// 로컬 세로 자막 영상 renderer (PM 6954300094). storyboard → 실제 mp4 바이트. **생성·업로드·외부 접속 없음.**
//
// 흐름(전체가 하나의 절대 마감을 공유한다)
//   1. 입력 → buildStoryboard(검증 copy 1회, 고정 3장면). 불량이면 spawn 0.
//   2. 고정 실행 파일 존재·실행 권한 확인. 없으면 NOT_AVAILABLE(자동 설치·다른 명령 fallback 없음).
//   3. 자기 임시 디렉터리(mkdtemp, 0700, symlink 아님) 생성.
//   4. 준비 확인(전부 고정 격리 접두 unshare -n + prlimit 아래에서 실행)
//      - OS 네트워크 격리: 격리 안에서 /proc/net/dev에 lo 외 인터페이스 0, 자원 제한이 실제 적용됐는지 /proc/self/limits로 확인
//        → 불가하면 NETWORK_ISOLATION_UNAVAILABLE / LIMITS_UNAVAILABLE(일반 네트워크 실행 fallback 없음)
//      - 폰트: 고정 폰트 파일의 크기·SHA-256이 검증된 값과 같은지 → FONT_UNAVAILABLE(fontconfig 이름 해석 미사용)
//      - 필터·인코더(drawtext·drawbox·bbox·libx264) → UNSUPPORTED
//   5. 실제 폰트로 각 줄 폭 측정(bbox). 폭 > 600px 또는 높이 > 줄 높이면 LAYOUT_OVERFLOW(렌더 0).
//   6. 렌더(고정 lavfi 배경 + 고정 템플릿 drawbox·drawtext, 문구는 자기 textfile로만).
//   7. 실제 파일 lstat(일반 파일·5MiB 이하) → 전체 디코딩 오류 0 → ffprobe 판정 → faststart 확인.
//   8. (선택) 고정 시각 3장의 프레임 PNG(720·390·320 폭).
//   9. 정리: 소유 자식 종료 확인 → 자기 디렉터리만 filesystem API로 삭제 → 삭제 확인.
//      정리 실패는 RENDERED와 함께 숨기지 않고 CLEANUP_FAILED로 돌려준다.
//
// 보안 계약
// - 문구는 인자·필터 문자열에 들어가지 않는다. drawtext는 textfile(상대 고정 이름)·expansion=none·reload=0만 쓴다.
// - 색·좌표·타이밍·폰트 크기는 storyboard 상수에서 오고 정수·고정 색 형식만 통과한다.
// - 입력은 고정 lavfi color 1개뿐이다. -protocol_whitelist file, -nostdin, 출력은 file:out.mp4 고정.
// - process.env를 읽지 않는다. 자식 env는 boundedProcess의 최소 고정 env다.
// - stderr 원문·경로·cause는 반환하지 않는다(고정 코드 + 허용 기술 메타데이터만).
// - 한계: 실행 사용자가 root면 prlimit nproc는 효과가 없다. CPU 60초·주소 공간 1GiB·파일 16MiB는 확인 후 실행한다.
import { createHash } from 'node:crypto';
import { constants as fsc } from 'node:fs';
import { access, lstat, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProcessOwner, type ProcessDeps, type RunOutcome } from './boundedProcess';
import { buildStoryboard, COLORS, MAX_LINE_WIDTH, SIDE_MARGIN, VIDEO_DURATION_SEC, VIDEO_FPS, VIDEO_HEIGHT, VIDEO_WIDTH, type Storyboard } from './storyboard';
import { isFastStart, MAX_VIDEO_BYTES, probeVideo, type ProbeReject, type ProbeReport } from './videoProbe';

export const TOOLS = Object.freeze({
  unshare: '/usr/bin/unshare',
  prlimit: '/usr/bin/prlimit',
  ffmpeg: '/usr/local/bin/ffmpeg',
  ffprobe: '/usr/bin/ffprobe',
  cat: '/usr/bin/cat',
});

export const LIMITS = Object.freeze({ addressSpace: 1024 * 1024 * 1024, cpuSeconds: 60, fileSize: 16 * 1024 * 1024, nproc: 64 });

/** 고정 격리·자원 제한 접두. 모든 도구는 이 뒤에서만 실행한다 */
export const WRAP_ARGS: readonly string[] = Object.freeze([
  '-n', '--', TOOLS.prlimit,
  `--as=${LIMITS.addressSpace}`, `--cpu=${LIMITS.cpuSeconds}`, `--fsize=${LIMITS.fileSize}`, `--nproc=${LIMITS.nproc}`, '--',
]);

/**
 * 고정 폰트 파일(Debian fonts-noto-cjk 1:20230817+repack1-3, SIL OFL 1.1).
 * ffmpeg 6.1 drawtext는 ttc의 face index를 고를 수 없어 **face 0 = Noto Sans CJK JP Bold**가 쓰인다.
 * 한글 음절 11172자 전부와 허용 문자(영문·공백·일부 문장부호)가 이 face에 있다. 한글 글리프 디자인은 KR face와 같지만
 * '·' 등 일부 문장부호의 모양·폭은 KR face와 다를 수 있다.
 * fontconfig 이름(font=)은 쓰지 않는다: 이 환경에서 'Noto Sans CJK KR:style=Bold' 지정이 한글 글리프 없는 대체 폰트로
 * 해석되는 것을 실제 프레임에서 확인했다(fc-match 결과와 달랐음).
 */
export const FONT_FILE = '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc';
export const FONT_BYTES = 20_050_760;
export const FONT_SHA256 = 'faa5f3656a78b2e2d450d27fe8382c778bc2b6bb5ea29c986664a6a435056ceb';
const FONT_FILTER_VALUE = `fontfile=${FONT_FILE}`;

export const MAX_TOTAL_MS = 120_000;
const MIN_TOTAL_MS = 1_000;
const FRAME_TIMES = Object.freeze([2.5, 9, 15.5]);
const FRAME_WIDTHS = Object.freeze([720, 390, 320]);
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const TMP_PREFIX = 'fideon-video-';
const SAFE_DIR = /^\/[A-Za-z0-9/_.-]+$/;

export type RenderCode =
  | 'RENDERED'
  | 'INVALID_INPUT' | 'LAYOUT_TOO_LONG' | 'NOT_AVAILABLE' | 'NETWORK_ISOLATION_UNAVAILABLE' | 'LIMITS_UNAVAILABLE' | 'FONT_UNAVAILABLE'
  | 'UNSUPPORTED' | 'LAYOUT_OVERFLOW' | 'RENDER_FAILED' | 'OUTPUT_TOO_LARGE' | 'TIMEOUT' | 'TOO_LARGE' | 'DECODE_FAILED'
  | 'PROBE_REJECTED' | 'PROBE_FAILED' | 'CLEANUP_FAILED';

export type FrameImage = { readonly atSec: number; readonly width: number; readonly png: Uint8Array };
export type LineMeasure = { readonly scene: string; readonly line: number; readonly width: number; readonly height: number };

export type RenderResult =
  | {
      readonly ok: true;
      readonly code: 'RENDERED';
      readonly copySource: Storyboard['copySource'];
      readonly situationId: Storyboard['situationId'];
      readonly video: Uint8Array;
      readonly probe: ProbeReport;
      readonly faststart: true;
      readonly lines: readonly LineMeasure[];
      readonly frames: readonly FrameImage[];
      readonly cleanup: 'OK';
      readonly spawned: number;
    }
  | {
      readonly ok: false;
      readonly code: Exclude<RenderCode, 'RENDERED'>;
      readonly reason?: ProbeReject;
      /** 실패 전 단계에서 확인된 원래 실패(정리 실패로 덮어쓰지 않음) */
      readonly primary?: Exclude<RenderCode, 'RENDERED' | 'CLEANUP_FAILED'>;
      readonly cleanup: 'OK' | 'FAILED' | 'NOT_NEEDED';
      readonly spawned: number;
    };

export type RendererFs = {
  readonly mkdtemp: (prefix: string) => Promise<string>;
  readonly checkExecutable: (file: string) => Promise<boolean>;
  readonly removeDir: (dir: string) => Promise<void>;
  readonly exists: (p: string) => Promise<boolean>;
  /** 일반 파일이고 크기가 정확히 bytes일 때만 SHA-256 hex. 아니면 null */
  readonly fontDigest: (file: string, bytes: number) => Promise<string | null>;
};

export type RendererDeps = ProcessDeps & {
  /** 시험용 일부 대체(나머지는 실제 fs) */
  readonly fs?: Partial<RendererFs>;
  /** 전체 절대 마감(1초~120초). 필수 */
  readonly totalTimeoutMs: number;
  /** 고정 시각 프레임 PNG를 함께 돌려줄지 */
  readonly frames?: boolean;
};

const realFs: RendererFs = {
  mkdtemp: (prefix) => mkdtemp(prefix),
  checkExecutable: async (file) => {
    try {
      const st = await lstat(file);
      if (!st.isFile()) return false;
      await access(file, fsc.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  removeDir: (dir) => rm(dir, { recursive: true, force: false }),
  fontDigest: async (file, bytes) => {
    try {
      const st = await lstat(file);
      if (!st.isFile() || st.size !== bytes) return null;
      const buf = await readOwnFile(file, bytes, bytes);
      return buf ? createHash('sha256').update(buf).digest('hex') : null;
    } catch {
      return null;
    }
  },
  exists: async (p) => {
    try {
      await lstat(p);
      return true;
    } catch (e) {
      if ((e as { code?: string }).code === 'ENOENT') return false;
      throw e;
    }
  },
};

const int = (n: number) => {
  if (!Number.isSafeInteger(n) || n < 0 || n > 100_000) throw new Error('layout');
  return String(n);
};
const COLOR_RE = /^0x[0-9a-f]{6}$/;
const color = (c: string) => {
  if (!COLOR_RE.test(c)) throw new Error('color');
  return c;
};

/** 렌더 필터(고정 템플릿). 문구는 t<i>.txt 파일로만 참조한다 */
export function buildRenderFilter(sb: Storyboard): { filter: string; files: { name: string; text: string }[] } {
  const parts: string[] = [
    `drawbox=x=${int(SIDE_MARGIN)}:y=220:w=120:h=12:color=${color(COLORS.accent)}:t=fill`,
    `drawbox=x=0:y=1160:w=${int(VIDEO_WIDTH)}:h=120:color=${color(COLORS.band)}:t=fill`,
  ];
  const files: { name: string; text: string }[] = [];
  for (const sc of sb.scenes) {
    for (const ln of sc.lines) {
      const name = `t${files.length}.txt`;
      files.push({ name, text: ln.text });
      parts.push(
        `drawtext=${FONT_FILTER_VALUE}:textfile=${name}:expansion=none:reload=0:fontsize=${int(sc.fontSize)}:fontcolor=${color(sc.color)}` +
          `:x=(w-text_w)/2:y=${int(ln.y)}:enable='gte(t\\,${int(sc.start)})*lt(t\\,${int(sc.end)})'`,
      );
    }
  }
  return { filter: parts.join(','), files };
}

/** 측정 필터: 프레임 i에 줄 i만 그리고 bbox로 실제 그려진 폭·높이를 기록 */
export function buildMeasureFilter(sb: Storyboard): { filter: string; files: { name: string; text: string }[]; meta: { scene: string; line: number; lineHeight: number }[] } {
  const parts: string[] = [];
  const files: { name: string; text: string }[] = [];
  const meta: { scene: string; line: number; lineHeight: number }[] = [];
  for (const sc of sb.scenes) {
    sc.lines.forEach((ln, li) => {
      const i = files.length;
      const name = `m${i}.txt`;
      files.push({ name, text: ln.text });
      meta.push({ scene: sc.id, line: li, lineHeight: sc.lineHeight });
      parts.push(`drawtext=${FONT_FILTER_VALUE}:textfile=${name}:expansion=none:reload=0:fontsize=${int(sc.fontSize)}:fontcolor=white:x=100:y=40:enable='eq(n\\,${int(i)})'`);
    });
  }
  parts.push('bbox=min_val=128');
  return { filter: parts.join(','), files, meta };
}

const fail = (code: Exclude<RenderCode, 'RENDERED'>, spawned: number, cleanup: 'OK' | 'FAILED' | 'NOT_NEEDED', reason?: ProbeReject): RenderResult =>
  Object.freeze(reason ? { ok: false, code, reason, cleanup, spawned } : { ok: false, code, cleanup, spawned });

class Stop extends Error {
  constructor(readonly code: Exclude<RenderCode, 'RENDERED' | 'CLEANUP_FAILED'>, readonly reason?: ProbeReject) {
    super(code);
  }
}

/** 실행 실패를 고정 코드로. exit 결과는 그대로 돌려준다 */
function need(r: RunOutcome, onFail: Exclude<RenderCode, 'RENDERED' | 'CLEANUP_FAILED'>): Extract<RunOutcome, { kind: 'exit' }> {
  if (r.kind === 'exit') return r;
  if (r.reason === 'TIMEOUT') throw new Stop('TIMEOUT');
  if (r.reason === 'CLEANUP_FAILED' || r.reason === 'BLOCKED') throw new CleanupStop();
  if (r.reason === 'STDIO_TOO_LARGE') throw new Stop('OUTPUT_TOO_LARGE');
  throw new Stop(onFail);
}
class CleanupStop extends Error {}

export async function renderAdVideo(input: unknown, deps: RendererDeps): Promise<RenderResult> {
  // deps는 한 번만 읽는다
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

  const sbr = buildStoryboard(input);
  if (!sbr.ok) return fail(sbr.error, 0, 'NOT_NEEDED');
  const sb = sbr.storyboard;

  for (const t of Object.values(TOOLS)) {
    if (!(await fs.checkExecutable(t))) return fail('NOT_AVAILABLE', 0, 'NOT_NEEDED');
  }
  if (!(pdeps.now() < deadlineAt)) return fail('TIMEOUT', 0, 'NOT_NEEDED');

  const owner = new ProcessOwner(pdeps);
  let dir: string | null = null;
  let primary: Exclude<RenderCode, 'RENDERED' | 'CLEANUP_FAILED'> | null = null;
  let reason: ProbeReject | undefined;
  let success: Omit<Extract<RenderResult, { ok: true }>, 'cleanup' | 'spawned'> | null = null;
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
      owner.run({ file: TOOLS.unshare, args: [...WRAP_ARGS, tool, ...args], cwd, deadlineAt, maxStdout, maxStderr });

    // ── 4. 준비 확인 ──
    const iso = await run(TOOLS.cat, ['/proc/self/limits', '/proc/net/dev'], 16 * 1024, 2048);
    if (iso.kind === 'exit' && iso.code !== 0) throw new Stop('NETWORK_ISOLATION_UNAVAILABLE');
    const isoOut = new TextDecoder().decode(need(iso, 'NETWORK_ISOLATION_UNAVAILABLE').stdout);
    if (!onlyLoopback(isoOut)) throw new Stop('NETWORK_ISOLATION_UNAVAILABLE');
    if (!limitsApplied(isoOut)) throw new Stop('LIMITS_UNAVAILABLE');

    if ((await fs.fontDigest(FONT_FILE, FONT_BYTES)) !== FONT_SHA256) throw new Stop('FONT_UNAVAILABLE');
    if (!(pdeps.now() < deadlineAt)) throw new Stop('TIMEOUT');

    const filt = need(await run(TOOLS.ffmpeg, ['-hide_banner', '-nostdin', '-filters'], 256 * 1024, 4096), 'UNSUPPORTED');
    const enc = need(await run(TOOLS.ffmpeg, ['-hide_banner', '-nostdin', '-encoders'], 256 * 1024, 4096), 'UNSUPPORTED');
    const ft = new TextDecoder().decode(filt.stdout);
    const et = new TextDecoder().decode(enc.stdout);
    if (filt.code !== 0 || enc.code !== 0 || !['drawtext', 'drawbox', 'bbox'].every((f) => new RegExp(`^\\s*\\S+\\s+${f}\\s`, 'm').test(ft)) || !/^\s*V\S*\s+libx264\s/m.test(et)) {
      throw new Stop('UNSUPPORTED');
    }

    // ── 5. 실제 폰트 측정 ──
    const m = buildMeasureFilter(sb);
    for (const f of m.files) await writeOwnFile(cwd, f.name, f.text);
    const mr = need(
      await run(TOOLS.ffmpeg, [
        '-hide_banner', '-nostdin', '-nostats', '-loglevel', 'info', '-threads', '2', '-filter_threads', '1',
        '-protocol_whitelist', 'file', '-f', 'lavfi', '-i', `color=c=black:s=1600x240:r=1:d=${int(m.files.length)}`,
        '-vf', m.filter, '-frames:v', int(m.files.length), '-f', 'null', '-',
      ], 4096, 64 * 1024),
      'RENDER_FAILED',
    );
    if (mr.code !== 0) throw new Stop('RENDER_FAILED');
    const sizes = parseBbox(mr.stderr, m.files.length);
    if (!sizes) throw new Stop('RENDER_FAILED');
    const lines: LineMeasure[] = sizes.map((s, i) => Object.freeze({ scene: m.meta[i]!.scene, line: m.meta[i]!.line, width: s.w, height: s.h }));
    if (lines.some((l, i) => l.width > MAX_LINE_WIDTH || l.height > m.meta[i]!.lineHeight)) throw new Stop('LAYOUT_OVERFLOW');

    // ── 6. 렌더 ──
    const r = buildRenderFilter(sb);
    for (const f of r.files) await writeOwnFile(cwd, f.name, f.text);
    const rr = need(
      await run(TOOLS.ffmpeg, [
        '-hide_banner', '-nostdin', '-nostats', '-loglevel', 'error', '-threads', '2', '-filter_threads', '1',
        '-protocol_whitelist', 'file',
        '-f', 'lavfi', '-i', `color=c=${color(COLORS.background)}:s=${int(VIDEO_WIDTH)}x${int(VIDEO_HEIGHT)}:r=${int(VIDEO_FPS)}:d=${int(VIDEO_DURATION_SEC)}`,
        '-vf', r.filter,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-r', int(VIDEO_FPS),
        '-t', int(VIDEO_DURATION_SEC), '-an', '-movflags', '+faststart', '-protocol_whitelist', 'file', '-f', 'mp4', 'file:out.mp4',
      ], 4096, 2048),
      'RENDER_FAILED',
    );
    if (rr.code !== 0) throw new Stop('RENDER_FAILED');

    // ── 7. 실제 파일 검사 ──
    const outPath = path.join(cwd, 'out.mp4');
    const st = await lstat(outPath);
    if (!st.isFile()) throw new Stop('RENDER_FAILED');
    if (st.size > MAX_VIDEO_BYTES) throw new Stop('TOO_LARGE');
    const dec = need(await run(TOOLS.ffmpeg, ['-hide_banner', '-nostdin', '-nostats', '-v', 'error', '-protocol_whitelist', 'file', '-i', 'file:out.mp4', '-map', '0', '-f', 'null', '-'], 4096, 2048), 'DECODE_FAILED');
    if (dec.code !== 0 || dec.stderr.length > 0) throw new Stop('DECODE_FAILED');
    const pr = await probeVideo(owner, { wrapFile: TOOLS.unshare, wrapArgs: [...WRAP_ARGS, TOOLS.ffprobe], cwd, deadlineAt, actualBytes: st.size });
    if (!pr.ok) {
      if (pr.code === 'CLEANUP_FAILED') throw new CleanupStop();
      throw new Stop(pr.code, pr.reason);
    }
    const video = await readOwnFile(outPath, st.size, MAX_VIDEO_BYTES);
    if (!video) throw new Stop('RENDER_FAILED');
    if (!isFastStart(video)) throw new Stop('PROBE_REJECTED', 'FORMAT');

    // ── 8. 프레임(선택) ──
    const frames: FrameImage[] = [];
    if (wantFrames) {
      for (const [ti, at] of FRAME_TIMES.entries()) {
        const outs = FRAME_WIDTHS.map((w) => ({ w, name: `f${ti}_${w}.png` }));
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
    success = {
      ok: true, code: 'RENDERED', copySource: sb.copySource, situationId: sb.situationId, video, probe: pr.report, faststart: true,
      lines: Object.freeze(lines), frames: Object.freeze(frames),
    };
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

  // ── 9. 정리(성공·실패 공통, 멱등) ──
  let cleanOk = await owner.settleAll();
  if (cleanupStopped) cleanOk = false;
  if (dir !== null && owner.liveCount === 0) {
    // 소유 자식이 모두 종료된 뒤에만 자기 디렉터리를 지운다
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

/** 격리 안 /proc/net/dev: 헤더 2줄 뒤 인터페이스가 lo 하나뿐 */
export function onlyLoopback(text: string): boolean {
  const idx = text.indexOf('Inter-|');
  if (idx < 0) return false;
  const rows = text.slice(idx).split('\n').slice(2).map((l) => l.trim()).filter(Boolean);
  const names = rows.map((l) => l.split(':')[0]!.trim());
  return names.length === 1 && names[0] === 'lo';
}

/** /proc/self/limits에 고정 한도가 soft·hard 모두 적용됐는지 */
export function limitsApplied(text: string): boolean {
  const want: [string, number][] = [
    ['Max cpu time', LIMITS.cpuSeconds], ['Max file size', LIMITS.fileSize], ['Max processes', LIMITS.nproc], ['Max address space', LIMITS.addressSpace],
  ];
  return want.every(([name, v]) => new RegExp(`^${name}\\s+${v}\\s+${v}\\s`, 'm').test(text));
}

/** bbox 로그에서 프레임 0..n-1의 w·h를 정확히 한 번씩 읽는다 */
export function parseBbox(stderr: string, n: number): { w: number; h: number }[] | null {
  const out: ({ w: number; h: number } | undefined)[] = new Array(n).fill(undefined);
  const re = /\bn:(\d+) pts:\S+ pts_time:\S+ x1:\d+ x2:\d+ y1:\d+ y2:\d+ w:(\d+) h:(\d+)/g;
  for (const mm of stderr.matchAll(re)) {
    const i = Number(mm[1]);
    if (!(i >= 0 && i < n) || out[i]) return null;
    out[i] = { w: Number(mm[2]), h: Number(mm[3]) };
  }
  return out.every(Boolean) ? (out as { w: number; h: number }[]) : null;
}

/** 자기 디렉터리에 고정 이름 파일을 새로 만든다(이미 있거나 symlink면 실패: wx) */
async function writeOwnFile(dir: string, name: string, text: string): Promise<void> {
  if (!/^[a-z][0-9_a-z]*\.txt$/.test(name)) throw new Stop('RENDER_FAILED');
  await writeFile(path.join(dir, name), text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}

/** 일반 파일을 크기 한도 안에서 읽고, 연 뒤의 크기가 stat과 같은지 확인한다 */
async function readOwnFile(p: string, expected: number, max: number): Promise<Uint8Array | null> {
  if (!(expected > 0 && expected <= max)) return null;
  const fh = await open(p, fsc.O_RDONLY | fsc.O_NOFOLLOW);
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size !== expected) return null;
    const buf = new Uint8Array(expected);
    let o = 0;
    while (o < expected) {
      const { bytesRead } = await fh.read(buf, o, expected - o, o);
      if (bytesRead <= 0) return null;
      o += bytesRead;
    }
    return buf;
  } finally {
    await fh.close();
  }
}
