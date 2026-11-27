// postgres 대체(미설치 환경 전용). 경로 시험은 DB에 닿으면 안 되므로, 연결을 시도하면 즉시 실패시킨다.
module.exports = function postgres() {
  throw new Error('route test must not open a DB connection');
};
