import { adminAuthMode } from '@/server/auth/adminAuthMode';
import { requireStaff } from '@/server/auth/requireStaff';
import type { SqlTag } from '@/server/admin/crmAdmin';
import { defaultNaverCrypto, importNaverForm, type NaverImportDeps } from '@/server/admin/naverFormImport';
import { withRole } from '@/server/db/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const H = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' };
const fail = (code: string, status: number) => new Response(JSON.stringify({ ok: false, code }), { status, headers: H });
const MAX_BYTES = 256 * 1024;

async function limitedText(req: Request): Promise<string | null> {
  if (!req.body) return '';
  const reader = req.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0, text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) { await reader.cancel(); return null; }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch { return null; }
}

const deps = (): NaverImportDeps => ({
  env: () => process.env, mode: () => adminAuthMode(), requireStaff,
  runInTransaction: (fn) => withRole('staff', (tx) => fn(tx as unknown as SqlTag)), now: () => new Date(), crypto: defaultNaverCrypto,
});

export async function POST(req: Request) {
  const type = (req.headers.get('content-type') ?? '').toLowerCase();
  if (!type.startsWith('text/csv') && !type.startsWith('text/tab-separated-values')) return fail('UNSUPPORTED_MEDIA', 415);
  const origin = req.headers.get('origin');
  if (origin && origin !== new URL(req.url).origin) return fail('FORBIDDEN', 403);
  const size = Number(req.headers.get('content-length'));
  if (Number.isFinite(size) && size > MAX_BYTES) return fail('PAYLOAD_TOO_LARGE', 413);
  const raw = await limitedText(req);
  if (raw === null) return fail('PAYLOAD_TOO_LARGE', 413);
  return importNaverForm(deps(), raw);
}
