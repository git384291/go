// 유입 출처(UTM) 판정 시험 — 순수 함수, 외부 호출 없음
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAttribution, resolveAttribution, ATTRIBUTION_STORAGE_KEY } from '../../src/content/attribution';

const mem = () => {
  const m = new Map<string, string>();
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

test('AT1 유효한 utm 세 값을 소문자로 읽는다', () => {
  assert.deepEqual(parseAttribution('?utm_source=Naver&utm_medium=cpc&utm_campaign=Internet-TV_1'),
    { utmSource: 'naver', utmMedium: 'cpc', utmCampaign: 'internet-tv_1' });
});

test('AT2 utm_source가 없거나 잘못되면 빈 객체(매체·캠페인만으로 귀속하지 않음)', () => {
  assert.deepEqual(parseAttribution(''), {});
  assert.deepEqual(parseAttribution('?utm_medium=cpc&utm_campaign=a'), {});
  assert.deepEqual(parseAttribution('?utm_source=<script>'), {});
  assert.deepEqual(parseAttribution('?utm_source=' + 'a'.repeat(65)), {});
  assert.deepEqual(parseAttribution('?utm_source=한글'), {});
});

test('AT3 잘못된 매체·캠페인만 버리고 나머지는 유지한다', () => {
  assert.deepEqual(parseAttribution('?utm_source=google&utm_medium=a b&utm_campaign=ok'), { utmSource: 'google', utmCampaign: 'ok' });
});

test('AT4 첫 유입 우선: 저장된 출처를 나중 링크가 덮지 않는다', () => {
  const s = mem();
  assert.equal(resolveAttribution('?utm_source=naver', s).utmSource, 'naver');
  assert.equal(resolveAttribution('?utm_source=meta', s).utmSource, 'naver');
  assert.equal(resolveAttribution('', s).utmSource, 'naver');
});

test('AT5 저장소 없음·오류여도 현재 URL 값으로 동작한다', () => {
  assert.equal(resolveAttribution('?utm_source=meta', null).utmSource, 'meta');
  const broken = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); } };
  assert.equal(resolveAttribution('?utm_source=meta', broken).utmSource, 'meta');
  assert.deepEqual(resolveAttribution('', broken), {});
});

test('AT6 변조된 저장값은 무시하고 현재 URL을 쓴다', () => {
  const s = mem();
  s.m.set(ATTRIBUTION_STORAGE_KEY, JSON.stringify({ utmSource: '<b>', utmMedium: 'cpc' }));
  assert.equal(resolveAttribution('?utm_source=google', s).utmSource, 'google');
  s.m.set(ATTRIBUTION_STORAGE_KEY, 'not json');
  assert.equal(resolveAttribution('', s).utmSource, undefined);
});

test('AT7 출처가 없으면 저장하지 않는다', () => {
  const s = mem();
  resolveAttribution('?foo=1', s);
  assert.equal(s.m.size, 0);
});

test('AT8 전화번호·이메일 모양 값은 출처로 쓰지 않는다', () => {
  assert.deepEqual(parseAttribution('?utm_source=01012345678'), {});
  assert.deepEqual(parseAttribution('?utm_source=010-1234-5678'), {});
  assert.deepEqual(parseAttribution('?utm_source=a@b.com'), {});
  assert.deepEqual(parseAttribution('?utm_source=naver&utm_campaign=01012345678'), { utmSource: 'naver' });
  assert.equal(parseAttribution('?utm_source=naver&utm_campaign=cpc_2026_11').utmCampaign, 'cpc_2026_11');
});
