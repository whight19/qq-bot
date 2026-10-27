/**
 * 纯函数工具：文本收尾、时间/金额格式化、解析、打分用的纯计算…
 * 这里的东西不碰全局状态（config / liveCfg / ws / memory），放哪儿都能直接调。
 */

function toId(v) {
  return v === undefined || v === null ? '' : String(v);
}

function allowed(cfg, id) {
  const sid = toId(id);
  const block = (cfg.blacklist || []).map(toId);
  if (block.includes(sid)) return false;
  const list = (cfg.whitelist || []).map(toId);
  if (list.length > 0) return list.includes(sid); // 配了白名单就只放行白名单
  return !cfg.whitelistOnly;                      // 没配白名单时看白名单模式开关
}

/**
 * 按「话题断档」裁剪：从最新一条往前找，遇到 ≥ gapMs 的沉默就从那里切开，
 * 只保留切开之后的消息。list 必须已按时间排序。
 */
function sliceCurrentTopic(list, gapMs) {
  if (list.length <= 1) return list;
  for (let i = list.length - 1; i > 0; i--) {
    if (list[i].time - list[i - 1].time >= gapMs) return list.slice(i);
  }
  return list;
}

/**
 * 要不要为这条消息联网搜一下。
 * 默认 keyword 模式：消息里必须显式带触发词（默认「/联网」）。
 * 群聊里本来就只在被 @ 之后才会走到这里，所以等于「@ 机器人 + 说了 /联网」才搜。
 */
function shouldSearch(text, cfg) {
  if (!cfg.enabled) return false;
  const t = String(text ?? '');
  if (!t.trim()) return false;
  if (cfg.trigger === 'always') return true;
  if (cfg.trigger === 'never') return false;
  if (cfg.trigger === 'smart') return /[?？]/.test(t) || SEARCH_HINTS.test(t);
  return t.toLowerCase().includes(String(cfg.keyword || '/联网').toLowerCase());
}

/** 把触发词从消息里摘掉，免得它进模型 prompt / 记忆里。 */
function stripSearchKeyword(text, cfg) {
  const kw = String(cfg.keyword || '/联网');
  if (!kw) return String(text ?? '').trim();
  const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(text ?? '')
    .replace(new RegExp(escaped, 'gi'), ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 把搜索结果拼成给模型看的上下文块（总长度有硬上限，免得一次搜索就吃掉几千 token）。 */
function buildWebContext(results, cfg) {
  const usable = results.filter((r) => r && (r.title || r.summary || r.snippet)).slice(0, 5);
  if (usable.length === 0) return '';

  const maxTotal = Math.max(400, Number(cfg.maxTotal ?? 1600));
  const lines = [
    '（用户刚刚要求你联网搜索，下面就是为他这个问题搜到的实时结果。请直接据此回答，别说“我查不了”“没法联网”之类的话；只有结果里确实没有答案时，才说不确定。）',
  ];
  let used = lines[0].length; // 累加，别在循环里反复 join 整段

  for (const [i, r] of usable.entries()) {
    const title = String(r.title ?? '').replace(/\s+/g, ' ').slice(0, 80);
    const summary = String(r.summary || r.snippet || '').replace(/\s+/g, ' ').slice(0, cfg.maxChars);
    const date = r.date ? String(r.date).slice(0, 10) : '';
    const entry = [`[${i + 1}] ${title}${date ? '（' + date + '）' : ''}`, summary, r.url ? String(r.url) : '']
      .filter(Boolean)
      .join('\n');
    if (used + 1 + entry.length > maxTotal) break;
    lines.push(entry);
    used += 1 + entry.length;
  }

  return lines.length > 1 ? lines.join('\n') : '';
}

/** 「我看不到图 / 看不清 / 识图没开」这类能力性拒绝，带图时会从历史里剔掉。 */
function isCapabilityRefusal(text) {
  const t = String(text ?? '');
  const said = /(看不到|看不见|看不清|没看到|没读到|读不到|收不到|没收到|没法看|不能看|看不了|无法查看)/.test(t)
    || /识图.{0,6}(没开|未开|没启用|没打开)/.test(t);
  return said && /(图|照片|图片|截图)/.test(t);
}

/** 发出去之前统一收尾：去掉句尾的句号（中英文），问号、感叹号、省略号保留。 */
function tidyReply(text) {
  return String(text ?? '')
    .replace(/[\s\u3000]+$/u, '')
    .replace(/[。．.]+$/u, '')
    .replace(/[\s\u3000]+$/u, '')
    .trim();
}

/** 收尾：去引号、压缩空白、截断、去句尾句号。文字为空时返回 ''。 */
function cleanReplyText(raw, maxChars) {
  let text = String(raw ?? '')
    .replace(/^[\s"'“”「」]+|[\s"'“”「」]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  const limit = Number(maxChars ?? 120);
  if (Number.isFinite(limit) && limit > 0 && text.length > limit) text = text.slice(0, limit) + '…';
  return tidyReply(text);
}

/** 把模型吐出来的性格文本收拾干净：去代码围栏、去标题、压到 maxChars（尽量断在句号）。 */
function sanitizePersonality(raw, maxChars) {
  let lines = String(raw ?? '')
    .replace(/```[a-zA-Z]*\n?/g, '')
    .split('\n')
    .map((line) => line.replace(/^\s*#{1,6}\s*/, '').trimEnd())
    .filter((line) => line.trim() !== '');
  let text = lines.join('\n').replace(/^[\s"'“”「」]+|[\s"'“”「」]+$/g, '').trim();
  if (!text) return '';

  const limit = Math.max(20, Number(maxChars) || 500);
  if (text.length > limit) {
    const cut = text.slice(0, limit);
    const m = cut.match(/^[\s\S]*[。！？!?；;]/); // 断在最后一个句末标点
    text = (m ? m[0] : cut).trim();
  }
  return text;
}

/** 「/禁言 @x 30分钟」里的时间：支持 秒/分/小时/天/永久，默认 10 分钟。 */
function parseMinutes(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return 10;
  if (/永久|永远|30\s*天/.test(s)) return 30 * 1440;
  const m = s.match(/(\d+(?:\.\d+)?)\s*(秒|s|分|分钟|m|小时|时|h|天|d)?/i);
  if (!m) throw new Error('时间看不懂，用「10」、「10分钟」或「1小时」');
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) throw new Error('时间不对');
  const unit = String(m[2] || '分').toLowerCase();
  if (unit === '秒' || unit === 's') return n / 60;
  if (unit === '小时' || unit === '时' || unit === 'h') return n * 60;
  if (unit === '天' || unit === 'd') return n * 1440;
  return n;
}

/** 「/充值 10」「/充值 ￥10.5」「/充值 10元」都能认；min=0.01 表示不许充 0 或负数。 */
function parseAmount(raw, min) {
  const text = String(raw ?? '')
    .trim()
    .replace(/[￥¥$元块,，\s]/g, '')
    .replace(/^\+/, '');
  if (!text) throw new Error('要给个金额，比如 /充值 10');
  const n = Number(text);
  if (!Number.isFinite(n)) throw new Error('「' + raw + '」不是数字');
  if (n < min) throw new Error(min > 0 ? '金额要大于 0' : '金额不能是负数');
  if (n > 1e6) throw new Error('金额太大了');
  return Math.round(n * 100) / 100;
}

function formatDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s === 0) return '0 秒';
  if (s % 86400 === 0) return s / 86400 + ' 天';
  if (s % 3600 === 0) return s / 3600 + ' 小时';
  if (s % 60 === 0) return s / 60 + ' 分钟';
  return s + ' 秒';
}

/** 花费：很小的数保留 4 位，别显示成 ￥0.00。 */
function moneyText(price, value) {
  const v = Number(value) || 0;
  if (Math.abs(v) < 0.00005) return price.symbol + '0.00';
  return price.symbol + (Math.abs(v) < 0.01 ? v.toFixed(4) : v.toFixed(2));
}

/** 余额：固定两位（负得极小时也别显示 -0.00）。 */
function moneyText2(price, value) {
  const v = Number(value) || 0;
  if (Math.abs(v) < 0.005) return price.symbol + '0.00';
  return price.symbol + v.toFixed(2);
}

function clockText(ms) {
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/**
 * 这条记录按峰时还是谷时计价。
 * 识别不了法定假日，假日会按峰时算（价格偏高，属于保守估计）。
 */
function isPeakAt(when) {
  const d = when instanceof Date ? when : new Date(when);
  if (Number.isNaN(d.getTime())) return true;
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false;
  const h = d.getUTCHours();
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}

function costOfRecord(rec, price) {
  const peak = isPeakAt(rec.ts);
  const take = (k) => (peak ? price[k + 'Peak'] : price[k + 'OffPeak']);
  const prompt = Number(rec.prompt) || 0;
  const cached = Math.min(Number(rec.cached) || 0, prompt);
  const miss = Math.max(0, prompt - cached);
  const output = Number(rec.completion) || 0;
  return (miss / 1e6) * take('cacheMiss') + (cached / 1e6) * take('cacheHit') + (output / 1e6) * take('output');
}

function emptyUsage() {
  return { calls: 0, prompt: 0, cached: 0, completion: 0, searches: 0, cost: 0 };
}

function addUsage(agg, rec, price) {
  const prompt = Number(rec.prompt) || 0;
  agg.calls++;
  agg.prompt += prompt;
  agg.cached += Math.min(Number(rec.cached) || 0, prompt);
  agg.completion += Number(rec.completion) || 0;
  const cost = costOfRecord(rec, price);
  agg.cost += cost;
  return cost;
}

function dayKey(d = new Date()) {
  return (
    d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0')
  );
}

function nowLine(now = new Date()) {
  const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()];
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  let bucket = NOW_BUCKETS[0][1];
  for (const [h, name] of NOW_BUCKETS) if (now.getHours() >= h) bucket = name;
  return '（现在是 ' + (now.getMonth() + 1) + '月' + now.getDate() + '日 ' + wd + ' ' + hh + ':' + mm + '，' + bucket + '）';
}

/**
 * 记忆时间的说法：近的用「今天/昨天/前天/N 天前」，远的改用「M月D日」。
 * 按**日历日**算，不按 24 小时算 —— 昨晚 23:50 的事，今天 00:10 问起来是「昨天」不是「今天」。
 * 今天/昨天/前天带上 HH:mm，免得模型把「昨天下午」说成「昨天晚上」。
 */
function memRelDay(iso, now) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '不知道什么时候';
  const startOf = (x) => {
    const d = new Date(x);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const dd = Math.round((startOf(now) - startOf(t)) / 86400000);
  const dt = new Date(t);
  const hm = String(dt.getHours()).padStart(2, '0') + ':' + String(dt.getMinutes()).padStart(2, '0');
  if (dd <= 0) return '今天 ' + hm;
  if (dd === 1) return '昨天 ' + hm;
  if (dd === 2) return '前天 ' + hm;
  if (dd < 7) return dd + ' 天前';
  return dt.getMonth() + 1 + '月' + dt.getDate() + '日';
}

/**
 * 绝对时间说法：`10月26日 21:03`。
 * 只给**画像文件**用 —— 那个文件一天只重算一次，写「昨天」会被冻在文件里：
 * 连着几天没人聊，画像不重渲染，里面的「昨天」就变成一周前了。
 */
function memAbsDay(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '不知道什么时候';
  const d = new Date(t);
  const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  return d.getMonth() + 1 + '月' + d.getDate() + '日 ' + hm;
}

/** 从 ISO 时间戳取出 HH:mm（本地时区）。 */
function hhmmOf(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--:--';
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

/**
 * 记忆里的时间 = **事情发生的时间**（日志那一天 + 模型指认的 HH:mm），不是提炼的时间。
 * 模型没给时刻、或给得不合法 → 落到那天 12:00（日期仍然准确，够算「昨天/前天」）。
 * 这样模型看到的是系统给的时间，不用自己猜。
 */
function memEventAt(day, time, fallback) {
  const tm = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(time ?? '').trim());
  const base = /^\d{4}-\d{2}-\d{2}$/.test(String(day ?? '')) ? String(day) : dayKey(new Date(fallback));
  const hhmm = tm ? String(tm[1]).padStart(2, '0') + ':' + tm[2] : '12:00';
  return base + 'T' + hhmm + ':00'; // 本地时间，故意不带 Z
}

function memSimilar(a, b) {
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const t of a) if (b.has(t)) hit++;
  return hit / Math.min(a.size, b.size);
}

function memberLabel(m) {
  const card = String(m?.card || '').trim();
  const nick = String(m?.nickname || '').trim();
  const name = card || nick || toId(m?.user_id);
  return card && nick && card !== nick ? name + '(' + nick + ')' : name;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 这个错误值不值得重试：网络层错误 / 429 / 5xx 值得；
 * 4xx（参数错、余额不足、key 无效）和超时（AbortError）不值得 —— 重试只会让用户多等。
 */
function isRetriableError(err) {
  if (!err) return false;
  if (err.name === 'AbortError' || err.code === 'ABORT_ERR') return false;
  const status = Number(err.status) || 0;
  if (!status) return true;
  return status === 429 || status >= 500;
}

const SEARCH_HINTS = /(今天|今日|现在|最新|最近|刚刚|刚才|新闻|热搜|天气|气温|下雨|几点|价格|多少钱|汇率|比分|股价|上映|开播|发布|版本|更新|谁赢|发生|怎么了|查一下|搜一下|是不是|有没有)/;

/**
 * 「现在几点」：给模型一个时间锚，免得它算星期、算凌晨全靠猜。
 * 写在尾部（每轮都变），而且跟着这一轮一起进 transcript —— 不打断前缀。
 */
const NOW_BUCKETS = [
  [0, '凌晨'],
  [5, '早上'],
  [8, '上午'],
  [11, '中午'],
  [13, '下午'],
  [17, '傍晚'],
  [19, '晚上'],
  [23, '深夜'],
];

export {
  toId,
  allowed,
  sliceCurrentTopic,
  shouldSearch,
  stripSearchKeyword,
  buildWebContext,
  isCapabilityRefusal,
  tidyReply,
  cleanReplyText,
  sanitizePersonality,
  parseMinutes,
  parseAmount,
  formatDuration,
  moneyText,
  moneyText2,
  clockText,
  isPeakAt,
  costOfRecord,
  emptyUsage,
  addUsage,
  dayKey,
  nowLine,
  memRelDay,
  memAbsDay,
  hhmmOf,
  memEventAt,
  memSimilar,
  memberLabel,
  sleep,
  isRetriableError,
  SEARCH_HINTS,
  NOW_BUCKETS,
};
