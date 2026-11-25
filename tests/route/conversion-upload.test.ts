// 광고 전환 업로드 Mock 시험(PM 11/25). 가짜 transport만 — 실제 Google 전송·광고비 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONVERSION_BATCH_MAX, DATA_MANAGER_INGEST_URL, planConversionUpload, reconcile, transactionIdFor, validateConversionUpload, type ConversionConfig, type ConversionLead, type ConversionTransport } from '../../src/server/advertising/conversionUpload';

const NOW = new Date('2026-11-25T03:00:00Z');
const KEY = 'k'.repeat(40);
const CFG: ConversionConfig = { customerId: '1234567890', conversionActionId: '987654', accountCurrency: 'KRW', valueKrw: 0, hmacKey: KEY };
const PHONE = '01012345678';
const lead = (i: number, o: Partial<ConversionLead> = {}): ConversionLead => ({ leadId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, gclid: `Cj0KCQabc_${i}x`, clickAt: new Date(NOW.getTime() - 86_400_000), convertedAt: new Date(NOW.getTime() - 3_600_000), ...o });
const fake = (status = 200, text = '{"requestId":"r-1"}') => {
  const calls: { url: string; body: string }[] = [];
  const t: ConversionTransport = async (url, init) => { calls.push({ url, body: init.body }); return { status, text }; };
  return { t, calls };
};
const deps = (t: ConversionTransport, alreadySent?: ReadonlySet<string>) => ({ transport: t, accessToken: 'ya29.fake', now: NOW, alreadySent });

test('CU1 요청 형식: Data Manager events:ingest, validateOnly=true 고정, KRW, gclid·시각·거래 ID만 — 리드 ID·전화 원문 없음', async () => {
  const f = fake();
  const r = await validateConversionUpload([lead(1), lead(2)], CFG, deps(f.t));
  assert.deepEqual([r.ok, r.code, r.sent, f.calls.length], [true, 'VALIDATED', 2, 1]);
  assert.equal(f.calls[0]!.url, DATA_MANAGER_INGEST_URL);
  const b = JSON.parse(f.calls[0]!.body);
  assert.equal(b.validateOnly, true);
  assert.deepEqual(b.destinations, [{ operatingAccount: { accountType: 'GOOGLE_ADS', accountId: '1234567890' }, productDestinationId: '987654' }]);
  assert.deepEqual(Object.keys(b.events[0]).sort(), ['adIdentifiers', 'conversionValue', 'currency', 'eventTimestamp', 'transactionId']);
  assert.equal(b.events[0].currency, 'KRW');
  assert.ok(!f.calls[0]!.body.includes(lead(1).leadId) && !f.calls[0]!.body.includes(PHONE) && !f.calls[0]!.body.includes('userData'));
});

test('CU2 계정 통화 KRW 아님·모름 → 전송 0회(CURRENCY_NOT_KRW)', async () => {
  for (const cur of ['USD', 'krw', null]) {
    const f = fake();
    const r = await validateConversionUpload([lead(1)], { ...CFG, accountCurrency: cur }, deps(f.t));
    assert.deepEqual([r.ok, r.code, f.calls.length], [false, 'CURRENCY_NOT_KRW', 0]);
  }
});

test('CU3 중복 집계 방지: 같은 리드 2번·같은 gclid 2건·이미 보낸 리드는 1건/0건 — 거래 ID는 결정적', async () => {
  assert.equal(transactionIdFor(lead(1).leadId, KEY), transactionIdFor(lead(1).leadId, KEY));
  assert.notEqual(transactionIdFor(lead(1).leadId, KEY), transactionIdFor(lead(2).leadId, KEY));
  const sent = new Set([transactionIdFor(lead(3).leadId, KEY)]);
  const input = [lead(1), lead(1), lead(2, { gclid: lead(1).gclid }), lead(3), lead(4)];
  const f = fake();
  const r = await validateConversionUpload(input, CFG, deps(f.t, sent));
  assert.equal(r.sent, 2);
  assert.deepEqual([r.skipped!.DUPLICATE_LEAD, r.skipped!.DUPLICATE_GCLID, r.skipped!.ALREADY_SENT], [1, 1, 1]);
  const tids = JSON.parse(f.calls[0]!.body).events.map((e: { transactionId: string }) => e.transactionId);
  assert.equal(new Set(tids).size, tids.length);
  assert.equal(reconcile(input.length, r), true, '접수 수 = 보낸 수 + 건너뛴 수');
});

test('CU4 gclid 형식(전화번호 혼입 등)·90일 초과·미래 시각은 보내지 않음', async () => {
  const bad = [lead(1, { gclid: PHONE }), lead(2, { gclid: 'abc' }), lead(3, { gclid: 'abc<script>xx' }), lead(4, { gclid: 'Ab0123456789' }),
    lead(5, { clickAt: new Date(NOW.getTime() - 91 * 86_400_000), convertedAt: new Date(NOW.getTime() - 1000) }), lead(6, { convertedAt: new Date(NOW.getTime() + 60_000) })];
  const f = fake();
  const r = await validateConversionUpload(bad, CFG, deps(f.t));
  assert.deepEqual([r.code, r.sent, f.calls.length, r.skipped!.GCLID_INVALID, r.skipped!.TOO_OLD, r.skipped!.FUTURE_TIME], ['NOTHING_TO_SEND', 0, 0, 4, 1, 1]);
  assert.equal(reconcile(bad.length, r), true);
});

test('CU5 Google 오류: 401·403 AUTH_ERROR, 400 REJECTED, 5xx·requestId 없음·예외는 UNKNOWN — 성공으로 세지 않음, 원문 반사 없음', async () => {
  for (const [status, text, code] of [[401, '', 'AUTH_ERROR'], [403, 'secret gclid', 'AUTH_ERROR'], [400, '{"error":"x"}', 'REJECTED'], [500, '', 'UNKNOWN'], [200, '{}', 'UNKNOWN'], [200, 'not json', 'UNKNOWN']] as const) {
    const f = fake(status, text);
    const r = await validateConversionUpload([lead(1)], CFG, deps(f.t));
    assert.deepEqual([r.ok, r.code, r.sent], [false, code, 0]);
    assert.ok(!JSON.stringify(r).includes('secret'));
    assert.equal(reconcile(1, r), false);
  }
  const throwing: ConversionTransport = async () => { throw new Error('net down token=abc'); };
  const r = await validateConversionUpload([lead(1)], CFG, deps(throwing));
  assert.deepEqual([r.ok, r.code], [false, 'UNKNOWN']);
});

test('CU6 설정 이상·묶음 초과 → 전송 0회', async () => {
  for (const c of [{ customerId: '123' }, { conversionActionId: 'abc' }, { valueKrw: -1 }, { valueKrw: 1.5 }, { hmacKey: 'short' }] as Partial<ConversionConfig>[]) {
    const f = fake();
    const r = await validateConversionUpload([lead(1)], { ...CFG, ...c }, deps(f.t));
    assert.deepEqual([r.code, f.calls.length], ['CONFIG_INVALID', 0]);
  }
  const many = Array.from({ length: CONVERSION_BATCH_MAX + 1 }, (_, i) => lead(i));
  const f = fake();
  assert.deepEqual([(await validateConversionUpload(many, CFG, deps(f.t))).code, f.calls.length], ['BATCH_TOO_LARGE', 0]);
});

test('CU7 동시 100건 묶음(같은 gclid 섞임): 서로 다른 리드 100건 중 gclid 겹침 50건 → 50건만, 대조 일치', async () => {
  const input = Array.from({ length: 100 }, (_, i) => lead(i, { gclid: `Cj0KCQabc_${i % 50}x` }));
  const f = fake();
  const r = await validateConversionUpload(input, CFG, deps(f.t));
  assert.deepEqual([r.sent, r.skipped!.DUPLICATE_GCLID, reconcile(100, r)], [50, 50, true]);
  const p = planConversionUpload(input, CFG, NOW);
  assert.ok(p.ok && p.body.validateOnly === true);
});
