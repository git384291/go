// 실제 로컬 영상 1편 렌더 + 증거 수집 (PM 6954300094 5절). **수동 실행 전용, CI 미연결.**
//
// 실행(저장소 루트에서, 기존 설치 tsx 사용. npx 자동 다운로드·전역 설정 변경 없음):
//   TSX_TSCONFIG_PATH=tests/route/tsconfig.json node --conditions=react-server \
//     --require ./tests/route/fallback.cjs --import tsx scripts/video/render-sample.mjs --out /절대/경로/저장소-밖-빈-폴더
//
// - 입력: 고정 초안 moving 1개, copySource 'fixed_draft'. 실제 모델 생성 결과가 아니다.
// - 생성·업로드·외부 접속 없음. 도구는 renderer의 고정 격리(unshare -n)·자원 제한(prlimit) 아래에서만 실행된다.
// - 결과(영상·프레임·evidence.json)는 --out에만 쓴다. 저장소 안·기존 비어 있지 않은 폴더는 거부한다.
// - 출력에는 파일 이름·기술 메타데이터만 쓴다(환경값·키·내부 임시 경로 없음).
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { renderAdVideo } from '../../src/server/advertising/video/ffmpegRenderer.ts';
import { AD_DRAFTS } from '../../src/content/adDrafts.ts';

const i = process.argv.indexOf('--out');
const out = i > 0 ? process.argv[i + 1] : undefined;
const repo = process.cwd();
if (!out || !path.isAbsolute(out)) {
  console.error('사용법: --out <절대 경로>');
  process.exit(2);
}
const rel = path.relative(repo, out);
if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
  console.error('거부: 결과 폴더는 저장소 밖이어야 합니다');
  process.exit(2);
}
if (existsSync(out) && readdirSync(out).length > 0) {
  console.error('거부: 결과 폴더가 비어 있지 않습니다');
  process.exit(2);
}
mkdirSync(out, { recursive: true, mode: 0o700 });

const tmpEntries = () => readdirSync(tmpdir()).filter((n) => n.startsWith('fideon-video-')).sort();
/** 이 프로세스의 직계 자식 PID 목록(/proc 기준). tsx 로더의 esbuild 서비스처럼 렌더 전부터 있던 자식은 전후 비교로 뺀다 */
const childPids = () => {
  const n = [];
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = readFileSync(`/proc/${d}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      if (ppid === process.pid) n.push(d);
    } catch {
      // 사라진 프로세스
    }
  }
  return n;
};

const before = tmpEntries();
const kidsBefore = childPids();
const deps = {
  spawn: (file, args, opts) => spawn(file, [...args], { ...opts, stdio: [...opts.stdio], env: { ...opts.env } }),
  killGroup: (pid) => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch (e) {
      if (e && e.code === 'ESRCH') return;
      throw e;
    }
  },
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h),
  killWaitMs: 3000,
  totalTimeoutMs: 120_000,
  frames: true,
};
const d = AD_DRAFTS.moving;
const t0 = Date.now();
const r = await renderAdVideo({ situationId: 'moving', copy: { title: d.title, description: d.description }, copySource: 'fixed_draft' }, deps);
const elapsedMs = Date.now() - t0;
const after = tmpEntries();
const kidsAfter = childPids();

const evidence = {
  input: { situationId: 'moving', copySource: 'fixed_draft', note: '고정 초안. 실제 모델 생성 아님' },
  result: r.ok ? 'RENDERED' : r.code,
  primary: r.ok ? null : (r.primary ?? null),
  reason: r.ok ? null : (r.reason ?? null),
  cleanup: r.cleanup,
  spawned: r.spawned,
  elapsedMs,
  probe: r.ok ? r.probe : null,
  faststart: r.ok ? r.faststart : null,
  lines: r.ok ? r.lines : null,
  frames: r.ok ? r.frames.map((f) => ({ atSec: f.atSec, width: f.width, bytes: f.png.byteLength, file: `frame_${f.atSec}s_${f.width}.png` })) : [],
  tempDirsBefore: before.length,
  tempDirsAfter: after.length,
  newTempDirs: after.filter((n) => !before.includes(n)).length,
  childProcessesBefore: kidsBefore.length,
  newChildProcessesAfter: kidsAfter.filter((p) => !kidsBefore.includes(p)).length,
  uploads: 0,
  externalRequests: 'none attempted; tools ran inside unshare -n (loopback only, verified per run)',
};
if (r.ok) {
  writeFileSync(path.join(out, 'sample.mp4'), r.video, { mode: 0o600 });
  for (const f of r.frames) writeFileSync(path.join(out, `frame_${f.atSec}s_${f.width}.png`), f.png, { mode: 0o600 });
}
writeFileSync(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify(evidence, null, 2));
process.exit(r.ok && evidence.newTempDirs === 0 && evidence.newChildProcessesAfter === 0 ? 0 : 1);
