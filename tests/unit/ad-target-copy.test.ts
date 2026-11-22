// 핵심 타깃 문안 5종(PM 11/22): 길이·금지 주장·브랜드 없음·미연결. 매체 실제 집계·심사 통과를 증명하지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { AD_TARGET_COPY, AD_TARGET_IDS } from '../../src/content/adTargetCopy';
import { AD_DESC_MAX, AD_DESC_MIN, AD_FORBIDDEN_CLAIMS, AD_TITLE_MAX, codePointLength } from '../../src/content/adDrafts';

test('AT1 다섯 타깃: 약정 2개월 전·임박·이사·전입·통신사 변경, 길이 기준 충족', () => {
  assert.deepEqual([...AD_TARGET_IDS], ['contract_2m', 'contract_soon', 'moving', 'move_in', 'carrier_change']);
  for (const id of AD_TARGET_IDS) {
    const d = AD_TARGET_COPY[id];
    assert.equal(d.id, id);
    assert.ok(codePointLength(d.title) <= AD_TITLE_MAX, d.title);
    assert.ok(codePointLength(d.description) >= AD_DESC_MIN && codePointLength(d.description) <= AD_DESC_MAX, d.description);
    assert.deepEqual([d.cta, d.evidence], ['UNSET', 'HYPOTHESIS_UNVERIFIED']);
    assert.ok(d.keywords.length >= 1);
  }
});
test('AT2 금지 주장·금액·숫자 금액·브랜드명 없음, 문안끼리 중복 없음', () => {
  const all = AD_TARGET_IDS.map((id) => AD_TARGET_COPY[id]);
  for (const d of all) {
    for (const w of AD_FORBIDDEN_CLAIMS) assert.ok(!d.title.includes(w) && !d.description.includes(w), `${d.id}: ${w}`);
    assert.ok(!/FIDEON|피데온|바른통신/i.test(d.title + d.description));
    assert.ok(!/\d+\s*(원|만|%)/.test(d.title + d.description));
  }
  assert.equal(new Set(all.map((d) => d.title)).size, 5);
  assert.equal(new Set(all.map((d) => d.description)).size, 5);
  assert.ok(Object.isFrozen(AD_TARGET_COPY) && Object.isFrozen(AD_TARGET_COPY.moving.keywords));
});
test('AT3 미연결: src에서 이 파일을 가져다 쓰는 곳 없음(광고 계정·화면 연결은 별도 승인)', () => {
  let hits = '';
  try { hits = execFileSync('git', ['grep', '-l', '-e', 'adTargetCopy', '-e', 'AD_TARGET_COPY', '--', 'src'], { encoding: 'utf8' }); } catch (e) { if ((e as { status?: number }).status !== 1) throw e; } // 1 = 일치 없음
  assert.deepEqual(hits.trim().split('\n').filter(Boolean), ['src/content/adTargetCopy.ts']);
});
