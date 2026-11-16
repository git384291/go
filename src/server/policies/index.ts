import 'server-only';
// 정책 견적 모듈 진입점(서버 전용). 화면·API·자동 상담에는 아직 연결하지 않는다(PHASE 1 비활성).
export { quotePolicy, QUOTABLE_SOURCES, NEEDS_REVIEW_GUIDANCE, QUOTE_NOTICES } from './quote';
export type * from './types';
