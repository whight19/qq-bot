#!/usr/bin/env node
/**
 * OneBot v11 连通性探针：连上 NapCat 的正向 WS，调几个只读接口确认通道可用。
 * 用法：node onebot-probe.mjs [ws://127.0.0.1:3001]
 * token 取 ONEBOT_TOKEN 环境变量，没设就用 config.json 里的 onebot.token。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
let cfgToken = '';
try {
  cfgToken = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8')).onebot?.token || '';
} catch {
  /* 读不到就当没有 token */
}

const token = String(process.env.ONEBOT_TOKEN || cfgToken).trim();
const base = process.argv[2] || process.env.ONEBOT_WS || 'ws://127.0.0.1:3001';
const url =
  token && !/[?&]access_token=/i.test(base)
    ? base + (base.includes('?') ? '&' : '?') + 'access_token=' + encodeURIComponent(token)
    : base;
const pending = new Map();
let seq = 0;

const ws = new WebSocket(url);
const timeout = setTimeout(() => {
  console.error('[超时] 6 秒内没有完成握手/调用');
  process.exit(1);
}, 6000);

function call(action, params = {}) {
  return new Promise((resolve, reject) => {
    const echo = 'p' + ++seq;
    const timer = setTimeout(() => {
      pending.delete(echo);
      reject(new Error(action + ' 超时'));
    }, 5000);
    pending.set(echo, { resolve, reject, timer });
    ws.send(JSON.stringify({ action, params, echo }));
  });
}

ws.onopen = async () => {
  try {
    const me = await call('get_login_info');
    const ver = await call('get_version_info');
    const groups = await call('get_group_list');
    const friends = await call('get_friend_list');

    console.log(JSON.stringify({ ok: true, self: me, version: ver, groups: groups?.length ?? 0, friends: friends?.length ?? 0 }, null, 2));
    if (Array.isArray(groups) && groups.length > 0) {
      console.log('群列表（前 10）:');
      for (const g of groups.slice(0, 10)) console.log(`  ${g.group_id}  ${g.group_name}`);
    }
    clearTimeout(timeout);
    ws.close();
    process.exit(0);
  } catch (err) {
    console.error('[失败] ' + err.message);
    clearTimeout(timeout);
    process.exit(1);
  }
};

ws.onmessage = (ev) => {
  let data;
  try { data = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { return; }
  const p = data.echo && pending.get(data.echo);
  if (!p) return;
  pending.delete(data.echo);
  clearTimeout(p.timer);
  if (data.retcode === 0 || data.retcode === undefined) p.resolve(data.data ?? data);
  else p.reject(new Error('retcode=' + data.retcode + ' ' + (data.message || data.wording || '')));
};

ws.onerror = (e) => {
  console.error('[连接失败] ' + url.replace(/(access_token=)[^&]*/i, '$1***'));
  console.error('  NapCat 的 WS 服务没起来？或者 token 和 NapCat 里的对不上？');
  clearTimeout(timeout);
  process.exit(1);
};
