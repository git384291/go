// 로컬 세로 자막 영상 renderer (PM 6954300094) — 가짜 process·가짜 도구 출력만. 실제 ffmpeg·폰트·영상 품질 증거가 아니다.
// 실제 렌더 증거는 scripts/video/render-sample.mjs(수동, CI 미연결)로 따로 낸다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, readdirSync, writeFileSync, symlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildStoryboard, wrapLines, NOTICE_TEXT, MAX_LINE_WIDTH } from '../../src/server/advertising/video/storyboard';
import { checkProbeJson, isFastStart, MAX_VIDEO_BYTES } from '../../src/server/advertising/video/videoProbe';
import { renderAdVideo, TOOLS, WRAP_ARGS, FONT_SHA256, LIMITS, onlyLoopback, limitsApplied, parseBbox, type RendererDeps } from '../../src/server/advertising/video/ffmpegRenderer';
import { ProcessOwner, FIXED_CHILD_ENV, type ChildLike, type FixedSpawnOptions } from '../../src/server/advertising/video/boundedProcess';
import { AD_DRAFTS } from '../../src/content/adDrafts';

const MOVING = { situationId: 'moving', copy: { title: AD_DRAFTS.moving.title, description: AD_DRAFTS.moving.description }, copySource: 'fixed_draft' };
// 시험 격리: 이 파일 전용 고유 루트를 만들고 TMPDIR을 그리로 돌린다. renderer의 tmpdir() 호출도 같은 루트를 쓰므로
// 시스템 tmp 전체의 fideon-video- 접두사를 비교하지 않는다(병렬 실행 중 다른 시험이 만들고 지우는 폴더에 흔들리지 않음).
const SYS_TMP = tmpdir();
const TEST_ROOT = mkdtempSync(path.join(SYS_TMP, 'fideon-vtest-'));
const PREV_TMPDIR = process.env.TMPDIR;
process.env.TMPDIR = TEST_ROOT;
const ownTmp = () => readdirSync(TEST_ROOT).filter((n) => n.startsWith('fideon-video-')).sort();
const tmpBefore = ownTmp();
after(() => {
  try {
    assert.deepEqual(ownTmp(), tmpBefore, '시험이 만든 임시 디렉터리 잔여 0');
  } finally {
    if (PREV_TMPDIR === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = PREV_TMPDIR;
    rmSync(TEST_ROOT, { recursive: true, force: true });
  }
});
test('TMP1 시험 격리: 타 소유 fideon-video- 폴더는 무시하고 고유 루트의 잔여는 감지', () => {
  assert.equal(tmpdir(), TEST_ROOT);
  const foreign = mkdtempSync(path.join(SYS_TMP, 'fideon-video-foreign-'));
  try {
    assert.deepEqual(ownTmp(), tmpBefore);
    const mine = mkdtempSync(path.join(tmpdir(), 'fideon-video-'));
    try {
      assert.notDeepEqual(ownTmp(), tmpBefore);
    } finally {
      rmSync(mine, { recursive: true, force: true });
    }
    assert.deepEqual(ownTmp(), tmpBefore);
  } finally {
    rmSync(foreign, { recursive: true, force: true });
  }
});

// ── 가짜 도구 출력 ──
const LIMITS_TEXT = [
  'Limit                     Soft Limit           Hard Limit           Units     ',
  `Max cpu time              ${LIMITS.cpuSeconds}                   ${LIMITS.cpuSeconds}                   seconds   `,
  `Max file size             ${LIMITS.fileSize}             ${LIMITS.fileSize}             bytes     `,
  `Max processes             ${LIMITS.nproc}                   ${LIMITS.nproc}                   processes `,
  `Max address space         ${LIMITS.addressSpace}           ${LIMITS.addressSpace}           bytes     `,
].join('\n');
const NETDEV_LO = 'Inter-|   Receive                                                |  Transmit\n face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n    lo:       0       0    0    0    0     0          0         0        0       0    0    0    0     0       0          0\n';
const NETDEV_ETH = NETDEV_LO + '  eth0:  100 1 0 0 0 0 0 0 100 1 0 0 0 0 0 0\n';
const FILTERS = ' T.C drawbox            V->V       Draw a colored box\n TSC drawtext           V->V       Draw text\n ... bbox               V->V       Compute bbox\n';
const ENCODERS = ' V....D libx264              libx264 H.264\n';
const box = (type: string, payload: number) => {
  const b = new Uint8Array(8 + payload);
  const n = 8 + payload;
  b.set([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255], 0);
  b.set([...type].map((c) => c.charCodeAt(0)), 4);
  return b;
};
const mp4 = (order: ('ftyp' | 'moov' | 'mdat')[] = ['ftyp', 'moov', 'mdat'], mdat = 900) => {
  const parts = order.map((t) => box(t, t === 'mdat' ? mdat : 24));
  const n = parts.reduce((a, p) => a + p.byteLength, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
};
const probeJson = (size: number, patch: (j: { streams: Record<string, unknown>[]; format: Record<string, unknown> }) => void = () => {}) => {
  const j = {
    programs: [],
    streams: [{ index: 0, codec_name: 'h264', profile: 'High', codec_type: 'video', width: 720, height: 1280, pix_fmt: 'yuv420p', r_frame_rate: '30/1', avg_frame_rate: '30/1', nb_read_frames: '540' }],
    format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '18.000000', size: String(size) },
  };
  patch(j);
  return JSON.stringify(j);
};

type Stage = 'iso' | 'filters' | 'encoders' | 'measure' | 'render' | 'decode' | 'probe' | 'frames';
type Behavior = { code?: number; stdout?: string; stderr?: string; hang?: boolean; noPid?: boolean; throwSync?: boolean; write?: (cwd: string) => void; flood?: boolean };
const stageOf = (args: readonly string[]): Stage => {
  const a = args.slice(WRAP_ARGS.length);
  if (a[0] === TOOLS.cat) return 'iso';
  if (a[0] === TOOLS.ffprobe) return 'probe';
  if (a.includes('-filters')) return 'filters';
  if (a.includes('-encoders')) return 'encoders';
  if (a.some((x) => x.includes('bbox'))) return 'measure';
  if (a.includes('-c:v')) return 'render';
  if (a.includes('-filter_complex')) return 'frames';
  if (a.includes('-map')) return 'decode';
  throw new Error('unknown stage');
};

type Spawned = { file: string; args: readonly string[]; opts: FixedSpawnOptions; stage: Stage; pid: number | undefined; child: FakeChild };
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exited = false;
  constructor(readonly pid: number | undefined) {
    super();
  }
  finish(code: number | null, signal: string | null = null) {
    if (this.exited) return;
    this.exited = true;
    this.emit('exit', code, signal);
  }
}

function harness(over: Partial<Record<Stage, Behavior>> = {}, opt: { killFails?: boolean; killNoExit?: boolean; lateExitMs?: number } = {}) {
  const spawned: Spawned[] = [];
  const kills: number[] = [];
  let nextPid = 4000;
  const defaults = (stage: Stage, cwd: string): Behavior => {
    switch (stage) {
      case 'iso': return { stdout: `${LIMITS_TEXT}\n${NETDEV_LO}` };
      case 'filters': return { stdout: FILTERS };
      case 'encoders': return { stdout: ENCODERS };
      case 'measure': {
        const n = readdirSync(cwd).filter((f) => /^m\d+\.txt$/.test(f)).length;
        return { stderr: Array.from({ length: n }, (_, i) => `[Parsed_bbox_${n} @ 0x1] n:${i} pts:${i} pts_time:${i} x1:108 x2:400 y1:40 y2:90 w:300 h:40 crop=1`).join('\n') };
      }
      case 'render': return { write: (d) => writeFileSync(path.join(d, 'out.mp4'), mp4()) };
      case 'decode': return {};
      case 'probe': return { stdout: probeJson(mp4().byteLength) };
      case 'frames': return { write: (d) => { for (const w of [720, 390, 320]) for (const t of [0, 1, 2]) { const p = path.join(d, `f${t}_${w}.png`); if (!existsSync(p)) writeFileSync(p, new Uint8Array([137, 80, 78, 71, 1, 2, 3])); } } };
    }
  };
  const deps: RendererDeps = {
    spawn: (file, args, opts) => {
      const stage = stageOf(args);
      const b = { ...defaults(stage, opts.cwd), ...(over[stage] ?? {}) };
      if (b.throwSync) throw new Error('spawn EAGAIN /secret/path');
      const pid = b.noPid ? undefined : nextPid++;
      const child = new FakeChild(pid);
      spawned.push({ file, args, opts, stage, pid, child });
      setImmediate(() => {
        if (b.noPid) {
          child.emit('error', new Error('ENOENT'));
          return;
        }
        if (b.flood) {
          for (let i = 0; i < 200; i++) child.stdout.emit('data', new Uint8Array(4096));
        }
        if (b.stdout) child.stdout.emit('data', new TextEncoder().encode(b.stdout));
        if (b.stderr) child.stderr.emit('data', new TextEncoder().encode(b.stderr));
        if (b.hang || b.flood) return;
        b.write?.(opts.cwd);
        child.finish(b.code ?? 0);
      });
      return child as unknown as ChildLike;
    },
    killGroup: (pid) => {
      kills.push(pid);
      const s = spawned.find((x) => x.pid === pid);
      if (opt.killFails) throw new Error('EPERM');
      if (opt.killNoExit || !s) return;
      if (opt.lateExitMs) setTimeout(() => s.child.finish(null, 'SIGKILL'), opt.lateExitMs);
      else setImmediate(() => s.child.finish(null, 'SIGKILL'));
    },
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as NodeJS.Timeout),
    killWaitMs: 60,
    totalTimeoutMs: 5_000,
    fs: { checkExecutable: async () => true, fontDigest: async () => FONT_SHA256 },
  };
  return { deps, spawned, kills };
}

// ── storyboard (순수) ──
test('VR1 storyboard: 고정 초안 → 3장면, 설명 4줄, 고정 안내, 동결·원본 불변', () => {
  const input = structuredClone(MOVING);
  const before = JSON.stringify(input);
  const r = buildStoryboard(input);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const sb = r.storyboard;
  assert.deepEqual(sb.scenes.map((s) => [s.id, s.start, s.end, s.fontSize]), [['title', 0, 5, 64], ['description', 5, 13, 48], ['notice', 13, 18, 40]]);
  assert.deepEqual(sb.scenes[0]!.lines.map((l) => l.text), ['이사 전', '인터넷·TV 확인']);
  assert.equal(sb.scenes[1]!.lines.length, 4, '설명 4줄 경우 포함');
  assert.equal(sb.scenes[1]!.lines.map((l) => l.text).join(' '), AD_DRAFTS.moving.description);
  assert.equal(sb.scenes[2]!.lines.map((l) => l.text).join(' '), NOTICE_TEXT);
  assert.equal(sb.copySource, 'fixed_draft');
  assert.equal(sb.durationSec, 18);
  assert.ok(Object.isFrozen(sb) && Object.isFrozen(sb.scenes) && Object.isFrozen(sb.scenes[1]!.lines));
  assert.equal(JSON.stringify(input), before, '입력 원본 불변');
  // 고정 초안 3종 모두 줄 수 안에 들어간다(추정 폭 기준 후보. 실제 폭은 renderer 측정이 판정)
  for (const id of ['moving', 'contract_end', 'general_compare'] as const) {
    const d = AD_DRAFTS[id];
    const rr = buildStoryboard({ situationId: id, copy: { title: d.title, description: d.description }, copySource: 'fixed_draft' });
    assert.equal(rr.ok, true, id);
    if (rr.ok) assert.deepEqual(rr.storyboard.scenes.map((s) => s.lines.map((l) => l.text).join(' ')), [d.title, d.description, NOTICE_TEXT], id);
  }
  assert.deepEqual(buildStoryboard(input), r, '결정적');
  // 문구는 copy와 고정 안내에서만
  const all = sb.scenes.flatMap((s) => s.lines.map((l) => l.text)).join(' ');
  for (const w of all.split(' ')) assert.ok((AD_DRAFTS.moving.title + ' ' + AD_DRAFTS.moving.description + ' ' + NOTICE_TEXT).includes(w), w);
});

test('VR2 storyboard: 불량 입력·주입 문자·임의 장면 필드는 INVALID_INPUT', () => {
  const bad: unknown[] = [
    null, [], 'x', { ...MOVING, extra: 1 }, { ...MOVING, situationId: 'other' }, { ...MOVING, copySource: 'ai' },
    { ...MOVING, copy: { ...MOVING.copy, color: '0xff0000' } }, { ...MOVING, scenes: [] },
    { situationId: 'moving', copy: { title: '인터넷 %{pts}', description: MOVING.copy.description }, copySource: 'model' },
    { situationId: 'moving', copy: { title: "인터넷'TV", description: MOVING.copy.description }, copySource: 'model' },
    { situationId: 'moving', copy: { title: '인터넷:TV', description: MOVING.copy.description }, copySource: 'model' },
    { situationId: 'moving', copy: { title: '인터넷\\TV', description: MOVING.copy.description }, copySource: 'model' },
    { situationId: 'moving', copy: { title: '인터넷\nTV', description: MOVING.copy.description }, copySource: 'model' },
    { situationId: 'moving', copy: { title: '인터넷 확인', description: '새집 조건을 확인하세요 http www 링크는 별도로 확인합니다' }, copySource: 'model' },
    { situationId: 'moving', copy: Object.create({ title: 'a', description: 'b' }), copySource: 'model' },
  ];
  for (const b of bad) assert.deepEqual(buildStoryboard(b), { ok: false, error: 'INVALID_INPUT' }, JSON.stringify(b));
  // 접근자는 한 번만 읽는다(두 번째 읽기에서 다른 값을 내도 쓰이지 않음)
  let reads = 0;
  const copy = { get title() { reads++; return reads === 1 ? '이사 전 인터넷 확인' : '%{pts} 주입'; }, description: MOVING.copy.description };
  const r = buildStoryboard({ situationId: 'moving', copy, copySource: 'model' });
  assert.equal(r.ok, true);
  assert.equal(reads, 1);
  if (r.ok) assert.ok(!JSON.stringify(r.storyboard).includes('%{'));
});

test('VR3 storyboard: 줄 수 초과는 LAYOUT_TOO_LONG, 긴 단어는 서기소 단위로 분할', () => {
  const long = { situationId: 'moving', copy: { title: '인터넷 확인', description: '가나다라마바사 가나다라마바사 가나다라마바사 가나다라마바사 가나다라마바사 가나' }, copySource: 'model' };
  assert.deepEqual(buildStoryboard(long), { ok: false, error: 'LAYOUT_TOO_LONG' });
  assert.deepEqual(wrapLines('가나다라마바사아자차카타파하', 9), ['가나다라마바사아자', '차카타파하']);
  assert.deepEqual(wrapLines('ééé', 2), ['éé', 'é'], '결합 문자를 쪼개지 않음');
});

// ── probe 판정 (순수) ──
test('VR4 probe: 정상 판정과 불신 JSON 반례', () => {
  const n = 1000;
  const ok = checkProbeJson(probeJson(n), n);
  assert.equal(ok.ok, true);
  const cases: [string, unknown, unknown, string][] = [
    ['null', 'null', n, 'SHAPE'],
    ['손상', '{"streams":[', n, 'JSON'],
    ['오디오 추가', probeJson(n, (j) => { j.streams.push({ codec_type: 'audio', codec_name: 'aac' }); }), n, 'STREAM_COUNT'],
    ['비디오 2개', probeJson(n, (j) => { j.streams.push({ ...j.streams[0]! }); }), n, 'STREAM_COUNT'],
    ['스트림 0', probeJson(n, (j) => { j.streams.length = 0; }), n, 'STREAM_COUNT'],
    ['코덱', probeJson(n, (j) => { j.streams[0]!.codec_name = 'hevc'; }), n, 'CODEC'],
    ['프로필', probeJson(n, (j) => { j.streams[0]!.profile = 'Main'; }), n, 'PROFILE'],
    ['폭 문자열', probeJson(n, (j) => { j.streams[0]!.width = '720'; }), n, 'SIZE_DIMENSIONS'],
    ['해상도', probeJson(n, (j) => { j.streams[0]!.height = 1920; }), n, 'SIZE_DIMENSIONS'],
    ['pix_fmt', probeJson(n, (j) => { j.streams[0]!.pix_fmt = 'yuv444p'; }), n, 'PIX_FMT'],
    ['fps', probeJson(n, (j) => { j.streams[0]!.avg_frame_rate = '25/1'; }), n, 'FPS'],
    ['프레임 수', probeJson(n, (j) => { j.streams[0]!.nb_read_frames = '539'; }), n, 'FRAMES'],
    ['프레임 숫자형', probeJson(n, (j) => { j.streams[0]!.nb_read_frames = 540; }), n, 'FRAMES'],
    ['길이 짧음', probeJson(n, (j) => { j.format.duration = '17.0'; }), n, 'DURATION'],
    ['길이 NaN', probeJson(n, (j) => { j.format.duration = 'NaN'; }), n, 'DURATION'],
    ['길이 지수', probeJson(n, (j) => { j.format.duration = '1.8e1'; }), n, 'DURATION'],
    ['길이 누락', probeJson(n, (j) => { delete j.format.duration; }), n, 'DURATION'],
    ['형식', probeJson(n, (j) => { j.format.format_name = 'matroska,webm'; }), n, 'FORMAT'],
    ['크기 불일치', probeJson(999), n, 'BYTES'],
    ['크기 음수', probeJson(n, (j) => { j.format.size = '-1'; }), n, 'BYTES'],
    ['실제 크기 불량', probeJson(n), Number.NaN, 'BYTES'],
    ['5MiB 초과', probeJson(MAX_VIDEO_BYTES + 1), MAX_VIDEO_BYTES + 1, 'TOO_LARGE'],
  ];
  for (const [name, text, bytes, reason] of cases) assert.deepEqual(checkProbeJson(text, bytes), { ok: false, reason }, name);
  assert.equal(isFastStart(mp4()), true);
  assert.equal(isFastStart(mp4(['ftyp', 'mdat', 'moov'])), false);
  assert.equal(isFastStart(new Uint8Array([0, 0, 0, 1])), false);
});

test('VR5 준비 판정 helper: 격리·한도·bbox 파싱', () => {
  assert.equal(onlyLoopback(NETDEV_LO), true);
  assert.equal(onlyLoopback(NETDEV_ETH), false);
  assert.equal(onlyLoopback(''), false);
  assert.equal(limitsApplied(LIMITS_TEXT), true);
  assert.equal(limitsApplied(LIMITS_TEXT.replace(`${LIMITS.cpuSeconds}                   ${LIMITS.cpuSeconds}`, `unlimited            unlimited`)), false);
  assert.deepEqual(parseBbox('n:0 pts:0 pts_time:0 x1:1 x2:2 y1:3 y2:4 w:10 h:20 \n n:1 pts:1 pts_time:1 x1:1 x2:2 y1:3 y2:4 w:11 h:21', 2), [{ w: 10, h: 20 }, { w: 11, h: 21 }]);
  assert.equal(parseBbox('n:0 pts:0 pts_time:0 x1:1 x2:2 y1:3 y2:4 w:10 h:20', 2), null, '누락');
  assert.equal(parseBbox('n:0 pts:0 pts_time:0 x1:1 x2:2 y1:3 y2:4 w:10 h:20\nn:0 pts:0 pts_time:0 x1:1 x2:2 y1:3 y2:4 w:10 h:20', 1), null, '중복');
});

// ── renderer (가짜 process) ──
test('VR6 정상 경로: 고정 실행·최소 env·문구는 textfile로만, 결과·정리 확인', async () => {
  const h = harness();
  const r = await renderAdVideo(structuredClone(MOVING), { ...h.deps, frames: true });
  assert.equal(r.code, 'RENDERED', JSON.stringify(r));
  if (!r.ok) return;
  assert.equal(r.cleanup, 'OK');
  assert.equal(r.copySource, 'fixed_draft');
  assert.equal(r.frames.length, 9);
  assert.deepEqual(h.spawned.map((s) => s.stage), ['iso', 'filters', 'encoders', 'measure', 'render', 'decode', 'probe', 'frames', 'frames', 'frames']);
  assert.equal(r.spawned, h.spawned.length);
  const words = [...MOVING.copy.title.split(' '), ...MOVING.copy.description.split(' ')].filter((w) => w.length >= 2);
  for (const s of h.spawned) {
    assert.equal(s.file, TOOLS.unshare);
    assert.deepEqual(s.args.slice(0, WRAP_ARGS.length), WRAP_ARGS);
    assert.ok((Object.values(TOOLS) as readonly string[]).includes(s.args[WRAP_ARGS.length]!), '고정 도구');
    assert.deepEqual(s.opts, { cwd: s.opts.cwd, env: FIXED_CHILD_ENV, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    assert.deepEqual(Object.keys(s.opts.env), ['LC_ALL'], 'env 비상속');
    assert.match(s.opts.cwd, new RegExp(`^${tmpdir()}/fideon-video-[A-Za-z0-9]+$`));
    const joined = s.args.join(' ');
    for (const w of words) assert.ok(!joined.includes(w), `문구가 인자에 없음: ${w}`);
    assert.ok(!/https?:|tcp:|udp:|rtmp|concat|movie=|amovie|subtitles=|\.\./.test(joined), '외부 입력·프로토콜 없음');
    if (s.stage !== 'iso' && s.stage !== 'probe') assert.ok(s.args.includes('-nostdin'), 'ffmpeg은 -nostdin(모든 자식 stdin은 ignore)');
  }
  const render = h.spawned.find((s) => s.stage === 'render')!;
  const vf = render.args[render.args.indexOf('-vf') + 1]!;
  assert.equal((vf.match(/drawtext=/g) ?? []).length, 8, '제목 2 + 설명 4 + 안내 2');
  assert.equal((vf.match(/expansion=none:reload=0/g) ?? []).length, 8);
  assert.ok(!/fontconfig|font=/.test(vf.replace(/fontfile=|fontsize=|fontcolor=/g, '')), 'fontconfig 이름 미사용');
  assert.ok(render.args.includes('-an') && render.args.includes('+faststart'));
  assert.equal(render.args.at(-1), 'file:out.mp4');
  assert.equal(render.args.filter((a) => a === '-protocol_whitelist').length, 2);
  assert.equal(render.args[render.args.indexOf('-i') + 1], 'color=c=0x0b1f3a:s=720x1280:r=30:d=18', '고정 lavfi 입력 하나');
  assert.equal(render.args.filter((a) => a === '-i').length, 1);
  assert.ok(!existsSync(render.opts.cwd), '자기 임시 디렉터리 삭제');
});

test('VR7 불량 입력·deps는 spawn 0, 임시 디렉터리 0', async () => {
  for (const input of [null, { ...MOVING, extra: 1 }, { ...MOVING, copy: { title: '%{pts}', description: MOVING.copy.description } }]) {
    const h = harness();
    const r = await renderAdVideo(input, h.deps);
    assert.deepEqual([r.code, r.spawned, r.cleanup], ['INVALID_INPUT', 0, 'NOT_NEEDED']);
    assert.equal(h.spawned.length, 0);
  }
  for (const bad of [{ totalTimeoutMs: 0 }, { totalTimeoutMs: 999_999 }, { totalTimeoutMs: Number.NaN }, { killWaitMs: 0 }, { spawn: null }]) {
    const h = harness();
    const r = await renderAdVideo(MOVING, { ...h.deps, ...bad } as unknown as RendererDeps);
    assert.equal(r.code, 'INVALID_INPUT');
    assert.equal(h.spawned.length, 0);
  }
});

test('VR8 준비 막힘: 도구·격리·한도·폰트·필터 → 고정 코드, 렌더 0, 자동설치·fallback 0', async () => {
  const cases: [string, Parameters<typeof harness>[0], Partial<RendererDeps>, string, number][] = [
    ['도구 없음', {}, { fs: { checkExecutable: async (f: string) => f !== TOOLS.ffmpeg, fontDigest: async () => FONT_SHA256 } }, 'NOT_AVAILABLE', 0],
    ['unshare 권한 없음', { iso: { code: 1 } }, {}, 'NETWORK_ISOLATION_UNAVAILABLE', 1],
    ['격리 안에 eth0', { iso: { stdout: `${LIMITS_TEXT}\n${NETDEV_ETH}` } }, {}, 'NETWORK_ISOLATION_UNAVAILABLE', 1],
    ['한도 미적용', { iso: { stdout: `${LIMITS_TEXT.replace(String(LIMITS.addressSpace), 'unlimited')}\n${NETDEV_LO}` } }, {}, 'LIMITS_UNAVAILABLE', 1],
    ['폰트 해시 불일치', {}, { fs: { checkExecutable: async () => true, fontDigest: async () => 'a'.repeat(64) } }, 'FONT_UNAVAILABLE', 1],
    ['폰트 없음', {}, { fs: { checkExecutable: async () => true, fontDigest: async () => null } }, 'FONT_UNAVAILABLE', 1],
    ['drawtext 없음', { filters: { stdout: ' T.C drawbox V->V x\n ... bbox V->V x\n' } }, {}, 'UNSUPPORTED', 3],
    ['libx264 없음', { encoders: { stdout: ' V....D libx265 x\n' } }, {}, 'UNSUPPORTED', 3],
  ];
  for (const [name, over, extra, code, spawns] of cases) {
    const h = harness(over);
    const r = await renderAdVideo(MOVING, { ...h.deps, ...extra });
    assert.equal(r.code, code, name);
    assert.equal(h.spawned.length, spawns, name);
    assert.ok(!h.spawned.some((s) => s.stage === 'render'), name);
    assert.notEqual(r.cleanup, 'FAILED', name);
  }
});

test('VR9 실제 폰트 측정: 폭 600 초과·높이 초과·측정 누락은 렌더 0', async () => {
  const wide = harness({ measure: { stderr: 'n:0 pts:0 pts_time:0 x1:1 x2:2 y1:3 y2:4 w:' + (MAX_LINE_WIDTH + 1) + ' h:40' } });
  // 8줄 중 1줄만 보고하면 측정 누락
  const r0 = await renderAdVideo(MOVING, wide.deps);
  assert.equal(r0.code, 'RENDER_FAILED');
  const mk = (w: number, hgt: number) => ({ stderr: Array.from({ length: 8 }, (_, i) => `n:${i} pts:${i} pts_time:${i} x1:1 x2:2 y1:3 y2:4 w:${i === 4 ? w : 300} h:${i === 4 ? hgt : 40}`).join('\n') });
  for (const [w, hgt] of [[MAX_LINE_WIDTH + 1, 40], [300, 200]] as const) {
    const h = harness({ measure: mk(w, hgt) });
    const r = await renderAdVideo(MOVING, h.deps);
    assert.equal(r.code, 'LAYOUT_OVERFLOW');
    assert.ok(!h.spawned.some((s) => s.stage === 'render'));
    assert.equal(r.cleanup, 'OK');
  }
  const okAt600 = harness({ measure: mk(MAX_LINE_WIDTH, 40) });
  assert.equal((await renderAdVideo(MOVING, okAt600.deps)).code, 'RENDERED', '경계 600px 통과');
});

test('VR10 spawn 예외·ENOENT·exit≠0: 고정 코드, stderr·경로 비반환, 다음 단계 0', async () => {
  const sync = harness({ render: { throwSync: true } });
  const r1 = await renderAdVideo(MOVING, sync.deps);
  assert.equal(r1.code, 'RENDER_FAILED');
  assert.ok(!sync.spawned.some((s) => s.stage === 'decode'));
  const enoent = harness({ iso: { noPid: true } });
  const r2 = await renderAdVideo(MOVING, enoent.deps);
  assert.equal(r2.code, 'NETWORK_ISOLATION_UNAVAILABLE');
  assert.equal(enoent.spawned.length, 1);
  const exit = harness({ render: { code: 1, stderr: 'Error /secret/key=abc DATABASE_URL=postgres://x' } });
  const r3 = await renderAdVideo(MOVING, exit.deps);
  assert.equal(r3.code, 'RENDER_FAILED');
  assert.ok(!/secret|DATABASE|postgres|\/tmp/.test(JSON.stringify(r3)), '원문 비반환');
  const dec = harness({ decode: { stderr: '[h264 @ 0x1] error while decoding MB 1 1' } });
  assert.equal((await renderAdVideo(MOVING, dec.deps)).code, 'DECODE_FAILED');
  const pf = harness({ probe: { stderr: 'corrupt' } });
  assert.equal((await renderAdVideo(MOVING, pf.deps)).code, 'PROBE_FAILED');
});

test('VR11 실제 파일 판정: 5MiB 초과는 probe 0, symlink 출력 거부, faststart 아님 거부, probe 반례', async () => {
  const big = harness({ render: { write: (d) => writeFileSync(path.join(d, 'out.mp4'), new Uint8Array(MAX_VIDEO_BYTES + 1)) } });
  const r1 = await renderAdVideo(MOVING, big.deps);
  assert.equal(r1.code, 'TOO_LARGE');
  assert.ok(!big.spawned.some((s) => s.stage === 'decode' || s.stage === 'probe'));
  const link = harness({ render: { write: (d) => symlinkSync('/etc/hostname', path.join(d, 'out.mp4')) } });
  assert.equal((await renderAdVideo(MOVING, link.deps)).code, 'RENDER_FAILED');
  const slow = harness({ render: { write: (d) => writeFileSync(path.join(d, 'out.mp4'), mp4(['ftyp', 'mdat', 'moov'])) } });
  const r3 = await renderAdVideo(MOVING, slow.deps);
  assert.deepEqual([r3.code, r3.ok ? null : r3.reason], ['PROBE_REJECTED', 'FORMAT']);
  const audio = harness({ probe: { stdout: probeJson(mp4().byteLength, (j) => { j.streams.push({ codec_type: 'audio' }); }) } });
  const r4 = await renderAdVideo(MOVING, audio.deps);
  assert.deepEqual([r4.code, r4.ok ? null : r4.reason], ['PROBE_REJECTED', 'STREAM_COUNT']);
  const lie = harness({ probe: { stdout: probeJson(10) } });
  const r5 = await renderAdVideo(MOVING, lie.deps);
  assert.deepEqual([r5.code, r5.ok ? null : r5.reason], ['PROBE_REJECTED', 'BYTES'], 'JSON size만 신뢰하지 않음');
});

test('VR12 시간 초과: 소유 그룹에만 SIGKILL 1회, 종료 확인 후 TIMEOUT·정리 OK, 마감 뒤 새 process 0', async () => {
  const h = harness({ render: { hang: true } });
  const t0 = Date.now();
  const r = await renderAdVideo(MOVING, { ...h.deps, totalTimeoutMs: 1_000 });
  assert.equal(r.code, 'TIMEOUT');
  assert.equal(r.cleanup, 'OK');
  const render = h.spawned.find((s) => s.stage === 'render')!;
  assert.deepEqual(h.kills, [render.pid], '자기 pid 그룹만');
  assert.equal(h.spawned.at(-1)!.stage, 'render', '마감 뒤 새 process 0');
  assert.ok(Date.now() - t0 < 3_000);
  assert.ok(!existsSync(render.opts.cwd));
});

test('VR13 종료 확인 실패: kill 예외·무응답 → CLEANUP_FAILED, 원래 실패 보존, 후속 기동 0, 디렉터리 보존', async () => {
  for (const opt of [{ killFails: true }, { killNoExit: true }]) {
    const h = harness({ measure: { hang: true } }, opt);
    const r = await renderAdVideo(MOVING, { ...h.deps, totalTimeoutMs: 1_000 });
    assert.equal(r.code, 'CLEANUP_FAILED');
    assert.equal(r.cleanup, 'FAILED');
    assert.ok(!h.spawned.some((s) => s.stage === 'render'), '후속 기동 0');
    assert.equal(h.kills.length, 1, '중복 신호 없음(정리 단계 포함)');
    const m = h.spawned.find((s) => s.stage === 'measure')!;
    assert.ok(existsSync(m.opts.cwd), '종료 미확인 자식이 쓰는 디렉터리는 지우지 않음(정리 완료로 주장하지 않음)');
    // 시험 정리: 자식을 끝내고 디렉터리 제거
    m.child.finish(null, 'SIGKILL');
    const { rmSync } = await import('node:fs');
    rmSync(m.opts.cwd, { recursive: true, force: true });
  }
});

test('VR14 출력 한도 초과: 즉시 중단·OUTPUT_TOO_LARGE, 늦은 종료는 정리에 반영', async () => {
  const h = harness({ filters: { flood: true } }, { lateExitMs: 20 });
  const r = await renderAdVideo(MOVING, h.deps);
  assert.equal(r.code, 'OUTPUT_TOO_LARGE');
  assert.equal(r.cleanup, 'OK', 'killWaitMs 안의 늦은 종료는 정리 성공');
  assert.equal(h.kills.length, 1);
  const late = harness({ filters: { flood: true } }, { lateExitMs: 500 });
  const r2 = await renderAdVideo(MOVING, late.deps);
  assert.equal(r2.code, 'CLEANUP_FAILED', 'killWaitMs를 넘긴 종료는 성공으로 뒤집지 않음');
  if (!r2.ok) assert.equal(r2.primary, undefined);
  await new Promise((res) => setTimeout(res, 600));
  const f = late.spawned.find((s) => s.stage === 'filters')!;
  assert.equal(f.child.exited, true);
  const { rmSync } = await import('node:fs');
  rmSync(f.opts.cwd, { recursive: true, force: true });
});

test('VR15 정리 실패는 RENDERED와 함께 숨기지 않는다', async () => {
  const h = harness();
  const r = await renderAdVideo(MOVING, { ...h.deps, fs: { checkExecutable: async () => true, fontDigest: async () => FONT_SHA256, removeDir: async () => { throw new Error('EBUSY'); } } });
  assert.deepEqual([r.ok, r.code, r.cleanup], [false, 'CLEANUP_FAILED', 'FAILED']);
  const dir = h.spawned[0]!.opts.cwd;
  const { rmSync } = await import('node:fs');
  rmSync(dir, { recursive: true, force: true });
  const h2 = harness({ render: { code: 1 } });
  const r2 = await renderAdVideo(MOVING, { ...h2.deps, fs: { checkExecutable: async () => true, fontDigest: async () => FONT_SHA256, removeDir: async () => {} } });
  assert.deepEqual([r2.code, r2.ok ? null : r2.primary], ['CLEANUP_FAILED', 'RENDER_FAILED'], '원래 실패 보존');
  rmSync(h2.spawned[0]!.opts.cwd, { recursive: true, force: true });
});

test('VR16 ProcessOwner: 마감 지난 run은 spawn 0, BLOCKED 이후 spawn 0, settleAll 멱등', async () => {
  const h = harness();
  const o = new ProcessOwner(h.deps);
  assert.deepEqual(await o.run({ file: TOOLS.unshare, args: [...WRAP_ARGS, TOOLS.cat], cwd: tmpdir(), deadlineAt: Date.now() - 1, maxStdout: 10, maxStderr: 10 }), { kind: 'fail', reason: 'TIMEOUT' });
  assert.equal(o.spawnCount, 0);
  o.blocked = true;
  assert.deepEqual(await o.run({ file: TOOLS.unshare, args: [...WRAP_ARGS, TOOLS.cat], cwd: tmpdir(), deadlineAt: Date.now() + 1000, maxStdout: 10, maxStderr: 10 }), { kind: 'fail', reason: 'BLOCKED' });
  assert.equal(o.spawnCount, 0);
  assert.equal(await o.settleAll(), true);
  assert.equal(await o.settleAll(), true);
  assert.equal(h.kills.length, 0);
});

test('VR17 정적: env·shell·fetch·네트워크·설치·다른 명령 없음, 고정 실행 파일 목록', () => {
  const files = ['storyboard.ts', 'ffmpegRenderer.ts', 'videoProbe.ts', 'boundedProcess.ts'].map((f) => `src/server/advertising/video/${f}`);
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    const code = src.replace(/^\s*\/\/.*$/gm, '');
    assert.match(src, /^import 'server-only';/, f);
    assert.ok(!/process\.env|fetch\(|console\.|shell:\s*true|execSync|execFile|exec\(|child_process|require\(|import\(|https?:\/\/|\bnpm |\bapt(-get)? |\bcurl\b|\bwget\b/.test(code), f);
  }
  const rend = readFileSync(files[1]!, 'utf8');
  assert.deepEqual([...rend.matchAll(/'(\/usr\/[^']+)'/g)].map((m) => m[1]).sort(), [
    '/usr/bin/cat', '/usr/bin/ffprobe', '/usr/bin/prlimit', '/usr/bin/unshare', '/usr/local/bin/ffmpeg', '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc',
  ]);
  assert.ok(!/upload|publish|youtube|openai|generateAdCopy|prepareYoutube/i.test(rend.replace(/^\s*\/\/.*$/gm, '')), '생성·업로드 연결 없음');
  assert.ok(!existsSync('src/server/advertising/video/videoAdPipeline.ts'), '조합 파이프라인은 이번 범위 아님');
});
