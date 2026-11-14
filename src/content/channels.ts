// 외부 상담 채널(카카오톡 등) 사용 여부. FIDEON PM PHASE 1 보완(검수 지적 4항).
//
// - 외부 채널은 시스템 밖에서 고객과 대화·접수가 이뤄지므로, 고객정보 수집 승인 전까지 열지 않는다.
// - 이 값은 코드 상수다. 환경변수(NEXT_PUBLIC_KAKAO_CHANNEL_URL)를 설정해도 켜지지 않는다.
//   켜려면 코드 변경 + PM 검수가 필요하다(tests/unit/catalog.test.ts G11이 확인).
// - 채널 주소 상수(KAKAO_CHANNEL_URL, products.ts)는 향후 사용을 위해 보존한다.
export const EXTERNAL_CONSULT_ENABLED: boolean = false;

// 온라인 상담 접수 안내 문구. PHASE 1 Mac 검증 보완(화면 문구 ⑧):
// 실제 접수가 비활성인 동안 '무료 상담 신청' 같은 접수 가능 문구 대신 이 안내를 쓴다.
// 고객정보 수집·외부 상담 연결은 이 문구와 무관하게 계속 비활성이다.
export const ONLINE_CONSULT_NOTICE = '온라인 상담 서비스 준비 중';
