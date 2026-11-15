// 공급망·자동 검토 보안 회귀 시험: 워크플로 설정이 약해지면 여기서 먼저 실패한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const DIR = '.github/workflows';
const FILES = readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f));

test('모든 워크플로 액션(uses:)은 40자리 커밋 SHA로 고정되어 있다(태그 바꿔치기 방지)', () => {
  let count = 0;
  for (const f of FILES) {
    for (const m of readFileSync(`${DIR}/${f}`, 'utf8').matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)) {
      count++;
      const ref = m[1];
      if (ref.startsWith('./')) continue; // 같은 저장소의 로컬 액션
      assert.match(ref, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, `${f}: ${ref}`);
    }
  }
  assert.ok(count >= 1);
});

test('자동 검토(claude-review)는 읽기 전용 도구만 쓰고 .git 읽기를 막는다(토큰 노출 방지)', () => {
  const s = readFileSync(`${DIR}/claude-review.yml`, 'utf8');
  const m = s.match(/--disallowedTools\s+"([^"]+)"/);
  assert.ok(m, '--disallowedTools 없음');
  const denied = m[1].split(',').map((x) => x.trim());
  for (const t of ['Bash', 'Edit', 'Write', 'NotebookEdit', 'Read(./.git/**)', 'Read(./.git)']) {
    assert.ok(denied.includes(t), `${t} 차단 누락`);
  }
  assert.match(s, /--tools\s+"Read,Glob,Grep"/);
  // pull_request_target은 외부 PR 코드에 쓰기 토큰을 줄 수 있으므로 쓰지 않는다
  for (const f of FILES) assert.ok(!/pull_request_target/.test(readFileSync(`${DIR}/${f}`, 'utf8')), f);
});
