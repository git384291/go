// 유튜브 게시 보호 장치·썸네일 어댑터 시험 — 가짜 transport만. 실계정·실접속·실제 업로드·실영상 품질 확인이 아니다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  contentKey, decidePublish, validateSchedule, complianceGate, checkThumbnail, createYoutubeThumbnailSetter,
  YT_THUMBNAIL_URL_PREFIX, YT_MAX_THUMBNAIL_BYTES, SCHEDULE_MIN_MS, SCHEDULE_MAX_MS,
} from '../../src/server/advertising/youtubePublishGuard';
import type { BodyTransport } from '../../src/server/advertising/boundedHttp';

const TOKEN = 'ya29.fake_oauth_token_for_tests_000000';
const VID = 'AbCdEfGhIj0';
const MP4 = () => { const b = new Uint8Array(64); b.set([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70], 0); return b; };
const JPG = () => { const b = new Uint8Array(32); b.set([0xff, 0xd8, 0xff, 0xe0], 0); return b; };
const PNG = () => { const b = new Uint8Array(32); b.set([0x89, 0x50, 0x4e, 0x47], 0); return b; };
const OK_INPUT = { title: '이사 전 인터넷 확인', description: '새집 설치 가능 여부를 확인하세요.', rightsConfirmed: true, madeForKids: false, syntheticDisclosed: true, reviewRef: 'PM-693816968' };

test('YG1 내용 키: 같은 입력은 같은 키, 영상·제목·종류가 다르면 다른 키, 형식 불량은 null', () => {
  const a = contentKey(MP4(), '제목', 'shorts');
  assert.match(a ?? '', /^[0-9a-f]{64}$/);
  assert.equal(contentKey(MP4(), '제목', 'shorts'), a);
  assert.notEqual(contentKey(MP4(), '제목', 'long'), a);
  assert.notEqual(contentKey(MP4(), '다른 제목', 'shorts'), a);
  const v = MP4(); v[10] = 9;
  assert.notEqual(contentKey(v, '제목', 'shorts'), a);
  assert.equal(contentKey(new Uint8Array(0), '제목', 'shorts'), null);
  assert.equal(contentKey(MP4(), '', 'shorts'), null);
  assert.equal(contentKey(MP4(), 'x'.repeat(101), 'shorts'), null);
  assert.equal(contentKey(MP4(), '제목', 'reel'), null);
  assert.equal(contentKey('video', '제목', 'shorts'), null);
});

test('YG2 중복 방지: 올라간·예약·게시 이력은 DUPLICATE, 결과 미확인은 재업로드 금지, 실패 이력만 있으면 재시도 가능', () => {
  const k = contentKey(MP4(), '제목', 'shorts')!;
  const o = contentKey(MP4(), '다른', 'shorts')!;
  assert.equal(decidePublish([], k), 'PROCEED');
  assert.equal(decidePublish([{ key: o, state: 'PUBLISHED' }], k), 'PROCEED');
  for (const state of ['UPLOADED_PRIVATE', 'SCHEDULED', 'PUBLISHED']) assert.equal(decidePublish([{ key: k, state }], k), 'DUPLICATE');
  assert.equal(decidePublish([{ key: k, state: 'RESULT_UNKNOWN' }], k), 'BLOCK_UNKNOWN_RESULT');
  assert.equal(decidePublish([{ key: k, state: 'UPLOAD_FAILED' }], k), 'PROCEED');
  // 미확인 + 이미 올라간 이력이 섞이면 중복이 우선
  assert.equal(decidePublish([{ key: k, state: 'RESULT_UNKNOWN' }, { key: k, state: 'UPLOADED_PRIVATE' }], k), 'DUPLICATE');
});

test('YG3 이력·키 형식이 이상하면 INVALID(닫힘)', () => {
  const k = contentKey(MP4(), '제목', 'shorts')!;
  assert.equal(decidePublish(null, k), 'INVALID');
  assert.equal(decidePublish([], 'abc'), 'INVALID');
  assert.equal(decidePublish([{ key: k, state: 'PUBLISHED_OK' }], k), 'INVALID');
  assert.equal(decidePublish([null], k), 'INVALID');
  assert.equal(decidePublish([{ key: 'zz', state: 'PUBLISHED' }], k), 'INVALID');
});

test('YG4 예약 시각: 15분~30일 범위·UTC 형식만, 없는 날짜·형식 불량·범위 밖은 거부', () => {
  const now = Date.parse('2026-11-26T09:00:00.000Z');
  const at = (ms: number) => new Date(now + ms).toISOString();
  const good = validateSchedule(at(SCHEDULE_MIN_MS + 1000), now);
  assert.equal(good.ok, true);
  assert.deepEqual(validateSchedule(at(SCHEDULE_MIN_MS - 1000), now), { ok: false, reason: 'TOO_SOON' });
  assert.deepEqual(validateSchedule(at(SCHEDULE_MAX_MS + 1000), now), { ok: false, reason: 'TOO_FAR' });
  assert.deepEqual(validateSchedule('2026-12-31T10:00:00+09:00', now), { ok: false, reason: 'FORMAT' });
  assert.deepEqual(validateSchedule('2026-12-01 10:00:00', now), { ok: false, reason: 'FORMAT' });
  assert.deepEqual(validateSchedule('2026-02-31T10:00:00Z', now), { ok: false, reason: 'FORMAT' });
  assert.deepEqual(validateSchedule(12345, now), { ok: false, reason: 'FORMAT' });
  assert.deepEqual(validateSchedule(at(SCHEDULE_MIN_MS + 1000), Number.NaN), { ok: false, reason: 'FORMAT' });
});

test('YG5 게시 전 점검: 사람이 정한 값이 모두 있으면 통과, 하나라도 빠지면 이유와 함께 불통과', () => {
  assert.deepEqual(complianceGate(OK_INPUT), { ok: true, issues: [] });
  assert.deepEqual(complianceGate({ ...OK_INPUT, rightsConfirmed: 'yes' }).issues, ['RIGHTS_NOT_CONFIRMED']);
  assert.deepEqual(complianceGate({ ...OK_INPUT, rightsConfirmed: undefined }).issues, ['RIGHTS_NOT_CONFIRMED']);
  assert.deepEqual(complianceGate({ ...OK_INPUT, madeForKids: undefined }).issues, ['KIDS_UNDECIDED']);
  assert.deepEqual(complianceGate({ ...OK_INPUT, syntheticDisclosed: 'true' }).issues, ['SYNTHETIC_UNDECIDED']);
  assert.deepEqual(complianceGate({ ...OK_INPUT, reviewRef: 'PM-1' }).issues, ['REVIEW_MISSING']);
  assert.equal(complianceGate({ ...OK_INPUT, madeForKids: true }).ok, true); // true도 사람이 정한 값이면 통과(판정은 사람 몫)
});

test('YG6 개인정보·링크·스팸·해시태그: 전화·이메일·주소, 주소 링크, 같은 낱말 4회 반복, 해시태그 4개는 불통과', () => {
  assert.ok(complianceGate({ ...OK_INPUT, description: '문의 010-1234-5678' }).issues.includes('PII_IN_TEXT'));
  assert.ok(complianceGate({ ...OK_INPUT, description: '메일 a@b.com 으로' }).issues.includes('PII_IN_TEXT'));
  assert.ok(complianceGate({ ...OK_INPUT, description: '자세히 https://example.com 에서' }).issues.includes('LINK_IN_TEXT'));
  assert.ok(complianceGate({ ...OK_INPUT, description: '바로 example.co.kr 방문' }).issues.includes('LINK_IN_TEXT'));
  assert.ok(complianceGate({ ...OK_INPUT, description: '인터넷 인터넷 인터넷 인터넷 확인' }).issues.includes('SPAM_REPEAT'));
  assert.ok(complianceGate({ ...OK_INPUT, description: '#하나 #둘 #셋 #넷' }).issues.includes('TOO_MANY_HASHTAGS'));
  assert.equal(complianceGate({ ...OK_INPUT, description: '#하나 #둘 #셋' }).ok, true);
});

test('YG7 제목·설명 형식: < > 포함·길이 초과·문자열 아님은 TEXT_INVALID 하나만', () => {
  assert.deepEqual(complianceGate({ ...OK_INPUT, title: '<b>제목</b>' }).issues, ['TEXT_INVALID']);
  assert.deepEqual(complianceGate({ ...OK_INPUT, title: 'x'.repeat(101) }).issues, ['TEXT_INVALID']);
  assert.deepEqual(complianceGate({ ...OK_INPUT, description: 'x'.repeat(5001) }).issues, ['TEXT_INVALID']);
  assert.deepEqual(complianceGate({ ...OK_INPUT, title: 5 }).issues, ['TEXT_INVALID']);
  assert.deepEqual(complianceGate(null as never).issues, ['TEXT_INVALID']);
});

test('YG8 썸네일 이미지 검사: jpeg·png 서명과 크기, 방어 복사', () => {
  assert.ok(checkThumbnail(JPG(), 'image/jpeg'));
  assert.ok(checkThumbnail(PNG(), 'image/png'));
  assert.equal(checkThumbnail(PNG(), 'image/jpeg'), null);
  assert.equal(checkThumbnail(JPG(), 'image/gif'), null);
  assert.equal(checkThumbnail(new Uint8Array(4), 'image/png'), null);
  const big = new Uint8Array(YT_MAX_THUMBNAIL_BYTES + 1); big.set([0xff, 0xd8, 0xff], 0);
  assert.equal(checkThumbnail(big, 'image/jpeg'), null);
  const src = JPG();
  const r = checkThumbnail(src, 'image/jpeg')!;
  src[0] = 0; // 검사 뒤 원본이 바뀌어도 복사본은 그대로
  assert.equal(r.image[0], 0xff);
});

type Resp = { status: number; text?: string; throws?: boolean };
const fakeTransport = (resp: Resp) => {
  const calls: { url: string; init: Parameters<BodyTransport>[1] }[] = [];
  const t: BodyTransport = async (url, init) => {
    calls.push({ url, init });
    if (resp.throws) throw new Error('boom');
    const body = new ReadableStream<Uint8Array>({ start(c) { if (resp.text) c.enqueue(new TextEncoder().encode(resp.text)); c.close(); } });
    return { status: resp.status, body };
  };
  return { t, calls };
};
const cfg = (t: BodyTransport | null, extra: Record<string, unknown> = {}) => ({ transport: t, accessToken: TOKEN, thumbnailAllowed: true, timeoutMs: 5000, ...extra });

test('YG9 썸네일 설정: 허용·처리 완료·검증된 이미지일 때만 정확히 1회 전송, 성공은 SET_OK', async () => {
  const f = fakeTransport({ status: 200, text: '{}' });
  const s = createYoutubeThumbnailSetter(cfg(f.t));
  const r = await s.setThumbnail({ videoId: VID, image: PNG(), mimeType: 'image/png', processed: true });
  assert.deepEqual(r, { state: 'SET_OK' });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]!.url, YT_THUMBNAIL_URL_PREFIX + VID);
  assert.equal(f.calls[0]!.init.method, 'POST');
  assert.equal(f.calls[0]!.init.headers['Content-Type'], 'image/png');
  assert.equal(f.calls[0]!.init.redirect, 'error');
});

test('YG10 썸네일 차단: 설정 없음·허용 아님·처리 전·잘못된 입력은 전송 0회', async () => {
  const f = fakeTransport({ status: 200, text: '{}' });
  const good = { videoId: VID, image: PNG(), mimeType: 'image/png', processed: true };
  assert.deepEqual(await createYoutubeThumbnailSetter(null).setThumbnail(good), { state: 'NOT_CONFIGURED' });
  assert.deepEqual(await createYoutubeThumbnailSetter(cfg(f.t, { thumbnailAllowed: 'true' })).setThumbnail(good), { state: 'NOT_CONFIGURED' });
  assert.deepEqual(await createYoutubeThumbnailSetter(cfg(f.t, { accessToken: 'short' })).setThumbnail(good), { state: 'NOT_CONFIGURED' });
  assert.deepEqual(await createYoutubeThumbnailSetter(cfg(null)).setThumbnail(good), { state: 'NOT_CONFIGURED' });
  const s = createYoutubeThumbnailSetter(cfg(f.t));
  assert.deepEqual(await s.setThumbnail({ ...good, processed: undefined }), { state: 'VIDEO_NOT_PROCESSED' });
  assert.deepEqual(await s.setThumbnail({ ...good, processed: 'true' }), { state: 'VIDEO_NOT_PROCESSED' });
  assert.deepEqual(await s.setThumbnail({ ...good, videoId: '../x' }), { state: 'INVALID_INPUT' });
  assert.deepEqual(await s.setThumbnail({ ...good, mimeType: 'image/jpeg' }), { state: 'INVALID_INPUT' });
  assert.equal(f.calls.length, 0);
});

test('YG11 썸네일 오류: 401·403·429·500은 고정 코드, 보낸 뒤 전송 오류는 RESULT_UNKNOWN, 재시도 없음', async () => {
  const good = { videoId: VID, image: JPG(), mimeType: 'image/jpeg', processed: true };
  for (const [status, code] of [[401, 'AUTH_FAILED'], [403, 'FORBIDDEN'], [429, 'RATE_LIMITED'], [500, 'HTTP_ERROR']] as const) {
    const f = fakeTransport({ status });
    assert.deepEqual(await createYoutubeThumbnailSetter(cfg(f.t)).setThumbnail(good), { state: 'SET_FAILED', code });
    assert.equal(f.calls.length, 1);
  }
  const f = fakeTransport({ status: 200, throws: true });
  assert.deepEqual(await createYoutubeThumbnailSetter(cfg(f.t)).setThumbnail(good), { state: 'RESULT_UNKNOWN' });
  assert.equal(f.calls.length, 1);
});
