import 'server-only';
// 유튜브 광고 소재 준비 조합 (PM 6951004870): AI 문구 생성 → 검증 → 가상/비공개 업로드 → 상태 조회.
// **비공개 시험 전용(PRIVATE_TEST_ONLY). 공개 게시·유료 집행·HTTP route/UI 배선 없음.**
// - 생성기(generateCopy)와 게시 어댑터(publisher)는 필수 주입. 없거나 생성 실패면 업로드 0회.
// - 입력은 고정 상황 ID·internet-tv·제약된 메모리 영상(mp4/webm, ≤5MiB)뿐. 게시 허용 여부는 입력으로 정하지 않는다.
// - 생성 결과는 validateAdCopy로 다시 검증하고 새 객체의 title·description만 넘긴다.
// - 가짜 영상·가짜 transport 성공은 실제 영상 품질·실 AI·실 계정·문의 성과를 뜻하지 않는다.
// - publicPublished·paidExecutionAllowed는 항상 false. 예외·원문은 고정 실패로 닫는다.
import { validateAdCopy, type AdGenerationResult } from './adGeneration';
import type { UploadOutcome, StatusOutcome, YoutubePrivatePublisher } from './youtubePrivatePublisher';
import { AD_DRAFT_IDS } from '@/content/adDrafts';

export type PreparationResult = {
  readonly stage: 'NOT_CONFIGURED' | 'INVALID_INPUT' | 'GENERATION_FAILED' | 'UPLOAD_NOT_COMPLETED' | 'PRIVATE_TEST_ONLY';
  readonly upload: UploadOutcome['state'] | 'NOT_ATTEMPTED';
  readonly status: StatusOutcome['state'] | 'NOT_QUERIED';
  readonly videoId: string | null;
  readonly publicPublished: false;
  readonly paidExecutionAllowed: false;
};

const done = (stage: PreparationResult['stage'], upload: PreparationResult['upload'], status: PreparationResult['status'], videoId: string | null = null): PreparationResult =>
  Object.freeze({ stage, upload, status, videoId, publicPublished: false, paidExecutionAllowed: false });

export async function prepareYoutubeAdPrivateTest(
  input: unknown,
  deps: {
    readonly generateCopy: ((i: { situationId: string; product: 'internet-tv' }) => Promise<AdGenerationResult>) | null;
    readonly publisher: YoutubePrivatePublisher | null;
  },
): Promise<PreparationResult> {
  let situationId: string;
  let video: Uint8Array;
  let mimeType: string;
  let gen: NonNullable<typeof deps.generateCopy>;
  let pub: YoutubePrivatePublisher;
  try {
    if (!deps || typeof deps.generateCopy !== 'function' || !deps.publisher || typeof deps.publisher.uploadPrivate !== 'function') return done('NOT_CONFIGURED', 'NOT_ATTEMPTED', 'NOT_QUERIED');
    gen = deps.generateCopy;
    pub = deps.publisher;
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return done('INVALID_INPUT', 'NOT_ATTEMPTED', 'NOT_QUERIED');
    const proto = Object.getPrototypeOf(input);
    if (proto !== Object.prototype && proto !== null) return done('INVALID_INPUT', 'NOT_ATTEMPTED', 'NOT_QUERIED');
    const keys = Object.keys(input);
    const want = ['situationId', 'product', 'video', 'mimeType'];
    if (keys.length !== want.length || !want.every((k) => keys.includes(k))) return done('INVALID_INPUT', 'NOT_ATTEMPTED', 'NOT_QUERIED');
    const o = input as Record<string, unknown>;
    if (typeof o.situationId !== 'string' || !(AD_DRAFT_IDS as readonly string[]).includes(o.situationId) || o.product !== 'internet-tv') return done('INVALID_INPUT', 'NOT_ATTEMPTED', 'NOT_QUERIED');
    if (!(o.video instanceof Uint8Array) || typeof o.mimeType !== 'string') return done('INVALID_INPUT', 'NOT_ATTEMPTED', 'NOT_QUERIED');
    situationId = o.situationId;
    video = new Uint8Array(o.video); // 방어 복사(원본 불변)
    mimeType = o.mimeType;
  } catch {
    return done('INVALID_INPUT', 'NOT_ATTEMPTED', 'NOT_QUERIED');
  }

  let copy: { title: string; description: string };
  try {
    const g = await gen({ situationId, product: 'internet-tv' });
    if (!g || g.ok !== true || g.source !== 'model') return done('GENERATION_FAILED', 'NOT_ATTEMPTED', 'NOT_QUERIED');
    const v = validateAdCopy({ title: g.title, description: g.description });
    if (!v.ok) return done('GENERATION_FAILED', 'NOT_ATTEMPTED', 'NOT_QUERIED');
    copy = { title: v.title, description: v.description };
  } catch {
    return done('GENERATION_FAILED', 'NOT_ATTEMPTED', 'NOT_QUERIED');
  }

  let up: UploadOutcome;
  try {
    up = await pub.uploadPrivate({ video, mimeType, title: copy.title, description: copy.description });
  } catch {
    return done('UPLOAD_NOT_COMPLETED', 'RESULT_UNKNOWN', 'NOT_QUERIED');
  }
  let upState: string;
  let upVideoId: unknown;
  try {
    upState = typeof up?.state === 'string' ? up.state : 'RESULT_UNKNOWN';
    upVideoId = (up as { videoId?: unknown }).videoId;
  } catch {
    return done('UPLOAD_NOT_COMPLETED', 'RESULT_UNKNOWN', 'NOT_QUERIED');
  }
  const KNOWN_UP = ['NOT_CONFIGURED', 'INVALID_INPUT', 'CHANNEL_CHECK_FAILED', 'CHANNEL_MISMATCH', 'UPLOAD_FAILED', 'RESULT_UNKNOWN', 'NOT_PRIVATE', 'UPLOADED_PRIVATE'];
  if (!KNOWN_UP.includes(upState)) upState = 'RESULT_UNKNOWN';
  const vidOk = typeof upVideoId === 'string' && /^[A-Za-z0-9_-]{11}$/.test(upVideoId);
  if (upState !== 'UPLOADED_PRIVATE' || !vidOk) {
    const st = upState === 'UPLOADED_PRIVATE' ? 'RESULT_UNKNOWN' : upState; // ID 없는 "성공"은 결과 미확인
    return done('UPLOAD_NOT_COMPLETED', st as PreparationResult['upload'], 'NOT_QUERIED', st === 'NOT_PRIVATE' && vidOk ? (upVideoId as string) : null);
  }
  const videoId = upVideoId as string;
  let st: StatusOutcome;
  try {
    st = await pub.getStatus(videoId);
  } catch {
    return done('PRIVATE_TEST_ONLY', 'UPLOADED_PRIVATE', 'QUERY_FAILED', videoId);
  }
  const KNOWN_ST = ['NOT_CONFIGURED', 'INVALID_INPUT', 'NOT_FOUND', 'NOT_PRIVATE', 'UPLOAD_REJECTED', 'QUERY_FAILED', 'PRIVATE_PROCESSING', 'PRIVATE_PROCESSED', 'PRIVATE_PROCESSING_FAILED', 'PRIVATE_PROCESSING_UNKNOWN'];
  let stState: string;
  try {
    stState = typeof st?.state === 'string' && KNOWN_ST.includes(st.state) ? st.state : 'QUERY_FAILED';
  } catch {
    stState = 'QUERY_FAILED';
  }
  return done('PRIVATE_TEST_ONLY', 'UPLOADED_PRIVATE', stState as PreparationResult['status'], videoId);
}
