/**
 * channelPublisher 테스트 — 중복 차단 · 어뷰징 방지 · 승인 전 게시 금지
 */
import {
  CHANNEL_REGISTRY,
  generateContent,
  isDuplicate,
  markPublished,
  preparePublish,
} from './channelPublisher';

// ── 1. 채널 분류 검증 ──
const FORBIDDEN = ['ppomppu', 'clien', 'dcinside', 'womens_site', 'local_cafe'] as const;
const API_AUTO  = ['youtube', 'instagram', 'facebook', 'blogger'] as const;

for (const ch of FORBIDDEN) {
  const meta = CHANNEL_REGISTRY[ch];
  if (meta.tier !== 'FORBIDDEN') throw new Error(`${ch}가 FORBIDDEN이어야 함`);
  if (meta.autoPostAllowed)       throw new Error(`${ch}는 autoPostAllowed=false이어야 함`);
  console.log(`✅ FORBIDDEN 확인: ${ch}`);
}

for (const ch of API_AUTO) {
  const meta = CHANNEL_REGISTRY[ch];
  if (meta.tier !== 'API_AUTO')  throw new Error(`${ch}가 API_AUTO이어야 함`);
  if (!meta.apiAvailable)        throw new Error(`${ch}는 apiAvailable=true이어야 함`);
  console.log(`✅ API_AUTO 확인: ${ch}`);
}

// ── 2. 콘텐츠 생성 ──
const blogPost = generateContent('blog_post', 0);
if (!blogPost.title)             throw new Error('블로그 제목 없음');
if (blogPost.approved !== false) throw new Error('신규 콘텐츠는 approved=false이어야 함');
console.log(`✅ 콘텐츠 생성: "${blogPost.title}"`);

const script = generateContent('short_video_script', 0);
if (!script.body)                throw new Error('쇼츠 스크립트 없음');
console.log(`✅ 쇼츠 스크립트 생성: "${script.title}"`);

// ── 3. 승인 전 게시 차단 ──
const results = preparePublish(blogPost);
const allPending = results.every(r => r.status === 'PENDING_APPROVAL');
if (!allPending) throw new Error('승인 전 게시 차단 실패');
console.log(`✅ 승인 전 게시 차단: ${results.length}개 채널 모두 PENDING_APPROVAL`);

// ── 4. 중복 콘텐츠 차단 ──
blogPost.approved = true;
markPublished(blogPost);
if (!isDuplicate(blogPost)) throw new Error('중복 감지 실패');
console.log(`✅ 중복 콘텐츠 차단 확인`);

// ── 5. FORBIDDEN 채널은 승인 후에도 게시 안 됨 ──
const forbiddenContent = generateContent('blog_post', 0);
forbiddenContent.approved = true;
(forbiddenContent.targetChannel as string[]) = ['ppomppu', 'clien'];
const forbiddenResults = preparePublish(forbiddenContent, false);
const allForbidden = forbiddenResults.every(r => r.status === 'SKIPPED_FORBIDDEN' || r.status === 'PENDING_APPROVAL');
if (!allForbidden) throw new Error('FORBIDDEN 채널 차단 실패');
console.log(`✅ FORBIDDEN 채널 차단 확인`);

console.log('\n🎉 모든 테스트 통과');
