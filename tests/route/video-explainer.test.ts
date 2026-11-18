// 30초 무음 화면 시안 renderer (PM 6983216833) — 가짜 process·가짜 도구 출력만.
// 실제 ffmpeg·폰트·화면 품질 증거가 아니다. 실제 렌더 증거는 scripts/video/render-explainer-sample.mjs(수동, CI 미연결).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildExplainerStoryboard, validateExplainerPlan, EXPLAINER_PLAN, EX_VARIANT, TEXT_RE } from '../../src/server/advertising/video/explainerStoryboard';
import { renderExplainerVideo, buildExplainerFilter, spriteGeq, EX_WRAP_ARGS, EX_LIMITS, exLimitsApplied, type ExplainerDeps } from '../../src/server/advertising/video/explainerRenderer';
import { checkExplainerProbeJson, checkProbeJson, MAX_VIDEO_BYTES } from '../../src/server/advertising/video/videoProbe';
import { TOOLS, WRAP_ARGS, LIMITS, FONT_SHA256 } from '../../src/server/advertising/video/ffmpegRenderer';
import { FIXED_CHILD_ENV, type ChildLike, type FixedSpawnOptions } from '../../src/server/advertising/video/boundedProcess';

const INPUT = { variant: EX_VARIANT };
const ownTmp = () => readdirSync(tmpdir()).filter((n) => n.startsWith('fideon-video-')).sort();
const tmpBefore = ownTmp();
after(() => assert.deepEqual(ownTmp(), tmpBefore, '시험이 만든 임시 디렉터리 잔여 0'));

const limitsText = (as: number) => [
  'Limit                     Soft Limit           Hard Limit           Units     ',
  `Max cpu time              ${EX_LIMITS.cpuSeconds}                   ${EX_LIMITS.cpuSeconds}                   seconds   `,
  `Max file size             ${EX_LIMITS.fileSize}             ${EX_LIMITS.fileSize}             bytes     `,
  `Max processes             ${EX_LIMITS.nproc}                   ${EX_LIMITS.nproc}                   processes `,
  `Max address space         ${as}           ${as}           bytes     `,
].join('\n');
const NETDEV_LO = 'Inter-|   Receive |  Transmit\n face |bytes packets|bytes packets\n    lo: 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n';
const FILTERS = ['drawtext', 'bbox', 'geq', 'overlay', 'loop', 'fade', 'trim', 'color', 'setpts', 'format'].map((f) => ` ... ${f}  V->V  x`).join('\n') + '\n';
const ENCODERS = ' V....D libx264              libx264 H.264\n';
const box = (type: string, payload: number) => {
  const n = 8 + payload;
  const b = new Uint8Array(n);
  b.set([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255], 0);
  b.set([...type].map((c) => c.charCodeAt(0)), 4);
  return b;
};
const mp4 = (order = ['ftyp', 'moov', 'mdat']) => {
  const parts = order.map((t) => box(t, t === 'mdat' ? 900 : 24));
  const out = new Uint8Array(parts.reduce((a, p) => a + p.byteLength, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
};
const probe = (size: number, frames = '900', duration = '30.000000', extra = false) =>
  JSON.stringify({
    streams: [{ index: 0, codec_name: 'h264', profile: 'High', codec_type: 'video', width: 720, height: 1280, pix_fmt: 'yuv420p', r_frame_rate: '30/1', avg_frame_rate: '30/1', nb_read_frames: frames }, ...(extra ? [{ codec_type: 'audio' }] : [])],
    format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration, size: String(size) },
  });

type Stage = 'iso' | 'filters' | 'encoders' | 'measure' | 'render' | 'decode' | 'probe' | 'frames';
type Behavior = { code?: number; stdout?: string; stderr?: string; hang?: boolean; flood?: boolean; throwSync?: boolean; write?: (cwd: string) => void };
const stageOf = (args: readonly string[]): Stage => {
  const a = args.slice(EX_WRAP_ARGS.length);
  if (a[0] === TOOLS.cat) return 'iso';
  if (a[0] === TOOLS.ffprobe) return 'probe';
  if (a.includes('-filters')) return 'filters';
  if (a.includes('-encoders')) return 'encoders';
  if (a.some((x) => x.includes('bbox'))) return 'measure';
  if (a.includes('-c:v')) return 'render';
  if (a.includes('-ss')) return 'frames';
  return 'decode';
};
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exited = false;
  constructor(readonly pid: number) {
    super();
  }
  finish(code: number | null, signal: string | null = null) {
    if (this.exited) return;
    this.exited = true;
    this.emit('exit', code, signal);
  }
}
type Spawned = { file: string; args: readonly string[]; opts: FixedSpawnOptions; stage: Stage; pid: number; child: FakeChild };

function harness(over: Partial<Record<Stage, Behavior>> = {}, opt: { killNoExit?: boolean; lateExitMs?: number } = {}) {
  const spawned: Spawned[] = [];
  const kills: number[] = [];
  let pid = 7000;
  const defaults = (stage: Stage, cwd: string): Behavior => {
    switch (stage) {
      case 'iso': return { stdout: `${limitsText(EX_LIMITS.addressSpace)}\n${NETDEV_LO}` };
      case 'filters': return { stdout: FILTERS };
      case 'encoders': return { stdout: ENCODERS };
      case 'measure': {
        const n = readdirSync(cwd).filter((f) => /^x\d+\.txt$/.test(f)).length;
        return { stderr: Array.from({ length: n }, (_, i) => `n:${i} pts:${i} pts_time:${i} x1:100 x2:150 y1:40 y2:60 w:50 h:20`).join('\n') };
      }
      case 'render': return { write: (d) => writeFileSync(path.join(d, 'out.mp4'), mp4()) };
      case 'decode': return {};
      case 'probe': return { stdout: probe(mp4().byteLength) };
      case 'frames': return { write: (d) => { for (let t = 0; t < 5; t++) for (const w of [720, 390, 320]) { const p = path.join(d, `f${t}_${w}.png`); if (!existsSync(p)) writeFileSync(p, new Uint8Array([137, 80, 78, 71])); } } };
    }
  };
  const deps: ExplainerDeps = {
    spawn: (file, args, opts) => {
      const stage = stageOf(args);
      const b = { ...defaults(stage, opts.cwd), ...(over[stage] ?? {}) };
      if (b.throwSync) throw new Error('EAGAIN /secret');
      const child = new FakeChild(pid++);
      spawned.push({ file, args, opts, stage, pid: child.pid, child });
      setImmediate(() => {
        if (b.flood) for (let i = 0; i < 200; i++) child.stdout.emit('data', new Uint8Array(4096));
        if (b.stdout) child.stdout.emit('data', new TextEncoder().encode(b.stdout));
        if (b.stderr) child.stderr.emit('data', new TextEncoder().encode(b.stderr));
        if (b.hang || b.flood) return;
        b.write?.(opts.cwd);
        child.finish(b.code ?? 0);
      });
      return child as unknown as ChildLike;
    },
    killGroup: (p) => {
      kills.push(p);
      const s = spawned.find((x) => x.pid === p);
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

// ── 계획(순수) ──
test('EX1 고정 계획: 5장면 대본·허용 문구·동결·결정적', () => {
  const r = buildExplainerStoryboard({ ...INPUT });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const all = r.plan.texts.map((t) => t.text).join(' ');
  for (const must of ['사은품 숫자만 보고', '결정하시나요?', '첫째, 매달 내는 요금과', '약정 기간을 함께 보세요.', '둘째, 집에서 쓰는 기기와 이용', '방식에 맞는 속도를 고르세요.', '셋째, 설치비와 설치 가능 여부,', '희망 일정도 확인하세요.', '나에게 맞는 조건부터', '꼼꼼하게', 'FIDEON']) {
    assert.ok(all.includes(must), must);
  }
  assert.ok(!/[0-9]+ ?(원|만|%|Mbps|기가)|할인|결합|사은품 증정|최저|무료|http|www|010|카톡|QR/.test(all.replace(/체크 [123]/g, '')), '금액·할인·결합·최저가·URL·연락처·CTA 없음');
  assert.ok(r.plan.texts.every((t) => TEXT_RE.test(t.text)));
  assert.ok(Object.isFrozen(r.plan) && Object.isFrozen(r.plan.sprites) && Object.isFrozen(r.plan.sprites[0]!.prims));
  assert.deepEqual(buildExplainerStoryboard({ ...INPUT }), r, '결정적');
  assert.equal(r.plan.sprites.length, EXPLAINER_PLAN.sprites.length);
});

test('EX2 고정 입력 외 거부: 다른 variant·추가 키·접근자·배열·프로토타입', () => {
  const bad: unknown[] = [null, [], 'general_internet_v1', {}, { variant: 'other' }, { ...INPUT, text: 'x' }, { ...INPUT, scenes: [] }, Object.create({ variant: EX_VARIANT })];
  for (const b of bad) assert.deepEqual(buildExplainerStoryboard(b), { ok: false, error: 'INVALID_INPUT' }, JSON.stringify(b));
  const getter = { get variant() { return EX_VARIANT; } };
  assert.deepEqual(buildExplainerStoryboard(getter), { ok: false, error: 'INVALID_INPUT' }, '접근자 거부');
});

test('EX3 계획 검증: 잘못된 장면·시간·좌표·색·문구·불신 getter·중복 id', () => {
  const clone = () => JSON.parse(JSON.stringify(EXPLAINER_PLAN)) as { variant: string; sprites: Record<string, unknown>[]; texts: Record<string, unknown>[] };
  assert.equal(validateExplainerPlan(clone()).ok, true);
  const mutations: [string, (p: ReturnType<typeof clone>) => void][] = [
    ['variant', (p) => { p.variant = 'x'; }],
    ['시간 30 초과', (p) => { p.sprites[0]!.tout = 31; }],
    ['시간 음수', (p) => { p.texts[0]!.tin = -1; }],
    ['시간 NaN', (p) => { p.texts[0]!.tin = Number.NaN; }],
    ['시간 짧음', (p) => { p.sprites[0]!.tout = p.sprites[0]!.tin; }],
    ['좌표 화면 밖', (p) => { p.sprites[0]!.x = 700; }],
    ['좌표 소수', (p) => { p.sprites[0]!.y = 10.5; }],
    ['이동 화면 밖', (p) => { p.sprites[0]!.dy = 120; p.sprites[0]!.y = 1280 - (p.sprites[0]!.h as number); }],
    ['도형 좌표 범위', (p) => { (p.sprites[0]!.prims as Record<string, unknown>[])[0]!.x = 99999; }],
    ['도형 종류', (p) => { (p.sprites[0]!.prims as Record<string, unknown>[])[0]!.k = 'image'; }],
    ['도형 추가 키', (p) => { (p.sprites[0]!.prims as Record<string, unknown>[])[0]!.src = 'a.png'; }],
    ['색 형식', (p) => { p.texts[0]!.c = 'red'; }],
    ['색 주입', (p) => { (p.sprites[0]!.prims as Record<string, unknown>[])[0]!.c = "0xffffff'"; }],
    ['문구 % 주입', (p) => { p.texts[0]!.text = '%{pts}'; }],
    ['문구 따옴표', (p) => { p.texts[0]!.text = "인터넷'"; }],
    ['문구 콜론', (p) => { p.texts[0]!.text = '인터넷:TV'; }],
    ['문구 URL', (p) => { p.texts[0]!.text = 'http//x'; }],
    ['문구 줄바꿈', (p) => { p.texts[0]!.text = '가\n나'; }],
    ['폭 한도 화면 밖', (p) => { p.texts[1]!.x = 600; p.texts[1]!.maxW = 300; }],
    ['중복 id', (p) => { p.texts[1]!.id = p.texts[0]!.id; }],
    ['장면 키 추가', (p) => { (p as Record<string, unknown>).audio = 'x.wav'; }],
    ['sprite 키 추가', (p) => { p.sprites[0]!.filter = 'movie=x'; }],
  ];
  for (const [name, m] of mutations) {
    const p = clone();
    m(p);
    assert.deepEqual(validateExplainerPlan(p), { ok: false, error: 'INVALID_PLAN' }, name);
  }
  const g = clone();
  let reads = 0;
  Object.defineProperty(g.texts[0]!, 'text', { enumerable: true, get() { reads++; return reads === 1 ? '인터넷' : '%{pts}'; } });
  assert.deepEqual(validateExplainerPlan(g), { ok: false, error: 'INVALID_PLAN' }, '불신 getter 거부');
  const arr = clone();
  Object.defineProperty(arr.sprites, 0, { enumerable: true, get: () => EXPLAINER_PLAN.sprites[0] });
  assert.deepEqual(validateExplainerPlan(arr), { ok: false, error: 'INVALID_PLAN' }, '배열 접근자 거부');
});

test('EX4 필터 조립: 문구 0·외부 입력 0·고정 소스만, 18초 판정과 분리', () => {
  const r = buildExplainerStoryboard(INPUT);
  assert.ok(r.ok);
  if (!r.ok) return;
  const f = buildExplainerFilter(r.plan);
  for (const t of r.plan.texts) if (t.text.length >= 3) assert.ok(!f.graph.includes(t.text), `문구가 필터에 없음: ${t.text}`);
  assert.equal(f.files.length, r.plan.texts.length);
  assert.ok(!/movie=|amovie|subtitles=|ass=|https?:|file:|concat|\.\.\/|\.png|\.wav|\.mp3/.test(f.graph), '외부 파일·프로토콜 없음');
  assert.equal((f.graph.match(/expansion=none:reload=0/g) ?? []).length, r.plan.texts.length);
  assert.equal((f.graph.match(/geq=/g) ?? []).length, r.plan.sprites.length);
  assert.ok(f.graph.endsWith('format=yuv420p[vout]'));
  const g = spriteGeq(r.plan.sprites[0]!);
  assert.ok(g.a.endsWith('ld(1)*255') && g.r.includes('if(gt(ld(1),0),ld(0)/ld(1),0)'));
  // 18초 판정은 30초 영상을, 30초 판정은 18초 영상을 거부
  const n = 1234;
  assert.equal(checkExplainerProbeJson(probe(n), n).ok, true);
  assert.deepEqual(checkProbeJson(probe(n), n), { ok: false, reason: 'FRAMES' });
  assert.deepEqual(checkExplainerProbeJson(probe(n, '540', '18.000000'), n), { ok: false, reason: 'FRAMES' });
  assert.deepEqual(checkExplainerProbeJson(probe(n, '900', '18.000000'), n), { ok: false, reason: 'DURATION' });
  assert.deepEqual(checkExplainerProbeJson(probe(n, '900', '30.000000', true), n), { ok: false, reason: 'STREAM_COUNT' }, '오디오 거부');
  assert.deepEqual(checkExplainerProbeJson(probe(MAX_VIDEO_BYTES + 1), MAX_VIDEO_BYTES + 1), { ok: false, reason: 'TOO_LARGE' });
  // 18초 renderer 자원 제한은 그대로, 30초는 주소 공간만 다름
  assert.equal(LIMITS.addressSpace, 1024 ** 3);
  assert.deepEqual({ ...EX_LIMITS, addressSpace: LIMITS.addressSpace }, { ...LIMITS });
  assert.equal(EX_LIMITS.addressSpace, 2 * 1024 ** 3);
  assert.equal(WRAP_ARGS.length, EX_WRAP_ARGS.length);
  assert.equal(exLimitsApplied(limitsText(EX_LIMITS.addressSpace)), true);
  assert.equal(exLimitsApplied(limitsText(LIMITS.addressSpace)), false);
});

// ── renderer (가짜 process) ──
test('EX5 정상 경로: 고정 실행·최소 env·인자에 문구 0·정리 OK', async () => {
  const h = harness();
  const r = await renderExplainerVideo({ ...INPUT }, { ...h.deps, frames: true });
  assert.equal(r.code, 'RENDERED', JSON.stringify(r));
  if (!r.ok) return;
  assert.equal(r.kind, 'silent_visual_draft');
  assert.equal(r.frames.length, 15);
  assert.deepEqual(h.spawned.map((s) => s.stage), ['iso', 'filters', 'encoders', 'measure', 'render', 'decode', 'probe', 'frames', 'frames', 'frames', 'frames', 'frames']);
  for (const s of h.spawned) {
    assert.equal(s.file, TOOLS.unshare);
    assert.deepEqual(s.args.slice(0, EX_WRAP_ARGS.length), EX_WRAP_ARGS);
    assert.deepEqual(s.opts, { cwd: s.opts.cwd, env: FIXED_CHILD_ENV, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const joined = s.args.join(' ');
    for (const t of EXPLAINER_PLAN.texts) if (t.text.length >= 3) assert.ok(!joined.includes(t.text), t.text);
  }
  const render = h.spawned.find((s) => s.stage === 'render')!;
  assert.equal(render.args.filter((a) => a === '-i').length, 1, '입력은 고정 lavfi 배경 하나');
  assert.ok(render.args.includes('-an') && render.args.includes('+faststart') && render.args.at(-1) === 'file:out.mp4');
  assert.ok(!existsSync(render.opts.cwd));
});

test('EX6 준비 막힘·한도 미적용·측정 초과는 렌더 0', async () => {
  const cases: [string, Partial<Record<Stage, Behavior>>, string][] = [
    ['18초 한도(1GiB) 적용 상태', { iso: { stdout: `${limitsText(LIMITS.addressSpace)}\n${NETDEV_LO}` } }, 'LIMITS_UNAVAILABLE'],
    ['격리 안 eth0', { iso: { stdout: `${limitsText(EX_LIMITS.addressSpace)}\n${NETDEV_LO}  eth0: 1 1\n` } }, 'NETWORK_ISOLATION_UNAVAILABLE'],
    ['geq 없음', { filters: { stdout: FILTERS.replace(/.*geq.*\n/, '') } }, 'UNSUPPORTED'],
    ['폭 초과', { measure: { stderr: Array.from({ length: EXPLAINER_PLAN.texts.length }, (_, i) => `n:${i} pts:${i} pts_time:${i} x1:1 x2:2 y1:3 y2:4 w:${i === 0 ? 9999 : 10} h:10`).join('\n') } }, 'LAYOUT_OVERFLOW'],
    ['측정 누락', { measure: { stderr: 'n:0 pts:0 pts_time:0 x1:1 x2:2 y1:3 y2:4 w:10 h:10' } }, 'RENDER_FAILED'],
  ];
  for (const [name, over, code] of cases) {
    const h = harness(over);
    const r = await renderExplainerVideo(INPUT, h.deps);
    assert.equal(r.code, code, name);
    assert.ok(!h.spawned.some((s) => s.stage === 'render'), name);
    assert.equal(r.cleanup, 'OK', name);
  }
  const font = harness();
  const rf = await renderExplainerVideo(INPUT, { ...font.deps, fs: { checkExecutable: async () => true, fontDigest: async () => null } });
  assert.equal(rf.code, 'FONT_UNAVAILABLE');
  const bad = harness();
  assert.equal((await renderExplainerVideo({ variant: 'x' }, bad.deps)).code, 'INVALID_INPUT');
  assert.equal(bad.spawned.length, 0);
});

test('EX7 오류·출력 한도·probe 반례: 고정 코드, 원문 비반환', async () => {
  const exit = harness({ render: { code: 1, stderr: 'Error /secret DATABASE_URL=x' } });
  const r1 = await renderExplainerVideo(INPUT, exit.deps);
  assert.equal(r1.code, 'RENDER_FAILED');
  assert.ok(!/secret|DATABASE/.test(JSON.stringify(r1)));
  assert.equal((await renderExplainerVideo(INPUT, harness({ render: { throwSync: true } }).deps)).code, 'RENDER_FAILED');
  assert.equal((await renderExplainerVideo(INPUT, harness({ decode: { stderr: 'error while decoding' } }).deps)).code, 'DECODE_FAILED');
  const aud = await renderExplainerVideo(INPUT, harness({ probe: { stdout: probe(mp4().byteLength, '900', '30.000000', true) } }).deps);
  assert.deepEqual([aud.code, aud.ok ? null : aud.reason], ['PROBE_REJECTED', 'STREAM_COUNT']);
  const r18 = await renderExplainerVideo(INPUT, harness({ probe: { stdout: probe(mp4().byteLength, '540', '18.000000') } }).deps);
  assert.deepEqual([r18.code, r18.ok ? null : r18.reason], ['PROBE_REJECTED', 'FRAMES']);
  const slow = await renderExplainerVideo(INPUT, harness({ render: { write: (d) => writeFileSync(path.join(d, 'out.mp4'), mp4(['ftyp', 'mdat', 'moov'])) } }).deps);
  assert.deepEqual([slow.code, slow.ok ? null : slow.reason], ['PROBE_REJECTED', 'FORMAT']);
  const big = harness({ render: { write: (d) => writeFileSync(path.join(d, 'out.mp4'), new Uint8Array(MAX_VIDEO_BYTES + 1)) } });
  assert.equal((await renderExplainerVideo(INPUT, big.deps)).code, 'TOO_LARGE');
  assert.ok(!big.spawned.some((s) => s.stage === 'probe'));
  const flood = harness({ filters: { flood: true } });
  const rf = await renderExplainerVideo(INPUT, flood.deps);
  assert.equal(rf.code, 'OUTPUT_TOO_LARGE');
  assert.equal(flood.kills.length, 1);
});

test('EX8 시간 초과·마감 뒤 spawn 0·종료 미확인·늦은 종료·정리 실패 보존', async () => {
  const hang = harness({ render: { hang: true } });
  const r = await renderExplainerVideo(INPUT, { ...hang.deps, totalTimeoutMs: 1_000 });
  assert.deepEqual([r.code, r.cleanup], ['TIMEOUT', 'OK']);
  assert.equal(hang.spawned.at(-1)!.stage, 'render', '마감 뒤 새 process 0');
  assert.deepEqual(hang.kills, [hang.spawned.at(-1)!.pid]);

  const stuck = harness({ measure: { hang: true } }, { killNoExit: true });
  const r2 = await renderExplainerVideo(INPUT, { ...stuck.deps, totalTimeoutMs: 1_000 });
  assert.deepEqual([r2.code, r2.cleanup], ['CLEANUP_FAILED', 'FAILED']);
  assert.ok(!stuck.spawned.some((s) => s.stage === 'render'));
  const m = stuck.spawned.find((s) => s.stage === 'measure')!;
  assert.ok(existsSync(m.opts.cwd), '종료 미확인 자식의 디렉터리는 지우지 않음');
  m.child.finish(null, 'SIGKILL');
  rmSync(m.opts.cwd, { recursive: true, force: true });

  const late = harness({ filters: { flood: true } }, { lateExitMs: 500 });
  const r3 = await renderExplainerVideo(INPUT, late.deps);
  assert.equal(r3.code, 'CLEANUP_FAILED', 'killWaitMs 뒤 늦은 종료를 성공으로 뒤집지 않음');
  await new Promise((res) => setTimeout(res, 600));
  rmSync(late.spawned.find((s) => s.stage === 'filters')!.opts.cwd, { recursive: true, force: true });

  const keep = harness({ render: { code: 1 } });
  const r4 = await renderExplainerVideo(INPUT, { ...keep.deps, fs: { checkExecutable: async () => true, fontDigest: async () => FONT_SHA256, removeDir: async () => {} } });
  assert.deepEqual([r4.code, r4.ok ? null : r4.primary], ['CLEANUP_FAILED', 'RENDER_FAILED'], '원래 실패 보존');
  rmSync(keep.spawned[0]!.opts.cwd, { recursive: true, force: true });
});

test('EX9 정적: env·shell·fetch·설치·음성·업로드 연결 없음', () => {
  for (const f of ['explainerStoryboard.ts', 'explainerRenderer.ts']) {
    const src = readFileSync(`src/server/advertising/video/${f}`, 'utf8');
    const code = src.replace(/^\s*\/\/.*$/gm, '').replace(/^\s*\*.*$/gm, '');
    assert.match(src, /^import 'server-only';/);
    assert.ok(!/process\.env|fetch\(|console\.|shell:\s*true|execSync|execFile|child_process|require\(|import\(|https?:\/\/|\bnpm |\bcurl\b|\bwget\b/.test(code), f);
    assert.ok(!/upload|publish|youtube|openai|tts|speech|flite|generateAdCopy|prepareYoutube/i.test(code), `${f}: 음성·생성·업로드 연결 없음`);
  }
});
