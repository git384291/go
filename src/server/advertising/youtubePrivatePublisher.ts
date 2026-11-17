import 'server-only';
// YouTube Data API 비공개 업로드·상태 조회 어댑터 (PM 6951004870). **비활성 준비 코드: 계정 연결·실접속·공개 게재 승인이 아니다.**
//
// 공식 근거(2026-11-17 Claude가 developers.google.com 문서 직접 대조):
//   https://developers.google.com/youtube/v3/docs/videos/insert — POST https://www.googleapis.com/upload/youtube/v3/videos,
//     part 필수, OAuth 범위(youtube.upload 등) 필요, 업로드 쿼터 1단위·하루 100회 버킷, 허용 MIME video/* · application/octet-stream.
//     미검증 API 프로젝트의 비공개 제한 문구는 **열람 결과가 엇갈린다**(Claude 열람본은 "not restricted to private", PM 열람본은 private 제한 명시).
//     확정하지 않는다. 어느 쪽이든 이 어댑터는 privacyStatus:'private'를 직접 고정한다. 실업로드 조건은 실계정에서 재확인.
//   https://developers.google.com/youtube/v3/docs/videos — status.privacyStatus(private/public/unlisted, 생략 시 public 기본 가능),
//     status.uploadStatus(deleted/failed/processed/rejected/uploaded), processingDetails.processingStatus(failed/processing/succeeded/terminated),
//     snippet.title 최대 100자·< > 불가, description 최대 5000바이트·< > 불가.
//   channels.list(part=id, mine=true)·videos.list(id, part=status,processingDetails)는 PM이 원문 열람으로 확인했다.
//   실제 token에 필요한 OAuth 범위(youtube.upload만으로 조회까지 되는지)는 미검증이다. 가짜 요청 계약 시험은 실제 Google 수락을 뜻하지 않는다.
//   multipart(uploadType=multipart, multipart/related)는 Google API 공통 업로드 방식이며 videos.insert 문서 표에는 uploadType이 직접 나오지 않는다(예제는 resumable).
//
// 계약
// - transport·OAuth access token·예상 채널 ID·업로드 허용(정확히 true)은 **모두 필수 주입**이다. env·기본 fetch·SDK·키 저장·발급·OAuth 로그인 경로 없음.
//   설정이 하나라도 없거나 허용이 false면 transport 0회. API key만으로 소유권을 대신하지 않는다(OAuth bearer만 받음).
// - 고정 endpoint 3개만 쓴다. 임의 URL·쿼리·redirect·로컬 파일 경로 입력은 없다. 영상 ID는 형식 검증 뒤에만 조회 쿼리에 들어간다.
// - 업로드 전에 channels.list(mine=true) 결과가 예상 채널 ID와 정확히 1건 일치해야 한다. 아니면 업로드 0회.
// - 업로드는 privacyStatus:'private' 고정. publishAt·공개 전환·예약·삭제·유료 광고·통계 API 없음.
// - selfDeclaredMadeForKids(아동 대상)·containsSyntheticMedia(합성물) 필드는 **보내지 않는다**. 이 코드는 그 사실을 판정하지 않으며,
//   실제 업로드 전에 사람이 판단·설정해야 한다(미확인). categoryId도 보내지 않는다.
// - 영상은 메모리 Uint8Array만(1바이트~5MiB, mp4/webm 서명 확인). 파일 다운로드·영상 생성은 범위 밖.
// - 응답은 불신 데이터. 반환은 고정 상태·최소 video ID·고정 오류뿐(채널명·토큰·헤더·본문·원문 미반환). 재시도 0.
// - 업로드 요청을 보낸 뒤의 마감·전송 오류·2xx 본문 판독 실패는 "실패"가 아니라 RESULT_UNKNOWN이다(재업로드 판단 금지).
// - 응답 수신은 공개 게시 성공이 아니다. 영속 멱등 저장소·백그라운드 재시도·스케줄러는 만들지 않았다.
import { boundedRequest, parseJsonSafe, type BodyTransport, type BoundedResult } from './boundedHttp';
import { validateAdCopy } from './adGeneration';

export const YT_CHANNELS_URL = 'https://www.googleapis.com/youtube/v3/channels?part=id&mine=true';
export const YT_UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=multipart&part=snippet,status';
export const YT_VIDEOS_URL_PREFIX = 'https://www.googleapis.com/youtube/v3/videos?part=status,processingDetails&id=';
export const YT_MAX_VIDEO_BYTES = 5 * 1024 * 1024;
export const YT_ALLOWED_MIME = Object.freeze(['video/mp4', 'video/webm'] as const);
type Mime = (typeof YT_ALLOWED_MIME)[number];

export type YoutubePublisherConfig = {
  readonly transport: BodyTransport | null;
  readonly accessToken: string | null;
  readonly expectedChannelId: string | null;
  /** 정확히 true일 때만 업로드한다 */
  readonly uploadAllowed: unknown;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
};

export type YtFailCode = 'AUTH_FAILED' | 'FORBIDDEN' | 'RATE_LIMITED' | 'HTTP_ERROR' | 'TIMEOUT' | 'TRANSPORT_ERROR' | 'TOO_LARGE' | 'BAD_RESPONSE';

export type UploadOutcome =
  | { readonly state: 'NOT_CONFIGURED'; readonly uploadAttempted: false }
  | { readonly state: 'INVALID_INPUT'; readonly uploadAttempted: false }
  | { readonly state: 'CHANNEL_CHECK_FAILED'; readonly code: YtFailCode; readonly uploadAttempted: false }
  | { readonly state: 'CHANNEL_MISMATCH'; readonly uploadAttempted: false }
  | { readonly state: 'TIMEOUT_BEFORE_UPLOAD'; readonly uploadAttempted: false }
  | { readonly state: 'UPLOAD_FAILED'; readonly code: YtFailCode; readonly uploadAttempted: true }
  | { readonly state: 'RESULT_UNKNOWN'; readonly uploadAttempted: true }
  | { readonly state: 'NOT_PRIVATE'; readonly videoId: string; readonly uploadAttempted: true }
  | { readonly state: 'UPLOADED_PRIVATE'; readonly videoId: string; readonly uploadAttempted: true };

export type StatusOutcome =
  | { readonly state: 'NOT_CONFIGURED' | 'INVALID_INPUT' | 'NOT_FOUND' | 'NOT_PRIVATE' | 'UPLOAD_REJECTED' }
  | { readonly state: 'QUERY_FAILED'; readonly code: YtFailCode }
  | { readonly state: 'PRIVATE_PROCESSING' | 'PRIVATE_PROCESSED' | 'PRIVATE_PROCESSING_FAILED' | 'PRIVATE_PROCESSING_UNKNOWN' };

export type YoutubePrivatePublisher = {
  readonly uploadPrivate: (input: unknown) => Promise<UploadOutcome>;
  readonly getStatus: (videoId: unknown) => Promise<StatusOutcome>;
};

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const TOKEN = /^[A-Za-z0-9._~+/-]{20,4096}={0,2}$/;
const fz = <T extends object>(o: T): T => Object.freeze(o);

type Snapshot = { transport: BodyTransport; token: string; channel: string; timeoutMs: number; maxResponseBytes: number };

/** 설정 각 속성을 경계 안에서 **한 번만** 읽어 스냅샷을 만들고, 그 스냅샷을 검증해 그대로 쓴다 */
function snapshotConfig(c: YoutubePublisherConfig | null | undefined): Snapshot | null {
  try {
    if (!c || typeof c !== 'object') return null;
    const uploadAllowed = c.uploadAllowed;
    const transport = c.transport;
    const token = c.accessToken;
    const channel = c.expectedChannelId;
    const timeoutMs = c.timeoutMs;
    const maxResponseBytes = c.maxResponseBytes;
    if (uploadAllowed !== true || typeof transport !== 'function') return null;
    if (typeof token !== 'string' || !TOKEN.test(token)) return null;
    if (typeof channel !== 'string' || !CHANNEL_ID.test(channel)) return null;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) return null;
    if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > 65536) return null;
    return Object.freeze({ transport, token, channel, timeoutMs, maxResponseBytes });
  } catch {
    return null;
  }
}

const httpCode = (status: number): YtFailCode => (status === 401 ? 'AUTH_FAILED' : status === 403 ? 'FORBIDDEN' : status === 429 ? 'RATE_LIMITED' : 'HTTP_ERROR');
const failCode = (r: Exclude<BoundedResult, { kind: 'ok' }>): YtFailCode => (r.kind === 'http' ? httpCode(r.status) : r.code);

/** mp4(ftyp 상자) 또는 webm(EBML) 서명 확인 — 형식 검사일 뿐 내용 안전성 검사가 아니다 */
const signatureOk = (b: Uint8Array, mime: Mime): boolean =>
  mime === 'video/mp4'
    ? b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70
    : b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;

type Upload = { video: Uint8Array; mimeType: Mime; title: string; description: string };

/** 영상 검증 + 방어 복사(생성 전 조합에서도 재사용). 크기 1B~5MiB, mp4/webm 서명. 실패 → null */
export function checkVideo(video: unknown, mimeType: unknown): { video: Uint8Array; mimeType: Mime } | null {
  try {
    if (!(video instanceof Uint8Array) || video.byteLength < 1 || video.byteLength > YT_MAX_VIDEO_BYTES) return null;
    if (typeof mimeType !== 'string' || !(YT_ALLOWED_MIME as readonly string[]).includes(mimeType)) return null;
    const copy = new Uint8Array(video); // 방어 복사
    if (copy.byteLength < 1 || copy.byteLength > YT_MAX_VIDEO_BYTES) return null;
    if (!signatureOk(copy, mimeType as Mime)) return null;
    return { video: copy, mimeType: mimeType as Mime };
  } catch {
    return null;
  }
}

/** 입력 검증 + 방어 복사(원본 불변·검증 뒤 변경 차단). 실패하면 null */
function readUploadInput(input: unknown): Upload | null {
  try {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;
    const proto = Object.getPrototypeOf(input);
    if (proto !== Object.prototype && proto !== null) return null;
    const keys = Object.keys(input);
    const want = ['video', 'mimeType', 'title', 'description'];
    if (keys.length !== want.length || !want.every((k) => keys.includes(k))) return null;
    const o = input as Record<string, unknown>;
    const video = o.video;
    const mimeType = o.mimeType;
    const title = o.title;
    const description = o.description;
    const v = checkVideo(video, mimeType);
    if (!v) return null;
    const copyCheck = validateAdCopy({ title, description });
    if (!copyCheck.ok) return null;
    return { video: v.video, mimeType: v.mimeType, title: copyCheck.title, description: copyCheck.description };
  } catch {
    return null;
  }
}

const enc = new TextEncoder();
const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
};
const includesBytes = (hay: Uint8Array, needle: Uint8Array): boolean => {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
};

/** multipart/related 본문(경계·Content-Type은 서버 통제). 경계가 영상 바이트에 있으면 null(닫힘) */
export function buildMultipart(u: Upload, boundary: string): { body: Uint8Array; contentType: string } | null {
  if (!/^[A-Za-z0-9]{24,64}$/.test(boundary)) return null;
  if (includesBytes(u.video, enc.encode(boundary))) return null;
  const meta = JSON.stringify({ snippet: { title: u.title, description: u.description }, status: { privacyStatus: 'private' } });
  const body = concat([
    enc.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${u.mimeType}\r\n\r\n`),
    u.video,
    enc.encode(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, contentType: `multipart/related; boundary=${boundary}` };
}

const newBoundary = (): string => {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return 'fideon' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
};

/** 불신 응답에서 안전하게 값 꺼내기(접근자·Proxy 예외 → undefined) */
const pick = (o: unknown, ...path: string[]): unknown => {
  try {
    let cur: unknown = o;
    for (const k of path) {
      if (cur === null || typeof cur !== 'object') return undefined;
      cur = (cur as Record<string, unknown>)[k];
    }
    return cur;
  } catch {
    return undefined;
  }
};

const UPLOAD_STATUS = ['deleted', 'failed', 'processed', 'rejected', 'uploaded'];
const PROCESSING_STATUS = ['failed', 'processing', 'succeeded', 'terminated'];

/** videos.list 응답 판정. 각 값은 한 번만 읽은 JSON 데이터에서 꺼낸다. enum 밖·누락·모순은 성공으로 넘기지 않는다 */
export function judgeVideoStatus(text: string, videoId: string): StatusOutcome {
  const items = pick(parseJsonSafe(text), 'items');
  if (!Array.isArray(items)) return fz({ state: 'QUERY_FAILED', code: 'BAD_RESPONSE' });
  if (items.length === 0) return fz({ state: 'NOT_FOUND' });
  if (items.length !== 1) return fz({ state: 'QUERY_FAILED', code: 'BAD_RESPONSE' });
  const it = items[0];
  const id = pick(it, 'id');
  const status = pick(it, 'status');
  const processing = pick(it, 'processingDetails');
  if (id !== videoId || status === null || typeof status !== 'object') return fz({ state: 'QUERY_FAILED', code: 'BAD_RESPONSE' });
  const privacy = pick(status, 'privacyStatus');
  const upload = pick(status, 'uploadStatus');
  if (typeof privacy !== 'string' || !['private', 'public', 'unlisted'].includes(privacy)) return fz({ state: 'QUERY_FAILED', code: 'BAD_RESPONSE' });
  if (typeof upload !== 'string' || !UPLOAD_STATUS.includes(upload)) return fz({ state: 'QUERY_FAILED', code: 'BAD_RESPONSE' });
  if (privacy !== 'private') return fz({ state: 'NOT_PRIVATE' });
  if (upload === 'failed' || upload === 'rejected' || upload === 'deleted') return fz({ state: 'UPLOAD_REJECTED' });
  // processingDetails는 소유자 요청에만 올 수 있어 누락은 '미확인'으로 둔다(성공 아님). 값이 있으면 enum이어야 한다
  if (processing === undefined) return fz({ state: 'PRIVATE_PROCESSING_UNKNOWN' });
  const p = pick(processing, 'processingStatus');
  if (p === undefined) return fz({ state: 'PRIVATE_PROCESSING_UNKNOWN' });
  if (typeof p !== 'string' || !PROCESSING_STATUS.includes(p)) return fz({ state: 'QUERY_FAILED', code: 'BAD_RESPONSE' });
  if (p === 'processing') return fz({ state: 'PRIVATE_PROCESSING' });
  if (p === 'succeeded') return upload === 'processed' || upload === 'uploaded' ? fz({ state: 'PRIVATE_PROCESSED' }) : fz({ state: 'QUERY_FAILED', code: 'BAD_RESPONSE' });
  return fz({ state: 'PRIVATE_PROCESSING_FAILED' });
}

export function createYoutubePrivatePublisher(config: YoutubePublisherConfig | null): YoutubePrivatePublisher {
  const cfg = snapshotConfig(config); // 이후 외부 config 변경·재읽기 없음
  const auth = (c: Snapshot, extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${c.token}`, Accept: 'application/json', ...extra });

  return fz({
    uploadPrivate: async (input: unknown): Promise<UploadOutcome> => {
      if (!cfg) return fz({ state: 'NOT_CONFIGURED', uploadAttempted: false });
      const deadlineAt = Date.now() + cfg.timeoutMs; // 채널 확인과 업로드가 공유하는 하나의 절대 마감
      const u = readUploadInput(input);
      if (!u) return fz({ state: 'INVALID_INPUT', uploadAttempted: false });
      const mp = buildMultipart(u, newBoundary());
      if (!mp) return fz({ state: 'INVALID_INPUT', uploadAttempted: false });
      const limits = { deadlineAt, maxResponseBytes: cfg.maxResponseBytes };

      // 1) 채널 소유 확인: 정확히 1건, 예상 ID와 일치해야만 업로드
      const ch = await boundedRequest(cfg.transport, YT_CHANNELS_URL, { method: 'GET', headers: auth(cfg) }, limits);
      if (ch.kind !== 'ok') return fz({ state: 'CHANNEL_CHECK_FAILED', code: failCode(ch), uploadAttempted: false });
      const items = pick(parseJsonSafe(ch.text), 'items');
      if (!Array.isArray(items)) return fz({ state: 'CHANNEL_CHECK_FAILED', code: 'BAD_RESPONSE', uploadAttempted: false });
      const ids = items.map((it) => pick(it, 'id'));
      if (ids.length !== 1 || ids[0] !== cfg.channel) return fz({ state: 'CHANNEL_MISMATCH', uploadAttempted: false });
      if (Date.now() >= deadlineAt) return fz({ state: 'TIMEOUT_BEFORE_UPLOAD', uploadAttempted: false });

      // 2) 비공개 업로드(1회, 같은 마감의 남은 시간). 보낸 뒤 결과를 알 수 없으면 RESULT_UNKNOWN
      const up = await boundedRequest(cfg.transport, YT_UPLOAD_URL, { method: 'POST', headers: auth(cfg, { 'Content-Type': mp.contentType }), body: mp.body }, limits);
      if (up.kind === 'error' && up.sent === false) return fz({ state: 'TIMEOUT_BEFORE_UPLOAD', uploadAttempted: false });
      if (up.kind === 'http') return fz({ state: 'UPLOAD_FAILED', code: httpCode(up.status), uploadAttempted: true });
      if (up.kind === 'error') return fz({ state: 'RESULT_UNKNOWN', uploadAttempted: true });
      const res = parseJsonSafe(up.text);
      const id = pick(res, 'id');
      const privacy = pick(res, 'status', 'privacyStatus');
      if (typeof id !== 'string' || !VIDEO_ID.test(id)) return fz({ state: 'RESULT_UNKNOWN', uploadAttempted: true });
      if (privacy !== 'private') return fz({ state: 'NOT_PRIVATE', videoId: id, uploadAttempted: true });
      return fz({ state: 'UPLOADED_PRIVATE', videoId: id, uploadAttempted: true });
    },

    getStatus: async (videoId: unknown): Promise<StatusOutcome> => {
      if (!cfg) return fz({ state: 'NOT_CONFIGURED' });
      if (typeof videoId !== 'string' || !VIDEO_ID.test(videoId)) return fz({ state: 'INVALID_INPUT' });
      const r = await boundedRequest(cfg.transport, YT_VIDEOS_URL_PREFIX + videoId, { method: 'GET', headers: auth(cfg) }, { deadlineAt: Date.now() + cfg.timeoutMs, maxResponseBytes: cfg.maxResponseBytes });
      if (r.kind !== 'ok') return fz({ state: 'QUERY_FAILED', code: failCode(r) });
      return judgeVideoStatus(r.text, videoId);
    },
  });
}
