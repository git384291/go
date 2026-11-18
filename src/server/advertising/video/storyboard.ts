import 'server-only';
// 광고 영상 storyboard — **순수 계약** (PM 6954300094 1·2·3절). 네트워크·파일·프로세스·환경 접근 없음.
//
// - 입력은 정확히 {situationId(고정 3종), copy:{title, description}, copySource:'model'|'fixed_draft'}다.
//   copy는 광고 문구 검증(validateAdCopy)을 다시 통과해야 한다. 원본 객체는 읽기만 하고 바꾸지 않는다.
// - 출력은 고정 3장면(제목 / 설명 / 확인 필요 안내)과 고정 색·좌표·시각이다. 색·좌표·타이밍·필터·경로·URL을
//   입력으로 받지 않는다. 화면 문구는 copy와 고정 안내문에서만 온다(임의 문구·URL·연락처·CTA 없음).
// - 줄바꿈은 여기서 **후보**만 만든다(공백 단위, 추정 em 폭, 최소 줄 수 안에서 균형 분할). 실제 폰트 너비 판정은
//   renderer가 실제 폰트로 각 줄을 측정해서 한다. 추정 폭·글자 수만으로 잘림 없음을 보장하지 않는다.
// - copySource는 표시용 출처다. 'model'로 넣었다고 실제 모델 생성 증거가 되지 않는다.
import { AD_DRAFT_IDS, type AdDraftId } from '@/content/adDrafts';
import { validateAdCopy } from '../adGeneration';

export const VIDEO_WIDTH = 720;
export const VIDEO_HEIGHT = 1280;
export const VIDEO_FPS = 30;
export const VIDEO_DURATION_SEC = 18;
/** 좌우 여백(각) */
export const SIDE_MARGIN = 60;
/** 한 줄이 넘으면 안 되는 실제 렌더 폭(px) */
export const MAX_LINE_WIDTH = VIDEO_WIDTH - SIDE_MARGIN * 2;

/** 고정 안내문(검수된 일반 안내. 금액·혜택 약속 없음) */
export const NOTICE_TEXT = '요금·혜택·설치 가능 여부는 별도 확인이 필요합니다';

export const COLORS = Object.freeze({
  background: '0x0b1f3a',
  accent: '0x2ec4b6',
  band: '0x13294b',
  text: '0xffffff',
  notice: '0xffe08a',
});

type SceneSpec = { readonly id: 'title' | 'description' | 'notice'; readonly start: number; readonly end: number; readonly fontSize: number; readonly maxLines: number; readonly color: string };

/** 고정 타임라인(초). 빈 화면 없이 3장면 */
export const SCENE_SPECS: readonly SceneSpec[] = Object.freeze([
  Object.freeze({ id: 'title', start: 0, end: 5, fontSize: 64, maxLines: 2, color: COLORS.text }),
  Object.freeze({ id: 'description', start: 5, end: 13, fontSize: 48, maxLines: 4, color: COLORS.text }),
  Object.freeze({ id: 'notice', start: 13, end: 18, fontSize: 40, maxLines: 3, color: COLORS.notice }),
] as const);

export const LINE_HEIGHT_RATIO = 1.45;

export type StoryboardLine = { readonly text: string; readonly y: number };
export type StoryboardScene = {
  readonly id: SceneSpec['id'];
  readonly start: number;
  readonly end: number;
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly color: string;
  readonly lines: readonly StoryboardLine[];
};
export type Storyboard = {
  readonly version: 1;
  readonly situationId: AdDraftId;
  readonly copySource: 'model' | 'fixed_draft';
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly durationSec: number;
  readonly scenes: readonly StoryboardScene[];
};

export type StoryboardResult = { readonly ok: true; readonly storyboard: Storyboard } | { readonly ok: false; readonly error: 'INVALID_INPUT' | 'LAYOUT_TOO_LONG' };

const INPUT_KEYS = ['situationId', 'copy', 'copySource'];
const isPlain = (v: unknown): v is Record<string, unknown> => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
};

/** 문자 단위(서기소 클러스터) 분할. 결합 문자를 쪼개지 않는다 */
function graphemes(s: string): string[] {
  const seg = new Intl.Segmenter('ko', { granularity: 'grapheme' });
  return Array.from(seg.segment(s), (x) => x.segment);
}

/**
 * 줄바꿈 후보용 **추정** 폭(em). 실제 폰트 측정이 최종 판정이며 이 값은 후보를 고르는 데만 쓴다.
 * 한글 음절 0.95, 그 밖의 CJK 1.0, 영문 대문자 0.7, 소문자 0.6, 공백 0.25, 문장부호 0.35, 그 밖 1.0(보수적)
 */
export function estimateEm(g: string): number {
  if (/^[가-힣]$/.test(g)) return 0.95;
  if (g === ' ') return 0.25;
  if (/^[A-Z]$/.test(g)) return 0.7;
  if (/^[a-z]$/.test(g)) return 0.6;
  if (/^[·.,!?()~\-+]$/.test(g)) return 0.35;
  return 1;
}
const widthEm = (gs: readonly string[]) => gs.reduce((a, g) => a + estimateEm(g), 0);

type Tok = { readonly g: readonly string[]; readonly glue: boolean };

/** 단어 토큰. 한 단어가 한 줄 폭을 넘으면 서기소 단위 조각으로 나누고 조각 사이는 공백 없이 잇는다 */
function tokens(text: string, maxEm: number): Tok[] {
  const out: Tok[] = [];
  for (const word of text.split(' ')) {
    const gs = graphemes(word);
    if (gs.length === 0) continue;
    let cur: string[] = [];
    let first = true;
    for (const g of gs) {
      if (cur.length && widthEm([...cur, g]) > maxEm) {
        out.push({ g: cur, glue: !first });
        first = false;
        cur = [];
      }
      cur.push(g);
    }
    out.push({ g: cur, glue: !first });
  }
  return out;
}

const lineOf = (ts: readonly Tok[]) => ts.map((t, i) => (i > 0 && !t.glue ? ' ' : '') + t.g.join('')).join('');
const lineEm = (ts: readonly Tok[]) => widthEm(graphemes(lineOf(ts)));

/**
 * 줄바꿈 후보: 먼저 필요한 최소 줄 수를 greedy로 정하고, 그 줄 수 안에서 가장 긴 줄이 가장 짧아지도록(균형) 끊는다.
 * 결정적이다(같은 입력 → 같은 결과).
 */
export function wrapLines(text: string, maxEm: number): string[] {
  const toks = tokens(text, maxEm);
  if (toks.length === 0) return [];
  let k = 1;
  let w = 0;
  toks.forEach((t, i) => {
    const add = widthEm(t.g) + (i > 0 && !t.glue && w > 0 ? 0.25 : 0);
    if (w > 0 && w + add > maxEm) {
      k++;
      w = widthEm(t.g);
    } else w += add;
  });
  // k줄로 나누는 모든 경우 중 최대 줄 폭 최소(토큰 수는 검증된 문구 길이로 작다)
  const memo = new Map<string, { cost: number; cuts: number[] }>();
  const best = (from: number, lines: number): { cost: number; cuts: number[] } => {
    const key = `${from}:${lines}`;
    const hit = memo.get(key);
    if (hit) return hit;
    let r: { cost: number; cuts: number[] };
    if (lines === 1) {
      r = { cost: lineEm(toks.slice(from)), cuts: [] };
    } else {
      r = { cost: Infinity, cuts: [] };
      for (let end = from + 1; end <= toks.length - (lines - 1); end++) {
        if (toks[end]!.glue) continue; // 조각난 단어 중간은 앞 조각이 꽉 찼을 때만(아래 greedy가 보장)
        const head = lineEm(toks.slice(from, end));
        if (head > maxEm) break;
        const rest = best(end, lines - 1);
        const cost = Math.max(head, rest.cost);
        if (cost < r.cost) r = { cost, cuts: [end, ...rest.cuts] };
      }
    }
    memo.set(key, r);
    return r;
  };
  const plan = best(0, k);
  if (!Number.isFinite(plan.cost) || plan.cost > maxEm) {
    // 조각난 단어 때문에 균형 분할이 불가하면 greedy 결과를 쓴다
    const lines: string[] = [];
    let cur: Tok[] = [];
    for (const t of toks) {
      const next = [...cur, t];
      if (cur.length && lineEm(next) > maxEm) {
        lines.push(lineOf(cur));
        cur = [{ g: t.g, glue: false }];
      } else cur = next;
    }
    if (cur.length) lines.push(lineOf(cur));
    return lines;
  }
  const lines: string[] = [];
  let at = 0;
  for (const c of [...plan.cuts, toks.length]) {
    lines.push(lineOf(toks.slice(at, c).map((t, i) => (i === 0 ? { g: t.g, glue: false } : t))));
    at = c;
  }
  return lines;
}

/** 장면별 줄 폭 상한(em): 실제 허용 폭 600px의 95%를 글자 크기로 나눈 값 */
export const maxEmFor = (fontSize: number) => (MAX_LINE_WIDTH * 0.95) / fontSize;

function scene(spec: SceneSpec, text: string): StoryboardScene | null {
  const lines = wrapLines(text, maxEmFor(spec.fontSize));
  if (lines.length < 1 || lines.length > spec.maxLines) return null;
  const lineHeight = Math.round(spec.fontSize * LINE_HEIGHT_RATIO);
  const top = Math.round(VIDEO_HEIGHT / 2 - (lines.length * lineHeight) / 2);
  return Object.freeze({
    id: spec.id,
    start: spec.start,
    end: spec.end,
    fontSize: spec.fontSize,
    lineHeight,
    color: spec.color,
    lines: Object.freeze(lines.map((t, i) => Object.freeze({ text: t, y: top + i * lineHeight }))),
  });
}

/** storyboard 생성(순수). 불신 입력을 한 번만 읽어 스냅샷을 만든다 */
export function buildStoryboard(input: unknown): StoryboardResult {
  let situationId: AdDraftId;
  let copySource: 'model' | 'fixed_draft';
  let title: string;
  let description: string;
  try {
    if (!isPlain(input)) return { ok: false, error: 'INVALID_INPUT' };
    const keys = Object.keys(input);
    if (keys.length !== INPUT_KEYS.length || !INPUT_KEYS.every((k) => keys.includes(k))) return { ok: false, error: 'INVALID_INPUT' };
    const sid = input.situationId;
    const src = input.copySource;
    const copy = input.copy;
    if (typeof sid !== 'string' || !(AD_DRAFT_IDS as readonly string[]).includes(sid)) return { ok: false, error: 'INVALID_INPUT' };
    if (src !== 'model' && src !== 'fixed_draft') return { ok: false, error: 'INVALID_INPUT' };
    if (!isPlain(copy)) return { ok: false, error: 'INVALID_INPUT' };
    // 한 번만 읽은 값으로 검증(접근자가 두 번째 읽기에서 다른 값을 내도 쓰지 않는다)
    const snap = { title: copy.title, description: copy.description };
    if (Object.keys(copy).length !== 2) return { ok: false, error: 'INVALID_INPUT' };
    const v = validateAdCopy(snap);
    if (!v.ok) return { ok: false, error: 'INVALID_INPUT' };
    situationId = sid as AdDraftId;
    copySource = src;
    title = v.title;
    description = v.description;
  } catch {
    return { ok: false, error: 'INVALID_INPUT' };
  }
  const texts = [title, description, NOTICE_TEXT];
  const scenes: StoryboardScene[] = [];
  for (let i = 0; i < SCENE_SPECS.length; i++) {
    const s = scene(SCENE_SPECS[i]!, texts[i]!);
    if (!s) return { ok: false, error: 'LAYOUT_TOO_LONG' };
    scenes.push(s);
  }
  return {
    ok: true,
    storyboard: Object.freeze({
      version: 1,
      situationId,
      copySource,
      width: VIDEO_WIDTH,
      height: VIDEO_HEIGHT,
      fps: VIDEO_FPS,
      durationSec: VIDEO_DURATION_SEC,
      scenes: Object.freeze(scenes),
    }),
  };
}
