import { KAKAO_INQUIRY_LABEL, KAKAO_INQUIRY_NOTES } from '@/content/channels';
import type { KakaoInquiryResult } from '@/content/kakaoInquiry';

// 카카오톡 상품 문의 링크(기본 꺼짐). off·누락이면 아무것도 그리지 않는다.
// - 링크 1개와 안내만 그린다. 입력칸·팝업·SDK·추적·저장·prefill·외부 요청은 없다.
// - rel=noreferrer + referrerPolicy=no-referrer: 현재 페이지 주소(광고 파라미터 포함)를 넘기지 않는다.
// - 안내 문구는 고객이 카카오톡에 민감정보를 입력하는 것까지 막지는 못한다(안내일 뿐).
export function KakaoInquiryLink({ inquiry }: { inquiry?: KakaoInquiryResult }) {
  if (!inquiry || inquiry.state !== 'on') return null;
  return (
    <div className="kakao-inquiry" data-kakao-inquiry="on">
      <a className="btn btn-kakao btn-lg" href={inquiry.href} rel="noopener noreferrer nofollow" referrerPolicy="no-referrer" target="_blank">
        {KAKAO_INQUIRY_LABEL}
      </a>
      {KAKAO_INQUIRY_NOTES.map((n) => (
        <p key={n} className="kakao-inquiry-note">{n}</p>
      ))}
    </div>
  );
}
