const LEVELS = ['error', 'warn', 'info', 'debug', 'trace'];
const LEVEL_INDEX = LEVELS.reduce((acc, name, idx) => {
  acc[name] = idx;
  return acc;
}, {});

// 尝试启用文件日志（主进程 / Node 环境有效）
let fs = null;
let path = null;
let logFilePath = null;

try {
  // 在 Electron 主进程 / Node 环境中可用
  // 不在 renderer 中直接 require，避免打包问题
  // eslint-disable-next-line global-require
  fs = require('fs');
  // eslint-disable-next-line global-require
  path = require('path');

  const baseDir = process.env.APP_LOG_DIR || process.cwd();
  try {
    if (!fs.existsSync(baseDir)) {
      fs.mkdirSync(baseDir, { recursive: true });
    }
  } catch (e) {
    // 目录创建失败则放弃文件日志
  }

  logFilePath = process.env.APP_LOG_FILE || (path && path.join(baseDir, 'app.log'));
} catch (e) {
  // 在纯浏览器环境中忽略文件日志
}

function appendToLog(line) {
  if (!fs || !logFilePath) return;
  try {
    fs.appendFileSync(logFilePath, line + '\n', 'utf-8');
  } catch (e) {
    // 写日志失败时静默忽略，避免影响主流程
  }
}

function normalizeLevel(value) {
  if (!value) return 'info';
  const lower = String(value).toLowerCase();
  return LEVEL_INDEX.hasOwnProperty(lower) ? lower : 'info';
}

let globalLevel = normalizeLevel(process.env.APP_LOG_LEVEL || process.env.LOG_LEVEL || 'info');

function formatError(err) {
  if (!err) return {};
  if (typeof err === 'string') return { message: err };

  const safeStringify = (value) => {
    try {
      return JSON.stringify(value);
    } catch (e) {
      return undefined;
    }
  };

  const truncate = (value, maxLen = 2000) => {
    if (value === null || value === undefined) return value;
    const str = typeof value === 'string' ? value : safeStringify(value);
    if (!str) return str;
    return str.length > maxLen ? str.slice(0, maxLen) + '…(truncated)' : str;
  };

  const config = err && err.config;
  const response = err && err.response;
  return {
    message: err.message || 'Unknown error',
    stack: err.stack,
    code: err.code,
    status: err.status || (response && response.status) || undefined,
    method: (config && config.method) || undefined,
    url: (config && config.url) || undefined,
    baseURL: (config && config.baseURL) || undefined,
    responseData: response ? truncate(response.data) : undefined
  };
}

function shouldLog(level) {
  return LEVEL_INDEX[level] <= LEVEL_INDEX[globalLevel];
}

function sanitizeArgs(args) {
  return args.map((arg) => {
    if (arg instanceof Error) return formatError(arg);
    if (arg && typeof arg === 'object' && arg.error instanceof Error) {
      return { ...arg, error: formatError(arg.error) };
    }
    return arg;
  });
}

function createLogger(scope) {
  const label = scope ? `[${scope}]` : '';

  function write(level, ...args) {
    if (!shouldLog(level)) return;
    const ts = new Date().toISOString();
    const payload = sanitizeArgs(args);

    const fn = console[level] || console.log;
    fn(`${ts} ${label}`.trim(), ...payload);

    // 同步写入简单的一行 JSON，方便排查问题
    appendToLog(
      `${ts} ${label}`.trim() + ' ' +
        (payload.length === 1 ? JSON.stringify(payload[0]) : JSON.stringify(payload))
    );
  }

  const api = {
    error: (...args) => write('error', ...args),
    warn: (...args) => write('warn', ...args),
    info: (...args) => write('info', ...args),
    debug: (...args) => write('debug', ...args),
    trace: (...args) => write('trace', ...args),
    child: (childScope) => createLogger(scope ? `${scope}:${childScope}` : childScope)
  };

  return api;
}

function setLogLevel(level) {
  globalLevel = normalizeLevel(level);
}

function getLogLevel() {
  return globalLevel;
}

module.exports = {
  createLogger,
  formatError,
  setLogLevel,
  getLogLevel
};
