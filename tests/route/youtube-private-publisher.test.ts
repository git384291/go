// YouTube 비공개 업로드 어댑터·준비 조합(PM 6951004870) — 가짜 transport만. 실계정·실접속·공개 게시·실영상 품질 확인이 아니다.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createYoutubePrivatePublisher, YT_CHANNELS_URL, YT_UPLOAD_URL, YT_VIDEOS_URL_PREFIX, YT_MAX_VIDEO_BYTES, buildMultipart, type YoutubePublisherConfig } from '../../src/server/advertising/youtubePrivatePublisher';
import type { BodyTransport } from '../../src/server/advertising/boundedHttp';
import { prepareYoutubeAdPrivateTest } from '../../src/server/advertising/youtubeAdPreparation';
import { generateAdCopy, type AdCopyGenerator } from '../../src/server/advertising/adGeneration';

const TOKEN = 'ya29.fake_oauth_token_for_tests_000000';
const CH = 'UC' + 'a'.repeat(22);
const VID = 'AbCdEfGhIj0';
const COPY = { title: '이사 전 인터넷·TV 확인', description: '새집 인터넷·TV 조건을 확인하세요. 설치 가능 여부는 별도 확인이 필요합니다.' };
const MP4 = () => { const b = new Uint8Array(64); b.set([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70], 0); return b; };
const WEBM = () => { const b = new Uint8Array(32); b.set([0x1a, 0x45, 0xdf, 0xa3], 0); return b; };
const enc = (s: string) => new TextEncoder().encode(s);
const stream = (text: string) => {
  const st = { pulls: 0, cancelled: false };
  let sent = false;
  const body = new ReadableStream<Uint8Array>({
    pull(c) { st.pulls++; if (!sent) { sent = true; c.enqueue(enc(text)); } else c.close(); },
    cancel() { st.cancelled = true; },
  }, { highWaterMark: 0 });
  return { body, st };
};
type Resp = { status: number; text?: string; delayMs?: number; throws?: boolean };
type Call = { url: string; init: Parameters<BodyTransport>[1] };
/** URL별 응답 스크립트를 가진 가짜 transport */
const fakeTransport = (script: Record<'channels' | 'upload' | 'videos', Resp>) => {
  const calls: Call[] = [];
  const streams: ReturnType<typeof stream>[] = [];
  const t: BodyTransport = async (url, init) => {
    calls.push({ url, init });
    const key = url === YT_CHANNELS_URL ? 'channels' : url === YT_UPLOAD_URL ? 'upload' : url.startsWith(YT_VIDEOS_URL_PREFIX) ? 'videos' : null;
    if (!key) throw new Error('unexpected url');
    const r = script[key];
    if (r.delayMs) await new Promise((res) => setTimeout(res, r.delayMs));
    if (r.throws) throw new Error('ECONNRESET ya29.leak');
    const s = stream(r.text ?? '');
    streams.push(s);
    return { status: r.status, body: s.body };
  };
  return { t, calls, streams };
};
const chOk = JSON.stringify({ kind: 'youtube#channelListResponse', items: [{ id: CH, snippet: { title: '비밀 채널명' } }] });
const upOk = JSON.stringify({ id: VID, status: { privacyStatus: 'private', uploadStatus: 'uploaded' }, snippet: { channelTitle: '비밀 채널명' } });
const vidOk = (p = 'processing', privacy = 'private', upload = 'uploaded') => JSON.stringify({ items: [{ id: VID, status: { privacyStatus: privacy, uploadStatus: upload }, processingDetails: { processingStatus: p } }] });
const OK = { channels: { status: 200, text: chOk }, upload: { status: 200, text: upOk }, videos: { status: 200, text: vidOk() } };
const cfg = (t: BodyTransport | null, over: Partial<YoutubePublisherConfig> = {}): YoutubePublisherConfig => ({ transport: t, accessToken: TOKEN, expectedChannelId: CH, uploadAllowed: true, timeoutMs: 1000, maxResponseBytes: 4096, ...over });
const upInput = (over: Record<string, unknown> = {}) => ({ video: MP4(), mimeType: 'video/mp4', ...COPY, ...over });

// 실제 네트워크 0: 시험 동안 전역 fetch를 막고 호출 여부를 기록
let realFetchCalls = 0;
const savedFetch = globalThis.fetch;
before(() => { globalThis.fetch = (async () => { realFetchCalls++; throw new Error('network blocked in tests'); }) as typeof fetch; });
after(() => { globalThis.fetch = savedFetch; assert.equal(realFetchCalls, 0, '전역 fetch 호출 0'); });

test('YT1 꺼짐·설정 누락·잘못된 설정 → transport 0', async () => {
  const { t, calls } = fakeTransport(OK);
  const bads = [null, cfg(null), cfg(t, { uploadAllowed: false }), cfg(t, { uploadAllowed: 'true' }), cfg(t, { accessToken: null }), cfg(t, { accessToken: 'AIzaSy-short' }),
    cfg(t, { accessToken: TOKEN + ' x' }), cfg(t, { expectedChannelId: null }), cfg(t, { expectedChannelId: 'channel' }), cfg(t, { timeoutMs: 10 }), cfg(t, { maxResponseBytes: 10 ** 8 })];
  for (const c of bads) {
    const p = createYoutubePrivatePublisher(c);
    assert.deepEqual(await p.uploadPrivate(upInput()), { state: 'NOT_CONFIGURED', uploadAttempted: false });
    assert.deepEqual(await p.getStatus(VID), { state: 'NOT_CONFIGURED' });
  }
  assert.equal(calls.length, 0);
});

test('YT2 불량 입력은 요청 전 거부(transport 0), 원본 불변', async () => {
  const { t, calls } = fakeTransport(OK);
  const p = createYoutubePrivatePublisher(cfg(t));
  const big = new Uint8Array(YT_MAX_VIDEO_BYTES + 1); big.set(MP4());
  const bad: unknown[] = [null, [], 'x', {}, upInput({ video: 'path/to/file.mp4' }), upInput({ video: new Uint8Array(0) }), upInput({ video: big }),
    upInput({ mimeType: 'video/quicktime' }), upInput({ mimeType: 'application/octet-stream' }), upInput({ video: WEBM() }), upInput({ video: new Uint8Array(64) }),
    upInput({ title: '최저가 인터넷·TV' }), upInput({ description: '짧음' }), upInput({ title: '<b>이사</b> 확인' }), { ...upInput(), privacyStatus: 'public' },
    { ...upInput(), publishAt: '2026-11-18T00:00:00Z' }, { ...upInput(), url: 'https://evil.example.net/' }, { ...upInput(), filePath: '/etc/passwd' }];
  for (const b of bad) assert.deepEqual(await p.uploadPrivate(b), { state: 'INVALID_INPUT', uploadAttempted: false }, JSON.stringify(b)?.slice(0, 80));
  assert.equal(calls.length, 0);
  for (const id of ['', 'short', VID + 'x', 'AbCdEfGh/j0', '../../etc', null, 1]) assert.deepEqual(await p.getStatus(id), { state: 'INVALID_INPUT' });
  assert.equal(calls.length, 0);
  const input = upInput();
  const before = Array.from(input.video as Uint8Array);
  await p.uploadPrivate(input);
  assert.deepEqual(Array.from(input.video as Uint8Array), before, '영상 원본 불변');
});

test('YT3 정상: 채널 확인 → 비공개 multipart 업로드 → 상태 조회, 요청 계약 정확', async () => {
  const { t, calls } = fakeTransport(OK);
  const p = createYoutubePrivatePublisher(cfg(t));
  assert.deepEqual(await p.uploadPrivate(upInput()), { state: 'UPLOADED_PRIVATE', videoId: VID, uploadAttempted: true });
  assert.deepEqual(calls.map((c) => [c.url, c.init.method]), [[YT_CHANNELS_URL, 'GET'], [YT_UPLOAD_URL, 'POST']]);
  assert.equal(YT_CHANNELS_URL, 'https://www.googleapis.com/youtube/v3/channels?part=id&mine=true');
  assert.equal(YT_UPLOAD_URL, 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=multipart&part=snippet,status');
  for (const c of calls) {
    assert.equal(c.init.redirect, 'error');
    assert.ok(c.init.signal instanceof AbortSignal);
    assert.equal(c.init.headers.Authorization, `Bearer ${TOKEN}`);
  }
  const up = calls[1]!.init;
  const m = /^multipart\/related; boundary=(fideon[0-9a-f]{32})$/.exec(up.headers['Content-Type']!);
  assert.ok(m, '서버 통제 경계');
  const body = new TextDecoder('latin1').decode(up.body!);
  const metaMatch = /Content-Type: application\/json; charset=UTF-8\r\n\r\n(.*?)\r\n--/s.exec(new TextDecoder().decode(up.body!));
  const meta = JSON.parse(metaMatch![1]!);
  assert.deepEqual(meta, { snippet: COPY, status: { privacyStatus: 'private' } }, 'private 고정, 아동대상·합성물·category·publishAt 미전송');
  assert.ok(body.includes('Content-Type: video/mp4\r\n\r\n'));
  assert.ok(body.endsWith(`\r\n--${m![1]}--\r\n`));
  assert.deepEqual(await p.getStatus(VID), { state: 'PRIVATE_PROCESSING' });
  assert.equal(calls[2]!.url, YT_VIDEOS_URL_PREFIX + VID);
  assert.equal(calls.length, 3, '재시도 0');
});

test('YT4 채널 불일치·여러 채널·조회 실패 → 업로드 0', async () => {
  const cases: [Resp, string][] = [
    [{ status: 200, text: JSON.stringify({ items: [{ id: 'UC' + 'b'.repeat(22) }] }) }, 'CHANNEL_MISMATCH'],
    [{ status: 200, text: JSON.stringify({ items: [{ id: CH }, { id: CH }] }) }, 'CHANNEL_MISMATCH'],
    [{ status: 200, text: JSON.stringify({ items: [] }) }, 'CHANNEL_MISMATCH'],
    [{ status: 200, text: '{"items":"x"}' }, 'CHANNEL_CHECK_FAILED'], [{ status: 200, text: 'not json' }, 'CHANNEL_CHECK_FAILED'],
    [{ status: 401, text: 'token ya29.leak' }, 'CHANNEL_CHECK_FAILED'], [{ status: 403 }, 'CHANNEL_CHECK_FAILED'], [{ status: 429 }, 'CHANNEL_CHECK_FAILED'],
    [{ status: 500 }, 'CHANNEL_CHECK_FAILED'], [{ status: 200, delayMs: 1200, text: chOk }, 'CHANNEL_CHECK_FAILED'], [{ status: 200, throws: true }, 'CHANNEL_CHECK_FAILED'],
  ];
  for (const [ch, state] of cases) {
    const { t, calls } = fakeTransport({ ...OK, channels: ch });
    const r = await createYoutubePrivatePublisher(cfg(t)).uploadPrivate(upInput());
    assert.equal(r.state, state, JSON.stringify(ch));
    assert.equal(r.uploadAttempted, false);
    assert.equal(calls.filter((c) => c.url === YT_UPLOAD_URL).length, 0);
    assert.ok(!JSON.stringify(r).includes('leak') && !JSON.stringify(r).includes('비밀'));
  }
});

test('YT5 업로드 응답: HTTP 오류는 실패, 마감·전송오류·판독 불가는 결과 미확인, 비공개 아님은 숨기지 않음', async () => {
  const cases: [Resp, Record<string, unknown>][] = [
    [{ status: 401 }, { state: 'UPLOAD_FAILED', code: 'AUTH_FAILED', uploadAttempted: true }],
    [{ status: 403 }, { state: 'UPLOAD_FAILED', code: 'FORBIDDEN', uploadAttempted: true }],
    [{ status: 429 }, { state: 'UPLOAD_FAILED', code: 'RATE_LIMITED', uploadAttempted: true }],
    [{ status: 503 }, { state: 'UPLOAD_FAILED', code: 'HTTP_ERROR', uploadAttempted: true }],
    [{ status: 200, delayMs: 1200, text: upOk }, { state: 'RESULT_UNKNOWN', uploadAttempted: true }],
    [{ status: 200, throws: true }, { state: 'RESULT_UNKNOWN', uploadAttempted: true }],
    [{ status: 200, text: '' }, { state: 'RESULT_UNKNOWN', uploadAttempted: true }],
    [{ status: 200, text: '{bad' }, { state: 'RESULT_UNKNOWN', uploadAttempted: true }],
    [{ status: 200, text: JSON.stringify({ id: 'bad id', status: { privacyStatus: 'private' } }) }, { state: 'RESULT_UNKNOWN', uploadAttempted: true }],
    [{ status: 200, text: 'x'.repeat(5000) }, { state: 'RESULT_UNKNOWN', uploadAttempted: true }],
    [{ status: 200, text: JSON.stringify({ id: VID, status: { privacyStatus: 'public' } }) }, { state: 'NOT_PRIVATE', videoId: VID, uploadAttempted: true }],
    [{ status: 200, text: JSON.stringify({ id: VID }) }, { state: 'NOT_PRIVATE', videoId: VID, uploadAttempted: true }],
  ];
  for (const [upR, want] of cases) {
    const { t, calls } = fakeTransport({ ...OK, upload: upR });
    const r = await createYoutubePrivatePublisher(cfg(t)).uploadPrivate(upInput());
    assert.deepEqual(r, want, JSON.stringify(upR).slice(0, 60));
    assert.equal(calls.filter((c) => c.url === YT_UPLOAD_URL).length, 1, '재업로드 0');
    assert.ok(!JSON.stringify(r).includes('leak'));
  }
  // 늦은 업로드 응답: 본문 읽기 0·정리
  const { t, streams } = fakeTransport({ ...OK, upload: { status: 200, delayMs: 1100, text: upOk } });
  await createYoutubePrivatePublisher(cfg(t)).uploadPrivate(upInput());
  await new Promise((r) => setTimeout(r, 250));
  const late = streams[1]!;
  assert.equal(late.st.pulls, 0);
  assert.equal(late.st.cancelled, true);
});

test('YT6 상태 조회: 처리 단계 구분, 공개·목록 불일치·형태 오류를 성공으로 숨기지 않음', async () => {
  const cases: [Resp, string][] = [
    [{ status: 200, text: vidOk('processing') }, 'PRIVATE_PROCESSING'], [{ status: 200, text: vidOk('succeeded') }, 'PRIVATE_PROCESSED'],
    [{ status: 200, text: vidOk('failed') }, 'PRIVATE_PROCESSING_FAILED'], [{ status: 200, text: vidOk('terminated') }, 'PRIVATE_PROCESSING_FAILED'],
    [{ status: 200, text: vidOk('weird') }, 'PRIVATE_PROCESSING_UNKNOWN'], [{ status: 200, text: vidOk('succeeded', 'public') }, 'NOT_PRIVATE'],
    [{ status: 200, text: vidOk('succeeded', 'unlisted') }, 'NOT_PRIVATE'], [{ status: 200, text: vidOk('processing', 'private', 'rejected') }, 'UPLOAD_REJECTED'],
    [{ status: 200, text: JSON.stringify({ items: [] }) }, 'NOT_FOUND'],
    [{ status: 200, text: JSON.stringify({ items: [{ id: 'ZZZZZZZZZZZ', status: { privacyStatus: 'private' } }] }) }, 'QUERY_FAILED'],
    [{ status: 200, text: JSON.stringify({ items: [JSON.parse(vidOk()).items[0], JSON.parse(vidOk()).items[0]] }) }, 'QUERY_FAILED'],
    [{ status: 200, text: 'nope' }, 'QUERY_FAILED'], [{ status: 404 }, 'QUERY_FAILED'], [{ status: 200, delayMs: 1200, text: vidOk() }, 'QUERY_FAILED'],
  ];
  for (const [v, state] of cases) {
    const { t } = fakeTransport({ ...OK, videos: v });
    const r = await createYoutubePrivatePublisher(cfg(t)).getStatus(VID);
    assert.equal(r.state, state, JSON.stringify(v).slice(0, 80));
  }
});

test('YT7 multipart 경계 충돌은 닫힘, 경계 형식 서버 통제', () => {
  const u = { video: MP4(), mimeType: 'video/mp4' as const, ...COPY };
  const b = 'a'.repeat(30);
  const v = new Uint8Array(64); v.set(MP4()); v.set(new TextEncoder().encode(b), 20);
  assert.equal(buildMultipart({ ...u, video: v }, b), null);
  assert.equal(buildMultipart(u, 'bad boundary;'), null);
  assert.ok(buildMultipart(u, 'b'.repeat(30)));
});

// ── 조합 ──
const gen = (data: unknown = COPY, called = true): AdCopyGenerator => ({ generate: async () => ({ kind: 'ok', data, called } as never) });
const prepInput = (over: Record<string, unknown> = {}) => ({ situationId: 'moving', product: 'internet-tv', video: MP4(), mimeType: 'video/mp4', ...over });

test('YP1 정상 가짜 조합: 생성→검증→비공개 업로드→상태, PRIVATE_TEST_ONLY·공개/유료 false', async () => {
  const { t, calls } = fakeTransport(OK);
  const r = await prepareYoutubeAdPrivateTest(prepInput(), { generateCopy: (i) => generateAdCopy(i, { generator: gen() }), publisher: createYoutubePrivatePublisher(cfg(t)) });
  assert.deepEqual(r, { stage: 'PRIVATE_TEST_ONLY', upload: 'UPLOADED_PRIVATE', status: 'PRIVATE_PROCESSING', videoId: VID, publicPublished: false, paidExecutionAllowed: false });
  assert.ok(Object.isFrozen(r));
  assert.equal(calls.length, 3);
});

test('YP2 생성 실패·꺼짐·불량 입력 → 업로드 0', async () => {
  const { t, calls } = fakeTransport(OK);
  const pub = createYoutubePrivatePublisher(cfg(t));
  const cases: [unknown, Parameters<typeof prepareYoutubeAdPrivateTest>[1], string][] = [
    [prepInput(), { generateCopy: (i) => generateAdCopy(i, { generator: null }), publisher: pub }, 'GENERATION_FAILED'],
    [prepInput(), { generateCopy: (i) => generateAdCopy(i, { generator: gen({ title: '최저가 인터넷', description: COPY.description }) }), publisher: pub }, 'GENERATION_FAILED'],
    [prepInput(), { generateCopy: (i) => generateAdCopy(i, { generator: gen(COPY, false) }), publisher: pub }, 'GENERATION_FAILED'],
    [prepInput(), { generateCopy: async () => { throw new Error('INTERNAL'); }, publisher: pub }, 'GENERATION_FAILED'],
    [prepInput(), { generateCopy: null, publisher: pub }, 'NOT_CONFIGURED'],
    [prepInput(), { generateCopy: (i) => generateAdCopy(i, { generator: gen() }), publisher: null }, 'NOT_CONFIGURED'],
    [prepInput({ situationId: 'x' }), { generateCopy: (i) => generateAdCopy(i, { generator: gen() }), publisher: pub }, 'INVALID_INPUT'],
    [prepInput({ publish: true }), { generateCopy: (i) => generateAdCopy(i, { generator: gen() }), publisher: pub }, 'INVALID_INPUT'],
    [prepInput({ video: 'file.mp4' }), { generateCopy: (i) => generateAdCopy(i, { generator: gen() }), publisher: pub }, 'INVALID_INPUT'],
  ];
  for (const [inp, deps, stage] of cases) {
    const r = await prepareYoutubeAdPrivateTest(inp, deps);
    assert.equal(r.stage, stage);
    assert.equal(r.upload, 'NOT_ATTEMPTED');
    assert.equal(r.publicPublished, false);
    assert.equal(r.paidExecutionAllowed, false);
  }
  assert.equal(calls.length, 0);
  // 꺼진 publisher(설정 없음) → 업로드 transport 0, NOT_CONFIGURED로 표시
  const r2 = await prepareYoutubeAdPrivateTest(prepInput(), { generateCopy: (i) => generateAdCopy(i, { generator: gen() }), publisher: createYoutubePrivatePublisher(null) });
  assert.deepEqual(r2, { stage: 'UPLOAD_NOT_COMPLETED', upload: 'NOT_CONFIGURED', status: 'NOT_QUERIED', videoId: null, publicPublished: false, paidExecutionAllowed: false });
});

test('YP3 업로드 미완료·결과 미확인·비공개 아님을 성공으로 숨기지 않음, 예외·Proxy 원문 미반환', async () => {
  for (const [upR, want] of [[{ status: 200, delayMs: 1200, text: upOk }, 'RESULT_UNKNOWN'], [{ status: 403 }, 'UPLOAD_FAILED'], [{ status: 200, text: JSON.stringify({ id: VID, status: { privacyStatus: 'public' } }) }, 'NOT_PRIVATE']] as const) {
    const { t } = fakeTransport({ ...OK, upload: upR });
    const r = await prepareYoutubeAdPrivateTest(prepInput(), { generateCopy: (i) => generateAdCopy(i, { generator: gen() }), publisher: createYoutubePrivatePublisher(cfg(t)) });
    assert.equal(r.stage, 'UPLOAD_NOT_COMPLETED');
    assert.equal(r.upload, want);
    assert.equal(r.status, 'NOT_QUERIED');
  }
  const evil = { uploadPrivate: async () => new Proxy({}, { get() { throw new Error('INTERNAL ya29.leak'); } }), getStatus: async () => ({ state: 'PRIVATE_PROCESSED' }) } as never;
  const r = await prepareYoutubeAdPrivateTest(prepInput(), { generateCopy: (i) => generateAdCopy(i, { generator: gen() }), publisher: evil });
  assert.equal(r.stage, 'UPLOAD_NOT_COMPLETED');
  assert.ok(!JSON.stringify(r).includes('leak'));
  const fakeOk = { uploadPrivate: async () => ({ state: 'UPLOADED_PRIVATE' }), getStatus: async () => ({ state: 'PRIVATE_PROCESSED' }) } as never;
  const r2 = await prepareYoutubeAdPrivateTest(prepInput(), { generateCopy: (i) => generateAdCopy(i, { generator: gen() }), publisher: fakeOk });
  assert.deepEqual([r2.stage, r2.upload], ['UPLOAD_NOT_COMPLETED', 'RESULT_UNKNOWN'], 'ID 없는 성공은 결과 미확인');
  const inp = prepInput();
  const before = Array.from(inp.video as Uint8Array);
  const { t } = fakeTransport(OK);
  await prepareYoutubeAdPrivateTest(inp, { generateCopy: (i) => generateAdCopy(i, { generator: gen() }), publisher: createYoutubePrivatePublisher(cfg(t)) });
  assert.deepEqual(Array.from(inp.video as Uint8Array), before);
});
