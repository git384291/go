// 개인정보 없는 상품 안내 — 고정 주제 선택형 규칙 응답 (PM 6924799021). **비활성 준비: 화면·폼·API·상담 채널에 연결하지 않았다.**
//
// - 입력은 고정 주제 ID 선택뿐이다({ product: 'internet-tv', topic }). 자유 문구·이름·전화·주소·고객 식별자는 받지 않는다.
// - 저장소·로그·네트워크·DB·환경변수·키·SDK·LLM에 접근하지 않는다. 같은 입력이면 항상 같은 고정 응답이다.
// - 생성형 AI 상담이 아니다. 미리 쓴 규칙 안내이며, 그렇게 표시한다(source: 'rules').
// - 응답 문구는 사이트에 이미 게시된 일반 안내(홈·상품 화면의 '꼭 알아두세요'·'가입 전 확인 사항' 수준)만 담는다.
//   요금·혜택·설치 가능 지역·일정·정책은 만들지 않고 '확인 필요'로 둔다. 정책 저장소·실자료와 연결돼 있지 않다.
// - 신청 완료·담당자 연결 완료를 만들지 않는다. 공식 접수 연결은 이미 검수된 판정 결과(OfficialIntakeResult)의 상태만 구분하고,
//   목적지 주소나 우회 링크를 응답에 넣지 않는다.
import type { OfficialIntakeResult } from './officialIntake';

export const GUIDE_TOPICS = ['speed', 'tv', 'bundle', 'contract', 'moving', 'install', 'fees', 'privacy', 'apply'] as const;
export type GuideTopicId = (typeof GUIDE_TOPICS)[number];

/** general = 확인된 일반 안내, needs_check = 조건 확인이 필요해 여기서 답하지 않음, not_ready = 준비 중 */
export type GuideKind = 'general' | 'needs_check' | 'not_ready';

export type GuideAnswer =
  | {
      readonly status: 'ok';
      readonly source: 'rules';
      readonly topic: GuideTopicId;
      readonly title: string;
      readonly kind: GuideKind;
      readonly lines: readonly string[];
      /** apply 주제에서만: 공식 접수처 연결 상태(주소는 담지 않는다) */
      readonly officialIntake?: 'available' | 'unavailable';
    }
  | { readonly status: 'unsupported'; readonly source: 'rules'; readonly lines: readonly string[] };

type Entry = { readonly title: string; readonly kind: GuideKind; readonly lines: readonly string[] };

const CHECK_NOTE = '요금·혜택·설치 조건은 신청 시점에 확정된 조건으로만 안내되며, 이 안내에서는 정하지 않습니다.';

const ENTRIES: ReadonlyMap<Exclude<GuideTopicId, 'apply'>, Entry> = new Map<Exclude<GuideTopicId, 'apply'>, Entry>([
  ['speed', { title: '인터넷 속도는 어떻게 고르나요?', kind: 'general', lines: [
    '집에서 동시에 쓰는 기기 수와 주 용도(영상 시청·재택근무·게임 등)를 먼저 정해 보세요.',
    '상품별 실제 속도 구성과 요금은 신청 시점 조건으로 확인해야 합니다.',
  ] }],
  ['tv', { title: 'TV 구성은 무엇을 정하나요?', kind: 'general', lines: [
    'TV를 볼 방 수(셋톱박스 대수)와 주로 보는 채널 종류를 정해 두면 구성을 고르기 쉽습니다.',
    '채널 구성과 월 추가 비용은 상품마다 달라 신청 전에 확인해야 합니다.',
  ] }],
  ['bundle', { title: '휴대폰 결합이 되나요?', kind: 'needs_check', lines: [
    '결합 가능 여부와 조건은 통신사·가족 구성·이용 중인 회선에 따라 달라 이 안내에서 정할 수 없습니다.',
    '이용 중인 휴대폰 통신사를 알고 계시면 확인할 때 도움이 됩니다.',
  ] }],
  ['contract', { title: '약정·해지 비용은요?', kind: 'general', lines: [
    '약정 기간 안에 해지하면 통신사 약관에 따른 위약금이 생길 수 있습니다.',
    '지금 쓰는 상품의 약정 종료일과 해지 비용을 먼저 확인한 뒤 비교하세요.',
  ] }],
  ['moving', { title: '이사할 때는 어떻게 하나요?', kind: 'needs_check', lines: [
    '기존 회선을 옮기는 것과 새로 가입하는 것은 조건이 다를 수 있습니다.',
    '새 주소의 설치 가능 여부는 접수 단계에서 확인됩니다. 이 안내에서는 주소를 받지 않습니다.',
  ] }],
  ['install', { title: '설치 가능 지역·일정은요?', kind: 'needs_check', lines: [
    '설치 가능 여부와 일정은 주소와 건물 조건에 따라 달라 이 안내에서 답할 수 없습니다.',
    '접수 단계에서 확인되며, 이 안내에서는 주소를 받지 않습니다.',
  ] }],
  ['fees', { title: '요금과 사은품은 얼마인가요?', kind: 'needs_check', lines: [
    '요금과 사은품은 화면에 게시하지 않고 신청 시점의 확정 조건으로만 안내합니다.',
    CHECK_NOTE,
  ] }],
  ['privacy', { title: '어떤 정보를 보내면 되나요?', kind: 'general', lines: [
    '이 안내에서는 이름·연락처·주소를 받지 않습니다.',
    '주민등록번호·신분증·계좌번호는 채팅이나 메시지로 보내지 마세요.',
  ] }],
]);

const APPLY_TITLE = '신청은 어떻게 하나요?';
const APPLY_ON = Object.freeze([
  '공식 접수처 화면에서 고객님이 직접 신청 정보를 입력합니다. FIDEON은 이 안내에서 개인정보를 받지 않습니다.',
  CHECK_NOTE,
]);
const APPLY_OFF = Object.freeze([
  '온라인 상담 서비스 준비 중입니다. 지금은 이 화면에서 신청을 받지 않습니다.',
  CHECK_NOTE,
]);
const UNSUPPORTED_LINES = Object.freeze(['선택하신 항목은 안내할 수 없습니다. 아래 목록에서 인터넷 + TV 주제를 골라 주세요.']);

const UNSUPPORTED: GuideAnswer = Object.freeze({ status: 'unsupported', source: 'rules', lines: UNSUPPORTED_LINES });

const isTopic = (v: unknown): v is GuideTopicId => typeof v === 'string' && (GUIDE_TOPICS as readonly string[]).includes(v);

/**
 * 고정 주제 선택에 대한 규칙 응답. 입력은 정확히 { product: 'internet-tv', topic: <GUIDE_TOPICS> }만 허용한다.
 * 그 밖(추가 키·null·배열·오타·예약 상품·자유 문구)은 고정 안전 안내로 닫는다. 입력 값을 응답에 되돌려 넣지 않는다.
 * intake는 서버가 이미 판정한 공식 접수 결과다. 넘기지 않거나 'on'이 아니면 접수 가능으로 안내하지 않는다.
 */
export function answerGuide(input: unknown, intake?: OfficialIntakeResult): GuideAnswer {
  try {
    return answerGuideUnsafe(input, intake);
  } catch {
    return UNSUPPORTED; // 접근자 예외·Proxy 등 이상 입력도 고정 안내로 닫는다
  }
}

function answerGuideUnsafe(input: unknown, intake?: OfficialIntakeResult): GuideAnswer {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return UNSUPPORTED;
  if (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) return UNSUPPORTED;
  const keys = Object.keys(input);
  if (keys.length !== 2 || !keys.includes('product') || !keys.includes('topic')) return UNSUPPORTED;
  const { product, topic } = input as { product: unknown; topic: unknown };
  if (product !== 'internet-tv' || !isTopic(topic)) return UNSUPPORTED;

  if (topic === 'apply') {
    const available = intake !== undefined && intake !== null && intake.state === 'on' && intake.links.length > 0;
    return Object.freeze({
      status: 'ok', source: 'rules', topic, title: APPLY_TITLE, kind: available ? 'general' : 'not_ready',
      lines: available ? APPLY_ON : APPLY_OFF, officialIntake: available ? 'available' : 'unavailable',
    });
  }
  const e = ENTRIES.get(topic);
  if (!e) return UNSUPPORTED;
  return Object.freeze({ status: 'ok', source: 'rules', topic, title: e.title, kind: e.kind, lines: Object.freeze([...e.lines]) });
}

/** 선택 목록(화면 연결 시 버튼용). 고정 순서·고정 제목만 */
export function guideMenu(): readonly { readonly topic: GuideTopicId; readonly title: string }[] {
  return Object.freeze(GUIDE_TOPICS.map((t) => Object.freeze({ topic: t, title: t === 'apply' ? APPLY_TITLE : ENTRIES.get(t)!.title })));
}
