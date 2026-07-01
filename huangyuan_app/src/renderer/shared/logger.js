(function () {
  const LEVELS = ['error', 'warn', 'info', 'debug', 'trace'];
  const INDEX = LEVELS.reduce((acc, level, idx) => {
    acc[level] = idx;
    return acc;
  }, {});

  function normalizeLevel(level) {
    if (!level) return 'info';
    const lower = String(level).toLowerCase();
    return INDEX.hasOwnProperty(lower) ? lower : 'info';
  }

  function readStoredLevel() {
    try {
      const stored = localStorage.getItem('app.logLevel');
      return normalizeLevel(stored);
    } catch {
      return 'info';
    }
  }

  function writeStoredLevel(level) {
    try {
      localStorage.setItem('app.logLevel', level);
    } catch {
      // ignore storage issues
    }
  }

  let currentLevel = readStoredLevel();

  function shouldLog(level) {
    return INDEX[level] <= INDEX[currentLevel];
  }

  function coerce(arg) {
    if (arg instanceof Error) {
      return {
        message: arg.message || 'Unknown error',
        stack: arg.stack,
        name: arg.name
      };
    }
    return arg;
  }

  function formatPrefix(scope) {
    const ts = new Date().toISOString();
    return scope ? `${ts} [${scope}]` : ts;
  }

  function create(scope) {
    const prefix = formatPrefix.bind(null, scope);

    function emit(level, ...args) {
      if (!shouldLog(level)) return;
      const fn = console[level] || console.log;
      fn(prefix(), ...args.map(coerce));
    }

    return {
      error: (...args) => emit('error', ...args),
      warn: (...args) => emit('warn', ...args),
      info: (...args) => emit('info', ...args),
      debug: (...args) => emit('debug', ...args),
      trace: (...args) => emit('trace', ...args)
    };
  }

  function setLevel(level) {
    currentLevel = normalizeLevel(level);
    writeStoredLevel(currentLevel);
  }

  function getLevel() {
    return currentLevel;
  }

  window.Logger = {
    create,
    setLevel,
    getLevel
  };
})();
