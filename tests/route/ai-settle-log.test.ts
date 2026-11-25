// PM 11/24: AI 정산(확정·취소·불확실) 3회 모두 실패 시 서버 오류 1줄 — 고정 단어·SQLSTATE만, 민감정보 없음. 비용 한도 우회 없음.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDbAiBudget, type BudgetSettleLog } from '../../src/server/consult/chatModel';

const KEY = 'sk-test-' + 'D'.repeat(30);
const PHONE = '010-1234-5678';
const REQ = '11111111-2222-4333-8444-555555555555';
const SCOPE = 'ab'.repeat(32);

/** 예약은 성공, 정산 SQL은 늘 실패(오류 원문에 키·전화번호·SQL이 섞여 있어도 기록에 나오면 안 된다) */
function failingDb(code: unknown) {
  const calls: string[] = [];
  const run = (async (fn: (tx: (s: TemplateStringsArray, ...v: unknown[]) => PromiseLike<unknown>) => Promise<unknown>) =>
    fn((s: TemplateStringsArray) => {
      const q = s.join('?'); calls.push(q);
      if (q.includes('ai_budget_hold')) return Promise.resolve([{ id: '7' }]);
      return Promise.reject(Object.assign(new Error(`boom ${KEY} ${PHONE} select api.ai_budget_uncertain(7, 3) ${REQ}`), { code }));
    })) as never;
  return { run, calls };
}

test('SL1 불확실 정산 3회 실패: 예외 없이 끝나고, 기록 1줄(op·SQLSTATE만), 재시도 3회에서 멈춤', async () => {
  const d = failingDb('42883'); const logs: [string, string][] = [];
  const b = createDbAiBudget(d.run, (op, st) => logs.push([op, st]));
  const h = await b.reserve(6, { requestId: REQ, scope: SCOPE });
  assert.ok(h);
  await h.uncertain!(3);
  assert.deepEqual(logs, [['uncertain', '42883']]);
  assert.equal(d.calls.filter((q) => q.includes('ai_budget_uncertain')).length, 3, '무한 재시도 없음');
});

test('SL2 확정·취소 실패도 같은 방식, SQLSTATE가 아니면 unknown(오류 원문을 그대로 쓰지 않음)', async () => {
  for (const [code, want] of [['40001', '40001'], [undefined, 'unknown'], ['abc; drop', 'unknown'], [42883, 'unknown']] as const) {
    const logs: [string, string][] = [];
    const b = createDbAiBudget(failingDb(code).run, (op, st) => logs.push([op, st]));
    await (await b.reserve(6, { requestId: REQ, scope: SCOPE }))!.confirm(2);
    await (await b.reserve(6, { requestId: REQ, scope: SCOPE }))!.cancel();
    assert.deepEqual(logs, [['confirm', want], ['release', want]], String(code));
  }
});

test('SL3 기본 기록(console.error) 내용: 고정 형식 1줄, 키·전화번호·요청 ID·사용자 키·SQL·금액 없음', async () => {
  const out: string[] = []; const orig = console.error;
  console.error = (...a: unknown[]) => { out.push(a.map(String).join(' ')); };
  try {
    const b = createDbAiBudget(failingDb('42501').run);
    await (await b.reserve(6, { requestId: REQ, scope: SCOPE }))!.uncertain!(3);
  } finally { console.error = orig; }
  assert.deepEqual(out, ['[ai-budget] settle_failed op=uncertain attempts=3 sqlstate=42501']);
  for (const s of [KEY, PHONE, REQ, SCOPE, 'select', 'boom']) assert.ok(!out[0]!.includes(s), s);
});

test('SL4 기록 함수가 실패해도 상담 응답 흐름은 예외 없이 계속, 이후 예약은 여전히 DB 판정(한도 우회 없음)', async () => {
  const d = failingDb('08006');
  const bad: BudgetSettleLog = () => { throw new Error('log down'); };
  const b = createDbAiBudget(d.run, bad);
  await (await b.reserve(6, { requestId: REQ, scope: SCOPE }))!.uncertain!(3);
  const before = d.calls.filter((q) => q.includes('ai_budget_hold')).length;
  assert.ok(await b.reserve(6, { requestId: REQ, scope: SCOPE }));
  assert.equal(d.calls.filter((q) => q.includes('ai_budget_hold')).length, before + 1, '정산 실패 뒤에도 예약은 DB 한도 함수를 거친다(메모리 우회·무료 통과 없음)');
});

test('SL5 정적: 정산 실패 기록은 고정 문자열 + op + SQLSTATE(5자 검사)만', () => {
  const src = readFileSync('src/server/consult/chatModel.ts', 'utf8');
  assert.match(src, /console\.error\(`\[ai-budget\] settle_failed op=\$\{op\} attempts=3 sqlstate=\$\{sqlstate\}`\)/);
  assert.match(src, /\/\^\[0-9A-Z\]\{5\}\$\/\.test\(c\) \? c : 'unknown'/);
  assert.equal((src.match(/console\./g) ?? []).length, 2, 'chatModel의 로그 출력은 설정 오류(기존)·정산 실패 2곳뿐');
});
