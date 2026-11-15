// 출시 설정 사전 점검 실행(읽기 전용, 네트워크·DB 접속 없음, 값 미출력).
// 사용: npm run preflight:launch            → 현재 셸 환경 변수 점검(항상 exit 0, 결과만 표시)
//       npm run preflight:launch -- --strict → MISSING·INVALID·POLICY가 하나라도 있으면 exit 1
// 로컬 .env 파일로 점검하려면: npx tsx --env-file=.env.local scripts/preflight/run.ts (파일 내용은 출력하지 않음)
import { readFileSync } from 'node:fs';
import { renderChecks, runChecks } from './checks';

const checks = runChecks(process.env, { layoutSource: readFileSync('src/app/layout.tsx', 'utf8') });
console.log('== 출시 설정 사전 점검 (값·원문 미출력, 읽기 전용)');
console.log(renderChecks(checks));
if (process.argv.includes('--strict') && checks.some((c) => c.status === 'MISSING' || c.status === 'INVALID' || c.status === 'POLICY')) process.exit(1);
