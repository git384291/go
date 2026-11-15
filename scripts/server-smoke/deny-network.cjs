// 서버 스모크 전용 사전 로드(NODE_OPTIONS=--require). 루프백 외 TCP·TLS·DNS 접속을 막는다.
// 막은 횟수만 FIDEON_SMOKE_NET_LOG 파일에 한 줄씩 남긴다(호스트·주소·내용은 기록하지 않음).
'use strict';
const net = require('node:net');
const dns = require('node:dns');
const fs = require('node:fs');

const LOG = process.env.FIDEON_SMOKE_NET_LOG;
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1']);
const allowed = (host) => host === undefined || host === null || host === '' || LOOPBACK.has(String(host).toLowerCase());
const record = () => { if (LOG) { try { fs.appendFileSync(LOG, 'blocked\n'); } catch { /* 기록 실패는 무시 */ } } };

const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function patchedConnect(...args) {
  // net.connect(port, host)·tls.connect 등은 인자를 [options, cb] 배열로 정규화해 넘긴다 → 그 options를 검사
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  let host;
  let isPath = false;
  if (first && typeof first === 'object') {
    if (first.path) isPath = true; else host = first.host ?? 'localhost';
  } else if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
    host = typeof args[1] === 'string' ? args[1] : 'localhost';
  } else if (typeof first === 'string') {
    isPath = true; // 유닉스 소켓
  }
  if (!isPath && !allowed(host)) {
    record();
    const err = Object.assign(new Error('FIDEON_SMOKE_NETWORK_BLOCKED'), { code: 'ECONNREFUSED' });
    process.nextTick(() => this.destroy(err));
    return this;
  }
  return origConnect.apply(this, args);
};

const blockedLookup = (cb) => {
  record();
  const err = Object.assign(new Error('FIDEON_SMOKE_DNS_BLOCKED'), { code: 'ENOTFOUND' });
  if (typeof cb === 'function') process.nextTick(() => cb(err));
};
const origLookup = dns.lookup;
dns.lookup = function patchedLookup(host, ...rest) {
  if (!allowed(host)) return blockedLookup(rest[rest.length - 1]);
  return origLookup.call(this, host, ...rest);
};
const origPromiseLookup = dns.promises.lookup;
dns.promises.lookup = function patchedPromiseLookup(host, ...rest) {
  if (!allowed(host)) {
    record();
    return Promise.reject(Object.assign(new Error('FIDEON_SMOKE_DNS_BLOCKED'), { code: 'ENOTFOUND' }));
  }
  return origPromiseLookup.call(this, host, ...rest);
};
