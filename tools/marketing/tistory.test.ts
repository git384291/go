/**
 * tistory 테스트 — 오프라인, 실제 API 호출 없음
 */
import {
  validatePost,
  isDuplicatePost,
  TISTORY_POSTS,
  createJobFromTemplate,
  getAllJobs,
  renderPostHtml,
  publishPost,
  type PostJob,
} from './tistory';

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean) {
  if (condition) { console.log(`✅ ${label}`); passed++; }
  else { console.error(`❌ ${label}`); failed++; }
}

// ── 1. 검증 ──────────────────────────────────────────────────────────────────
{
  const v = validatePost({
    title: '인천 인터넷 가입 혜택 2026',
    content: '<p>테스트 본문입니다.</p>',
    tags: ['인터넷', '인천'],
    visibility: 3,
  });
  assert('정상 포스팅 검증 통과', v.valid);
}
{
  const v = validatePost({ title: '', content: '본문', tags: [], visibility: 3 });
  assert('빈 제목 거부', !v.valid && v.errors.some(e => e.includes('제목 필수')));
}
{
  const v = validatePost({ title: '제목', content: '', tags: [], visibility: 3 });
  assert('빈 본문 거부', !v.valid && v.errors.some(e => e.includes('본문 필수')));
}
{
  const v = validatePost({
    title: '제목',
    content: '본문',
    tags: Array(11).fill('tag'),
    visibility: 3,
  });
  assert('태그 11개 거부', !v.valid && v.errors.some(e => e.includes('태그 최대 10개')));
}

// ── 2. 콘텐츠 ────────────────────────────────────────────────────────────────
{
  assert('포스팅 3개 준비됨', TISTORY_POSTS.length >= 3);
  TISTORY_POSTS.forEach(tpl => {
    assert(`포스팅 "${tpl.id}" 본문 1,000자 이상`, tpl.post.content.replace(/<[^>]+>/g, '').length >= 1000);
    assert(`포스팅 "${tpl.id}" 태그 5개 이상`, tpl.post.tags.length >= 5);
  });
}

// ── 3. 렌더링 ────────────────────────────────────────────────────────────────
{
  const post = TISTORY_POSTS[0].post;
  const html = renderPostHtml(post);
  assert('태그 렌더링 포함', html.includes('class="tags"'));
  assert('본문 포함', html.includes(post.content.slice(0, 20)));
}

// ── 4. Job 생성 ───────────────────────────────────────────────────────────────
{
  const job = createJobFromTemplate('tistory_01');
  assert('tistory_01 Job 생성', job !== null && job.status === 'pending');
}
{
  const job = createJobFromTemplate('nonexistent');
  assert('없는 템플릿 → null', job === null);
}
{
  const jobs = getAllJobs();
  assert('전체 Job 3개', jobs.length === 3);
}

// ── 5. PUBLISH_ENABLED=false 차단 ────────────────────────────────────────────
{
  const job: PostJob = {
    id: 'test-001',
    post: { title: '테스트', content: '본문', tags: [], visibility: 3 },
    status: 'pending',
    attempts: 0,
  };
  publishPost(job, false).then(r => {
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
