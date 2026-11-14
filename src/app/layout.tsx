import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'FIDEON · 인터넷 + TV 가입 상담',
  description: '인터넷 + TV 결합 조건을 통신사별로 비교해 상담해 드립니다.',
  robots: { index: false, follow: false }, // 1단계 공개 승인 전까지 검색 노출 차단
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#0f2a3d' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
