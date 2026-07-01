/**
 * 统一客户端预加载脚本
 * 合并学生端和教师端 API
 */
const { contextBridge, ipcRenderer } = require('electron');
const path = require('path');
const fs = require('fs');
const marked = require('marked');
const hljs = require('highlight.js');

// 配置 marked
marked.setOptions({
  gfm: true,
  breaks: false,
  headerIds: true,
  mangle: false,
  highlight(code, lang) {
    try {
      if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value;
      return hljs.highlightAuto(code).value;
    } catch (e) {
      return code;
    }
  }
});

// Strip raw HTML blocks
marked.use({
  renderer: {
    html(html) { return ''; }
  }
});

// ========== 统一 API ==========
contextBridge.exposeInMainWorld('api', {
  // ===== 环境和设备 =====
  getBaseUrl: () => ipcRenderer.invoke('env:getBaseUrl'),
  getMachineId: () => ipcRenderer.invoke('device:getMachineId'),
  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),
  
  // ===== 认证 =====
  isTeacher: (inputId) => ipcRenderer.invoke('auth:isTeacher', { inputId }),
  validate: (studentId) => ipcRenderer.invoke('auth:validate', { studentId }),
  validateTeacher: (teacherId) => ipcRenderer.invoke('auth:validateTeacher', { teacherId }),
  
  // ===== 缓存 =====
  cacheRead: (studentId, key) => ipcRenderer.invoke('cache:read', { studentId, key }),
  cacheWrite: (studentId, key, content) => ipcRenderer.invoke('cache:write', { studentId, key, content }),
  
  // ===== 作业 =====
  homeworkList: (studentId, className) => ipcRenderer.invoke('homework:list', { studentId, className }),
  homeworkInfo: (studentId, className) => ipcRenderer.invoke('homework:getInfo', { studentId, className }),
  homeworkSubmissions: (studentId, className) => ipcRenderer.invoke('homework:getSubmissions', { studentId, className }),
  getStudentSubmissionStatus: (studentId, className) => ipcRenderer.invoke('student:getSubmissionStatus', { studentId, className }),
  syncFileList: (studentId, className, fileList) => ipcRenderer.invoke('homework:syncFileList', { studentId, className, fileList }),
  downloadFile: (opts) => ipcRenderer.invoke('homework:downloadFile', opts),
  uploadHomework: (files, studentId, className, problemId, taskId) =>
    ipcRenderer.invoke('homework:upload', { files, studentId, className, problemId, taskId }),
  autogradeHomework: (payload) => ipcRenderer.invoke('homework:autograde', payload),
  downloadHomeworkZip: (studentId, className) => 
    ipcRenderer.invoke('homework:downloadZip', { studentId, className }),
  downloadMockMidtermZip: (studentId, className) =>
    ipcRenderer.invoke('homework:downloadMockMidtermZip', { studentId, className }),
  downloadFinalZip: (studentId, className) => 
    ipcRenderer.invoke('homework:downloadFinalZip', { studentId, className }),
  downloadTestCsv: (studentId, className) => ipcRenderer.invoke('homework:downloadTestCsv', { studentId, className }),
  unzipFile: (zipPath, targetDir) => ipcRenderer.invoke('homework:unzipFile', { zipPath, targetDir }),
  backupModifiedFiles: (extractedDir) => ipcRenderer.invoke('homework:backupModified', { extractedDir }),
  restoreModifiedFiles: (extractedDir) => ipcRenderer.invoke('homework:restoreModified', { extractedDir }),
  getExtractedDir: (studentId, className) => 
    ipcRenderer.invoke('homework:getExtractedDir', { studentId, className }),
  uploadHomeworkAttachment: (filePath, studentId, className, fileType = 'attachment') =>
    ipcRenderer.invoke('homework:uploadAttachment', { filePath, studentId, className, fileType }),
  pickHomeworkAttachment: () => ipcRenderer.invoke('ui:pickHomeworkAttachment'),
  
  // ===== 期末大作业 =====
  finalExamMarkdown: (opts) => ipcRenderer.invoke('final:md', opts || {}),
  finalExamStatus: (studentId, className) => 
    ipcRenderer.invoke('final:getStatus', { studentId, className }),
  uploadFinalFile: async (uiType, file, studentId, className) => {
    try {
      const ab = await file.arrayBuffer();
      const uint8 = new Uint8Array(ab);
      return await ipcRenderer.invoke('final:upload', {
        studentId,
        className,
        uiType,
        name: file.name,
        data: uint8
      });
    } catch (_) {
      const typeMap = {
        result: 'result_file',
        home: 'homepage_file',
        body: 'report_file',
        code: 'code_archive'
      };
      const base = await ipcRenderer.invoke('env:getBaseUrl');
      const url = String(base || '') + '/api/uploadFinaltest';
      const fd = new FormData();
      fd.append('student_id', studentId);
      if (className) fd.append('class_name', className);
      fd.append('file_type', typeMap[uiType] || uiType);
      fd.append('file', file, file.name);
      const resp = await fetch(url, { method: 'POST', body: fd });
      let data = {};
      try { data = await resp.json(); } catch {}
      const source = data && typeof data.data === 'object' ? data.data : data;
      return {
        ok: data.success !== false,
        success: data.success !== false,
        msg: data.msg || data.message || '',
        auc: source.auc,
        start_time: source.start_time,
        end_time: source.end_time
      };
    }
  },

  // ===== 期末大作业 final_auc 班级排名 =====
  getFinalRanking: (studentId, className, window = 3) =>
    ipcRenderer.invoke('final:getRanking', { studentId, className, window }),

  // ===== Python 执行 =====
  runPython: (cwd, entry) => ipcRenderer.invoke('exec:python', { cwd, entry }),
  onPythonLive: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('exec:python:live', handler);
    return () => ipcRenderer.removeListener('exec:python:live', handler);
  },
  
  // ===== 文件系统 =====
  listFiles: (dirPath) => ipcRenderer.invoke('fs:listFiles', { dirPath }),
  writeFile: (file, content, encoding) =>
    ipcRenderer.invoke('fs:writeFile', { file, content, encoding }),
  readFile: (file, encoding) => ipcRenderer.invoke('fs:readFile', { file, encoding }),
  countFiles: (dirPath) => ipcRenderer.invoke('fs:countFiles', { dirPath }),
  findFileInDir: (dirPath, fileName) => ipcRenderer.invoke('fs:findFileInDir', { dirPath, fileName }),
  fileSystem: {
    readFile: (file, encoding = 'utf-8') => ipcRenderer.invoke('fs:readFile', { file, encoding }),
    writeFile: (file, content, encoding) => 
      ipcRenderer.invoke('fs:writeFile', { file, content, encoding }),
    listFiles: (dirPath) => ipcRenderer.invoke('fs:listFiles', { dirPath })
  },
  
  // ===== 路径 =====
  paths: {
    getAssignmentDir: (studentId, className, assignmentId) => 
      ipcRenderer.invoke('homework:getAssignmentDir', { studentId, className, assignmentId })
  },
  
  // ===== 系统 =====
  showItem: (filePath) => ipcRenderer.invoke('sys:showItem', filePath),

  // ===== 期末大作业管理(教师端) =====
  finalAssignment: {
    status:        (className)            => ipcRenderer.invoke('finalAssignment:status', className),
    upload:        (args)                 => ipcRenderer.invoke('finalAssignment:upload', args),
    delete:        (args)                 => ipcRenderer.invoke('finalAssignment:delete', args),
    setTime:       (args)                 => ipcRenderer.invoke('finalAssignment:setTime', args),
    submissions:   (className)            => ipcRenderer.invoke('finalAssignment:submissions', className),
    downloadStudent: (args)               => ipcRenderer.invoke('finalAssignment:downloadStudent', args),
    downloadAll:   (className)            => ipcRenderer.invoke('finalAssignment:downloadAll', className),
    previewHtml:   (className)            => ipcRenderer.invoke('finalAssignment:previewHtml', className),
    applyToAll:    (className)            => ipcRenderer.invoke('finalAssignment:applyToAll', className),
  },
  openExternal: (url) => ipcRenderer.invoke('sys:openExternal', url),
  openPath: (filePath) => ipcRenderer.invoke('sys:openPath', filePath),
  quitApp: () => ipcRenderer.invoke('app:quit'),
  
  // ===== 窗口 =====
  openFinalBlank: () => ipcRenderer.invoke('ui:openFinalBlank'),
  openScoreBlank: (studentId) => ipcRenderer.invoke('ui:openScoreBlank', { studentId }),
  openAiAgents: () => ipcRenderer.invoke('ui:openAiAgents'),
  openAiCourse: () => ipcRenderer.invoke('ui:openAiCourse'),
  
  // ===== 更新 =====
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  // C 方案 - 静默更新 API
  appCheckForUpdates: () => ipcRenderer.invoke('app:checkForUpdates'),
  appGetUpdateStatus: () => ipcRenderer.invoke('app:getUpdateStatus'),
  appApplyUpdate: () => ipcRenderer.invoke('app:applyUpdate'),
  appSkipUpdate: () => ipcRenderer.invoke('app:skipUpdate'),
  appClearStaleUpdate: () => ipcRenderer.invoke('app:clearStaleUpdate'),
  // 监听主进程推过来的更新状态
  onUpdateStatus: (callback) => {
    const handler = (_e, payload) => callback(payload);
    ipcRenderer.on('app:updateStatus', handler);
    return () => ipcRenderer.removeListener('app:updateStatus', handler);
  },
  
  // ===== DOCX 解析 =====
  docxToHtml: (file) => ipcRenderer.invoke('docx:toHtml', { file }),
  docxToText: (file) => ipcRenderer.invoke('docx:toText', { file }),
  
  // ===== 页面导航 =====
  navigateTo: (page, role) => ipcRenderer.send('navigate:page', { page, role }),
  
  // ===== 日志 =====
  log: (message) => ipcRenderer.send('log:write', message),
});

// ========== 教师端专用 API (electronAPI) ==========
contextBridge.exposeInMainWorld('electronAPI', {
  getMachineId: () => ipcRenderer.invoke('device:getMachineId'),
  navigateToHome: () => ipcRenderer.send('navigate:page', { page: 'teacher:home' }),
  SetStudentId: (studentId) => ipcRenderer.send('set-student-id', studentId),
  getStudentId: () => ipcRenderer.invoke('get-student-id'),
  logToFile: (message) => ipcRenderer.send('log:write', message),
  setFullscreen: (enabled) => ipcRenderer.send('window:setFullscreen', enabled),
});

// ========== Markdown 渲染 ==========
function rewriteLinks(md, baseDir) {
  function repl(match, p1, p2, p3) {
    let url = p2.trim();
    if (/^https?:\/\//i.test(url)) {
      return `${p1}(#blocked)`;
    }
    const local = 'file://' + path.resolve(baseDir, 'assets', url);
    return `${p1}(${local})`;
  }
  md = md.replace(/(!\[[^\]]*\]\()([^)]+)(\))/g, repl);
  md = md.replace(/(\[[^\]]*\]\()([^)]+)(\))/g, repl);
  return md;
}

contextBridge.exposeInMainWorld('md', {
  renderLocal: (mdText, baseDir) => {
    const safeMd = rewriteLinks(mdText, baseDir);
    return marked.parse(safeMd);
  }
});

// ========== 兼容层 ==========
contextBridge.exposeInMainWorld('fsapi', {
  readFile: (file, encoding = 'utf-8') => ipcRenderer.invoke('fs:readFile', { file, encoding }),
});

// ========== Monaco 静态资源路径 ==========
contextBridge.exposeInMainWorld('monaco', {
  getBase: () => {
    const localDir = path.join(__dirname, '..', 'renderer', 'vendor', 'monaco');
    if (!fs.existsSync(localDir)) {
      const devDir = path.join(__dirname, '..', '..', 'node_modules', 'monaco-editor', 'min');
      return 'file://' + devDir.replace(/\\/g, '/');
    }
    return 'file://' + localDir.replace(/\\/g, '/');
  }
});
