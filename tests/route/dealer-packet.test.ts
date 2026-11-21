// PM 11/22: 총판 전달용 신청서 열람·복사·이력 서버 모듈 시험. 가짜 의존성만 쓴다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dealerPacketGet, handoffList, handoffRecord, type DealerPacketDeps } from '../../src/server/admin/dealerPacket';
import type { NoticeConfig } from '../../src/content/requiredNotices';
import { StaffAuthError } from '../../src/server/auth/staffAssertion';
import type { StaffIdentity } from '../../src/server/auth/staffSession';

const ID = '10000000-0000-4000-8000-000000000001';
const READY = { ADMIN_LEADS_SOURCE: 'db', NODE_ENV: 'test', DATABASE_URL: 'postgresql://u@127.0.0.1:5432/fideon_lrs_123_abcdef01' };
const who = (role: string) => ({ actor: '00000000-0000-4000-8000-000000000001', session: '00000000-0000-4000-8000-0000000000aa', token: 'tok', role }) as StaffIdentity;
const CONFIRMED: NoticeConfig = { version: 'pv1', confirmed: true, items: [{ key: 'n1', title: '시험', body: '시험 문구' }] };
const APP = { carrier: 'kt', productId: 'p1', regionCode: 'r1', installAddress: '서울시 가상구 시험로 12', phoneCarrier: 'kt', email: 'test@example.com', currentCarrier: 'kt', installPref: 'asap', existingLine: 'has', ack12m: 'confirmed', ackContract3y: 'confirmed' };

function mk(o: { env?: Record<string, string | undefined>; staff?: StaffIdentity | Error; rows?: unknown[]; err?: unknown; quote?: () => Promise<{ kind: 'quote' | 'needs_review'; text: string; fields?: { productLabel: string; monthlyFee: string; installFee: string; gift: string } }>; notices?: NoticeConfig } = {}) {
  const c = { staff: 0, tx: 0, sql: [] as string[], vals: [] as unknown[][] };
  const d: DealerPacketDeps = {
    env: () => o.env ?? READY, mode: () => 'supabase',
    requireStaff: async () => { c.staff++; if (o.staff instanceof Error) throw o.staff; return o.staff ?? who('owner'); },
    runInTransaction: async (fn) => {
      c.tx++;
      const tag = (async (s: TemplateStringsArray, ...v: unknown[]) => { c.sql.push(s.join('?')); c.vals.push(v); if (o.err) throw o.err; return o.rows ?? []; }) as never;
      return fn(tag);
    },
    decrypt: (s) => s.replace(/^v1:/, ''),
    quoteFor: o.quote ?? (async () => ({ kind: 'needs_review', text: '승인된 정책 안내 없음 — 총판 확인' })),
    notices: () => o.notices ?? CONFIRMED, privacyVersion: () => 'pv1',
    now: () => new Date('2026-11-22T00:00:00Z'),
  };
  return { d, c };
}
const row = (over: Record<string, unknown> = {}) => ({ name_enc: 'v1:홍길동', phone_enc: 'v1:01012345678', payload_enc: 'v1:' + JSON.stringify(APP), summary: {}, interest: 'internet_tv', contact_time: '저녁', created_at: new Date('2026-11-21T00:00:00Z'), notice_version: 'pv1', notice_keys: ['n1'], ...over });

const R = { reason: 'dealer_handoff' };
const QUOTE = async () => ({ kind: 'quote' as const, text: 'x', fields: { productLabel: '가상 인터넷+TV', monthlyFee: '11,111원(부가세 포함)', installFee: '0원(부가세 포함)', gift: '5,000원 상품권' } });

test('DP1 닫힘: 환경 미충족·잘못된 id → 인증·DB 0회', async () => {
  for (const env of [{}, { ...READY, NODE_ENV: 'production' }, { ...READY, ADMIN_LEADS_SOURCE: 'mock' }]) {
    const { d, c } = mk({ env });
    assert.equal((await dealerPacketGet(d, ID, R)).status, 503);
    assert.deepEqual([c.staff, c.tx], [0, 0]);
  }
  const { d, c } = mk();
  assert.equal((await dealerPacketGet(d, 'x', R)).status, 400);
  assert.deepEqual([c.staff, c.tx], [0, 0]);
});

test('DP2 MVP 최소 권한: 대표만. 미인증 401, 대표 외(상담원·검토자·정책 담당)는 열람·기록·이력 모두 403(DB 0회)', async () => {
  assert.equal((await dealerPacketGet(mk({ staff: new StaffAuthError(401, 'UNAUTHENTICATED') }).d, ID, R)).status, 401);
  for (const role of ['counselor', 'reviewer', 'policy_editor']) {
    const { d, c } = mk({ staff: who(role) });
    assert.equal((await dealerPacketGet(d, ID, R)).status, 403, role);
    assert.equal((await handoffRecord(d, ID, { event: 'copied' })).status, 403, role);
    assert.equal((await handoffList(d, ID)).status, 403, role);
    assert.equal(c.tx, 0, role);
  }
  assert.equal((await handoffList(mk({ rows: [{ event: 'viewed', note: null, actor_id: 'a', created_at: 't' }] }).d, ID)).status, 200);
});

test('DP3 열람: 사유는 고정 코드만(자유 문장 거부), 총판 양식 순서로 출력, 고지 확인 완료+정책 승인값이면 준비 완료, no-store', async () => {
  for (const b of [{}, { reason: '' }, { reason: 'x' }, { reason: '홍길동 010-1234-5678' }, { reason: '전달 준비' }, { ...R, extra: 1 }, null]) {
    const { d, c } = mk({ rows: [row()] });
    assert.equal((await dealerPacketGet(d, ID, b)).status, 400);
    assert.equal(c.tx, 0);
  }
  const { d, c } = mk({ rows: [row()], quote: QUOTE });
  const r = await dealerPacketGet(d, ID, R);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('cache-control') ?? '', /no-store/);
  const j = (await r.json()) as { packet: { status: string; text: string } };
  assert.equal(j.packet.status, 'ready');
  const t = j.packet.text;
  const order = ['고객명: 홍길동', '주민번호: 총판 별도 확인', '설치주소: 서울시 가상구 시험로 12', '연락처 / 통신사: 01012345678 / KT', '이메일: test@example.com', '자동이체: 총판 별도 확인', '사은품계좌: 총판 별도 확인', '가입 통신사: kt', '신청상품: 가상 인터넷+TV', '월요금: 11,111원', '설치비(기사출동비): 0원', '설치희망일 / 빠른 날짜: 빠른 날짜', '상품권: 5,000원 상품권', '이전통신사: KT', '기타: 기존회선 12개월 유지 안내: 고객 확인함', '기존회선 확인: 기존 회선 있음', '약정 3년 및 설치비 안내·확인: 고객 확인함'];
  let at = -1;
  for (const o of order) { const k = t.indexOf(`■ ${o}`); assert.ok(k > at, o); at = k; }
  assert.match(c.sql[0], /api\.dealer_packet_get/);
  assert.equal(c.vals[0].includes('dealer_handoff'), true);
});

test('DP4 필수 고지 확인 미완료(상수 미확정·버전 불일치·노출 기록 없음·키 불일치)면 준비 완료 금지(notice_pending), 정책 없으면 금액 대신 총판 확인', async () => {
  const bad: [string, Parameters<typeof mk>[0]][] = [
    ['상수 미확정', { rows: [row()], notices: { version: '', confirmed: false, items: [] } }],
    ['노출 기록 없음', { rows: [row({ notice_version: null, notice_keys: [] })] }],
    ['버전 불일치', { rows: [row({ notice_version: 'old' })] }],
    ['키 불일치', { rows: [row({ notice_keys: ['n1', 'zz'] })] }],
  ];
  for (const [name, o] of bad) {
    const j = (await (await dealerPacketGet(mk(o).d, ID, R)).json()) as { packet: { status: string; text: string } };
    assert.equal(j.packet.status, 'notice_pending', name);
    assert.ok(!j.packet.text.includes('총판 전달 준비 완료'), name);
  }
  const x = (await (await dealerPacketGet(mk({ rows: [row()] }).d, ID, R)).json()) as { packet: { text: string } };
  assert.match(x.packet.text, /월요금: 총판 확인/);
  assert.doesNotMatch(x.packet.text, /\d,?\d*원/);
});

test('DP5 신청서 없음 → incomplete·누락 목록, 견적 조회 실패는 총판 확인(금액 없음), 본문 변조·복호화 실패 502', async () => {
  const { d } = mk({ rows: [row({ payload_enc: null })], quote: async () => { throw new Error('boom'); } });
  const j = (await (await dealerPacketGet(d, ID, R)).json()) as { hasApplication: boolean; packet: { status: string; missing: string[]; text: string } };
  assert.equal(j.hasApplication, false);
  assert.equal(j.packet.status, 'incomplete');
  assert.ok(j.packet.missing.includes('installAddress'));
  assert.equal((await dealerPacketGet(mk({ rows: [row({ payload_enc: 'v1:{"installAddress":"900101-1234567"}' })] }).d, ID, R)).status, 502);
  const dec = mk({ rows: [row()] }); dec.d.decrypt = () => { throw new Error('bad key'); };
  assert.equal((await dealerPacketGet(dec.d, ID, R)).status, 502);
});

test('DP6 DB 오류는 허용 코드만(SQL 비노출), 열람 대상 없음 403', async () => {
  for (const [err, status] of [[{ code: '42501' }, 403], [{ code: '54000' }, 429], [{ code: '22023', message: 'REASON_REQUIRED' }, 400], [{ message: 'select secret from x' }, 503]] as const) {
    const x = await dealerPacketGet(mk({ err }).d, ID, R);
    assert.equal(x.status, status);
    assert.doesNotMatch(await x.text(), /select|secret/);
  }
  assert.equal((await dealerPacketGet(mk({ rows: [] }).d, ID, R)).status, 403);
});

test('DP7 이력 기록: 메모는 총판 이름만(전화·계좌·이메일 형태 거부), 복사는 항상, 전달 완료는 준비 완료일 때만(409)', async () => {
  const ok = { rows: [{ summary: { missing: [] }, notice_version: 'pv1', notice_keys: ['n1'] }] };
  assert.equal((await handoffRecord(mk().d, ID, { event: 'copied' })).status, 200);
  const sent = mk(ok);
  assert.equal((await handoffRecord(sent.d, ID, { event: 'sent', note: 'A총판' })).status, 200);
  assert.match(sent.c.sql[0], /dealer_packet_status/);
  assert.match(sent.c.sql[1], /api\.handoff_record/);
  for (const b of [{ event: 'viewed' }, { event: 'sent', note: 'A총판 010-1234-5678' }, { event: 'sent', note: 'a@b.co' }, { event: 'sent', note: '가'.repeat(31) }, { event: 'copied', foo: 1 }, { event: 'sent', note: 3 }, null]) {
    const m = mk(ok);
    assert.equal((await handoffRecord(m.d, ID, b)).status, 400, JSON.stringify(b));
    assert.equal(m.c.tx, 0);
  }
  for (const rows of [[{ summary: { missing: ['email'] }, notice_version: 'pv1', notice_keys: ['n1'] }], [{ summary: null, notice_version: 'pv1', notice_keys: ['n1'] }], [{ summary: { missing: [] }, notice_version: null, notice_keys: [] }]]) {
    const m = mk({ rows });
    assert.equal((await handoffRecord(m.d, ID, { event: 'sent', note: 'A총판' })).status, 409);
    assert.equal(m.c.sql.some((q) => /api\.handoff_record/.test(q)), false);
  }
  assert.equal((await handoffRecord(mk({ ...ok, err: { code: '22023', message: 'PACKET_NOT_VIEWED' } }).d, ID, { event: 'copied' })).status, 400);
});
test('DP-AM 변경 요청: 원본 packet은 그대로, 변경 항목만 이전→변경 값(선택지는 라벨), 대표 열람 직후 같은 요청에서 조회, 조회 실패는 amendmentsError로 알림', async () => {
  const amendRow = { payload_enc: 'v1:' + JSON.stringify({ ...APP, installAddress: '서울시 가상구 변경로 99', phoneCarrier: 'skt', installPref: 'date', installDate: '2026-12-05' }), created_at: new Date('2026-11-22T01:00:00Z') };
  const { d, c } = mk();
  d.runInTransaction = async (fn) => { c.tx++; return fn((async (s: TemplateStringsArray) => { const q = s.join('?'); c.sql.push(q); return /application_amendments/.test(q) ? [amendRow] : [row()]; }) as never); };
  const r = await dealerPacketGet(d, ID, R);
  const j = (await r.json()) as { packet: { text: string }; amendments: { changes: { key: string; before: string; after: string }[] }[]; amendmentsError: boolean };
  assert.equal(r.status, 200);
  assert.ok(j.packet.text.includes('서울시 가상구 시험로 12') && !j.packet.text.includes('변경로'), '원본 packet 불변');
  assert.deepEqual(j.amendments[0].changes.map((x) => [x.key, x.before, x.after]), [
    ['installAddress', '서울시 가상구 시험로 12', '서울시 가상구 변경로 99'], ['phoneCarrier', 'KT', 'SKT'], ['installPref', '빠른 날짜', '희망일 지정'], ['installDate', '(없음)', '2026-12-05']]);
  assert.equal(j.amendmentsError, false);
  assert.ok(c.sql.findIndex((q) => /dealer_packet_get/.test(q)) < c.sql.findIndex((q) => /application_amendments/.test(q)), '열람(감사) 뒤 변경 요청 조회');
  const e = mk();
  e.d.runInTransaction = async (fn) => fn((async (s: TemplateStringsArray) => { if (/application_amendments/.test(s.join('?'))) throw Object.assign(new Error('x'), { code: '22023' }); return [row()]; }) as never);
  const je = (await (await dealerPacketGet(e.d, ID, R)).json()) as { ok: boolean; amendments: unknown[]; amendmentsError: boolean };
  assert.deepEqual([je.ok, je.amendments.length, je.amendmentsError], [true, 0, true]);
});
