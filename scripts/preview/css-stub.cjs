// 미리보기 렌더링 전용: CommonJS 경로에서 CSS import를 빈 모듈로 처리
require.extensions['.css'] = (m) => { m.exports = {}; };
