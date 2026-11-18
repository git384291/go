import 'server-only';
// 렌더 결과 판독 (PM 6954300094 5절). ffprobe JSON은 **불신 데이터**다.
//
// - ffprobe는 boundedProcess로만 실행한다(고정 인자, stdout 상한, 절대 마감 공유).
// - 판정: 비디오 스트림 정확히 1개, 그 밖의 스트림 0개(오디오 포함), h264 High, 720×1280, yuv420p,
//   30/1 fps, 17.5~18.5초, 실제 디코딩 프레임 수, 실제 파일 크기(stat)와 format.size 일치, 5MiB 이하.
// - JSON의 size만 믿지 않는다. 호출자가 넘긴 실제 stat 크기와 대조한다.
// - 실패는 고정 사유 코드만 돌려준다(원문 JSON·stderr·경로 비반환).
import type { ProcessOwner } from './boundedProcess';
import { VIDEO_DURATION_SEC, VIDEO_FPS, VIDEO_HEIGHT, VIDEO_WIDTH } from './storyboard';

export const MAX_VIDEO_BYTES = 5 * 1024 * 1024;
export const PROBE_MAX_STDOUT = 64 * 1024;
const DURATION_TOLERANCE = 0.5;
const EXPECTED_FRAMES = VIDEO_FPS * VIDEO_DURATION_SEC;

export type ProbeReport = {
  readonly codec: 'h264';
  readonly profile: 'High';
  readonly width: number;
  readonly height: number;
  readonly pixFmt: 'yuv420p';
  readonly fps: number;
  readonly durationSec: number;
  readonly frames: number;
  readonly bytes: number;
  readonly videoStreams: 1;
  readonly otherStreams: 0;
};

export type ProbeReject =
  | 'JSON' | 'SHAPE' | 'STREAM_COUNT' | 'CODEC' | 'PROFILE' | 'SIZE_DIMENSIONS' | 'PIX_FMT' | 'FPS' | 'FRAMES' | 'DURATION' | 'BYTES' | 'TOO_LARGE' | 'FORMAT';

export type ProbeCheck = { readonly ok: true; readonly report: ProbeReport } | { readonly ok: false; readonly reason: ProbeReject };

const plain = (v: unknown): v is Record<string, unknown> => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
};
const DEC = /^(0|[1-9][0-9]{0,15})(\.[0-9]{1,9})?$/;
const INT = /^(0|[1-9][0-9]{0,15})$/;
/** 문자열 숫자 → 유한수. 지수·부호·NaN·Infinity·공백 거부 */
const decimal = (v: unknown): number | null => (typeof v === 'string' && DEC.test(v) && Number.isFinite(Number(v)) ? Number(v) : null);
const integer = (v: unknown): number | null => (typeof v === 'string' && INT.test(v) && Number.isSafeInteger(Number(v)) ? Number(v) : null);

/** ffprobe JSON 판정(순수). actualBytes는 호출자가 stat으로 잰 실제 크기 */
export function checkProbeJson(text: unknown, actualBytes: unknown): ProbeCheck {
  try {
    return checkUnsafe(text, actualBytes, PROFILE_18S);
  } catch {
    return { ok: false, reason: 'SHAPE' };
  }
}

/** 판정 기준(내부 고정값). 외부 입력으로 받지 않는다 */
type Profile = { readonly width: number; readonly height: number; readonly fps: number; readonly durationSec: number; readonly frames: number };
const PROFILE_18S: Profile = Object.freeze({ width: VIDEO_WIDTH, height: VIDEO_HEIGHT, fps: VIDEO_FPS, durationSec: VIDEO_DURATION_SEC, frames: EXPECTED_FRAMES });
/** 30초 무음 화면 시안(PM 6983216833). 오디오 없음·5MiB 상한은 18초와 같다 */
const PROFILE_30S: Profile = Object.freeze({ width: 720, height: 1280, fps: 30, durationSec: 30, frames: 900 });

/** 30초 화면 시안 판정(순수). 18초 판정과 별도 함수 */
export function checkExplainerProbeJson(text: unknown, actualBytes: unknown): ProbeCheck {
  try {
    return checkUnsafe(text, actualBytes, PROFILE_30S);
  } catch {
    return { ok: false, reason: 'SHAPE' };
  }
}

function checkUnsafe(text: unknown, actualBytes: unknown, pf: Profile): ProbeCheck {
  const no = (reason: ProbeReject): ProbeCheck => ({ ok: false, reason });
  if (typeof actualBytes !== 'number' || !Number.isSafeInteger(actualBytes) || actualBytes <= 0) return no('BYTES');
  if (actualBytes > MAX_VIDEO_BYTES) return no('TOO_LARGE');
  if (typeof text !== 'string' || text.length > PROBE_MAX_STDOUT) return no('JSON');
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return no('JSON');
  }
  if (!plain(j)) return no('SHAPE');
  const streams = j.streams;
  const format = j.format;
  if (!Array.isArray(streams) || !plain(format)) return no('SHAPE');
  if (streams.length !== 1) return no('STREAM_COUNT');
  const s = streams[0];
  if (!plain(s) || s.codec_type !== 'video') return no('STREAM_COUNT');
  if (s.codec_name !== 'h264') return no('CODEC');
  if (s.profile !== 'High') return no('PROFILE');
  if (s.width !== pf.width || s.height !== pf.height) return no('SIZE_DIMENSIONS');
  if (s.pix_fmt !== 'yuv420p') return no('PIX_FMT');
  const fpsText = `${pf.fps}/1`;
  if (s.r_frame_rate !== fpsText || s.avg_frame_rate !== fpsText) return no('FPS');
  const frames = integer(s.nb_read_frames);
  if (frames === null || frames !== pf.frames) return no('FRAMES');
  if (typeof format.format_name !== 'string' || !format.format_name.split(',').includes('mp4')) return no('FORMAT');
  const duration = decimal(format.duration);
  if (duration === null || Math.abs(duration - pf.durationSec) > DURATION_TOLERANCE) return no('DURATION');
  const size = integer(format.size);
  if (size === null || size !== actualBytes) return no('BYTES');
  return {
    ok: true,
    report: Object.freeze({
      codec: 'h264', profile: 'High', width: pf.width, height: pf.height, pixFmt: 'yuv420p', fps: pf.fps,
      durationSec: duration, frames, bytes: actualBytes, videoStreams: 1, otherStreams: 0,
    }),
  };
}

/** mp4 최상위 box 순서: moov가 mdat보다 앞(faststart). 불량 구조는 false */
export function isFastStart(bytes: Uint8Array): boolean {
  let o = 0;
  let sawMoov = false;
  let guard = 0;
  while (o + 8 <= bytes.byteLength && guard++ < 64) {
    const size = ((bytes[o]! << 24) >>> 0) + (bytes[o + 1]! << 16) + (bytes[o + 2]! << 8) + bytes[o + 3]!;
    const type = String.fromCharCode(bytes[o + 4]!, bytes[o + 5]!, bytes[o + 6]!, bytes[o + 7]!);
    if (type === 'moov') sawMoov = true;
    if (type === 'mdat') return sawMoov;
    let len = size;
    if (size === 1) {
      if (o + 16 > bytes.byteLength) return false;
      const hi = (((bytes[o + 8]! << 24) >>> 0) + (bytes[o + 9]! << 16) + (bytes[o + 10]! << 8) + bytes[o + 11]!);
      const lo = (((bytes[o + 12]! << 24) >>> 0) + (bytes[o + 13]! << 16) + (bytes[o + 14]! << 8) + bytes[o + 15]!);
      len = hi * 2 ** 32 + lo;
    }
    if (len < 8) return false;
    o += len;
  }
  return false;
}

/** 고정 ffprobe 인자(상대 파일명 out.mp4, cwd는 호출자 소유 임시 디렉터리) */
export const FFPROBE_ARGS: readonly string[] = Object.freeze([
  '-v', 'error', '-count_frames',
  '-show_entries', 'stream=index,codec_type,codec_name,profile,width,height,pix_fmt,r_frame_rate,avg_frame_rate,nb_read_frames:format=format_name,duration,size',
  '-of', 'json', '-protocol_whitelist', 'file', 'file:out.mp4',
]);

export type ProbeRun = { readonly ok: true; readonly report: ProbeReport } | { readonly ok: false; readonly code: 'PROBE_REJECTED' | 'TIMEOUT' | 'CLEANUP_FAILED' | 'PROBE_FAILED'; readonly reason?: ProbeReject };

/** ffprobe 실행 + 판정. wrap은 renderer의 고정 격리·자원 제한 접두 인자 */
export async function probeVideo(owner: ProcessOwner, p: ProbeParams): Promise<ProbeRun> {
  return runProbe(owner, p, checkProbeJson);
}

/** 30초 화면 시안용 실행 + 판정(18초 probeVideo와 같은 실행 규칙, 판정만 30초 기준) */
export async function probeExplainerVideo(owner: ProcessOwner, p: ProbeParams): Promise<ProbeRun> {
  return runProbe(owner, p, checkExplainerProbeJson);
}

type ProbeParams = { readonly wrapFile: string; readonly wrapArgs: readonly string[]; readonly cwd: string; readonly deadlineAt: number; readonly actualBytes: number };

async function runProbe(owner: ProcessOwner, p: ProbeParams, check: (text: unknown, bytes: unknown) => ProbeCheck): Promise<ProbeRun> {
  const r = await owner.run({ file: p.wrapFile, args: [...p.wrapArgs, ...FFPROBE_ARGS], cwd: p.cwd, deadlineAt: p.deadlineAt, maxStdout: PROBE_MAX_STDOUT, maxStderr: 2048 });
  if (r.kind === 'fail') {
    if (r.reason === 'TIMEOUT') return { ok: false, code: 'TIMEOUT' };
    if (r.reason === 'CLEANUP_FAILED' || r.reason === 'BLOCKED') return { ok: false, code: 'CLEANUP_FAILED' };
    if (r.reason === 'STDIO_TOO_LARGE') return { ok: false, code: 'PROBE_REJECTED', reason: 'JSON' };
    return { ok: false, code: 'PROBE_FAILED' };
  }
  // 디코딩 오류(-v error 출력)도 거부한다
  if (r.code !== 0 || r.stderr.length > 0) return { ok: false, code: 'PROBE_FAILED' };
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(r.stdout);
  } catch {
    return { ok: false, code: 'PROBE_REJECTED', reason: 'JSON' };
  }
  const c = check(text, p.actualBytes);
  return c.ok ? { ok: true, report: c.report } : { ok: false, code: 'PROBE_REJECTED', reason: c.reason };
}
