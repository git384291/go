/**
 * xTwitter 테스트 — 오프라인, 실제 API 호출 없음
 */
import {
  validateTweet,
  isDuplicateTweet,
  TWEET_TEMPLATES,
  getTemplatesByCategory,
  createJobFromTemplate,
  buildDailyQueue,
  postTweet,
  type TweetJob,
} from './xTwitter';

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean) {
  if (condition) { console.log(`✅ ${label}`); passed++; }
  else { console.error(`❌ ${label}`); failed++; }
}

// ── 1. 검증 ──────────────────────────────────────────────────────────────────
{
  const v = validateTweet({ text: '인천 인터넷 가입 상담 무료입니다 #바른통신365' });
  assert('정상 트윗 검증 통과', v.valid);
}
{
  const v = validateTweet({ text: '' });
  assert('빈 텍스트 거부', !v.valid);
}
{
  const v = validateTweet({ text: 'a'.repeat(281) });
  assert('281자 초과 거부', !v.valid && v.errors.some(e => e.includes('280자')));
}
{
  const v = validateTweet({ text: 'a'.repeat(280) });
  assert('280자 허용', v.valid && v.charCount === 280);
}

// ── 2. 템플릿 ─────────────────────────────────────────────────────────────────
{
  assert('템플릿 6개 이상', TWEET_TEMPLATES.length >= 6);
  const promos = getTemplatesByCategory('short_promo');
  assert('short_promo 카테고리 존재', promos.length >= 1);
}
{
  const job = createJobFromTemplate('promo_01');
  assert('템플릿으로 Job 생성', job !== null && job.meta.text.length > 0);
}
{
  const job = createJobFromTemplate('nonexistent');
  assert('없는 템플릿 → null', job === null);
}

// ── 3. 일일 큐 ───────────────────────────────────────────────────────────────
{
  const queue = buildDailyQueue();
  assert('일일 큐 2~3개', queue.length >= 2 && queue.length <= 3);
  queue.forEach(j => assert(`큐 Job 상태 pending: ${j.id}`, j.status === 'pending'));
}

// ── 4. PUBLISH_ENABLED=false 차단 ────────────────────────────────────────────
{
  const job: TweetJob = {
    id: 'test-001',
    meta: { text: '테스트 트윗' },
    status: 'pending',
    attempts: 0,
  };
  postTweet(job, false).then(r => {
    assert('PUBLISH_ENABLED=false → pending', r.status === 'pending');
    assert('승인 필요 메시지', r.lastError?.includes('승인') ?? false);
    printResult();
  }).catch(e => {
    console.error('비동기 오류:', e);
    process.exit(1);
  });
}

function printResult() {
  console.log(`\n${'─'.repeat(50)}`);
  if (failed === 0) console.log(`\n🎉 모든 테스트 통과 (${passed}/${passed + failed})`);
  else { console.log(`\n⚠️  ${failed}개 실패 / ${passed}개 통과`); process.exit(1); }
}
