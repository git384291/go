import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('VD1 Vercel 프로젝트는 보존하되 Git 자동 배포와 GitHub 댓글은 중지한다', () => {
  const config = JSON.parse(readFileSync('vercel.json', 'utf8')) as {
    git?: { deploymentEnabled?: unknown };
    github?: { silent?: unknown };
  };
  assert.equal(config.git?.deploymentEnabled, false);
  assert.equal(config.github?.silent, true);
});
