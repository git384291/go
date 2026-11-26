import 'server-only';
import { createHash } from 'node:crypto';
import { maskPii } from '../consult/piiMask';
import { boundedRequest, type BodyTransport } from './boundedHttp';
// 유튜브 게시 보호 장치 + 썸네일 어댑터 (비활성 준비 코드). **실계정 연결·공개 게시·예약 실행이 아니다.**
//
// 공식 근거(2026-11-26 Claude가 developers.google.com 문서 직접 확인):
//   videos.insert — status.publishAt은 요청 본문 속성이며, 잘못된 시간은 400 invalidPublishAt. 업로드 쿼터 1단위·하루 100회 버킷.
//   thumbnails.set — POST https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=…, 본문은 이미지 바이트, MIME image/jpeg·image/png,
//     쿼터 약 50단위, 공식 최대 50MB. Shorts는 processingStatus가 succeeded가 된 뒤에 호출해야 적용된다.
//   미확인: 미검증 API 프로젝트의 비공개 제한(문서 열람 결과가 엇갈림). 이 모듈은 어느 쪽이든 공개 전환 경로를 만들지 않는다.
//
// 이 모듈이 하는 일(전부 순수 판정, 저장소·네트워크 없음, 썸네일 어댑터만 주입 transport 사용)
// - 중복 게시 방지: 내용 키(영상 바이트+제목+종류) 대조. 결과 미확인(RESULT_UNKNOWN) 이력이 있으면 재업로드 금지(사람 확인).
// - 예약 시각 검증(자체 정책: 현재+15분 ~ 30일, UTC 'Z' 형식만). Google 공식 제한값이 아니다.
// - 게시 전 점검: 개인정보·링크·스팸 반복·해시태그 과다, 그리고 **사람이 정해야 하는 값**(저작권 확인·아동 대상·합성물 표시·PM 검수 근거)이
//   명시되지 않으면 통과 못 한다. 이 코드는 그 사실을 판정하지 않는다.
// - 썸네일: 서명·크기(자체 상한 2MiB) 확인 후 처리 완료된 영상에만 설정한다. 재시도 0.
// 영속 이력 저장소(DB)는 아직 없다 → 호출자가 이력을 읽어 넘겨야 하며, 저장 없이는 재시작 뒤 중복 방지가 되지 않는다(미완료).

export type PublishKind = 'shorts' | 'long';
export type HistoryState = 'UPLOADED_PRIVATE' | 'SCHEDULED' | 'PUBLISHED' | 'RESULT_UNKNOWN' | 'UPLOAD_FAILED';
export type HistoryEntry = { readonly key: string; readonly state: HistoryState };

/** 내용 키: 같은 영상·제목·종류면 같은 값(sha256 hex). 입력 형식이 틀리면 null */
export function contentKey(video: unknown, title: unknown, kind: unknown): string | null {
  if (!(video instanceof Uint8Array) || video.byteLength < 1) return null;
  if (typeof title !== 'string' || title.length < 1 || title.length > 100) return null;
  if (kind !== 'shorts' && kind !== 'long') return null;
  const h = createHash('sha256');
  h.update(kind);
  h.update('\u0000');
  h.update(title.normalize('NFC'));
  h.update('\u0000');
  h.update(video);
  return h.digest('hex');
}

export type PublishDecision = 'PROCEED' | 'DUPLICATE' | 'BLOCK_UNKNOWN_RESULT' | 'INVALID';
const KEY = /^[0-9a-f]{64}$/;
const STATES: readonly string[] = ['UPLOADED_PRIVATE', 'SCHEDULED', 'PUBLISHED', 'RESULT_UNKNOWN', 'UPLOAD_FAILED'];

/** 이력에서 같은 키를 찾아 판정. 이력 형식이 이상하면 INVALID(닫힘). UPLOAD_FAILED는 다시 시도 가능 */
export function decidePublish(history: unknown, key: unknown): PublishDecision {
  if (typeof key !== 'string' || !KEY.test(key) || !Array.isArray(history)) return 'INVALID';
  let unknown = false;
  for (const e of history) {
    if (e === null || typeof e !== 'object') return 'INVALID';
    const k = (e as Record<string, unknown>).key;
    const s = (e as Record<string, unknown>).state;
    if (typeof k !== 'string' || !KEY.test(k) || typeof s !== 'string' || !STATES.includes(s)) return 'INVALID';
    if (k !== key) continue;
    if (s === 'UPLOADED_PRIVATE' || s === 'SCHEDULED' || s === 'PUBLISHED') return 'DUPLICATE';
    if (s === 'RESULT_UNKNOWN') unknown = true;
  }
  return unknown ? 'BLOCK_UNKNOWN_RESULT' : 'PROCEED';
}

export const SCHEDULE_MIN_MS = 15 * 60 * 1000;
export const SCHEDULE_MAX_MS = 30 * 24 * 60 * 60 * 1000;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
export type ScheduleCheck = { readonly ok: true; readonly publishAt: string } | { readonly ok: false; readonly reason: 'FORMAT' | 'TOO_SOON' | 'TOO_FAR' };

/** 예약 시각 검사(자체 정책). 반환 publishAt은 정규화된 ISO(밀리초 포함) */
export function validateSchedule(publishAt: unknown, nowMs: number): ScheduleCheck {
  if (typeof publishAt !== 'string' || !ISO_UTC.test(publishAt) || !Number.isFinite(nowMs)) return Object.freeze({ ok: false, reason: 'FORMAT' });
  const t = Date.parse(publishAt);
  if (!Number.isFinite(t)) return Object.freeze({ ok: false, reason: 'FORMAT' });
  const iso = new Date(t).toISOString();
  if (iso.slice(0, 19) !== publishAt.slice(0, 19)) return Object.freeze({ ok: false, reason: 'FORMAT' }); // 2026-02-31 같은 날짜가 밀려 바뀌는 경우
  if (t < nowMs + SCHEDULE_MIN_MS) return Object.freeze({ ok: false, reason: 'TOO_SOON' });
  if (t > nowMs + SCHEDULE_MAX_MS) return Object.freeze({ ok: false, reason: 'TOO_FAR' });
  return Object.freeze({ ok: true, publishAt: iso });
}

export type ComplianceInput = {
  readonly title: unknown;
  readonly description: unknown;
  /** 저작권·사용권을 사람이 확인했는지(정확히 true만 통과) */
  readonly rightsConfirmed: unknown;
  /** 아동 대상 여부를 사람이 정한 값(true/false 모두 가능, 미정(undefined)은 불통과) */
  readonly madeForKids: unknown;
  /** AI 생성·합성물 표시 여부를 사람이 정한 값(true/false, 미정은 불통과) */
  readonly syntheticDisclosed: unknown;
  /** PM 검수 근거(PM-숫자 6~12자리). 형식 검사일 뿐 진위 확인이 아니다 */
  readonly reviewRef: unknown;
};
export type ComplianceIssue = 'TEXT_INVALID' | 'PII_IN_TEXT' | 'LINK_IN_TEXT' | 'SPAM_REPEAT' | 'TOO_MANY_HASHTAGS' | 'RIGHTS_NOT_CONFIRMED' | 'KIDS_UNDECIDED' | 'SYNTHETIC_UNDECIDED' | 'REVIEW_MISSING';
export type ComplianceResult = { readonly ok: boolean; readonly issues: readonly ComplianceIssue[] };

const LINK = /(https?:\/\/|www\.|[a-z0-9-]+\.(com|net|kr|co\.kr|io|me|ly)\b)/i;
/** 자체 정책(Google 공식 한도 아님): 해시태그 최대 3개, 같은 낱말 4회 이상 반복 금지 */
export function complianceGate(input: ComplianceInput): ComplianceResult {
  const issues: ComplianceIssue[] = [];
  const title = input?.title;
  const description = input?.description;
  if (typeof title !== 'string' || typeof description !== 'string' || title.length < 1 || title.length > 100 || description.length > 5000 || /[<>]/.test(title + description)) {
    return Object.freeze({ ok: false, issues: Object.freeze(['TEXT_INVALID'] as ComplianceIssue[]) });
  }
  const all = `${title}\n${description}`;
  if (maskPii(all) !== all) issues.push('PII_IN_TEXT');
  if (LINK.test(all)) issues.push('LINK_IN_TEXT');
  const words = all.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  const count = new Map<string, number>();
  for (const w of words) count.set(w, (count.get(w) ?? 0) + 1);
  if ([...count.values()].some((n) => n >= 4)) issues.push('SPAM_REPEAT');
  if ((all.match(/#[\p{L}\p{N}_]+/gu) ?? []).length > 3) issues.push('TOO_MANY_HASHTAGS');
  if (input.rightsConfirmed !== true) issues.push('RIGHTS_NOT_CONFIRMED');
  if (typeof input.madeForKids !== 'boolean') issues.push('KIDS_UNDECIDED');
  if (typeof input.syntheticDisclosed !== 'boolean') issues.push('SYNTHETIC_UNDECIDED');
  if (typeof input.reviewRef !== 'string' || !/^PM-[0-9]{6,12}$/.test(input.reviewRef)) issues.push('REVIEW_MISSING');
  return Object.freeze({ ok: issues.length === 0, issues: Object.freeze(issues) });
}

// ---- 썸네일 ----
export const YT_THUMBNAIL_URL_PREFIX = 'https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=';
export const YT_MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024; // 자체 상한(공식 50MB보다 보수적)
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const TOKEN = /^[A-Za-z0-9._~+/-]{20,4096}={0,2}$/;

/** 이미지 검사: image/jpeg 또는 image/png, 서명 일치, 1B~2MiB. 방어 복사본 반환 */
export function checkThumbnail(image: unknown, mimeType: unknown): { image: Uint8Array; mimeType: 'image/jpeg' | 'image/png' } | null {
  try {
    if (!(image instanceof Uint8Array) || image.byteLength < 8 || image.byteLength > YT_MAX_THUMBNAIL_BYTES) return null;
    const copy = new Uint8Array(image);
    if (mimeType === 'image/jpeg' && copy[0] === 0xff && copy[1] === 0xd8 && copy[2] === 0xff) return { image: copy, mimeType };
    if (mimeType === 'image/png' && copy[0] === 0x89 && copy[1] === 0x50 && copy[2] === 0x4e && copy[3] === 0x47) return { image: copy, mimeType };
    return null;
  } catch {
    return null;
  }
}

export type ThumbnailConfig = {
  readonly transport: BodyTransport | null;
  readonly accessToken: string | null;
  /** 정확히 true일 때만 전송 */
  readonly thumbnailAllowed: unknown;
  readonly timeoutMs: number;
};
export type ThumbnailOutcome =
  | { readonly state: 'NOT_CONFIGURED' | 'INVALID_INPUT' | 'VIDEO_NOT_PROCESSED' | 'NOT_SENT' | 'SET_OK' | 'RESULT_UNKNOWN' }
  | { readonly state: 'SET_FAILED'; readonly code: 'AUTH_FAILED' | 'FORBIDDEN' | 'RATE_LIMITED' | 'HTTP_ERROR' };

/** 썸네일 설정(재시도 0). processed는 호출자가 getStatus()로 PRIVATE_PROCESSED를 확인한 결과(정확히 true만 통과) */
export function createYoutubeThumbnailSetter(config: ThumbnailConfig | null) {
  const fz = <T extends object>(o: T): T => Object.freeze(o);
  let cfg: { transport: BodyTransport; token: string; timeoutMs: number } | null = null;
  try {
    if (config && config.thumbnailAllowed === true && typeof config.transport === 'function' && typeof config.accessToken === 'string' && TOKEN.test(config.accessToken) && Number.isSafeInteger(config.timeoutMs) && config.timeoutMs >= 1000 && config.timeoutMs <= 120000) {
      cfg = { transport: config.transport, token: config.accessToken, timeoutMs: config.timeoutMs };
    }
  } catch {
    cfg = null;
  }
  return Object.freeze({
    setThumbnail: async (input: { videoId: unknown; image: unknown; mimeType: unknown; processed: unknown }): Promise<ThumbnailOutcome> => {
      if (!cfg) return fz({ state: 'NOT_CONFIGURED' as const });
      const videoId = input?.videoId;
      const img = checkThumbnail(input?.image, input?.mimeType);
      if (typeof videoId !== 'string' || !VIDEO_ID.test(videoId) || !img) return fz({ state: 'INVALID_INPUT' as const });
      if (input.processed !== true) return fz({ state: 'VIDEO_NOT_PROCESSED' as const });
      const r = await boundedRequest(cfg.transport, YT_THUMBNAIL_URL_PREFIX + videoId, { method: 'POST', headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': img.mimeType }, body: img.image }, { deadlineAt: Date.now() + cfg.timeoutMs, maxResponseBytes: 16384 });
      if (r.kind === 'ok') return fz({ state: 'SET_OK' as const });
      if (r.kind === 'http') return fz({ state: 'SET_FAILED' as const, code: r.status === 401 ? ('AUTH_FAILED' as const) : r.status === 403 ? ('FORBIDDEN' as const) : r.status === 429 ? ('RATE_LIMITED' as const) : ('HTTP_ERROR' as const) });
      return fz({ state: r.sent ? ('RESULT_UNKNOWN' as const) : ('NOT_SENT' as const) });
    },
  });
}
