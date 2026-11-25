// 사용(Mac mini 로컬에서만, credential은 로컬 환경변수로만 — 저장소·채팅에 넣지 말 것):
//   GOOGLE_ADS_CLIENT_ID=… GOOGLE_ADS_CLIENT_SECRET=… GOOGLE_ADS_REFRESH_TOKEN=… GOOGLE_ADS_CUSTOMER_ID=… [GOOGLE_ADS_MONTHLY_CAP_KRW=…] \
//   node --conditions=react-server --import tsx scripts/google-ads-probe/liveread.mts
// 읽기만 한다(변경 0회). 출력은 JSON 줄(단계·숫자·불리언·Google 오류코드)뿐.
import { runLiveRead } from './liveread.ts';
import type { ProbeTransport } from './core.ts';

const MAX = 512 * 1024;
const transport: ProbeTransport = async (url, init) => {
  try {
    const r = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) });
    return { status: r.status, text: (await r.text()).slice(0, MAX) };
  } catch { return { status: 0, text: '' }; }
};
process.exit(await runLiveRead(process.env, transport, (l) => console.log(JSON.stringify(l))));
