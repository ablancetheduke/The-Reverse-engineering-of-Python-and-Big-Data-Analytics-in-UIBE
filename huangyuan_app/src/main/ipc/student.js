// ipcHandlers.js：集中管理所有 ipcMain.handle 相关逻辑
const { createLogger, formatError } = require('../../shared/logger');

module.exports = function setupIpcHandlers(deps) {
  const {
    ipcMain,
    app,
    BrowserWindow,
    dialog,
    shell,
    http,
    BASE_URL,
    BACKUP_BASE_URL,
    HTTP_FALLBACK_URL,
    getUserDataDir,
    tempDir,
    homeworkZipDir,
    studentDir,
    courseRoot,
    writeAtomic,
    spawn,
    execSync,
    extract,
    fs,
    path,
    FormData,
    getMainWindow,
    ensureMachineId,
    getIconPath
  } = deps;

  const ipcLog = createLogger('ipc');
  ipcLog.info('Initializing IPC handlers...');

  const rootBaseUrl = (() => {
    const b = String(BASE_URL || '').replace(/\/+$/, '');
    return b.endsWith('/api') ? b.slice(0, -4) : b;
  })();

  const toAbsoluteUrl = (p) => {
    if (!p) return p;
    if (/^https?:\/\//i.test(p)) return p;
    if (/^https?:\/\//i.test(rootBaseUrl)) {
      return rootBaseUrl + (p.startsWith('/') ? p : `/${p}`);
    }
    return p;
  };

  const withLegacy404Fallback = async (_logger, { apiPath, legacyPath, requestFactory }) => {
    const primaryUrl = toAbsoluteUrl(apiPath);
    try {
      const result = await requestFactory(primaryUrl);
      return { result, resolvedUrl: primaryUrl };
    } catch (error) {
      const status = error && error.response && error.response.status;
      if (status !== 404 || !legacyPath) {
        throw error;
      }

      const fallbackUrl = toAbsoluteUrl(legacyPath);
      const result = await requestFactory(fallbackUrl);
      return { result, resolvedUrl: fallbackUrl };
    }
  };

  let homeworkValidatedPostPath = '/api/getHomeworkValidated';
  let homeworkValidatedListPath = '/api/getHomeworkValidated?client=1';

  const postHomeworkValidated = async (logger, pathOrUrl, formBody, axiosOpts) => {
    return postWithFallback(logger, pathOrUrl, formBody, axiosOpts);
  };

  const scope = (name) => ipcLog.child(name);

  const reportError = (logger, err, extra = {}) => {
    logger.error({ ...extra, error: formatError(err) });
  };

  const normalizeStudentCoursePayload = (raw) => {
    if (!raw) return raw;

    const looksLikeCourses = (obj) =>
      !!(
        obj &&
        typeof obj === 'object' &&
        (obj.current_semester_classes || obj.all_classes || obj.courses)
      );

    // 常见形态：{ success: true, data: { current_semester_classes, all_classes } }
    if (looksLikeCourses(raw)) return raw;
    if (looksLikeCourses(raw.data)) return raw.data;

    // 兼容更深一层：{ data: { data: { ... } } }
    if (looksLikeCourses(raw.data && raw.data.data)) return raw.data.data;

    return raw;
  };

  // ====== 网络重试工具 ======

  /** 判断是否为可重试的网络/TLS 错误 */
  function isRetryableNetworkError(err) {
    if (!err) return false;
    const code = err.code || '';
    // ECONNRESET, ETIMEDOUT, ENOTFOUND, ECONNREFUSED, EPIPE, ERR_NETWORK
    const retryableCodes = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', 'EPIPE', 'ERR_NETWORK', 'ECONNABORTED'];
    if (retryableCodes.includes(code)) return true;
    // TLS 特定错误
    if (/TLS|CERT_|SSL/i.test(code)) return true;
    // 消息中包含典型 TLS/网络关键词
    const msg = (err.message || '').toLowerCase();
    if (/socket disconnected|tls|ssl|econnreset|enotfound|etimedout|econnrefused/i.test(msg)) return true;
    // 没有 response 且没有 status -> 网络层错误（非 HTTP 错误）
    if (!err.response && !err.status && !err.statusCode) return true;
    return false;
  }

  /** 判断是否为 TLS/SSL 层面的错误（需要 HTTP 降级） */
  function isTlsError(err) {
    if (!err) return false;
    const code = (err.code || '').toUpperCase();
    // Node.js TLS 特定错误码
    if (/TLS|CERT_|SSL|ERR_SSL|EPROTO|UNABLE_TO_VERIFY_LEAF_SIGNATURE|DEPTH_ZERO_SELF_SIGNED|SELF_SIGNED_CERT|CERT_HAS_EXPIRED/i.test(code)) return true;
    const msg = (err.message || '').toLowerCase();
    if (/socket disconnected before secure tls connection|tls|ssl|handshake|certificate/i.test(msg)) return true;
    return false;
  }

  /**
   * 带备用域名重试的 POST 请求（三级降级：主域名 → 备用HTTPS → HTTP降级）
   * 优先使用 http 实例的 baseURL（主域名），失败时自动切换到 BACKUP_BASE_URL，
   * 若 TLS 层面失败则进一步降级到 HTTP_FALLBACK_URL（Nginx 80端口 → 301 重定向回 HTTPS）
   */
  async function postWithFallback(logger, endpointPath, formBody, axiosOpts) {
    // 首次请求：使用 http 实例（baseURL 为主域名）
    try {
      return await http.post(endpointPath, formBody, axiosOpts);
    } catch (err) {
      if (!isRetryableNetworkError(err) || !BACKUP_BASE_URL) throw err;
      // 如果 http 实例的 baseURL 已经是备用域名，就不再重试
      if (http.defaults.baseURL && http.defaults.baseURL === BACKUP_BASE_URL) throw err;
      // 如果 http 使用的是 localhost，也不重试
      if (http.defaults.baseURL && http.defaults.baseURL.includes('127.0.0.1')) throw err;

      logger.warn('primary request failed, retrying with backup URL', {
        primary: http.defaults.baseURL,
        backup: BACKUP_BASE_URL,
        error: err.code || err.message
      });

      // 用完整 URL 重试（axios 遇到绝对 URL 会忽略 baseURL）
      const backupUrl = BACKUP_BASE_URL.replace(/\/+$/, '') + endpointPath;
      try {
        return await http.post(backupUrl, formBody, axiosOpts);
      } catch (backupErr) {
        // 如果备用 HTTPS 也失败且是 TLS 错误，尝试 HTTP 降级
        if (HTTP_FALLBACK_URL && isTlsError(backupErr)) {
          logger.warn('backup HTTPS also failed with TLS error, falling back to HTTP', {
            backup: BACKUP_BASE_URL,
            httpFallback: HTTP_FALLBACK_URL,
            error: backupErr.code || backupErr.message
          });
          const httpUrl = HTTP_FALLBACK_URL.replace(/\/+$/, '') + endpointPath;
          // 允许跟随 301 重定向：HTTP 80 端口 → Nginx 301 → 重新 TLS 握手到 443
          return await http.post(httpUrl, formBody, axiosOpts);
        }
        throw backupErr;
      }
    }
  }

  // ====== 全局网络重试拦截器 ======
  // 三级降级：主域名 → 备用HTTPS → HTTP（Nginx 80端口 → 301重定向回HTTPS）
  http.interceptors.response.use(
    response => response,
    async error => {
      if (!error.config || error.config.__retryWithBackup) {
        // 已经重试过备用域名，如果是 TLS 错误且还有 HTTP 降级可用，再试一次
        if (
          error.config &&
          error.config.__retryWithBackup &&
          !error.config.__retryWithHttp &&
          HTTP_FALLBACK_URL &&
          isTlsError(error)
        ) {
          error.config.__retryWithHttp = true;
          const originalUrl = error.config.url || '';
          const prevBase = error.config.__retryBackupUrl || BACKUP_BASE_URL;
          // 只有当上一次重试用的是 HTTPS 时才降级到 HTTP（避免 HTTP → HTTP 死循环）
          if (prevBase.startsWith('https://') || prevBase.startsWith('https:')) {
            // 从 originalUrl 中提取路径部分，拼到 HTTP fallback host 上
            const pathPart = originalUrl.replace(/^https?:\/\/[^\/]+/, '');
            const httpFallbackUrl = HTTP_FALLBACK_URL.replace(/\/+$/, '') + (pathPart.startsWith('/') ? pathPart : `/${pathPart}`);
            error.config.url = httpFallbackUrl;
            error.config.baseURL = undefined;
            // 允许跟随 301 重定向：HTTP 80 端口 → Nginx 301 → 重新 TLS 握手到 443

            ipcLog.warn('backup HTTPS also failed with TLS error, falling back to HTTP', {
              previousUrl: originalUrl,
              httpFallback: httpFallbackUrl,
              error: error.code || error.message
            });

            return http(error.config);
          }
        }
        return Promise.reject(error);
      }
      if (
        isRetryableNetworkError(error) &&
        BACKUP_BASE_URL &&
        http.defaults.baseURL &&
        !http.defaults.baseURL.includes('127.0.0.1') &&
        http.defaults.baseURL !== BACKUP_BASE_URL
      ) {
        error.config.__retryWithBackup = true;
        const originalUrl = error.config.url || '';
        const backupUrl = originalUrl.startsWith('http')
          ? originalUrl.replace(/^https?:\/\/[^\/]+/, BACKUP_BASE_URL.replace(/\/+$/, ''))
          : BACKUP_BASE_URL.replace(/\/+$/, '') + (originalUrl.startsWith('/') ? originalUrl : `/${originalUrl}`);
        error.config.url = backupUrl;
        error.config.baseURL = undefined;
        error.config.__retryBackupUrl = BACKUP_BASE_URL;

        ipcLog.warn('network error, retrying with backup URL', {
          original: originalUrl,
          backup: backupUrl,
          error: error.code || error.message
        });

        return http(error.config);
      }
      return Promise.reject(error);
    }
  );

  // ====== IPC API ======

  ipcMain.handle('device:getMachineId', async () => ensureMachineId());

  ipcMain.handle('cache:read', async (_e, { studentId, key }) => {
    const file = path.join(studentDir(studentId), key);
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf-8');
    return null;
  });

  ipcMain.handle('cache:write', async (_e, { studentId, key, content }) => {
    const dir = studentDir(studentId);
    const file = path.join(dir, key);
    writeAtomic(file, content);
    return true;
  });

  // 验证学生 + 获取课程
  const authLog = scope('auth:validate');
  ipcMain.handle('auth:validate', async (_e, { studentId }) => {
    const machine_id = ensureMachineId();
    const endpointPath = '/api/validateStudentMachine';
    authLog.info('start', { studentId, machine_id });
    try {
      const form = new URLSearchParams();
      form.append('student_id', studentId);
      form.append('machine_id', machine_id);

      const res = await postWithFallback(authLog, endpointPath, form.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });
      const raw = res.data;
      if (!raw || raw.success === false) {
        throw new Error((raw && (raw.message || raw.msg)) || '验证失败');
      }
      const data = normalizeStudentCoursePayload(raw);
      authLog.info('success', {
        studentId,
        hasCourses:
          !!(
            data &&
            (data.current_semester_classes || data.all_classes || data.courses)
          )
      });
      const sdir = studentDir(studentId);
      writeAtomic(
        path.join(sdir, 'user.json'),
        JSON.stringify(
          { student_id: studentId, machine_id, ts: Date.now() },
          null,
          2
        )
      );

      // 保存最后一次登录的学号
      try {
        const lastUserFile = path.join(getUserDataDir(), 'last_user.json');
        writeAtomic(lastUserFile, JSON.stringify({ studentId }));
      } catch (e) {
        reportError(authLog, e, { action: 'saveLastStudentId' });
      }

      // 统一缓存为“课程载荷”，避免前端还要处理 { success, data: ... } 外壳
      writeAtomic(path.join(sdir, 'courses.json'), JSON.stringify(data, null, 2));
      courseRoot(studentId);
      return { ok: true, data };
    } catch (err) {
      const status = err && err.response && err.response.status;
      const respData = err && err.response && err.response.data;

      let msg = (err && err.message) || '网络异常';

      const isProbablyHtml =
        typeof respData === 'string' && /<!doctype\s+html|<html[\s>]/i.test(respData);

      // 优先处理网关/服务端错误（常见于需要内网/VPN，或后端服务异常）
      if (status && status >= 500) {
        msg = `后端接口暂时不可用（HTTP ${status}）。当前请求：${BASE_URL}${endpointPath}。请检查网络环境（是否需校园网/VPN）以及后端服务是否已启动。`;
      } else if (isProbablyHtml) {
        const statusPart = status ? `HTTP ${status}` : 'HTTP 错误';
        msg = `后端接口返回了网页内容（HTML），无法完成登录验证：${statusPart}。当前请求：${BASE_URL}${endpointPath}。请检查 API_BASE_URL/反向代理是否配置正确。`;
      } else if (respData) {
        if (typeof respData === 'string') {
          msg = respData;
        } else if (respData.message || respData.msg) {
          msg = respData.message || respData.msg;
        }
      }

      reportError(authLog, err, { studentId, status, message: msg });
      return { ok: false, error: msg, status };
    }
  });

  // 期末大作业上传（CSV / 文档 / 代码）
  const finalUploadLog = scope('final:upload');
  ipcMain.handle('final:upload', async (_e, payload) => {
    const { studentId, className, uiType, name, data } = payload || {};
    try {
      finalUploadLog.info('start', {
        studentId,
        className,
        uiType,
        name,
        hasData: data !== undefined
      });

      if (!studentId) {
        return { ok: false, success: false, msg: '缺少学号' };
      }

      const typeMap = {
        result: 'result_file',
        home: 'homepage_file',
        body: 'report_file',
        code: 'code_archive'
      };
      const form = new FormData();
      form.append('student_id', studentId);
      if (className) {
        form.append('class_name', className);
      }
      form.append('file_type', typeMap[uiType] || uiType || 'attachment');
      form.append('file', Buffer.from(data || []), {
        filename: name || 'upload.bin'
      });

      const uploadUrl = BASE_URL + '/api/uploadFinaltest';
      finalUploadLog.debug('resolved upload url', { uploadUrl });

      const res = await http.post(uploadUrl, form, {
        headers: form.getHeaders(),
        maxContentLength: Infinity,
        maxBodyLength: Infinity
      });

      const body = res.data || {};
      const source = body && typeof body.data === 'object' ? body.data : body;
      finalUploadLog.info('response', { success: body.success !== false, msg: body.msg });

      return {
        ok: body.success !== false,
        success: body.success !== false,
        msg: body.msg || body.message || '',
        auc: source.auc,
        server_verified_auc: source.server_verified_auc,
        verify_reason: source.verify_reason,
        // 提交次数信息(后端在 source 和 body 顶层都可能冗余,都尝试取)
        submit_count: (source && source.submit_count) ?? (body && body.submit_count) ?? null,
        max_submissions: (source && source.max_submissions) ?? (body && body.max_submissions) ?? null,
        remaining: (source && source.remaining) ?? (body && body.remaining) ?? null,
        filename: source.filename,
        file_type: source.file_type,
        start_time: source.start_time,
        end_time: source.end_time
      };
    } catch (err) {
      // 优先提取后端返回的详细错误信息(如 CSV 格式校验失败原因)
      let detail = '';
      if (err && err.response && err.response.data) {
        detail = err.response.data.detail || err.response.data.msg || err.response.data.message || err.response.data.error || '';
      }
      const status = err && err.response && err.response.status;
      const fallbackMsg = (err && err.message) || '上传失败';
      const msg = detail || fallbackMsg;
      reportError(finalUploadLog, err, { status, msg, studentId, className });
      return {
        ok: false,
        success: false,
        msg: status ? `${msg}` : msg
      };
    }
  });

  // 获取平时作业列表
  const homeworkListLog = scope('homework:list');
  ipcMain.handle('homework:list', async (_e, { studentId, className }) => {
    try {
      homeworkListLog.info('request', { studentId, className });

      const form = new URLSearchParams();
      form.append('student_id', studentId);

      if (className) {
        form.append('class_name', className);
      }

      const res = await postHomeworkValidated(
        homeworkListLog,
        homeworkValidatedListPath,
        form.toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );

      const body = res && res.data;
      const summary =
        body && typeof body === 'object'
          ? {
            success: body.success,
            msg: body.msg || body.message,
            count: Array.isArray(body.data) ? body.data.length : undefined
          }
          : { type: typeof body };

      homeworkListLog.info('response', {
        status: res.status,
        ...summary
      });

      return body;
    } catch (e) {
      reportError(homeworkListLog, e, { studentId, className });
      return { success: false, msg: e.message || '获取作业失败' };
    }
  });

  // 获取期末大作业 Markdown
  const finalMdLog = scope('final:md');
  ipcMain.handle('final:md', async (e, { className, studentId } = {}) => {
    try {
      let cls = className;
      if (!cls) {
        try {
          const urlStr =
            (e && e.senderFrame && e.senderFrame.url) ||
            (e && e.sender && e.sender.getURL && e.sender.getURL());
          if (urlStr) {
            const u = new URL(urlStr);
            cls = u.searchParams.get('class_name') || undefined;
          }
        } catch (err) {
          // ignore
        }
      }

      const params = { client: 1 };
      if (cls) params.class_name = cls;
      if (studentId) params.student_id = studentId;

      finalMdLog.info('request', { params });

      const res = await http.get('/api/finaltestmd', { params });
      finalMdLog.info('response', {
        status: res.status,
        hasBody: !!res.data
      });

      let markdown = '';
      let start_time = null;
      let end_time = null;
      let final_auc = null;
      let submit_count = 0;
      let max_submissions = 3;
      let final_assignment_start = null;
      let final_assignment_end = null;
      let html = '';

      let body = res.data;

      if (typeof body === 'string') {
        if (body.trim().startsWith('{')) {
          try {
            const parsed = JSON.parse(body);
            if (typeof parsed === 'object' && parsed) {
              body = parsed;
            } else {
              markdown = body;
            }
          } catch (e) {
            markdown = body;
          }
        } else {
          markdown = body;
        }
      }

      if (typeof body === 'object' && body !== null) {
        const source =
          body.data &&
            typeof body.data === 'object' &&
            !body.markdown &&
            !body.markdown_content
            ? body.data
            : body;

        if (!markdown) {
          markdown =
            source.markdown_content || source.markdown || source.content || '';
        }

        // 读取 html 字段（后端可能返回清洗后的 html）
        if (!html) {
          html = source.html || '';
        }

        start_time =
          source.final_exam_time ||
          source.start_time ||
          source.startTime ||
          source.begin_time;
        end_time =
          source.end_time || source.endTime || source.deadline;

        // 关键(2026-06-13):后端在 finaltestmd 里也开始返回这几个字段了,
        // 否则前端 topbar 会一直显示"剩 3 次"(默认 fallback 0/3)
        final_auc = source.final_auc;
        if (source.submit_count !== undefined) submit_count = source.submit_count;
        if (source.max_submissions !== undefined)
          max_submissions = source.max_submissions;
        if (source.remaining !== undefined && source.max_submissions !== undefined) {
          // 优先用后端算好的 remaining(保证前后端口径一致)
          max_submissions = source.max_submissions;
        }

        // 期末大作业时间窗口
        final_assignment_start = source.final_assignment_start || null;
        final_assignment_end = source.final_assignment_end || null;

        // 剩余次数 = max - count(后端已经算过了,这里再算一次保险)
        const _max = Number.isFinite(parseInt(max_submissions)) ? parseInt(max_submissions) : 3;
        const _count = Number.isFinite(parseInt(submit_count)) ? parseInt(submit_count) : 0;
        const remaining = Math.max(0, _max - _count);
        // 写到 result,顺手也塞进 source 让前端只读 result 也能拿到
        source.remaining = remaining;
        source.max_submissions = _max;
        source.submit_count = _count;
      }

      const result = {
        ok: true,
        markdown,
        html,
        start_time,
        end_time,
        final_auc,
        submit_count,
        max_submissions,
        remaining,
        final_assignment_start,
        final_assignment_end
      };
      finalMdLog.info('parsed', {
        markdownLength: markdown ? String(markdown).length : 0,
        start_time,
        end_time,
        final_auc,
        submit_count,
        max_submissions,
        final_assignment_start,
        final_assignment_end
      });
      return result;
    } catch (error) {
      const msg =
        (error &&
          error.response &&
          error.response.data &&
          error.response.data.msg) ||
        (error && error.message) ||
        '获取失败';
      reportError(finalMdLog, error, { className, studentId, message: msg });
      return { ok: false, error: msg };
    }
  });

  // 期末大作业提交状态
  const finalStatusLog = scope('final:getStatus');
  ipcMain.handle('final:getStatus', async (_e, { studentId, className }) => {
    try {
      finalStatusLog.info('request', { studentId, className });
      const form = new URLSearchParams();
      form.append('student_id', studentId);
      if (className) form.append('class_name', className);
      const res = await http.post('/api/getFinaltestStatus', form.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });
      const raw = res.data || {};

      finalStatusLog.info('response', {
        status: res.status,
        keys: Object.keys(raw || {}).length
      });

      function pick(obj, keys) {
        for (const k of keys) {
          if (obj[k]) return obj[k];
        }
        return '';
      }

      const items = {
        result: {
          submit: pick(raw, ['result_file', 'resultSubmitTime', 'result_submitted_at']),
          start: pick(raw, ['result_start_time', 'resultStartTime', 'result_begin_time']),
          end: pick(raw, ['result_end_time', 'resultEndTime', 'result_deadline']),
          auc: pick(raw, ['auc', 'result_auc']),
          // 新增:提交次数信息(后端在 items.final 和顶层都冗余了,这里都尝试取)
          submit_count: (raw && (raw.submit_count ?? raw.items?.final?.submit_count)) ?? null,
          max_submissions: (raw && (raw.max_submissions ?? raw.items?.final?.max_submissions)) ?? null,
          remaining: (raw && (raw.remaining ?? raw.items?.final?.remaining)) ?? null,
          server_auc: (raw && (raw.server_auc ?? raw.items?.final?.server_auc)) ?? null
        },
        home: {
          submit: pick(raw, ['homepage_file', 'homeSubmitTime', 'homepage_submitted_at']),
          start: pick(raw, ['home_start_time', 'homeStartTime', 'homepage_start_time']),
          end: pick(raw, ['home_end_time', 'homeEndTime', 'homepage_deadline'])
        },
        body: {
          submit: pick(raw, ['report_file', 'reportSubmitTime', 'report_submitted_at']),
          start: pick(raw, ['body_start_time', 'report_start_time', 'bodyStartTime']),
          end: pick(raw, ['body_end_time', 'report_end_time', 'bodyEndTime'])
        },
        code: {
          submit: pick(raw, ['code_archive', 'codeSubmitTime', 'code_submitted_at']),
          start: pick(raw, ['code_start_time', 'codeStartTime', 'code_begin_time']),
          end: pick(raw, ['code_end_time', 'codeEndTime', 'code_deadline'])
        }
      };

      finalStatusLog.info('parsed', {
        hasResult: !!items.result.submit || !!items.result.auc,
        hasHome: !!items.home.submit,
        hasBody: !!items.body.submit,
        hasCode: !!items.code.submit
      });
      return { ok: true, items, raw };
    } catch (e) {
      reportError(finalStatusLog, e, { studentId, className });
      return { ok: false, error: e.message || '获取状态失败' };
    }
  });

  // 1.X 期末大作业 final_auc 班级排名(前后 window 名)
  ipcMain.handle('final:getRanking', async (_e, { studentId, className, window }) => {
    const finalRankLog = createLogger('ipc:final:ranking');
    try {
      if (!studentId) return { ok: false, error: '缺少学号' };
      if (!className) return { ok: false, error: '缺少班级名称' };
      const w = Number.isFinite(window) ? Math.max(0, Math.min(20, window | 0)) : 3;
      const res = await http.get('/api/getFinaltestRanking', {
        params: { student_id: studentId, class_name: className, window: w }
      });
      return res.data || { ok: false, error: '无响应' };
    } catch (e) {
      // 优先提取后端返回的详细错误信息
      let detail = '';
      if (e && e.response && e.response.data) {
        detail = e.response.data.detail || e.response.data.msg || e.response.data.message || e.response.data.error || '';
      }
      reportError(finalRankLog, e, { studentId, className, window });
      return { ok: false, error: detail || e.message || '获取排名失败' };
    }
  });

  // 1. 解压作业压缩包（主+副本）
  ipcMain.handle('homework:unzipFile', async (_e, { zipPath, targetDir }) => {
    try {
      const baseTemp = getUserDataDir();
      if (!targetDir.startsWith(baseTemp)) {
        throw new Error('Path not allowed');
      }

      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      await extract(zipPath, { dir: targetDir });

      return { ok: true, targetDir };
    } catch (e) {
      if (process.platform === 'win32') {
        try {
          const baseTemp = getUserDataDir();
          if (!targetDir.startsWith(baseTemp)) {
            throw new Error('Path not allowed');
          }

          fs.mkdirSync(targetDir, { recursive: true });

          const ps = `Expand-Archive -LiteralPath ${JSON.stringify(
            zipPath
          )} -DestinationPath ${JSON.stringify(targetDir)} -Force`;
          execSync(
            `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command ${ps}`,
            { stdio: 'ignore' }
          );

          return { ok: true, targetDir, fallback: 'powershell' };
        } catch (e2) {
          return { ok: false, error: e2.message || e.message || '解压失败' };
        }
      }
      return { ok: false, error: e.message || '解压失败' };
    }
  });

  // 1.5 备份已修改的文件（解压前调用）
  ipcMain.handle('homework:backupModified', async (_e, { extractedDir }) => {
    try {
      if (!extractedDir || !fs.existsSync(extractedDir)) return { ok: true, backedUp: 0 };

      const backupDir = extractedDir + '_modified';
      // 获取最近一次 ZIP 的时间戳作为基准
      const zipDir = path.join(getUserDataDir(), 'homework_zips');
      let zipMtimeMs = 0;
      if (fs.existsSync(zipDir)) {
        const findZipMtime = (dir) => {
          try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
              const full = path.join(dir, entry.name);
              if (entry.isDirectory()) findZipMtime(full);
              else if (entry.name.endsWith('.zip')) {
                const st = fs.statSync(full);
                if (st.mtimeMs > zipMtimeMs) zipMtimeMs = st.mtimeMs;
              }
            }
          } catch {}
        };
        findZipMtime(zipDir);
      }

      let backedUp = 0;
      const walkAndBackup = (srcDir, relDir) => {
        const entries = fs.readdirSync(srcDir, { withFileTypes: true });
        for (const entry of entries) {
          const srcPath = path.join(srcDir, entry.name);
          const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            walkAndBackup(srcPath, relPath);
          } else {
            const st = fs.statSync(srcPath);
            // 文件修改时间晚于 ZIP（或没有 ZIP 基准则备份所有非 autosave 文件）
            const isModified = zipMtimeMs > 0
              ? st.mtimeMs > zipMtimeMs
              : !entry.name.includes('_autosave');
            if (isModified) {
              const destPath = path.join(backupDir, relPath);
              fs.mkdirSync(path.dirname(destPath), { recursive: true });
              fs.copyFileSync(srcPath, destPath);
              backedUp++;
            }
          }
        }
      };
      walkAndBackup(extractedDir, '');

      return { ok: true, backedUp };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // 1.6 恢复已备份的文件（解压后调用）
  ipcMain.handle('homework:restoreModified', async (_e, { extractedDir }) => {
    try {
      const backupDir = extractedDir + '_modified';
      if (!backupDir.startsWith(getUserDataDir())) {
        throw new Error('Path not allowed');
      }
      if (!fs.existsSync(backupDir)) return { ok: true, restored: 0 };

      let restored = 0;
      const walkAndRestore = (srcDir, targetBase) => {
        const entries = fs.readdirSync(srcDir, { withFileTypes: true });
        for (const entry of entries) {
          const srcPath = path.join(srcDir, entry.name);
          const destPath = path.join(targetBase, entry.name);
          if (entry.isDirectory()) {
            fs.mkdirSync(destPath, { recursive: true });
            walkAndRestore(srcPath, destPath);
          } else {
            fs.mkdirSync(path.dirname(destPath), { recursive: true });
            fs.copyFileSync(srcPath, destPath);
            restored++;
          }
        }
      };
      walkAndRestore(backupDir, extractedDir);

      // 清理备份目录
      fs.rmSync(backupDir, { recursive: true, force: true });

      return { ok: true, restored };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // 2. 列目录
  ipcMain.handle('fs:listFiles', async (_e, { dirPath }) => {
    try {
      if (!fs.existsSync(dirPath)) {
        return { ok: false, error: '目录不存在' };
      }

      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      const files = entries.map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        path: path.join(dirPath, entry.name)
      }));

      return { ok: true, files };
    } catch (e) {
      return { ok: false, error: e.message || '读取目录失败' };
    }
  });

  // 3. 写文件
  ipcMain.handle('fs:writeFile', async (_e, { file, content, encoding }) => {
    try {
      if (!file.startsWith(getUserDataDir())) {
        throw new Error('Path not allowed');
      }
      const dir = path.dirname(file);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      // 如果 encoding 是 'base64'，则先将 Base64 解码为 Buffer
      if (encoding === 'base64') {
        const buffer = Buffer.from(content, 'base64');
        fs.writeFileSync(file, buffer);
      } else {
        fs.writeFileSync(file, content, encoding || 'utf-8');
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message || '写入文件失败' };
    }
  });

  // 4. 获取作业解压目录
  ipcMain.handle('homework:getExtractedDir', async (_e, { studentId, className }) => {
    const dir = path.join(
      getUserDataDir(),
      'extracted_homeworks',
      studentId,
      className
    );
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  });



  // 6. 递归统计文件数
  ipcMain.handle('fs:countFiles', async (_e, { dirPath }) => {
    try {
      function countRec(p) {
        if (!fs.existsSync(p)) return 0;
        const ents = fs.readdirSync(p, { withFileTypes: true });
        let n = 0;
        for (const ent of ents) {
          const fp = path.join(p, ent.name);
          if (ent.isDirectory()) n += countRec(fp);
          else if (ent.isFile()) n += 1;
        }
        return n;
      }
      const count = countRec(dirPath);
      return { ok: true, count };
    } catch (e) {
      return { ok: false, error: e.message || '统计失败' };
    }
  });

  // 6b. 在目录中递归查找文件
  ipcMain.handle('fs:findFileInDir', async (_e, { dirPath, fileName }) => {
    try {
      if (!fs.existsSync(dirPath)) {
        return { ok: false, error: '目录不存在', path: null };
      }

      function searchRec(dir) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            const found = searchRec(fullPath);
            if (found) return found;
          } else if (entry.isFile() && entry.name === fileName) {
            return fullPath;
          }
        }
        return null;
      }

      const foundPath = searchRec(dirPath);
      return { ok: true, path: foundPath };
    } catch (e) {
      return { ok: false, error: e.message || '查找文件失败', path: null };
    }
  });



  // 下载单个作业附件
  ipcMain.handle(
    'homework:downloadFile',
    async (_e, { studentId, className, assignmentId, url, targetRel }) => {
      try {
        if (!studentId || !className || !assignmentId || !url || !targetRel) {
          throw new Error('参数不完整');
        }
        const assignDir = path.join(
          courseRoot(studentId),
          className,
          'homeworks',
          assignmentId
        );
        const target = path.join(assignDir, targetRel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const writer = fs.createWriteStream(target);
        const response = await http.get(url, { responseType: 'stream' });
        await new Promise((resolve, reject) => {
          response.data.pipe(writer);
          writer.on('finish', resolve);
          writer.on('error', reject);
        });
        return { ok: true, file: target };
      } catch (e) {
        return { ok: false, error: e.message || '下载失败' };
      }
    }
  );

  // 同步文件列表到服务端（用于服务器记录学生本地文件）
  const syncFileListLog = scope('homework:syncFileList');
  ipcMain.handle('homework:syncFileList', async (_e, { studentId, className, fileList }) => {
    try {
      syncFileListLog.info('start', { studentId, className, fileCount: fileList?.length || 0 });

      if (!studentId || !className) {
        syncFileListLog.warn('missing studentId or className');
        return { ok: false, error: '缺少学号或班级名称' };
      }

      // 调用后端API同步文件列表
      const formData = new FormData();
      formData.append('student_id', studentId);
      formData.append('class_name', className);
      formData.append('file_list', JSON.stringify(fileList || []));

      const response = await http.post('/api/syncFileList', formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });

      const data = response.data || {};
      syncFileListLog.info('success', {
        success: data.success !== false,
        message: data.message
      });

      return {
        ok: data.success !== false,
        success: data.success !== false,
        message: data.message || '同步完成'
      };
    } catch (e) {
      syncFileListLog.error('error', { error: e.message });
      // 非关键功能，失败不阻塞主流程
      return { ok: true, warning: e.message || '同步失败但不影响使用' };
    }
  });

  // 用系统默认应用打开文件
  ipcMain.handle('sys:openPath', async (_e, filePath) => {
    try {
      const res = await shell.openPath(filePath);
      if (res === '') return { ok: true };
      return { ok: false, error: res || '打开失败' };
    } catch (e) {
      return { ok: false, error: e.message || '打开失败' };
    }
  });

  // 平时作业压缩包下载（按学生+班级，自动保存到临时目录）
  const downloadZipLog = scope('homework:downloadZip');
  ipcMain.handle('homework:downloadZip', async (_e, { studentId, className }) => {
    try {
      downloadZipLog.info('start', { studentId, className });
      const form = new URLSearchParams();
      form.append('student_id', studentId);
      form.append('class_name', className);

      const res = await postHomeworkValidated(
        downloadZipLog,
        homeworkValidatedPostPath,
        form.toString(),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          responseType: 'arraybuffer'
        }
      );

      downloadZipLog.info('response', {
        status: res.status,
        contentLength:
          (res.headers && (res.headers['content-length'] || res.headers['Content-Length'])) ||
          undefined
      });

      const dispo =
        res.headers['content-disposition'] ||
        res.headers['Content-Disposition'] ||
        '';
      let filename = 'homeworks.zip';
      const m =
        dispo.match(/filename\*?=(?:UTF-8''|")?(.*?)(?:;|$|")/i) ||
        dispo.match(/filename=([^;]+)/i);
      if (m && m[1]) {
        try {
          filename = decodeURIComponent(m[1].replace(/"/g, ''));
        } catch (e) {
          filename = m[1].replace(/"/g, '');
        }
      }

      const dir = homeworkZipDir(studentId, className);
      fs.mkdirSync(dir, { recursive: true });
      const target = path.join(dir, filename);
      fs.writeFileSync(target, Buffer.from(res.data));

      const size = Buffer.byteLength(res.data);
      downloadZipLog.info('success', { target, size });
      return { ok: true, file: target, size };
    } catch (e) {
      reportError(downloadZipLog, e, { studentId, className });
      return { ok: false, error: e.message || '下载作业包失败' };
    }
  });

  function isPythonCourseClass(className) {
    return /python/i.test(String(className || ''));
  }

  function pickRandomItems(items, count) {
    const pool = [...items];
    for (let i = pool.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, count);
  }

  function buildMockMidtermSelection(sourceDir) {
    const entries = fs.readdirSync(sourceDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^hwc\d{3}\.py$/i.test(entry.name))
      .map((entry) => entry.name);

    const rules = [
      { label: 'hwc1xx', regex: /^hwc1\d{2}\.py$/i, count: 2 },
      { label: 'hwc2xx', regex: /^hwc2\d{2}\.py$/i, count: 2 },
      { label: 'hwc3xx', regex: /^hwc3\d{2}\.py$/i, count: 2 },
      { label: 'hwc4xx', regex: /^hwc4\d{2}\.py$/i, count: 1 },
      { label: 'hwc5xx', regex: /^hwc5\d{2}\.py$/i, count: 1 }
    ];

    const selected = [];
    for (const rule of rules) {
      const matched = entries.filter((name) => rule.regex.test(name));
      if (matched.length < rule.count) {
        throw new Error(`题库不足，${rule.label} 仅有 ${matched.length} 道题，无法抽取 ${rule.count} 道`);
      }
      selected.push(...pickRandomItems(matched, rule.count));
    }

    return selected.map((name) => path.join(sourceDir, name));
  }

  function createZipByPython(specPath) {
    const { execFileSync } = require('child_process');
    const scriptContent = [
      'import json',
      'import pathlib',
      'import zipfile',
      'import sys',
      '',
      'spec = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))',
      'output = pathlib.Path(spec["output"])',
      'output.parent.mkdir(parents=True, exist_ok=True)',
      'root = pathlib.Path(spec.get("root", "midterm_mock_exam"))',
      'files = [pathlib.Path(item) for item in spec["files"]]',
      'with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as zf:',
      '    for file_path in files:',
      '        zf.write(file_path, arcname=str(root / file_path.name))',
      '    manifest = "\\n".join(file_path.name for file_path in files) + "\\n"',
      '    zf.writestr(str(root / "README.txt"), manifest.encode("utf-8"))',
      'print(output)'
    ].join('\n');

    const scriptFile = path.join(tempDir(), `mock_zip_${Date.now()}.py`);
    fs.writeFileSync(scriptFile, scriptContent, 'utf-8');
    try {
      execFileSync('python', [scriptFile, specPath], { stdio: 'pipe', timeout: 30000 });
    } finally {
      try { fs.unlinkSync(scriptFile); } catch (_) { /* ignore cleanup error */ }
    }
  }

  function resolveMockMidtermSourceDir() {
    const relativeParts = [
      'uploads',
      'course_materials',
      'CMP245-Python与大数据分析',
      'homeworks'
    ];
    const rootsToSearch = [];

    const pushRoot = (root) => {
      if (!root) return;
      const resolved = path.resolve(root);
      if (!rootsToSearch.includes(resolved)) {
        rootsToSearch.push(resolved);
      }
    };

    pushRoot(__dirname);
    pushRoot(process.cwd());

    try {
      if (typeof app.getAppPath === 'function') {
        pushRoot(app.getAppPath());
      }
    } catch (_e) { }

    const tried = [];
    for (const root of rootsToSearch) {
      let current = root;
      let previous = '';

      while (current && current !== previous) {
        const candidate = path.join(current, ...relativeParts);
        tried.push(candidate);
        if (fs.existsSync(candidate)) {
          return candidate;
        }
        previous = current;
        current = path.dirname(current);
      }
    }

    throw new Error('本地题库目录不存在');
  }

  async function saveMockMidtermZipByLocalFallback(studentId, className) {
    const sourceDir = resolveMockMidtermSourceDir();
    const selectedFiles = buildMockMidtermSelection(sourceDir);
    const defaultName = `${studentId || 'student'}_期中模拟考试.zip`;
    const win = BrowserWindow.getFocusedWindow() || getMainWindow();
    const { filePath, canceled } = await dialog.showSaveDialog(win, {
      title: '保存期中模拟考试题包',
      defaultPath: path.join(app.getPath('downloads'), defaultName),
      filters: [
        { name: 'ZIP Files', extensions: ['zip'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });

    if (canceled || !filePath) {
      return { ok: false, error: '用户取消保存' };
    }

    const specPath = path.join(tempDir(), `midterm_mock_${Date.now()}.json`);
    fs.writeFileSync(specPath, JSON.stringify({
      output: filePath,
      files: selectedFiles,
      root: '期中模拟考试'
    }, null, 2), 'utf-8');

    try {
      createZipByPython(specPath);
    } finally {
      try { fs.unlinkSync(specPath); } catch (_) { }
    }

    return {
      ok: true,
      file: filePath,
      filename: path.basename(filePath),
      selected: selectedFiles.map((item) => path.basename(item)),
      fallback: 'local'
    };
  }

  const mockMidtermZipLog = scope('homework:downloadMockMidtermZip');
  ipcMain.handle('homework:downloadMockMidtermZip', async (_e, { studentId, className }) => {
    try {
      mockMidtermZipLog.info('start', { studentId, className });

      if (!isPythonCourseClass(className)) {
        return { ok: false, error: '仅 Python 课程支持生成期中模拟考试题包' };
      }

      const requestParams = {
        student_id: studentId,
        class_name: className
      };
      try {
        const { result: res, resolvedUrl } = await withLegacy404Fallback(
          mockMidtermZipLog,
          {
            apiPath: '/api/downloadMockMidtermZip',
            legacyPath: '/downloadMockMidtermZip',
            requestFactory: async (targetUrl) => http.get(targetUrl, {
              params: requestParams,
              responseType: 'arraybuffer'
            })
          }
        );

        const dispo =
          res.headers['content-disposition'] ||
          res.headers['Content-Disposition'] ||
          '';
        let filename = `${studentId || 'student'}_期中模拟考试.zip`;
        const m =
          dispo.match(/filename\*?=(?:UTF-8''|")?(.*?)(?:;|$|")/i) ||
          dispo.match(/filename=([^;]+)/i);
        if (m && m[1]) {
          try {
            filename = decodeURIComponent(m[1].replace(/"/g, ''));
          } catch (_e) {
            filename = m[1].replace(/"/g, '');
          }
        }

        const win = BrowserWindow.getFocusedWindow() || getMainWindow();
        const { filePath, canceled } = await dialog.showSaveDialog(win, {
          title: '保存期中模拟考试题包',
          defaultPath: path.join(app.getPath('downloads'), filename),
          filters: [
            { name: 'ZIP Files', extensions: ['zip'] },
            { name: 'All Files', extensions: ['*'] }
          ]
        });

        if (canceled || !filePath) {
          mockMidtermZipLog.info('canceled', { studentId, className });
          return { ok: false, error: '用户取消保存' };
        }

        fs.writeFileSync(filePath, Buffer.from(res.data));

        mockMidtermZipLog.info('success', {
          file: filePath,
          size: Buffer.byteLength(res.data),
          url: resolvedUrl
        });
        return {
          ok: true,
          file: filePath,
          filename,
          fallback: 'backend'
        };
      } catch (error) {
        const status = error && error.response && error.response.status;
        mockMidtermZipLog.warn('backend mock zip download failed, fallback to local', {
          status,
          error: formatError(error)
        });
        try {
          return await saveMockMidtermZipByLocalFallback(studentId, className);
        } catch (localError) {
          mockMidtermZipLog.error('local mock zip fallback failed', {
            error: formatError(localError)
          });
          return {
            ok: false,
            error: '后端下载接口不可用，且本地题库也未找到。请确认后端已更新并已启动，或从项目根目录运行 unifiedClient。'
          };
        }
      }
    } catch (e) {
      reportError(mockMidtermZipLog, e, { studentId, className });
      return { ok: false, error: e.message || '下载期中模拟考试题包失败' };
    }
  });

  // 新增：期末大作业压缩包下载（弹窗另存为）
  // 调用新的 /api/finalAssignment/download?kind=zip
  const downloadFinalZipLog = scope('homework:downloadFinalZip');
  ipcMain.handle('homework:downloadFinalZip', async (_e, { studentId, className }) => {
    try {
      downloadFinalZipLog.info('start', { studentId, className });
      if (!className) return { ok: false, error: '缺少班级名称' };

      const res = await http.get('/api/finalAssignment/download', {
        params: { class_name: className, kind: 'zip', student_id: studentId },
        responseType: 'arraybuffer',
        validateStatus: (s) => s >= 200 && s < 300
      });

      // 弹出另存为对话框，默认文件名为 期末大作业.zip
      const win = BrowserWindow.getFocusedWindow() || getMainWindow();
      const { filePath, canceled } = await dialog.showSaveDialog(win, {
        title: '保存期末大作业压缩包',
        defaultPath: path.join(app.getPath('downloads'), '期末大作业.zip'),
        filters: [
          { name: 'ZIP Files', extensions: ['zip'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      });

      if (canceled || !filePath) {
        downloadFinalZipLog.info('canceled', { studentId, className });
        return { ok: false, error: '用户取消保存' };
      }

      fs.writeFileSync(filePath, Buffer.from(res.data));
      const size = Buffer.byteLength(res.data);
      downloadFinalZipLog.info('success', { file: filePath, size });
      return { ok: true, file: filePath, size };
    } catch (e) {
      let msg = e.message || '下载期末大作业失败';
      const respData = e && e.response && e.response.data;
      if (respData) {
        try {
          const txt = Buffer.isBuffer(respData) ? respData.toString('utf-8') : (typeof respData === 'string' ? respData : JSON.stringify(respData));
          const parsed = (() => { try { return JSON.parse(txt); } catch (err) { return null; } })();
          msg = (parsed && (parsed.message || parsed.msg || parsed.detail)) || txt || msg;
        } catch (err) { }
      }
      downloadFinalZipLog.error('failed', { studentId, className, message: msg });
      return { ok: false, error: msg };
    }
  });

  // 新增：下载 test.csv（基于学期+课号共享子目录）
  // 走新的 /api/finalAssignment/download?kind=test_csv，后端会做时间窗校验
  const downloadTestCsvLog = scope('homework:downloadTestCsv');
  ipcMain.handle('homework:downloadTestCsv', async (_e, { studentId, className }) => {
    try {
      downloadTestCsvLog.info('start', { studentId, className });
      if (!studentId) return { ok: false, error: '缺少学号参数' };
      if (!className) return { ok: false, error: '缺少班级名称' };

      const res = await http.get('/api/finalAssignment/download', {
        params: { class_name: className, kind: 'test_csv', student_id: studentId },
        responseType: 'arraybuffer',
        validateStatus: (s) => s >= 200 && s < 300
      });

      // 弹出另存为对话框，默认文件名为 test.csv
      const win = BrowserWindow.getFocusedWindow() || getMainWindow();
      const { filePath, canceled } = await dialog.showSaveDialog(win, {
        title: '保存测试数据',
        defaultPath: path.join(app.getPath('downloads'), 'test.csv'),
        filters: [
          { name: 'CSV Files', extensions: ['csv'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      });

      if (canceled || !filePath) {
        downloadTestCsvLog.info('canceled', { studentId });
        return { ok: false, error: '用户取消保存' };
      }

      fs.writeFileSync(filePath, Buffer.from(res.data));
      downloadTestCsvLog.info('success', { studentId, file: filePath });
      return { ok: true, file: filePath };
    } catch (e) {
      let msg = (e && e.message) || '下载测试CSV失败';
      const respData = e && e.response && e.response.data;
      if (respData) {
        try {
          const txt = Buffer.isBuffer(respData) ? respData.toString('utf-8') : (typeof respData === 'string' ? respData : JSON.stringify(respData));
          const parsed = (() => { try { return JSON.parse(txt); } catch (err) { return null; } })();
          msg = (parsed && (parsed.message || parsed.msg || parsed.detail)) || txt || msg;
        } catch (err) { }
      }
      if (e.response && e.response.status === 403) {
        msg = msg || '考试不在时间窗口内';
      } else if (e.response && e.response.status === 404) {
        msg = '教师尚未发布测试数据';
      }
      downloadTestCsvLog.error('failed', { studentId, className, message: msg });
      return { ok: false, error: msg };
    }
  });

  // 获取作业信息
  const homeworkInfoLog = scope('homework:getInfo');
  ipcMain.handle('homework:getInfo', async (_e, { studentId, className }) => {
    try {
      homeworkInfoLog.info('start', { studentId, className });
      const form = new URLSearchParams();
      form.append('student_id', studentId);
      form.append('class_name', className);
      form.append('client', '1');

      const requestConfig = {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      };
      const { result: res, resolvedUrl } = await withLegacy404Fallback(
        homeworkInfoLog,
        {
          apiPath: '/api/getHomeworkInfo',
          legacyPath: '/getHomeworkInfo',
          requestFactory: async (targetUrl) => http.post(targetUrl, form.toString(), requestConfig)
        }
      );

      const body = res.data || {};
      homeworkInfoLog.debug('info url', { infoUrl: resolvedUrl });
      homeworkInfoLog.info('success', {
        status: res.status,
        success: body.success,
        msg: body.msg || body.message,
        fileCount: Array.isArray(body.files) ? body.files.length : undefined,
        videoCount: Array.isArray(body.video_files) ? body.video_files.length : undefined
      });
      return body;
    } catch (error) {
      reportError(homeworkInfoLog, error, { studentId, className });
      return {
        success: false,
        msg:
          (error &&
            error.response &&
            error.response.data &&
            error.response.data.msg) ||
          (error && error.message) ||
          '获取作业信息失败'
      };
    }
  });

  // 获取学生已提交作业列表
  const homeworkSubmissionsLog = scope('homework:getSubmissions');
  ipcMain.handle('homework:getSubmissions', async (_e, { studentId, className }) => {
    try {
      homeworkSubmissionsLog.info('start', { studentId, className });

      const { result: res, resolvedUrl } = await withLegacy404Fallback(
        homeworkSubmissionsLog,
        {
          apiPath: `/api/homework/submissions/${studentId}/${className}`,
          legacyPath: `/homework/submissions/${studentId}/${className}`,
          requestFactory: async (targetUrl) => http.get(targetUrl)
        }
      );

      const body = res.data || {};
      homeworkSubmissionsLog.debug('submissions url', { url: resolvedUrl });
      homeworkSubmissionsLog.info('success', {
        status: res.status,
        success: body.success,
        totalCount: body.total_count,
        submissionsCount: Array.isArray(body.submissions) ? body.submissions.length : 0
      });

      return {
        success: body.success !== false,
        message: body.message,
        student_id: body.student_id,
        class_name: body.class_name,
        total_count: body.total_count,
        submissions: Array.isArray(body.submissions) ? body.submissions : []
      };
    } catch (error) {
      reportError(homeworkSubmissionsLog, error, { studentId, className });
      return {
        success: false,
        message: (error && error.response && error.response.data && error.response.data.message) ||
                 (error && error.message) ||
                 '获取已提交作业列表失败',
        submissions: []
      };
    }
  });

  // 获取学生提交状态（从数据库实时查询）
  const studentSubmissionStatusLog = scope('student:submissionStatus');
  ipcMain.handle('student:getSubmissionStatus', async (_e, { studentId, className }) => {
    try {
      studentSubmissionStatusLog.info('start', { studentId, className });

      if (!studentId || !className) {
        studentSubmissionStatusLog.warn('missing student/class');
        return { 
          success: false, 
          message: '缺少学号或班级名称',
          submissions: []
        };
      }

      // 调用后端API
      const formData = new FormData();
      formData.append('student_id', studentId);
      formData.append('class_name', className);

      const response = await http.post('/api/student/submission_status', formData, {
        headers: {
          'Content-Type': 'multipart/form-data'
        }
      });

      const body = response.data || {};
      
      studentSubmissionStatusLog.info('success', {
        status: response.status,
        success: body.success,
        totalCount: body.total_count,
        submissionsCount: Array.isArray(body.submissions) ? body.submissions.length : 0
      });

      return {
        success: body.success !== false,
        message: body.message,
        total_count: body.total_count,
        submissions: Array.isArray(body.submissions) ? body.submissions : []
      };
    } catch (error) {
      reportError(studentSubmissionStatusLog, error, { studentId, className });
      return {
        success: false,
        message: (error && error.response && error.response.data && error.response.data.message) ||
                 (error && error.message) ||
                 '获取学生提交状态失败',
        submissions: []
      };
    }
  });

  ipcMain.handle('homework:autograde', async (_e, { studentId, className, problemId, taskId }) => {
    try {
      const autogradeLog = scope('homework:autograde');
      autogradeLog.info('start', { studentId, className, problemId, taskId });

      if (!studentId || !className) {
        autogradeLog.warn('missing student/class');
        return { success: false, msg: '缺少学生ID或班级名称' };
      }

      if (!problemId) {
        autogradeLog.warn('missing problemId');
        return { success: false, msg: '缺少题目ID' };
      }

      const explicitTaskId = (() => {
        if (taskId === undefined || taskId === null || taskId === '') return undefined;
        if (typeof taskId === 'number' && Number.isFinite(taskId)) {
          return Math.trunc(taskId);
        }
        const text = String(taskId).trim();
        if (!/^\d+$/.test(text)) return undefined;
        const value = Number.parseInt(text, 10);
        return Number.isFinite(value) ? value : undefined;
      })();
      if (taskId !== undefined && taskId !== null && taskId !== '' && explicitTaskId === undefined) {
        autogradeLog.warn('invalid taskId', { taskId });
        return { success: false, msg: '无效的taskId' };
      }

      const formData = new FormData();
      formData.append('student_id', studentId);
      formData.append('class_name', className);
      formData.append('problem_id', problemId);
      if (explicitTaskId !== undefined) {
        formData.append('task_id', explicitTaskId);
      }

      const response = await http.post('/api/homework/autograde', formData, {
        headers: {
          'Content-Type': 'multipart/form-data'
        }
      });

      const body = response.data || {};
      autogradeLog.info('success', {
        status: response.status,
        success: body.success,
        msg: body.msg || body.message,
        score: body.score,
        totalScore: body.total_score,
        details: body.details
      });

      return {
        success: body.success !== false,
        message: body.message,
        score: body.score,
        total_score: body.total_score,
        details: body.details
      };
    } catch (error) {
      reportError(autogradeLog, error, { studentId, className, problemId, taskId });
      return {
        success: false,
        message: (error && error.response && error.response.data && error.response.data.message) ||
                 (error && error.message) ||
                 '自动评分失败',
        score: 0,
        total_score: 0,
        details: []
      };
    }
  });

  // 平时作业多文件上传
  const homeworkUploadLog = scope('homework:upload');
  ipcMain.handle('homework:upload', async (_e, { files, studentId, className, problemId, taskId }) => {
    try {
      if (!studentId || !className) {
        homeworkUploadLog.warn('missing student/class');
        return { success: false, msg: '缺少学生ID或班级名称' };
      }

      if (!files || files.length === 0) {
        homeworkUploadLog.warn('no files provided');
        return { success: false, msg: '没有要上传的文件' };
      }

      for (const f of files) {
        if (!fs.existsSync(f)) {
          homeworkUploadLog.warn('file missing', { file: f });
          return { success: false, msg: `文件不存在: ${f}` };
        }
      }

      const explicitTaskId = (() => {
        if (taskId === undefined || taskId === null || taskId === '') return undefined;
        if (typeof taskId === 'number' && Number.isFinite(taskId)) {
          return Math.trunc(taskId);
        }
        const text = String(taskId).trim();
        if (!/^\d+$/.test(text)) return undefined;
        const value = Number.parseInt(text, 10);
        return Number.isFinite(value) ? value : undefined;
      })();
      if (taskId !== undefined && taskId !== null && taskId !== '' && explicitTaskId === undefined) {
        homeworkUploadLog.warn('ignoring non-numeric explicit task_id', { taskId });
      }

      const derivedProblemId = (() => {
        if (problemId) return problemId;
        const firstFile = files[0];
        const baseName = path.basename(firstFile);
        const idx = baseName.indexOf('_');
        return idx > 0 ? baseName.slice(0, idx) : baseName.replace(/\.[^.]+$/, '');
      })();
      const derivedTaskId = (() => {
        if (explicitTaskId !== undefined) return explicitTaskId;
        const source = String(derivedProblemId || '').trim();
        if (!source) return undefined;
        const match = source.match(/\d+/);
        if (!match) return undefined;
        const value = Number.parseInt(match[0], 10);
        return Number.isFinite(value) ? value : undefined;
      })();
      homeworkUploadLog.info('start', {
        studentId,
        className,
        files: files.length,
        problemId: derivedProblemId || undefined,
        taskId: derivedTaskId
      });

      const buildFormData = () => {
        const formData = new FormData();
        formData.append('student_id', studentId);
        formData.append('class_name', className);

        if (derivedTaskId !== undefined) {
          formData.append('task_id', String(derivedTaskId));
        }

        for (const file of files) {
          formData.append('files', fs.createReadStream(file), {
            filename: path.basename(file)
          });
        }

        return formData;
      };

      const parseMaybeJson = (value) => {
        if (!value || typeof value !== 'string') return value;
        const text = value.trim();
        if (!text) return value;
        if (!(text.startsWith('{') || text.startsWith('['))) return value;
        try {
          return JSON.parse(text);
        } catch {
          return value;
        }
      };

      const pickValue = (obj, keys) => {
        if (!obj || typeof obj !== 'object') return undefined;
        for (const key of keys) {
          if (
            Object.prototype.hasOwnProperty.call(obj, key) &&
            obj[key] !== undefined &&
            obj[key] !== null &&
            obj[key] !== ''
          ) {
            return obj[key];
          }
        }
        return undefined;
      };

      const normalizeSubmitBody = (raw) => {
        const parsed = parseMaybeJson(raw);
        if (parsed && typeof parsed === 'object') {
          const inner = parsed.data && typeof parsed.data === 'object' ? parsed.data : parsed;
          return { raw: parsed, body: inner };
        }
        return { raw, body: {} };
      };

      const toFiniteNumber = (value) => {
        if (value === undefined || value === null || value === '') return undefined;
        const num = Number(value);
        return Number.isFinite(num) ? num : undefined;
      };

      const toBooleanFlag = (value) => {
        if (value === true || value === false) return value;
        if (value === 1 || value === '1') return true;
        if (value === 0 || value === '0') return false;
        if (typeof value === 'string') {
          const lower = value.trim().toLowerCase();
          if (['true', 'passed', 'pass', 'success', 'ok', 'yes'].includes(lower)) return true;
          if (['false', 'failed', 'fail', 'error', 'no'].includes(lower)) return false;
        }
        return undefined;
      };

      const toCleanText = (value) => {
        if (value === undefined || value === null) return '';
        if (typeof value === 'string') return value.trim();
        return String(value).trim();
      };

      const extractGradingData = (payload) => {
        if (!payload || typeof payload !== 'object') return {};

        const candidate =
          pickValue(payload, [
            'grading',
            'grading_detail',
            'gradingDetail',
            'detail',
            'grading_result',
            'result',
            'score_detail',
            'evaluation',
            'grading_data',
            'gradingData'
          ]) || payload;

        return candidate && typeof candidate === 'object' ? candidate : payload;
      };

      const collectCandidateObjects = (payload) => {
        const candidates = [];
        const add = (value) => {
          if (!value || typeof value !== 'object') return;
          if (candidates.includes(value)) return;
          candidates.push(value);
        };

        add(payload);
        if (payload && typeof payload === 'object') {
          add(payload.data);
          add(payload.result);
          add(payload.record);
          add(payload.assignment);
          add(payload.submission);
          add(payload.grading);
          add(payload.table);
          add(payload.grading_detail);
          add(payload.gradingDetail);
          add(payload.grading_result);
          add(payload.score_detail);
          add(payload.evaluation);
          add(payload.detail);
          if (payload.grading && typeof payload.grading === 'object') {
            add(payload.grading.grading);
            add(payload.grading.table);
          }
        }

        return candidates;
      };

      const extractAssignmentId = (payload) => {
        const candidates = collectCandidateObjects(payload);

        for (const obj of candidates) {
          const found = pickValue(obj, [
            'assignment_id',
            'assignmentId',
            'submission_id',
            'submissionId'
          ]);
          if (found !== undefined) return found;
        }

        for (const obj of candidates) {
          const found = pickValue(obj, ['id']);
          if (found !== undefined) return found;
        }

        return undefined;
      };

      const normalizeCaseItem = (item, index) => {
        if (!item || typeof item !== 'object') {
          const message = toCleanText(item);
          return {
            index: index + 1,
            name: `Test Case ${index + 1}`,
            passed: undefined,
            score: undefined,
            score_full: undefined,
            message,
            stdout: '',
            stderr: '',
            expected: undefined,
            actual: undefined,
            raw: item
          };
        }

        return {
          index: index + 1,
          name:
            toCleanText(
              pickValue(item, [
                'name',
                'title',
                'case_name',
                'caseName',
                'label',
                'test_name',
                'testName',
                'id'
              ])
            ) || `Test Case ${index + 1}`,
          passed: toBooleanFlag(
            pickValue(item, [
              'ok',
              'passed',
              'pass',
              'success',
              'is_passed',
              'isPassed',
              'correct'
            ])
          ),
          score: toFiniteNumber(pickValue(item, ['score', 'points', 'point', 'grade'])),
          score_full: toFiniteNumber(
            pickValue(item, ['score_full', 'full_score', 'max_score', 'maxScore', 'points_full', 'pointsFull'])
          ),
          message: toCleanText(
            pickValue(item, ['msg', 'message', 'feedback', 'error', 'error_message', 'reason'])
          ),
          stdout: toCleanText(
            pickValue(item, ['stdout', 'output', 'execution_output', 'executionOutput'])
          ),
          stderr: toCleanText(
            pickValue(item, ['stderr', 'error', 'error_message', 'traceback', 'compile_output', 'compileOutput'])
          ),
          input: pickValue(item, ['input']),
          expected: pickValue(item, ['expected', 'expect', 'expected_output', 'expectedOutput']),
          actual: pickValue(item, ['actual', 'actual_output', 'actualOutput', 'got', 'received']),
          duration_ms: toFiniteNumber(pickValue(item, ['duration_ms', 'durationMs'])),
          error: toCleanText(pickValue(item, ['error', 'error_message'])),
          raw: item
        };
      };

      const normalizeGradingResult = (payload, meta = {}) => {
        const gradingSource = extractGradingData(payload);
        const candidates = [
          ...collectCandidateObjects(gradingSource),
          ...collectCandidateObjects(payload)
        ];

        let caseSource = null;
        for (const obj of candidates) {
          let found = null;
          if (Array.isArray(obj)) {
            found = obj;
          } else {
            found = pickValue(obj, ['detail', 'test_cases', 'cases', 'results', 'tests', 'items', 'table']);
          }

          if (Array.isArray(found)) {
            caseSource = found;
            break;
          }
        }

        const detail = Array.isArray(caseSource) ? caseSource.map(normalizeCaseItem) : [];

        let score;
        let fullScore;
        let pass;
        let message = '';
        let stdout = '';
        let stderr = '';
        let status = '';
        let attempted;
        let problemIdValue =
          meta.problem_id ||
          pickValue(payload, ['problem_id', 'problemId']) ||
          derivedProblemId;
        let taskIdValue =
          meta.task_id ||
          pickValue(payload, ['task_id', 'taskId']) ||
          derivedTaskId;

        for (const obj of candidates) {
          if (score === undefined) {
            score = toFiniteNumber(
              pickValue(obj, ['score', 'total_score', 'grade', 'points', 'earned_score', 'earnedScore'])
            );
          }

          if (fullScore === undefined) {
            fullScore = toFiniteNumber(
              pickValue(obj, ['score_full', 'full_score', 'max_score', 'maxScore', 'total_points', 'totalPoints'])
            );
          }

          if (pass === undefined) {
            pass = toBooleanFlag(
              pickValue(obj, ['pass', 'passed', 'success', 'all_passed', 'allPassed'])
            );
          }

          if (!message) {
            message = toCleanText(
              pickValue(obj, ['msg', 'message', 'summary', 'feedback', 'status_text', 'statusText', 'error'])
            );
          }

          if (!stdout) {
            stdout = toCleanText(
              pickValue(obj, ['stdout', 'output', 'execution_output', 'executionOutput'])
            );
          }

          if (!stderr) {
            stderr = toCleanText(
              pickValue(obj, ['stderr', 'error', 'error_message', 'traceback', 'compile_output', 'compileOutput'])
            );
          }

          if (!status) {
            status = toCleanText(pickValue(obj, ['status', 'grading_status', 'gradingStatus']));
          }

          if (attempted === undefined) {
            attempted = toBooleanFlag(pickValue(obj, ['attempted']));
          }

          if (!problemIdValue) {
            problemIdValue = pickValue(obj, ['problem_id', 'problemId', 'question_id', 'questionId']);
          }

          if (!taskIdValue) {
            taskIdValue = pickValue(obj, ['task_id', 'taskId']);
          }
        }

        let passedCount;
        let totalCount;

        for (const obj of candidates) {
          if (passedCount === undefined) {
            passedCount = toFiniteNumber(pickValue(obj, ['passed_count', 'passedCount']));
          }

          if (totalCount === undefined) {
            totalCount = toFiniteNumber(pickValue(obj, ['total_count', 'totalCount', 'total_cases', 'totalCases']));
          }
        }

        if (passedCount === undefined) {
          passedCount = detail.filter((item) => item.passed === true).length;
        }

        if (totalCount === undefined) {
          totalCount = detail.length;
        }

        if (fullScore === undefined && detail.length) {
          const computed = detail.reduce((sum, item) => {
            return sum + (item.score_full !== undefined ? item.score_full : 0);
          }, 0);
          if (computed > 0) fullScore = computed;
        }

        if (pass === undefined) {
          if (totalCount > 0) {
            pass = passedCount === totalCount;
          } else if (status) {
            const lower = status.toLowerCase();
            if (['passed', 'pass', 'success', 'ok'].includes(lower)) pass = true;
            if (['failed', 'fail', 'error'].includes(lower)) pass = false;
          }
        }

        return {
          assignment_id: meta.assignment_id !== undefined ? meta.assignment_id : extractAssignmentId(payload),
          task_id: taskIdValue,
          problem_id: problemIdValue || derivedProblemId,
          score,
          score_full: fullScore,
          pass,
          passed: pass,
          detail,
          test_cases: detail,
          passed_count: passedCount,
          total_count: totalCount,
          msg: message,
          message,
          stdout,
          stderr,
          status,
          attempted,
          raw: payload
        };
      };

      const hasRenderableGradeData = (payload) => {
        if (!payload || typeof payload !== 'object') return false;
        const normalizedGrade =
          payload.detail || payload.test_cases || payload.stdout || payload.stderr
            ? normalizeGradingResult(payload, {
              assignment_id: payload.assignment_id,
              problem_id: payload.problem_id || derivedProblemId,
              task_id: payload.task_id || derivedTaskId
            })
            : normalizeGradingResult(payload, {
              problem_id: derivedProblemId,
              task_id: derivedTaskId
            });

        return !!(
          (Array.isArray(normalizedGrade.detail) && normalizedGrade.detail.length > 0) ||
          normalizedGrade.score !== undefined ||
          normalizedGrade.pass !== undefined ||
          normalizedGrade.attempted !== undefined ||
          normalizedGrade.status ||
          normalizedGrade.message ||
          normalizedGrade.stdout ||
          normalizedGrade.stderr
        );
      };

      const submitRequest = async (targetUrl) => {
        const formData = buildFormData();
        return http.post(targetUrl, formData, {
          headers: formData.getHeaders(),
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
          timeout: 120000
        });
      };

      let response;
      let resolvedUrl;

      const submitResult = await withLegacy404Fallback(
        homeworkUploadLog,
        {
          apiPath: '/api/homework/submit',
          legacyPath: '/homework/submit',
          requestFactory: submitRequest
        }
      );
      response = submitResult.result;
      resolvedUrl = submitResult.resolvedUrl;

      homeworkUploadLog.debug('submit url', { submitUrl: resolvedUrl });

      const normalized = normalizeSubmitBody(response && response.data);
      const submitBody = normalized.body || {};
      const success = response.status >= 200 && response.status < 300 && submitBody.success !== false;
      const assignmentId = extractAssignmentId(submitBody);
      const submitGrading = normalizeGradingResult(submitBody, {
        assignment_id: assignmentId,
        problem_id: derivedProblemId,
        task_id: derivedTaskId
      });
      const gradingResult = hasRenderableGradeData(submitGrading) ? submitGrading : undefined;
      const gradingSource = gradingResult ? 'submit' : 'none';

      homeworkUploadLog.info('submit finished', {
        status: response.status,
        success,
        assignmentId,
        hasGrading: !!gradingResult,
        gradingSource,
        gradingStatus: gradingResult && gradingResult.status,
        gradingAttempted: gradingResult && gradingResult.attempted
      });

      return {
        ok: success,
        success,
        msg: submitBody.msg || submitBody.message || (success ? 'submit success' : 'submit failed'),
        assignment_id: assignmentId,
        task_id: derivedTaskId,
        problem_id: derivedProblemId,
        score:
          (gradingResult && gradingResult.score !== undefined ? gradingResult.score : undefined) ??
          pickValue(submitBody, ['score', 'total_score', 'grade']),
        grading: gradingResult || submitBody,
        grading_result: gradingResult,
        grading_source: gradingSource,
        grading_status: gradingResult && gradingResult.status ? gradingResult.status : undefined,
        grading_attempted:
          gradingResult && gradingResult.attempted !== undefined ? gradingResult.attempted : undefined,
        raw: submitBody
      };
    } catch (e) {
      reportError(homeworkUploadLog, e, { studentId, className, problemId });
      const responseData = e && e.response ? e.response.data : undefined;
      let responseMessage = '';

      if (responseData && typeof responseData === 'object') {
        if (Array.isArray(responseData.detail) && responseData.detail.length) {
          responseMessage = responseData.detail
            .map((item) => {
              const loc = Array.isArray(item && item.loc) ? item.loc.join('.') : '';
              const msg = item && item.msg ? item.msg : '';
              return [loc, msg].filter(Boolean).join(': ');
            })
            .filter(Boolean)
            .join('; ');
        }

        if (!responseMessage) {
          responseMessage = responseData.message || responseData.msg || responseData.error || '';
        }
      }

      const statusText =
        e && (e.status || (e.response && e.response.status))
          ? `HTTP ${e.status || (e.response && e.response.status)}`
          : '';
      const message = [statusText, responseMessage || e.message || 'upload failed'].filter(Boolean).join(' - ');
      return { success: false, msg: message, raw: responseData };
    }
  });

  // 平时作业附件上传（pdf/docx）
  const attachmentLog = scope('homework:uploadAttachment');
  ipcMain.handle('homework:uploadAttachment', async (_e, payload) => {
    try {
      const filePathOrObj = payload && payload.filePath;
      const studentId = payload && payload.studentId;
      const className = payload && payload.className;
      const fileType = payload && payload.fileType;

      if (!studentId || !className) {
        return { success: false, message: '缺少学生ID或班级名称' };
      }

      attachmentLog.info('start', { studentId, className, fileType });

      let fileStream;
      let filename;

      if (typeof filePathOrObj === 'string') {
        if (!filePathOrObj || !fs.existsSync(filePathOrObj)) {
          return { success: false, message: '文件不存在' };
        }
        filename = path.basename(filePathOrObj);
        fileStream = fs.createReadStream(filePathOrObj);
      } else if (
        filePathOrObj &&
        typeof filePathOrObj === 'object' &&
        filePathOrObj.content &&
        filePathOrObj.name
      ) {
        filename = filePathOrObj.name;
        fileStream = Buffer.from(filePathOrObj.content);
      } else {
        return { success: false, message: '无效的文件路径或内容' };
      }

      const ext = path.extname(filename).toLowerCase();
      if (ext !== '.pdf' && ext !== '.docx') {
        attachmentLog.warn('invalid attachment type', { filename });
        return { success: false, message: '只允许上传 .pdf 或 .docx 文件' };
      }

      const url = BASE_URL + '/api/uploadHomeworkTest';

      const form = new FormData();
      form.append('student_id', studentId);
      form.append('class_name', className);
      if (fileType) {
        form.append('file_type', fileType);
      }
      form.append('file', fileStream, {
        filename: filename
      });

      const res = await http.post(url, form, {
        headers: form.getHeaders(),
        maxContentLength: Infinity,
        maxBodyLength: Infinity
      });

      attachmentLog.info('attachment uploaded', { filename });
      return res.data;
    } catch (err) {
      reportError(attachmentLog, err, {});

      let msg = '上传失败';
      if (err && err.message) {
        msg = err.message;
      }

      const resp = err && err.response && err.response.data;
      if (resp) {
        if (typeof resp === 'string') {
          msg = resp;
        } else if (resp.message) {
          msg = resp.message;
        } else if (resp.msg) {
          msg = resp.msg;
        }
      }

      return { success: false, message: msg };
    }
  });

  // 执行本地 Python
  const execPythonLog = scope('exec:python');

  // 尝试修复 Mac/Linux 环境变量
  const fixPath = () => {
    if (process.platform === 'win32') return;
    const candidates = [
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
      '/opt/homebrew/bin',
      '/opt/local/bin'
    ];
    // 尝试添加用户目录下的 Python bin
    if (process.env.HOME) {
      candidates.push(path.join(process.env.HOME, '.pyenv', 'shims'));
      candidates.push(path.join(process.env.HOME, '.pyenv', 'bin'));
      candidates.push(path.join(process.env.HOME, '.asdf', 'shims'));
      candidates.push(path.join(process.env.HOME, 'miniconda3', 'bin'));
      candidates.push(path.join(process.env.HOME, 'anaconda3', 'bin'));
      candidates.push(path.join(process.env.HOME, 'miniforge3', 'bin'));
      candidates.push(path.join(process.env.HOME, 'mambaforge', 'bin'));
      candidates.push(path.join(process.env.HOME, '.local', 'bin'));
      candidates.push(path.join(process.env.HOME, 'Library/Python/3.11/bin'));
      candidates.push(path.join(process.env.HOME, 'Library/Python/3.10/bin'));
      candidates.push(path.join(process.env.HOME, 'Library/Python/3.9/bin'));
      candidates.push(path.join(process.env.HOME, 'Library/Python/3.8/bin'));
    }

    let envPath = process.env.PATH || '';
    candidates.forEach(p => {
      if (!envPath.includes(p) && fs.existsSync(p)) {
        envPath = p + path.delimiter + envPath;
      }
    });
    process.env.PATH = envPath;
  };

  ipcMain.handle('exec:python', async (_e, { cwd, entry }) => {
    execPythonLog.info('start', { cwd, entry });
    fixPath(); // 确保 PATH 包含常见路径

    return await new Promise((resolve) => {
      const normalizeRuntimePath = (input) => {
        const raw = String(input || '').trim();
        if (!raw) return '';
        if (process.platform === 'win32') return raw;
        return raw.replace(/\\/g, '/');
      };

      const runtimeEntry = normalizeRuntimePath(entry);
      const requestedCwd = normalizeRuntimePath(cwd);
      const runtimeCwd = (() => {
        if (requestedCwd && fs.existsSync(requestedCwd)) return requestedCwd;
        if (runtimeEntry) {
          const dir = path.dirname(runtimeEntry);
          if (dir && fs.existsSync(dir)) return dir;
        }
        return process.cwd();
      })();

      if (!runtimeEntry || !fs.existsSync(runtimeEntry)) {
        return resolve({
          ok: false,
          output: `Python 文件不存在或路径无效：${runtimeEntry || entry || '(empty)'}`,
          code: 1
        });
      }

      const isPythonMissingOutput = (raw) => {
        const s = String(raw || '').toLowerCase();
        if (!s) return false;
        if (s.includes('python was not found')) return true;
        if (s.includes('microsoft store')) return true;
        if (s.includes('not recognized as an internal or external command')) return true;
        if (s.includes('command not found') && s.includes('python')) return true;
        if (s.includes('no such file or directory') && s.includes('python')) return true;
        return false;
      };

      const shellEscapePosix = (value) => {
        const s = String(value ?? '');
        return `'${s.replace(/'/g, `'\"'\"'`)}'`;
      };

      const pushIfFile = (arr, p) => {
        try {
          if (p && fs.existsSync(p)) arr.push(p);
        } catch (_) { }
      };

      const resolvePythonFromWhere = () => {
        if (process.platform !== 'win32') return null;
        try {
          const out = execSync('where python', { stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8').trim();
          const first = out.split(/\r?\n/).map((x) => x.trim()).find(Boolean);
          if (first && (first.includes('\\') || first.includes('/'))) return first;
        } catch (_) { }
        return null;
      };

      const resolvePosixPythonFromShell = () => {
        if (process.platform === 'win32') return [];
        const shells = [];
        if (process.env.SHELL) shells.push(process.env.SHELL);
        shells.push('/bin/zsh', '/bin/bash', '/usr/bin/zsh', '/usr/bin/bash');

        const uniqueShells = [];
        const shellSeen = new Set();
        for (const sh of shells) {
          const shellPath = String(sh || '').trim();
          if (!shellPath || shellSeen.has(shellPath) || !fs.existsSync(shellPath)) continue;
          shellSeen.add(shellPath);
          uniqueShells.push(shellPath);
        }

        const resolved = [];
        const resolvedSeen = new Set();
        const probeScript =
          "python3 -c 'import sys; print(sys.executable)' 2>/dev/null || python -c 'import sys; print(sys.executable)' 2>/dev/null";

        for (const sh of uniqueShells) {
          try {
            const cmd = `${shellEscapePosix(sh)} -l -i -c ${shellEscapePosix(probeScript)}`;
            const out = execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8').trim();
            const first = out.split(/\r?\n/).map((x) => x.trim()).find(Boolean);
            if (first && first.startsWith('/') && fs.existsSync(first) && !resolvedSeen.has(first)) {
              resolvedSeen.add(first);
              resolved.push(first);
            }
          } catch (_) { }
        }

        return resolved;
      };

      const whereResolved = resolvePythonFromWhere();
      const posixResolved = resolvePosixPythonFromShell();

      const rawCandidates = [];
      if (process.platform === 'darwin') {
        rawCandidates.push(...posixResolved);
        if (process.env.HOME) {
          pushIfFile(rawCandidates, path.join(process.env.HOME, '.pyenv', 'shims', 'python3'));
          pushIfFile(rawCandidates, path.join(process.env.HOME, '.pyenv', 'shims', 'python'));
          pushIfFile(rawCandidates, path.join(process.env.HOME, '.asdf', 'shims', 'python3'));
          pushIfFile(rawCandidates, path.join(process.env.HOME, '.asdf', 'shims', 'python'));
          pushIfFile(rawCandidates, path.join(process.env.HOME, 'miniconda3', 'bin', 'python'));
          pushIfFile(rawCandidates, path.join(process.env.HOME, 'anaconda3', 'bin', 'python'));
          pushIfFile(rawCandidates, path.join(process.env.HOME, 'miniforge3', 'bin', 'python'));
          pushIfFile(rawCandidates, path.join(process.env.HOME, 'mambaforge', 'bin', 'python'));
        }
        rawCandidates.push('/Library/Frameworks/Python.framework/Versions/Current/bin/python3');
        rawCandidates.push(
          '/opt/homebrew/bin/python3',
          '/usr/local/bin/python3',
          '/opt/local/bin/python3',
          '/usr/bin/python3',
          'python3',
          'python'
        );
      } else if (process.platform === 'win32') {
        if (whereResolved) rawCandidates.push(whereResolved);
        rawCandidates.push('py', 'python', 'python3');
      } else {
        rawCandidates.push(...posixResolved);
        rawCandidates.push('python3', 'python');
      }

      const seen = new Set();
      const exeCandidates = rawCandidates.filter((x) => {
        const k = String(x || '').trim();
        if (!k) return false;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      }).map((cmd) => {
        if (process.platform === 'win32' && cmd === 'py') {
          return { cmd, args: ['-3', runtimeEntry] };
        }
        return { cmd, args: [runtimeEntry] };
      });

      if (process.platform !== 'win32') {
        const entryEscaped = shellEscapePosix(runtimeEntry);
        const shells = [];
        if (process.env.SHELL) shells.push(process.env.SHELL);
        shells.push('/bin/zsh', '/bin/bash', '/usr/bin/zsh', '/usr/bin/bash');
        const shellSeen = new Set();
        const shellCandidates = shells
          .map((sh) => String(sh || '').trim())
          .filter((sh) => sh && !shellSeen.has(sh) && fs.existsSync(sh) && shellSeen.add(sh))
          .flatMap((sh) => {
            return [
              { cmd: sh, args: ['-l', '-i', '-c', `python3 ${entryEscaped}`] },
              { cmd: sh, args: ['-l', '-i', '-c', `python ${entryEscaped}`] }
            ];
          });
        exeCandidates.push(...shellCandidates);
      }

      const attempts = [];
      function trySpawn(i) {
        if (i >= exeCandidates.length) {
          const details = attempts
            .slice(-5)
            .map((item) => {
              const text = String(item.message || '').trim().replace(/\s+/g, ' ').slice(0, 180);
              return `${item.candidate}${text ? ` -> ${text}` : ''}`;
            })
            .join('\n');
          const msg = process.platform === 'darwin'
            ? `未找到 Python 解释器。请确保已安装 Python 且能在终端中运行 python 或 python3。${details ? `\n最近尝试:\n${details}` : ''}`
            : `未找到 Python 解释器。请确保已安装 Python 并勾选 "Add to PATH"。${details ? `\n最近尝试:\n${details}` : ''}`;
          return resolve({ ok: false, output: msg });
        }

        const candidate = exeCandidates[i];
        const proc = spawn(candidate.cmd, candidate.args, {
          cwd: runtimeCwd,
          env: process.env
        });

        let output = '';
        let errorOccurred = false;

        proc.stdout.on('data', (d) => {
          const text = d.toString();
          output += text;
          const win = getMainWindow();
          if (win && win.webContents) {
            win.webContents.send('exec:python:live', text);
          }
        });
        proc.stderr.on('data', (d) => {
          const text = d.toString();
          output += text;
          const win = getMainWindow();
          if (win && win.webContents) {
            win.webContents.send('exec:python:live', text);
          }
        });
        proc.on('close', (code) => {
          if (errorOccurred) return;
          execPythonLog.info('python process closed', { code, candidate: candidate.cmd });
          if (code !== 0 && isPythonMissingOutput(output)) {
            attempts.push({ candidate: candidate.cmd, message: output });
            return trySpawn(i + 1);
          }
          resolve({ ok: code === 0, output, code });
        });
        proc.on('error', (err) => {
          errorOccurred = true;
          attempts.push({ candidate: candidate.cmd, message: err && err.message ? err.message : 'spawn error' });
          trySpawn(i + 1);
        });
      }

      trySpawn(0);
    });
  });

  // 获取作业本地目录
  ipcMain.handle(
    'homework:getAssignmentDir',
    async (_e, { studentId, className, assignmentId }) => {
      const dir = path.join(
        courseRoot(studentId),
        className,
        'homeworks',
        assignmentId
      );
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    }
  );

  // 读取本地文件
  ipcMain.handle('fs:readFile', async (_e, { file, encoding }) => {
    const userData = getUserDataDir();
    if (!file.startsWith(userData) && !file.startsWith(tempDir())) {
      throw new Error('Path not allowed');
    }
    const enc = encoding || 'utf-8';
    return fs.readFileSync(file, enc);
  });

  // 注意：应用版本 / 更新检查由主进程入口 (src/main/index.js) 提供，避免重复注册 handler

  // 打开期末大作业提交窗口
  ipcMain.handle('ui:openFinalBlank', async () => {
    const win = new BrowserWindow({
      width: 960,
      height: 700,
      minWidth: 800,
      minHeight: 600,
      title: '期末大作业提交',
      titleBarStyle: 'hiddenInset',
      icon: getIconPath(),
      webPreferences: {
        preload: path.join(__dirname, '../preload/preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    });
    await win.loadFile(path.join(__dirname, '../renderer/final-submit.html'));
    win.setTitle('期末大作业提交');
    return true;
  });

  // 打开成绩查询窗口
  ipcMain.handle('ui:openScoreBlank', async (_e, { studentId }) => {
    const win = new BrowserWindow({
      width: 960,
      height: 700,
      minWidth: 800,
      minHeight: 600,
      title: '成绩查询',
      titleBarStyle: 'hiddenInset',
      icon: getIconPath(),
      webPreferences: {
        preload: path.join(__dirname, '../preload/preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    });
    await win.loadFile(path.join(__dirname, '../renderer/score-query.html'), {
      query: { student_id: studentId || '' }
    });
    win.setTitle('成绩查询页面');
    return true;
  });

  // ===== 作业副本同步 ====

  const ensureMirrorLog = scope('homework:ensureMirror');
  ipcMain.handle('homework:ensureMirror', async (_e, { studentId, className }) => {
    try {
      ensureMirrorLog.info('start', { studentId, className });
      const baseTemp = tempDir();
      const mainDir = path.join(
        baseTemp,
        'extracted_homeworks',
        studentId,
        className
      );
      const mirrorDir = path.join(
        baseTemp,
        'extracted_homeworks_bk',
        studentId,
        className
      );

      if (!fs.existsSync(mainDir)) {
        ensureMirrorLog.warn('main dir missing', { mainDir });
        return { ok: false, error: '主目录不存在' };
      }

      if (fs.existsSync(mirrorDir)) {
        const entries = fs.readdirSync(mirrorDir);
        if (entries.length > 0) {
          ensureMirrorLog.info('mirror already populated', { mirrorDir });
          return { ok: true, mirrorDir, skipped: true };
        }
      }

      fs.mkdirSync(mirrorDir, { recursive: true });

      const zipRoot = homeworkZipDir(studentId, className);
      let zipFile = null;
      if (fs.existsSync(zipRoot)) {
        const zips = fs
          .readdirSync(zipRoot)
          .filter((f) => /\.zip$/i.test(f))
          .map((f) => ({
            full: path.join(zipRoot, f),
            mtime: fs.statSync(path.join(zipRoot, f)).mtimeMs
          }))
          .sort((a, b) => b.mtime - a.mtime);
        if (zips.length) zipFile = zips[0].full;
      }

      if (!zipFile) {
        const url = `${BASE_URL}/api/homework/zip?studentId=${encodeURIComponent(
          studentId
        )}&className=${encodeURIComponent(className)}`;
        fs.mkdirSync(zipRoot, { recursive: true });
        zipFile = path.join(zipRoot, `latest_${Date.now()}.zip`);
        const resp = await http.get(url, { responseType: 'stream' });
        await new Promise((resolve, reject) => {
          const w = fs.createWriteStream(zipFile);
          resp.data.pipe(w);
          w.on('finish', resolve);
          w.on('error', reject);
        });
        await extract(zipFile, { dir: mirrorDir });
        ensureMirrorLog.info('mirror generated from download', { mirrorDir });
        return { ok: true, mirrorDir, method: 'download' };
      }

      await extract(zipFile, { dir: mirrorDir });
      ensureMirrorLog.info('mirror generated from cached zip', { zipFile });
      return { ok: true, mirrorDir, method: 'zip' };
    } catch (e) {
      reportError(ensureMirrorLog, e, { studentId, className });
      return { ok: false, error: e.message || '生成副本失败' };
    }
  });

  function copyAll(src, dest) {
    const created = [];
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      const s = path.join(src, entry.name);
      const d = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        if (!fs.existsSync(d)) fs.mkdirSync(d);
        created.push(d);
        const sub = copyAll(s, d);
        for (const it of sub) created.push(it);
      } else if (entry.isFile()) {
        fs.copyFileSync(s, d);
        created.push(d);
      }
    }
    return created;
  }

  function copyMissing(src, dest) {
    if (!fs.existsSync(src)) return [];
    const copied = [];
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      const s = path.join(src, entry.name);
      const d = path.join(dest, entry.name);
      if (!fs.existsSync(d)) {
        if (entry.isDirectory()) {
          fs.mkdirSync(d, { recursive: true });
          copied.push(d);
          const all = copyAll(s, d);
          copied.push(...all);
        } else if (entry.isFile()) {
          fs.copyFileSync(s, d);
          copied.push(d);
        }
      } else {
        if (entry.isDirectory()) {
          copied.push(...copyMissing(s, d));
        }
      }
    }
    return copied;
  }

  const syncMissingLog = scope('homework:syncMissing');
  ipcMain.handle('homework:syncMissing', async (_e, { studentId, className }) => {
    try {
      syncMissingLog.info('start', { studentId, className });
      const baseTemp = tempDir();
      const mainDir = path.join(
        baseTemp,
        'extracted_homeworks',
        studentId,
        className
      );
      const mirrorDir = path.join(
        baseTemp,
        'extracted_homeworks_bk',
        studentId,
        className
      );

      if (!fs.existsSync(mirrorDir)) {
        syncMissingLog.warn('mirror dir missing', { mirrorDir });
        return { ok: false, error: '副本不存在' };
      }

      // 如果主目录不存在，创建它
      if (!fs.existsSync(mainDir)) {
        syncMissingLog.info('main dir missing, creating...', { mainDir });
        fs.mkdirSync(mainDir, { recursive: true });
      }

      const copied = copyMissing(mirrorDir, mainDir);
      syncMissingLog.info('synced missing items', { copied: copied.length });
      return { ok: true, copied };
    } catch (e) {
      reportError(syncMissingLog, e, { studentId, className });
      return { ok: false, error: e.message || '同步失败' };
    }
  });

  // ===== DOCX 解析 =====

  function parseDocxToText(docxPath) {
    if (!fs.existsSync(docxPath)) throw new Error('文件不存在');
    const baseTmp = tempDir();
    const workDir = path.join(
      baseTmp,
      'docx_parse',
      Date.now().toString() + '_' + Math.random().toString(16).slice(2)
    );
    fs.mkdirSync(workDir, { recursive: true });
    return (async () => {
      try {
        await extract(docxPath, { dir: workDir });
        const xmlFile = path.join(workDir, 'word', 'document.xml');
        if (!fs.existsSync(xmlFile)) throw new Error('缺少 document.xml');
        let xml = fs.readFileSync(xmlFile, 'utf-8');
        xml = xml.replace(/<\/w:p>/g, '\n');
        xml = xml.replace(/<w:br\s*\/>/g, '\n');
        xml = xml.replace(/<[^>]+>/g, '');
        xml = xml
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/&apos;/g, "'");
        xml = xml.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
        return xml;
      } finally {
        try {
          fs.rmSync(workDir, { recursive: true, force: true });
        } catch { }
      }
    })();
  }

  async function parseDocxToHtmlSimple(docxPath) {
    const text = await parseDocxToText(docxPath);
    if (!text) return '<p>（空文档）</p>';
    const lines = String(text).split(/\r?\n/);
    const esc = (s) =>
      s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    return lines
      .map((line) => `<p>${esc(line)}</p>`)
      .join('\n');
  }

  const docxHtmlLog = scope('docx:toHtml');
  ipcMain.handle('docx:toHtml', async (_e, { file }) => {
    try {
      if (!file || typeof file !== 'string') throw new Error('无效路径');
      const abs = path.resolve(file);

      // 允许解析 tempDir 与 userData 下的 DOCX（作业解压目录在 userData 下）
      const allowedBases = [path.resolve(tempDir()), path.resolve(getUserDataDir())];
      const isSubPath = (baseDir, targetPath) => {
        const rel = path.relative(baseDir, targetPath);
        return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
      };
      const allowed = allowedBases.some((b) => isSubPath(b, abs));
      if (!allowed) throw new Error('Path not allowed');
      const html = await parseDocxToHtmlSimple(abs);
      return { ok: true, html };
    } catch (e) {
      reportError(docxHtmlLog, e, { file });
      return { ok: false, error: e.message || '解析失败' };
    }
  });

  const docxTextLog = scope('docx:toText');
  ipcMain.handle('docx:toText', async (_e, { file }) => {
    try {
      if (!file || typeof file !== 'string') throw new Error('无效路径');
      const abs = path.resolve(file);

      // 允许解析 tempDir 与 userData 下的 DOCX（作业解压目录在 userData 下）
      const allowedBases = [path.resolve(tempDir()), path.resolve(getUserDataDir())];
      const isSubPath = (baseDir, targetPath) => {
        const rel = path.relative(baseDir, targetPath);
        return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
      };
      const allowed = allowedBases.some((b) => isSubPath(b, abs));
      if (!allowed) throw new Error('Path not allowed');
      const text = await parseDocxToText(abs);
      return { ok: true, text };
    } catch (e) {
      reportError(docxTextLog, e, { file });
      return { ok: false, error: e.message || '解析失败' };
    }
  });

  // ===== 课程 AI 窗口 =====

  ipcMain.handle('ui:openAiCourse', async () => {
    const win = new BrowserWindow({
      width: 1100,
      height: 760,
      minWidth: 1000,
      minHeight: 680,
      title: '课程AI智能体',
      titleBarStyle: 'hiddenInset',
      icon: getIconPath(),
      webPreferences: {
        preload: path.join(__dirname, '../preload/preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        webviewTag: true
      }
    });
    await win.loadFile(path.join(__dirname, '../renderer/ai-course.html'));
    win.setTitle('课程AI智能体');
    return true;
  });

  // ===== 建议反馈 =====

  const suggestLog = scope('suggestion:submit');
  ipcMain.handle('suggestion:submit', async (_e, { studentId, content, imagePath }) => {
    suggestLog.info('start', { studentId, contentLength: content?.length, hasImage: !!imagePath });
    try {
      const FormData = require('form-data');
      const form = new FormData();
      form.append('student_id', studentId);
      form.append('content', content);
      if (imagePath) {
        const fs = require('fs');
        const stat = fs.statSync(imagePath);
        if (stat.isFile() && stat.size > 0) {
          form.append('image', fs.createReadStream(imagePath), path.basename(imagePath));
        }
      }

      const res = await postWithFallback(suggestLog, '/api/suggestions', form, {
        headers: form.getHeaders ? form.getHeaders() : { 'Content-Type': 'multipart/form-data' }
      });
      const raw = res.data;
      if (!raw || raw.success === false) {
        throw new Error((raw && (raw.message || raw.msg)) || '提交失败');
      }
      suggestLog.info('success', { suggestionId: raw.data?.id });
      return { ok: true, data: raw.data };
    } catch (err) {
      const status = err && err.response && err.response.status;
      const respData = err && err.response && err.response.data;
      let msg = (err && err.message) || '网络异常';
      if (respData) {
        if (typeof respData === 'string') msg = respData;
        else if (respData.message || respData.msg) msg = respData.message || respData.msg;
      }
      reportError(suggestLog, err, { studentId, status, message: msg });
      return { ok: false, error: msg, status };
    }
  });
};
