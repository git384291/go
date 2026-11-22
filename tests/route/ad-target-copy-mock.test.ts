// 핵심 타깃 문안 5종 ↔ 기존 광고 모듈 연결 모의시험(PM 11/22: 설계·모의시험까지만). 실제 광고 계정·네트워크 호출 없음.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AD_TARGET_COPY, AD_TARGET_IDS, AD_TARGET_TO_SITUATION } from '../../src/content/adTargetCopy';
import { AD_DRAFT_IDS } from '../../src/content/adDrafts';
import { validateAdCopy } from '../../src/server/advertising/adGeneration';

test('ATM1 다섯 문안 모두 기존 생성 검증기(validateAdCopy: 길이·문자·금지어)를 그대로 통과', () => {
  for (const id of AD_TARGET_IDS) {
    const { title, description } = AD_TARGET_COPY[id];
    const r = validateAdCopy({ title, description });
    assert.ok(r.ok, `${id}: ${JSON.stringify(r)}`);
  }
});
test('ATM2 연결 설계: 모든 타깃이 기존 상황 ID 하나에 대응(새 상황 ID 없음), 통신사 변경은 일반 비교로 둠', () => {
  assert.deepEqual(Object.keys(AD_TARGET_TO_SITUATION).sort(), [...AD_TARGET_IDS].sort());
  for (const id of AD_TARGET_IDS) assert.ok((AD_DRAFT_IDS as readonly string[]).includes(AD_TARGET_TO_SITUATION[id]), id);
  assert.equal(AD_TARGET_TO_SITUATION.carrier_change, 'general_compare');
});
