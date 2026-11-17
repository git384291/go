import 'server-only';
// 유튜브 광고 소재 준비 조합 (PM 6951004870 / 6952112639): 영상 검증 → AI 문구 생성 → 검증 → 비공개 업로드 → 상태 조회.
// **비공개 시험 전용(PRIVATE_TEST_ONLY). 공개 게시·유료 집행·HTTP route/UI 배선 없음.**
// - 생성기(generateCopy)·게시 어댑터(publisher)·전체 마감(totalTimeoutMs)은 필수 주입. 각 속성은 한 번만 읽어 스냅샷으로 쓴다.
// - 입력은 고정 상황 ID·internet-tv·제약된 메모리 영상(mp4/webm, ≤5MiB)뿐. 게시 허용 여부는 입력으로 정하지 않는다.
// - 영상(크기·MIME·서명)은 **생성 전에** 검증·방어 복사한다. 불량이면 생성 0·업로드 0.
// - 생성 결과는 ok·source:'model'·generatorCalled===true·같은 situationId/product·미게시·executionAllowed:false 계약을 모두 대조하고
//   validateAdCopy로 다시 검증한 새 title·description만 넘긴다.
// - 마감 계약: totalTimeoutMs로 정한 하나의 절대 마감을 생성·업로드·조회 await에 공유한다(Promise.race).
//   마감 뒤에는 새 단계(업로드·조회)를 시작하지 않는다. 생성·업로드 호출 자체는 이 조합에서 취소할 수 없으므로,
//   마감 뒤 늦게 끝난 결과는 버린다(업로드 단계에서 마감이 오면 결과 미확인 RESULT_UNKNOWN). 업로드 내부에는 어댑터 자체 절대 마감이 따로 있다.
// - 업로드·조회 결과는 state·videoId·uploadAttempted를 한 번만 읽어 상태별 계약과 대조한다. 모순·알 수 없는 값은 성공으로 처리하지 않는다.
// - 가짜 영상·가짜 transport 성공은 실제 영상 품질·실 AI·실 계정·문의 성과를 뜻하지 않는다. publicPublished·paidExecutionAllowed는 항상 false.
import { validateAdCopy, type AdGenerationResult } from './adGeneration';
import { checkVideo, type UploadOutcome, type StatusOutcome, type YoutubePrivatePublisher } from './youtubePrivatePublisher';
import { AD_DRAFT_IDS } from '@/content/adDrafts';

export type PreparationResult = {
  readonly stage: 'NOT_CONFIGURED' | 'INVALID_INPUT' | 'GENERATION_FAILED' | 'DEADLINE_EXCEEDED' | 'UPLOAD_NOT_COMPLETED' | 'PRIVATE_TEST_ONLY';
  readonly upload: UploadOutcome['state'] | 'NOT_ATTEMPTED';
  readonly status: StatusOutcome['state'] | 'NOT_QUERIED';
  readonly videoId: string | null;
  readonly publicPublished: false;
  readonly paidExecutionAllowed: false;
};

export type PreparationDeps = {
  readonly generateCopy: ((i: { situationId: string; product: 'internet-tv' }) => Promise<AdGenerationResult>) | null;
  readonly publisher: YoutubePrivatePublisher | null;
  /** 조합 전체 절대 마감(1초~5분). 필수 */
  readonly totalTimeoutMs: number;
};

const done = (stage: PreparationResult['stage'], upload: PreparationResult['upload'], status: PreparationResult['status'], videoId: string | null = null): PreparationResult =>
  Object.freeze({ stage, upload, status, videoId, publicPublished: false, paidExecutionAllowed: false });

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const PRE_UPLOAD = ['NOT_CONFIGURED', 'INVALID_INPUT', 'CHANNEL_CHECK_FAILED', 'CHANNEL_MISMATCH', 'TIMEOUT_BEFORE_UPLOAD'];
const POST_UPLOAD_NO_ID = ['UPLOAD_FAILED', 'RESULT_UNKNOWN'];
const STATUS_STATES = ['NOT_CONFIGURED', 'INVALID_INPUT', 'NOT_FOUND', 'NOT_PRIVATE', 'UPLOAD_REJECTED', 'QUERY_FAILED', 'PRIVATE_PROCESSING', 'PRIVATE_PROCESSED', 'PRIVATE_PROCESSING_FAILED', 'PRIVATE_PROCESSING_UNKNOWN'];

const TIMEOUT = Symbol('timeout');
/** 남은 시간 안에 끝나면 결과, 아니면 TIMEOUT(늦은 결과는 버린다). 타이머는 항상 정리 */
async function within<T>(p: Promise<T>, deadlineAt: number): Promise<T | typeof TIMEOUT> {
  const remaining = deadlineAt - Date.now();
  if (!(remaining > 0)) {
    p.catch(() => undefined);
    return TIMEOUT;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<typeof TIMEOUT>((r) => { timer = setTimeout(() => r(TIMEOUT), remaining); })]);
  } finally {
    if (timer) clearTimeout(timer);
    p.catch(() => undefined);
  }
}

export async function prepareYoutubeAdPrivateTest(input: unknown, deps: PreparationDeps): Promise<PreparationResult> {
  // ── deps 스냅샷(한 번만 읽기) ──
  let generate: NonNullable<PreparationDeps['generateCopy']>;
  let upload: YoutubePrivatePublisher['uploadPrivate'];
  let status: YoutubePrivatePublisher['getStatus'];
  let deadlineAt: number;
  try {
    if (!deps || typeof deps !== 'object') return done('NOT_CONFIGURED', 'NOT_ATTEMPTED', 'NOT_QUERIED');
    const g = deps.generateCopy;
    const pub = deps.publisher;
    const total = deps.totalTimeoutMs;
    if (typeof g !== 'function' || !pub || typeof pub !== 'object') return done('NOT_CONFIGURED', 'NOT_ATTEMPTED', 'NOT_QUERIED');
    const up = pub.uploadPrivate;
    const st = pub.getStatus;
    if (typeof up !== 'function' || typeof st !== 'function') return done('NOT_CONFIGURED', 'NOT_ATTEMPTED', 'NOT_QUERIED');
    if (!Number.isSafeInteger(total) || total < 1000 || total > 300000) return done('NOT_CONFIGURED', 'NOT_ATTEMPTED', 'NOT_QUERIED');
    generate = g;
    upload = up.bind(pub);
    status = st.bind(pub);
    deadlineAt = Date.now() + total;
  } catch {
    return done('NOT_CONFIGURED', 'NOT_ATTEMPTED', 'NOT_QUERIED');
  }

  // ── 입력 스냅샷 + 영상 검증(생성 전) ──
  let situationId: string;
  let video: Uint8Array;
  let mimeType: string;
  try {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return done('INVALID_INPUT', 'NOT_ATTEMPTED', 'NOT_QUERIED');
    const proto = Object.getPrototypeOf(input);
    if (proto !== Object.prototype && proto !== null) return done('INVALID_INPUT', 'NOT_ATTEMPTED', 'NOT_QUERIED');
    const keys = Object.keys(input);
    const want = ['situationId', 'product', 'video', 'mimeType'];
    if (keys.length !== want.length || !want.every((k) => keys.includes(k))) return done('INVALID_INPUT', 'NOT_ATTEMPTED', 'NOT_QUERIED');
    const o = input as Record<string, unknown>;
    const sid = o.situationId;
    const product = o.product;
    const vRaw = o.video;
    const mRaw = o.mimeType;
    if (typeof sid !== 'string' || !(AD_DRAFT_IDS as readonly string[]).includes(sid) || product !== 'internet-tv') return done('INVALID_INPUT', 'NOT_ATTEMPTED', 'NOT_QUERIED');
    const v = checkVideo(vRaw, mRaw);
    if (!v) return done('INVALID_INPUT', 'NOT_ATTEMPTED', 'NOT_QUERIED');
    situationId = sid;
    video = v.video;
    mimeType = v.mimeType;
  } catch {
    return done('INVALID_INPUT', 'NOT_ATTEMPTED', 'NOT_QUERIED');
  }

  // ── 생성(마감 공유) + 결과 계약 대조 ──
  let copy: { title: string; description: string };
  try {
    const g = await within(Promise.resolve().then(() => generate({ situationId, product: 'internet-tv' })), deadlineAt);
    if (g === TIMEOUT) return done('DEADLINE_EXCEEDED', 'NOT_ATTEMPTED', 'NOT_QUERIED');
    if (!g || typeof g !== 'object') return done('GENERATION_FAILED', 'NOT_ATTEMPTED', 'NOT_QUERIED');
    const r = g as Record<string, unknown>;
    const snap = {
      ok: r.ok, source: r.source, generatorCalled: r.generatorCalled, situationId: r.situationId, product: r.product,
      status: r.status, executionAllowed: r.executionAllowed, title: r.title, description: r.description,
    };
    if (snap.ok !== true || snap.source !== 'model' || snap.generatorCalled !== true || snap.situationId !== situationId ||
        snap.product !== 'internet-tv' || snap.status !== 'DRAFT_UNPUBLISHED' || snap.executionAllowed !== false) {
      return done('GENERATION_FAILED', 'NOT_ATTEMPTED', 'NOT_QUERIED');
    }
    const v = validateAdCopy({ title: snap.title, description: snap.description });
    if (!v.ok) return done('GENERATION_FAILED', 'NOT_ATTEMPTED', 'NOT_QUERIED');
    copy = { title: v.title, description: v.description };
  } catch {
    return done('GENERATION_FAILED', 'NOT_ATTEMPTED', 'NOT_QUERIED');
  }
  if (Date.now() >= deadlineAt) return done('DEADLINE_EXCEEDED', 'NOT_ATTEMPTED', 'NOT_QUERIED');

  // ── 업로드(마감 공유) + 상태별 계약 대조 ──
  let upState: string;
  let videoId: string | null = null;
  try {
    const u = await within(Promise.resolve().then(() => upload({ video, mimeType, title: copy.title, description: copy.description })), deadlineAt);
    if (u === TIMEOUT) return done('UPLOAD_NOT_COMPLETED', 'RESULT_UNKNOWN', 'NOT_QUERIED');
    if (!u || typeof u !== 'object') return done('UPLOAD_NOT_COMPLETED', 'RESULT_UNKNOWN', 'NOT_QUERIED');
    const r = u as Record<string, unknown>;
    const state = r.state;
    const attempted = r.uploadAttempted;
    const vid = r.videoId;
    const idOk = typeof vid === 'string' && VIDEO_ID.test(vid);
    if (typeof state === 'string' && PRE_UPLOAD.includes(state) && attempted === false) {
      return done('UPLOAD_NOT_COMPLETED', state as PreparationResult['upload'], 'NOT_QUERIED');
    }
    if (typeof state === 'string' && POST_UPLOAD_NO_ID.includes(state) && attempted === true) {
      return done('UPLOAD_NOT_COMPLETED', state as PreparationResult['upload'], 'NOT_QUERIED');
    }
    if (state === 'NOT_PRIVATE' && attempted === true && idOk) return done('UPLOAD_NOT_COMPLETED', 'NOT_PRIVATE', 'NOT_QUERIED', vid as string);
    if (state !== 'UPLOADED_PRIVATE' || attempted !== true || !idOk) return done('UPLOAD_NOT_COMPLETED', 'RESULT_UNKNOWN', 'NOT_QUERIED'); // 모순·미지 → 미확인
    upState = 'UPLOADED_PRIVATE';
    videoId = vid as string;
  } catch {
    return done('UPLOAD_NOT_COMPLETED', 'RESULT_UNKNOWN', 'NOT_QUERIED');
  }
  if (Date.now() >= deadlineAt) return done('PRIVATE_TEST_ONLY', 'UPLOADED_PRIVATE', 'NOT_QUERIED', videoId);

  // ── 상태 조회(마감 공유), state 한 번만 읽기 ──
  try {
    const s = await within(Promise.resolve().then(() => status(videoId)), deadlineAt);
    if (s === TIMEOUT || !s || typeof s !== 'object') return done('PRIVATE_TEST_ONLY', 'UPLOADED_PRIVATE', 'QUERY_FAILED', videoId);
    const state = (s as Record<string, unknown>).state;
    const safe = typeof state === 'string' && STATUS_STATES.includes(state) ? state : 'QUERY_FAILED';
    return done('PRIVATE_TEST_ONLY', upState as 'UPLOADED_PRIVATE', safe as PreparationResult['status'], videoId);
  } catch {
    return done('PRIVATE_TEST_ONLY', 'UPLOADED_PRIVATE', 'QUERY_FAILED', videoId);
  }
}
