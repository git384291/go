// PM 11/22 P2 진단 평가 함수 시험(보정/평가 분리·균형 정확도·다수 범주 기준). 시간 측정 자체는 Next E2E BF30에서 하며 합격 조건이 아니다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { thresholdEval } from '../../scripts/next-e2e/timing-probe.mjs';

test('TP1 완전히 갈리는 분포: 평가 균형 정확도 1, 오분류 0', () => {
  const r = thresholdEval([5, 6, 7, 8], [1, 2, 3, 4], [5.5, 9], [0.5, 3.5]);
  assert.deepEqual([r.evalBalancedAcc, r.evalMisclassified, r.majorityBaseline], [1, 0, 0.5]);
});
test('TP2 기준은 보정 표본으로만 정한다(평가 표본이 기준에 영향 없음) — 보정에서 갈려도 평가에서 섞이면 0.5 근처', () => {
  const r = thresholdEval([10, 11], [1, 2], [1, 11], [2, 10]);
  assert.equal(r.calibrationBalancedAcc, 1);
  assert.equal(r.evalBalancedAcc, 0.5);
  assert.equal(r.evalMisclassified, 2);
});
test('TP3 불균형 평가 집합: 단순 정확도와 다수 범주 기준을 함께 보고', () => {
  const r = thresholdEval([1, 2], [1, 2], [1], [1, 2, 3, 4]);
  assert.equal(r.majorityBaseline, 0.8);
  assert.equal(r.evalN, 5);
});
