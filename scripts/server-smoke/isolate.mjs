// 서버 스모크용 격리 실행 루트. Next는 실행 루트의 .env* 파일을 스스로 읽으므로(환경 허용 목록 우회),
// 실제 설정 파일이 없는 임시 루트에서 빌드 산출물을 실행한다.
// - 원본 루트의 dotenv 파일은 '이름 존재'만 확인한다(내용을 읽지 않음, 삭제·이동·덮어쓰기 없음).
// - 임시 루트: .next·node_modules는 심볼릭 링크, next.config.ts·package.json만 복사. 다른 파일은 두지 않는다.
// - 시작 전 임시 루트에 .env*가 하나라도 있으면 fail-closed.
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DOTENV = /^\.env(\..+)?$/;
const COPY = ['next.config.ts', 'next.config.mjs', 'next.config.js', 'package.json'];
const LINK = ['.next', 'node_modules'];

/** 폴더의 dotenv 파일 이름 목록(내용은 읽지 않는다) */
export function dotenvFilesIn(dir) {
  try { return readdirSync(dir).filter((n) => DOTENV.test(n)).sort(); } catch { return []; }
}

export function prepareIsolatedRoot(srcRoot) {
  if (!existsSync(path.join(srcRoot, '.next'))) throw new Error('ISOLATE_NO_BUILD');
  const root = mkdtempSync(path.join(os.tmpdir(), 'fideon-smoke-'));
  try {
    for (const name of LINK) if (existsSync(path.join(srcRoot, name))) symlinkSync(path.join(srcRoot, name), path.join(root, name), 'dir');
    for (const name of COPY) if (existsSync(path.join(srcRoot, name))) copyFileSync(path.join(srcRoot, name), path.join(root, name));
    if (dotenvFilesIn(root).length) throw new Error('ISOLATE_DOTENV_PRESENT');
  } catch (e) {
    rmSync(root, { recursive: true, force: true });
    throw e;
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
