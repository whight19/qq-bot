/** 运行日志：按天切文件，攒一批再落盘（appendFileSync 是同步的，别一条一条写）。 */
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOG_DIR, SELFTEST } from './paths.mjs';

/** 和 log() 用同一套命名：按本机日期切文件。 */
function logFileName(d) {
  return (
    'bot-' +
    d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0') +
    '.jsonl'
  );
}

/** 当天日志路径（按天缓存，别再每条日志都拼一遍日期）。 */
let logFileCache = { key: '', file: '' };
function logFileFor(d) {
  const key = d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate();
  if (logFileCache.key !== key) logFileCache = { key, file: join(LOG_DIR, logFileName(d)) };
  return logFileCache.file;
}

// 日志是攒着写的：原来每条记录一次 appendFileSync，群消息多时是实打实的同步 I/O。
// 攒到 8KB 或 500ms 就落盘；进程退出、被 Ctrl+C、崩溃前都会先 flush 一次。
const LOG_FLUSH_MS = 500;
const LOG_FLUSH_CHARS = 8192;
let logBuffer = '';
let logBufferFile = '';
let logFlushTimer = null;

let dialogueBuffer = '';
let dialogueBufferFile = '';
let dialogueFlushTimer = null;

function flushLog() {
  if (logFlushTimer) {
    clearTimeout(logFlushTimer);
    logFlushTimer = null;
  }
  if (!logBuffer) return false;
  const text = logBuffer;
  const file = logBufferFile;
  logBuffer = '';
  try {
    appendFileSync(file, text);
    return true;
  } catch {
    /* 日志写失败不影响主流程 */
    return false;
  }
}

function log(record) {
  const now = new Date();
  const line = JSON.stringify({ ts: now.toISOString(), ...record });
  console.log(line);
  if (SELFTEST) return; // 自测不写日志文件，别污染 logs/
  const file = logFileFor(now); // 用同一个 now 算文件名，跨零点不会写错天
  if (logBuffer && logBufferFile !== file) flushLog(); // 跨天前的先落盘
  logBufferFile = file;
  logBuffer += line + '\n';
  if (logBuffer.length >= LOG_FLUSH_CHARS) {
    flushLog();
    return;
  }
  if (!logFlushTimer) {
    logFlushTimer = setTimeout(() => {
      logFlushTimer = null;
      flushLog();
    }, LOG_FLUSH_MS);
    if (typeof logFlushTimer.unref === 'function') logFlushTimer.unref();
  }
}

function dialogueFileName(d) {
  return logFileName(d).replace(/^bot-/, 'dialogue-');
}

function flushDialogueLog() {
  if (dialogueFlushTimer) {
    clearTimeout(dialogueFlushTimer);
    dialogueFlushTimer = null;
  }
  if (!dialogueBuffer) return false;
  const text = dialogueBuffer;
  const file = dialogueBufferFile;
  dialogueBuffer = '';
  try {
    appendFileSync(file, text);
    return true;
  } catch {
    return false;
  }
}

/** 只记录真正调用模型并成功发送的一轮对话，长期记忆优先读这个精简文件。 */
function logDialogue(record) {
  if (SELFTEST) return;
  const now = new Date();
  const file = join(LOG_DIR, dialogueFileName(now));
  const line = JSON.stringify({ ts: now.toISOString(), kind: 'turn', ...record });
  if (dialogueBuffer && dialogueBufferFile !== file) flushDialogueLog();
  dialogueBufferFile = file;
  dialogueBuffer += line + '\n';
  if (dialogueBuffer.length >= LOG_FLUSH_CHARS) {
    flushDialogueLog();
    return;
  }
  if (!dialogueFlushTimer) {
    dialogueFlushTimer = setTimeout(() => {
      dialogueFlushTimer = null;
      flushDialogueLog();
    }, LOG_FLUSH_MS);
    if (typeof dialogueFlushTimer.unref === 'function') dialogueFlushTimer.unref();
  }
}

export { log, flushLog, logFileName, dialogueFileName, logDialogue, flushDialogueLog };
