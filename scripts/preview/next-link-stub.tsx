// 미리보기 렌더링 전용: next/link가 설치되지 않은 환경에서만 쓰인다(설치된 환경에서는 실제 next/link 사용).
// 서버 렌더링 결과는 실제 Next.js Link와 같이 <a href>로 나온다.
import type { AnchorHTMLAttributes, ReactNode } from 'react';

type Props = { href: string; children?: ReactNode } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>;

export default function Link({ href, children, ...rest }: Props) {
  return (
    <a href={href} {...rest}>
      {children}
    </a>
  );
}
