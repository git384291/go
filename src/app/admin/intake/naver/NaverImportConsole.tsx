'use client';
import { useState, type FormEvent } from 'react';

type Result = { ok?: boolean; code?: string; imported?: number; duplicates?: number; rejected?: Array<{ row: number; code: string }> };

export function NaverImportConsole() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const input = e.currentTarget.elements.namedItem('export') as HTMLInputElement | null;
    const file = input?.files?.[0];
    if (!file) { setMessage('결과 파일을 선택해 주세요.'); return; }
    if (file.size > 256 * 1024) { setMessage('파일이 256KB를 넘습니다. 100건 이하로 나눠 주세요.'); return; }
    setBusy(true); setMessage('암호화해서 가져오는 중…');
    try {
      const raw = await file.text();
      const tsv = file.name.toLowerCase().endsWith('.tsv') || raw.split(/\r?\n/, 1)[0]!.includes('\t');
      const res = await fetch('/api/admin/intake/naver', { method: 'POST', headers: { 'content-type': tsv ? 'text/tab-separated-values;charset=utf-8' : 'text/csv;charset=utf-8' }, body: raw });
      const body = await res.json().catch(() => ({})) as Result;
      if (!res.ok || !body.ok) { setMessage(`가져오기 실패: ${body.code ?? 'UNKNOWN'}`); return; }
      const rejected = body.rejected?.length ?? 0;
      setMessage(`완료: 새 접수 ${body.imported ?? 0}건, 중복 ${body.duplicates ?? 0}건, 제외 ${rejected}건${rejected ? ` (${body.rejected!.map((x) => `${x.row}행 ${x.code}`).join(', ')})` : ''}`);
      input.value = '';
    } catch { setMessage('연결 오류로 가져오지 못했습니다.'); }
    finally { setBusy(false); }
  }

  return (
    <form className="admin-card" onSubmit={submit}>
      <h2>네이버 폼 결과 가져오기</h2>
      <ol>
        <li>네이버 폼 결과 화면에서 결과 파일을 내려받습니다.</li>
        <li>CSV 또는 TSV 파일을 선택합니다(최대 100건).</li>
        <li>가져온 원본 파일은 서버와 DB에 보관하지 않습니다.</li>
      </ol>
      <label className="field"><span>결과 파일</span><input name="export" type="file" accept=".csv,.tsv,text/csv,text/tab-separated-values" required disabled={busy} /></label>
      <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? '처리 중…' : 'CRM으로 가져오기'}</button>
      <p className="hint" role="status">{message}</p>
      <p className="read-note">현재 운영 상품인 ‘인터넷+TV’만 가져옵니다. ‘인터넷만’ 응답은 활성 상품 승인 전까지 자동 제외합니다.</p>
    </form>
  );
}
