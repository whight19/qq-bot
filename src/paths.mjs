/**
 * 路径 / 配置 / 常量：整个程序启动时只读一次的东西。
 * （config 是启动时读进来的对象；热加载的那部分在 bot.mjs 里，叫 liveCfg。）
 */
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
// node bot.mjs --selftest：只跑内置自测，不连 NapCat、不写记忆
const SELFTEST = process.argv.includes('--selftest');

if (typeof WebSocket === 'undefined' || typeof fetch === 'undefined') {
  console.error('[致命] 当前 Node 运行时缺少内置 WebSocket/fetch（需要 Node 22 或更高）。');
  console.error('       D:\\nodejs\\node.exe 的版本如果低于 22，请先升级，或用 --experimental-websocket 启动。');
  process.exit(1);
}

/* ---------------------------------------------------------------- 配置加载 */

function parseEnvFile(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    let value = line.slice(i + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[line.slice(0, i).trim()] = value;
  }
  return out;
}

const env = { ...parseEnvFile(join(ROOT, '.env')), ...process.env };

let config;
try {
  config = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'));
} catch (err) {
  const missing = !existsSync(join(ROOT, 'config.json'));
  if (missing && existsSync(join(ROOT, 'config.example.json'))) {
    console.error('[致命] 没有 config.json —— 先复制一份模板再填：');
    console.error('       copy config.example.json config.json');
    console.error('       （填好 onebot.token、admin.users 再启动）');
  } else {
    console.error('[致命] 读不到或解析不了 config.json：' + err.message);
  }
  process.exit(1);
}

const API_KEY = String(env.DEEPSEEK_API_KEY || env.LLM_API_KEY || '').trim();
const WS_URL_RAW = String(env.ONEBOT_WS || config.onebot?.wsUrl || 'ws://127.0.0.1:3001').trim();
const WS_TOKEN = String(env.ONEBOT_TOKEN || config.onebot?.token || '').trim();
const BASE_URL = String(env.LLM_BASE_URL || config.llm?.baseUrl || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
const MODEL = String(env.LLM_MODEL || config.llm?.model || 'deepseek-flash').trim();

/**
 * 把 access_token 拼进 WS URL。
 * Node 内置的 WebSocket（undici）不支持自定义 header，只能走查询参数；
 * NapCat 的 WS 服务端两者都认（?access_token= 或 Authorization: Bearer），这里用前者。
 */
function withWsToken(url, token) {
  if (!token) return url;
  if (/[?&]access_token=/i.test(url)) return url;
  return url + (url.includes('?') ? '&' : '?') + 'access_token=' + encodeURIComponent(token);
}

/** 日志里别把 token 原样打出来。 */
function wsUrlForLog(url = WS_URL) {
  return String(url).replace(/(access_token=)[^&]*/i, '$1***');
}

const WS_URL = withWsToken(WS_URL_RAW, WS_TOKEN);

if (!API_KEY) {
  console.error('[致命] .env 里的 DEEPSEEK_API_KEY 是空的。');
  console.error('       去 https://platform.deepseek.com/ 建一个 Key，填进 ' + join(ROOT, '.env'));
  process.exit(1);
}

if (!WS_TOKEN && !SELFTEST) {
  console.warn('[安全] OneBot 的 token 是空的：本机任何进程都能连上 3001 端口替你操作 QQ。');
  console.warn('       在 config.json 的 onebot.token 和 NapCat 的 onebot11 配置里填同一个值即可。');
}

/* -------------------------------------------------------------------- 日志 */

const LOG_DIR = join(ROOT, config.logDir || 'logs');
mkdirSync(LOG_DIR, { recursive: true });

const CONFIG_FILE = join(ROOT, 'config.json');
const PID_FILE = join(ROOT, 'data', 'bot.pid');
const MEM_DICT_FILES = [join(ROOT, 'data', 'dict.txt'), join(ROOT, 'assets', 'dict.txt')];

export {
  ROOT, SELFTEST, env, config, API_KEY, WS_URL_RAW, WS_TOKEN, WS_URL, BASE_URL, MODEL,
  withWsToken, wsUrlForLog, LOG_DIR, CONFIG_FILE, PID_FILE, MEM_DICT_FILES,
};
