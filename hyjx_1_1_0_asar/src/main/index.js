/**
 * 统一教学助手客户端 - 主进程入口
 * 合并学生端和教师端功能，通过登录时的工号/学号区分
 */

const { app, BrowserWindow, ipcMain, dialog, shell, session, Menu, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execSync } = require('child_process');
const axios = require('axios');
const crypto = require('crypto');
const FormData = require('form-data');
const extract = require('extract-zip');
const { isTeacherId } = require('../shared/constants');

// 禁用 GPU 硬件加速
app.disableHardwareAcceleration();

const APP_NAME = 'unified-education-client';
let mainWindow;

function getDefaultBackendBaseUrl() {
  if (process.env.BACKEND_BASE_URL) {
    return process.env.BACKEND_BASE_URL;
  }

  const repoRoot = path.resolve(__dirname, '../../..');
  const localBackendEntry = path.join(repoRoot, 'backend', 'main.py');
  if (fs.existsSync(localBackendEntry)) {
    return 'http://127.0.0.1:3000';
  }

  return 'https://lab.uibe.edu.cn';
}

let BASE_URL = getDefaultBackendBaseUrl();
// 真实备用域名: lab.uibe.edu.cn TLS 失败时切换到 www.uibe.online
const BACKUP_BASE_URL = 'https://www.uibe.online';
// HTTP 降级: 同一备用域名的 HTTP 端口(80 → 301 重定向回 HTTPS, 绕过 TLS 握手问题)
const HTTP_FALLBACK_URL = 'http://www.uibe.online';

// ========== 日志系统 ==========
const logPath = path.join(app.getPath('userData'), 'client.log');
function log(message, level = 'info') {
  const time = new Date().toISOString();
  const logMsg = `[${time}] [${level.toUpperCase()}] ${message}\n`;
  try {
    fs.appendFileSync(logPath, logMsg, 'utf-8');
  } catch (e) {
    console.error('写日志失败:', e);
  }
  console.log(`[${level.toUpperCase()}] ${message}`);
}

// ========== 图标路径 ==========
function getIconPath() {
  const dev = path.join(__dirname, '../image/tupian.ico');
  const prod = path.join(process.resourcesPath, 'image', 'tupian.ico');
  if (fs.existsSync(dev)) return dev;
  if (fs.existsSync(prod)) return prod;
  return dev;
}

// ========== 路径工具 ==========
function getUserDataDir() {
  const dir = path.join(app.getPath('userData'), APP_NAME);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function tempDir() {
  const dir = path.join(os.tmpdir(), APP_NAME);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function studentDir(studentId) {
  const dir = path.join(getUserDataDir(), 'students', studentId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function homeworkZipDir(studentId, className) {
  return path.join(getUserDataDir(), 'homework_zips', studentId, className);
}

function courseRoot(studentId) {
  const dir = path.join(studentDir(studentId), `${studentId}_courses`);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeAtomic(filePath, data) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}

// ========== 机器 ID（学生端方案）==========
const MACHINE_ID_FINGERPRINT_VERSION = 2;

function safeExecText(command) {
  try {
    return execSync(command, { stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8').trim();
  } catch (e) {
    return '';
  }
}

function safeReadText(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return '';
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch (e) {
    return '';
  }
}

function getWindowsMachineGuidSync() {
  const out = safeExecText('REG QUERY "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid');
  const m = out.match(/MachineGuid\s+REG_SZ\s+([^\r\n]+)/i);
  return m ? m[1].trim() : '';
}

function getMacPlatformUuidSync() {
  const out = safeExecText('ioreg -rd1 -c IOPlatformExpertDevice');
  const uuidMatch = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
  return uuidMatch ? uuidMatch[1].trim() : '';
}

function getMacSerialNumberSync() {
  const out = safeExecText('ioreg -rd1 -c IOPlatformExpertDevice');
  const serialMatch = out.match(/"IOPlatformSerialNumber"\s*=\s*"([^"]+)"/);
  return serialMatch ? serialMatch[1].trim() : '';
}

function getLinuxMachineIdSync() {
  return (
    safeReadText('/etc/machine-id') ||
    safeReadText('/var/lib/dbus/machine-id') ||
    safeReadText('/sys/class/dmi/id/product_uuid')
  );
}

function getNetworkMacs() {
  const nets = os.networkInterfaces() || {};
  const macs = [];
  for (const key of Object.keys(nets)) {
    for (const ni of nets[key]) {
      try {
        if (
          ni &&
          !ni.internal &&
          ni.mac &&
          ni.mac !== '00:00:00:00:00:00'
        ) {
          macs.push(ni.mac.toLowerCase());
        }
      } catch (e) { }
    }
  }
  return Array.from(new Set(macs)).sort();
}

function getStablePlatformFingerprints() {
  const base = {
    version: MACHINE_ID_FINGERPRINT_VERSION,
    platform: process.platform || '',
    arch: process.arch || ''
  };

  if (process.platform === 'win32') {
    return {
      ...base,
      machineGuid: getWindowsMachineGuidSync()
    };
  }

  if (process.platform === 'darwin') {
    return {
      ...base,
      platformUuid: getMacPlatformUuidSync(),
      serialNumber: getMacSerialNumberSync()
    };
  }

  return {
    ...base,
    machineId: getLinuxMachineIdSync()
  };
}

function computeStableMachineHash() {
  // 只基于纯硬件信息计算，不包含 version/platform/arch
  // 确保客户端删除重装、设备.json 丢失后，只要硬件没变，machine_id 仍然一致
  const basis = JSON.stringify({
    machineGuid: process.platform === 'win32' ? getWindowsMachineGuidSync() : undefined,
    platformUuid: process.platform === 'darwin' ? getMacPlatformUuidSync() : undefined,
    serialNumber: process.platform === 'darwin' ? getMacSerialNumberSync() : undefined,
    machineId: process.platform === 'linux' ? getLinuxMachineIdSync() : undefined
  });
  return crypto.createHash('sha256').update(basis).digest('hex');
}

function ensureMachineId() {
  const file = path.join(getUserDataDir(), 'device.json');
  const isHash = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
  if (fs.existsSync(file)) {
    try {
      const obj = JSON.parse(fs.readFileSync(file, 'utf-8'));
      // 只要存在有效的 machine_id 就复用，不再因版本号变化而重新生成
      // 避免更新客户端后设备绑定失效
      if (obj && obj.machine_id && isHash(obj.machine_id)) {
        // 如果版本号有变化，静默更新文件中的版本号，但保持 machine_id 不变
        if (obj.fingerprint_version !== MACHINE_ID_FINGERPRINT_VERSION) {
          writeAtomic(
            file,
            JSON.stringify(
              {
                machine_id: obj.machine_id,
                fingerprint_version: MACHINE_ID_FINGERPRINT_VERSION
              },
              null,
              2
            )
          );
        }
        return obj.machine_id;
      }
    } catch (e) { }
  }
  const machine_id = computeStableMachineHash();
  writeAtomic(
    file,
    JSON.stringify(
      {
        machine_id,
        fingerprint_version: MACHINE_ID_FINGERPRINT_VERSION
      },
      null,
      2
    )
  );
  return machine_id;
}

// ========== HTTP 客户端 ==========
const http = axios.create({
  baseURL: BASE_URL,
  timeout: 20000
});

// ========== 创建主窗口 ==========
function createWindow() {
  log('Creating main window');
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 1000,
    minHeight: 680,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      enableRemoteModule: false,
      webviewTag: true
    },
    titleBarStyle: 'hiddenInset',
    icon: getIconPath()
  });

  // CSP 配置
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const url = details.url || '';
    const isLocalFile = url.startsWith('file://');
    const isBackend = url.startsWith(BASE_URL);

    if (isLocalFile || isBackend) {
      const csp = [
        "default-src 'self'",
        "img-src 'self' file: data: blob:",
        "style-src 'self' 'unsafe-inline'",
        "script-src 'self' 'unsafe-inline'",
        "font-src 'self' data:",
        "connect-src 'self' http: https: ws: wss:",
        "object-src 'self' file: data:",
        "media-src 'self' file: data: https://lab.uibe.edu.cn https://www.uibe.online https://lab.uibe.edu.cn:8999 http://127.0.0.1:8999",
        "frame-src 'self' file: https://lab.uibe.edu.cn https://www.uibe.online https://lab.uibe.edu.cn:8999 http://127.0.0.1:8999",
        "child-src 'self' https://lab.uibe.edu.cn https://www.uibe.online https://lab.uibe.edu.cn:8999 http://127.0.0.1:8999"
      ].join('; ');

      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [csp]
        }
      });
    } else {
      callback({ responseHeaders: { ...details.responseHeaders } });
    }
  });

  // 加载统一登录页
  mainWindow.loadFile(path.join(__dirname, '../renderer/login/index.html'));
  log('Loaded login page');

  // 隐藏菜单栏
  Menu.setApplicationMenu(null);
}

// ========== 静默更新系统（C 方案）==========
// 核心思路:启动后台静默检测+下载,退出时只弹 1 次对话框,中途对用户零打扰
let updateCheckInFlight = null;
// 内存中的待更新状态(与 pending.json 同步)
let pendingUpdate = null;
// 用于退出时阻止默认关闭,询问用户
let isQuitting = false;

function resolveUpdatePlatform(input) {
  const guess = (input || process.platform || '').toLowerCase();
  if (guess.includes('darwin') || guess.includes('mac')) return 'darwin';
  if (guess.includes('linux')) return 'linux';
  return 'win32';
}

// ========== 待更新状态持久化 ==========
function getUpdateDir() {
  const dir = path.join(app.getPath('userData'), 'update');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getPendingMetaPath() {
  return path.join(getUpdateDir(), 'pending.json');
}

function readPending() {
  try {
    if (!fs.existsSync(getPendingMetaPath())) return null;
    const raw = fs.readFileSync(getPendingMetaPath(), 'utf-8');
    const data = JSON.parse(raw);
    // 校验文件还存在
    if (data && data.file && fs.existsSync(data.file)) return data;
    // 文件丢了,清理
    clearPending();
    return null;
  } catch (e) {
    return null;
  }
}

function writePending(data) {
  try {
    pendingUpdate = data;
    fs.writeFileSync(getPendingMetaPath(), JSON.stringify(data, null, 2), 'utf-8');
  } catch (e) {
    log('写入 pending.json 失败: ' + e.message, 'error');
  }
}

function clearPending() {
  try {
    pendingUpdate = null;
    if (fs.existsSync(getPendingMetaPath())) fs.unlinkSync(getPendingMetaPath());
  } catch (_) { }
}

// 推送给前端的当前状态
function broadcastUpdateStatus(payload) {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('app:updateStatus', payload);
    }
  } catch (_) { }
}

function destroyStreamQuietly(stream) {
  try {
    if (stream && typeof stream.destroy === 'function') {
      stream.destroy();
    }
  } catch (_) { }
}

function parseDownloadFilename(headers, platform) {
  const dispo =
    headers['content-disposition'] ||
    headers['Content-Disposition'] ||
    '';
  const match =
    dispo.match(/filename\*?=(?:UTF-8''|")(.*?)(?:;|$|")/i) ||
    dispo.match(/filename=([^;]+)/i);
  if (match && match[1]) {
    try {
      return decodeURIComponent(match[1].replace(/"/g, ''));
    } catch (_) {
      return match[1].replace(/"/g, '');
    }
  }

  const fallback = {
    win32: 'latest_exam_client.exe',
    darwin: 'latest_exam_client.dmg',
    linux: 'latest_exam_client_linux'
  };
  return fallback[platform] || fallback.win32;
}

function parseVersionFromFilename(filename) {
  const text = String(filename || '');
  const match = text.match(/(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/);
  return match ? match[1] : '';
}

function compareVersions(a, b) {
  const parse = (value) =>
    String(value || '')
      .split('-')[0]
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0);
  const av = parse(a);
  const bv = parse(b);
  const len = Math.max(av.length, bv.length);
  for (let i = 0; i < len; i += 1) {
    const left = av[i] || 0;
    const right = bv[i] || 0;
    if (left > right) return 1;
    if (left < right) return -1;
  }
  return 0;
}

function destroyStreamQuietly(stream) {
  try {
    if (stream && typeof stream.destroy === 'function') {
      stream.destroy();
    }
  } catch (_) { }
}

async function saveDownloadedStream(stream, filePath, onProgress) {
  let received = 0;
  let total = 0;
  return new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(filePath);
    stream.on('data', (chunk) => {
      received += chunk.length;
      if (onProgress) onProgress(received, total);
    });
    stream.on('response', (res) => {
      const len = parseInt(res.headers['content-length'] || '0', 10);
      if (len > 0) total = len;
    });
    stream.pipe(writer);
    writer.on('finish', () => resolve({ received, total }));
    writer.on('error', reject);
    stream.on('error', reject);
  });
}

/**
 * 静默更新（C 方案）：
 * 1. 后台 HTTP 检测新版本（无任何 UI 打扰）
 * 2. 发现新版本 → 静默下载到 userData/update/v<version>/<filename>
 *    下载进度通过 IPC 推给前端(底栏文字/小角标,可忽略)
 * 3. 下载完成 → 写 pending.json 记录 { version, file, downloadedAt }
 * 4. 退出时的"立即更新 / 稍后再说"弹窗由 promptUpdateOnQuit() 单独处理
 *
 * 整个过程中用户看不到任何弹窗、不会被打断、不会要求选保存位置。
 *
 * 保留旧 API(checkForUpdates)以兼容调用方,内部走静默流程。
 */
async function checkForUpdates() {
  if (updateCheckInFlight) {
    return updateCheckInFlight;
  }

  updateCheckInFlight = (async () => {
    const platform = resolveUpdatePlatform();
    const currentVersion = app.getVersion();
    let response = null;
    try {
      log(`静默检测更新: current=${currentVersion}, platform=${platform}`);
      broadcastUpdateStatus({ phase: 'checking', currentVersion });

      response = await http.get('/api/downloads/latest_exam_client', {
        params: { platform },
        responseType: 'stream',
        validateStatus: (s) => s >= 200 && s < 300
      });

      const filename = parseDownloadFilename(response.headers || {}, platform);
      const latestVersion = parseVersionFromFilename(filename);
      log(`服务器最新包: ${filename}${latestVersion ? `, version=${latestVersion}` : ''}`);

      if (!latestVersion) {
        destroyStreamQuietly(response.data);
        broadcastUpdateStatus({ phase: 'idle' });
        return { checking: false, downloaded: false, version: null, error: '无法识别版本号' };
      }

      if (compareVersions(latestVersion, currentVersion) <= 0) {
        destroyStreamQuietly(response.data);
        // 已经是最新版 → 清理残留 pending
        if (readPending()) clearPending();
        log(`已是最新版本: ${currentVersion}`);
        broadcastUpdateStatus({ phase: 'upToDate', currentVersion, latestVersion });
        return { checking: false, downloaded: false, version: latestVersion, available: false };
      }

      // 已有同版本 pending → 不重复下载
      const existing = readPending();
      if (existing && existing.version === latestVersion) {
        destroyStreamQuietly(response.data);
        log(`新版本 v${latestVersion} 已就绪(此前已下载)`);
        broadcastUpdateStatus({
          phase: 'ready',
          version: latestVersion,
          currentVersion,
          file: existing.file
        });
        return {
          checking: false,
          downloaded: true,
          version: latestVersion,
          file: existing.file,
          available: true
        };
      }

      // === 静默下载到 userData/update/v<version>/<filename> ===
      // 关键:此阶段没有任何 dialog,完全不打扰用户
      const targetDir = path.join(getUpdateDir(), `v${latestVersion}`);
      if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
      const targetFile = path.join(targetDir, filename);

      // 进度回调(写到内存,定时器节流推给前端)
      let lastBroadcastAt = 0;
      const onProgress = (received, total) => {
        const now = Date.now();
        if (now - lastBroadcastAt < 1000) return; // 节流:1s 最多 1 次
        lastBroadcastAt = now;
        broadcastUpdateStatus({
          phase: 'downloading',
          version: latestVersion,
          currentVersion,
          received,
          total,
          percent: total > 0 ? Math.floor((received / total) * 100) : null
        });
      };

      log(`静默下载: ${filename} → ${targetFile}`);
      const { received, total } = await saveDownloadedStream(
        response.data,
        targetFile,
        onProgress
      );
      log(`下载完成: ${targetFile} (${received}/${total} bytes)`);

      // 写 pending 状态
      writePending({
        version: latestVersion,
        file: targetFile,
        downloadedAt: new Date().toISOString(),
        skipCount: 0
      });

      broadcastUpdateStatus({
        phase: 'ready',
        version: latestVersion,
        currentVersion,
        file: targetFile
      });

      return {
        checking: false,
        downloaded: true,
        version: latestVersion,
        file: targetFile,
        available: true
      };
    } catch (err) {
      if (response && response.data) {
        destroyStreamQuietly(response.data);
      }
      const message = (err && err.message) || '更新检测失败';
      log('静默更新检测失败: ' + message, 'error');
      broadcastUpdateStatus({ phase: 'error', error: message });
      return { checking: false, downloaded: false, error: message };
    }
  })().finally(() => {
    updateCheckInFlight = null;
  });

  return updateCheckInFlight;
}

/**
 * 检测当前运行模式 + 给定更新包类型 → 决定更新策略
 * 返回:
 *   - 'portable-exe': 单 .exe 文件(Windows portable / Linux AppImage)→ 用 .bat 脚本覆盖
 *   - 'installer': NSIS .exe / MSI → 直接 openPath 让安装器处理
 *   - 'dmg': macOS 磁盘镜像 → 挂载后提示用户拖到 Applications
 *   - 'zip': 压缩包 → 提示用户手动解压覆盖
 *   - 'unknown': 兜底走 openPath
 */
function detectUpdateStrategy(updateFile) {
  if (!updateFile) return 'unknown';
  const ext = path.extname(updateFile).toLowerCase();
  const platform = process.platform;

  if (platform === 'win32') {
    if (ext === '.exe') {
      // 简易判断:文件名含 portable/绿色版字样,或 currentVersion < latestVersion(说明是完整新包)
      // 这里保守:直接当 portable 处理(已经是 portable 客户端)
      return 'portable-exe';
    }
    if (ext === '.msi') return 'installer';
  }

  if (platform === 'darwin') {
    if (ext === '.dmg') return 'dmg';
    if (ext === '.zip') return 'zip';
  }

  if (platform === 'linux') {
    if (ext === '.appimage' || ext === '' || ext === '.zip') return 'portable-exe';
  }

  return 'unknown';
}

/**
 * 跨平台静默更新(覆盖原来的 exe)
 * 关键点:不能直接 shell.openPath(.exe),否则会双开
 * 改用 spawn 一个外部脚本,等主进程退出后再覆盖 + 启动
 */
function applyPortableUpdate(updateFile) {
  const currentExe = process.execPath;
  const updateDir = getUpdateDir();
  const strategy = detectUpdateStrategy(updateFile);
  log(`更新策略: ${strategy}, updateFile=${updateFile}, currentExe=${currentExe}`);

  if (strategy !== 'portable-exe') {
    // 非 portable:交给系统/安装器处理
    return shell.openPath(updateFile).then(() => ({ mode: 'openPath' }));
  }

  // ============ portable .exe 覆盖替换流程 ============
  if (process.platform === 'win32') {
    // 生成 .bat 脚本:
    //   1. 等待 2 秒(让主进程完全退出)
    //   2. 用新 exe 覆盖当前 exe
    //   3. 启动新版本
    //   4. 自删 .bat
    const batPath = path.join(updateDir, `apply_update_${Date.now()}.bat`);
    const updateFileWin = updateFile.replace(/'/g, "''");
    const currentExeWin = currentExe.replace(/'/g, "''");

    const bat = `@echo off
chcp 65001 >nul
title 正在更新到新版本...
echo 等待主进程退出...
ping 127.0.0.1 -n 3 >nul

echo 正在替换 ${currentExeWin}
copy /Y "${updateFileWin}" "${currentExeWin}" >nul
if errorlevel 1 (
  echo 替换失败,请手动操作
  echo 新版本位置: ${updateFileWin}
  pause
  exit /b 1
)

echo 启动新版本...
start "" "${currentExeWin}"
exit
`;
    fs.writeFileSync(batPath, bat, 'utf-8');
    log('写入 .bat 脚本: ' + batPath);

    // spawn .bat(独立进程,父进程退出后继续跑)
    const child = spawn('cmd.exe', ['/c', batPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.unref();
    return Promise.resolve({ mode: 'portable-bat', script: batPath });
  }

  if (process.platform === 'darwin') {
    // Mac:同样思路,用 .command 脚本
    const scriptPath = path.join(updateDir, `apply_update_${Date.now()}.command`);
    const currentAppBundle = path.dirname(path.dirname(currentExe)); // .../Foo.app
    const newAppBundleGuess = updateFile.replace(/\.zip$/, '.app');

    const sh = `#!/bin/bash
sleep 2
echo "正在替换 ${currentAppBundle} ..."
rm -rf "${currentAppBundle}"
if [[ "${updateFile}" == *.zip ]]; then
  unzip -q -o "${updateFile}" -d "$(dirname "${currentAppBundle}")"
else
  mv "${newAppBundleGuess}" "${currentAppBundle}" 2>/dev/null || cp -R "${updateFile}" "${currentAppBundle}"
fi
echo "启动新版本..."
open "${currentAppBundle}"
rm -- "$0"
exit
`;
    fs.writeFileSync(scriptPath, sh, { mode: 0o755 });
    log('写入 .command 脚本: ' + scriptPath);

    const child = spawn('/bin/bash', [scriptPath], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
    return Promise.resolve({ mode: 'portable-sh', script: scriptPath });
  }

  if (process.platform === 'linux') {
    const scriptPath = path.join(updateDir, `apply_update_${Date.now()}.sh`);
    const sh = `#!/bin/bash
sleep 2
chmod +x "${updateFile}"
cp -f "${updateFile}" "${currentExe}"
nohup "${currentExe}" >/dev/null 2>&1 &
rm -- "$0"
exit
`;
    fs.writeFileSync(scriptPath, sh, { mode: 0o755 });
    log('写入 .sh 脚本: ' + scriptPath);

    const child = spawn('/bin/bash', [scriptPath], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
    return Promise.resolve({ mode: 'portable-sh', script: scriptPath });
  }

  // 兜底
  return shell.openPath(updateFile).then(() => ({ mode: 'fallback-openPath' }));
}

/**
 * 退出前单次弹窗(整个 C 方案中用户唯一一次被打扰的时刻)
 *  - 拿到 pending → 弹 1 次"立即更新 / 稍后再说"
 *  - 用户点"立即更新" → 调 applyPortableUpdate() + app.quit()(主进程退出后,外部脚本接管覆盖+启动)
 *  - 用户点"稍后再说" → 写 skipCount, 静默退出
 *  - 没有 pending → 直接退出
 */
async function promptUpdateOnQuit() {
  const pending = readPending();
  if (!pending) {
    return { needQuit: true, action: 'no-update' };
  }

  const parent = BrowserWindow.getFocusedWindow() || mainWindow;
  const result = await dialog.showMessageBox(parent, {
    type: 'info',
    buttons: ['立即更新', '稍后再说'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    title: '新版本已就绪',
    message: `新版本 v${pending.version} 已下载完成`,
    detail: '点击"立即更新"将自动关闭客户端并替换为新版本,新版本会自动启动。\n点击"稍后再说"则下次启动再次提醒。'
  });

  if (result.response === 0) {
    try {
      const r = await applyPortableUpdate(pending.file);
      log('触发更新: ' + JSON.stringify(r));
    } catch (e) {
      log('应用更新失败: ' + e.message, 'error');
      // 兜底:在文件管理器中显示新版本
      try { shell.showItemInFolder(pending.file); } catch (_) { }
    }
    return { needQuit: true, action: 'updated' };
  }

  // 稍后再说:累加 skipCount
  const skipCount = (pending.skipCount || 0) + 1;
  writePending({ ...pending, skipCount, lastSkipAt: new Date().toISOString() });
  return { needQuit: true, action: 'skipped', skipCount };
}

// ========== IPC 处理器 ==========

// 获取基础 URL
ipcMain.handle('env:getBaseUrl', async () => BASE_URL);

// 获取机器 ID
// 由学生端 IPC（src/main/ipc/student.js）统一提供，避免重复注册 handler

// 获取应用版本
ipcMain.handle('app:getVersion', async () => app.getVersion());

// ========== C 方案 - 静默更新相关 IPC ==========

// 触发静默更新检测(不弹任何对话框)
ipcMain.handle('app:checkForUpdates', async () => {
  return checkForUpdates();
});

// 查询当前是否有已就绪的待更新包
ipcMain.handle('app:getUpdateStatus', async () => {
  const pending = readPending();
  if (!pending) return { hasUpdate: false };
  const currentVersion = app.getVersion();
  return {
    hasUpdate: true,
    version: pending.version,
    currentVersion,
    file: pending.file,
    downloadedAt: pending.downloadedAt,
    skipCount: pending.skipCount || 0
  };
});

// 用户在 app 内主动点击"立即更新"
ipcMain.handle('app:applyUpdate', async () => {
  const pending = readPending();
  if (!pending) return { ok: false, error: '没有可用的更新包' };
  try {
    const r = await applyPortableUpdate(pending.file);
    log('用户主动触发更新: ' + JSON.stringify(r));
    return { ok: true, mode: r.mode };
  } catch (e) {
    try { shell.showItemInFolder(pending.file); } catch (_) { }
    return { ok: false, error: e.message };
  }
});

// 用户在 app 内主动点击"稍后再说"(关闭顶部提示)
ipcMain.handle('app:skipUpdate', async () => {
  const pending = readPending();
  if (!pending) return { ok: true };
  const skipCount = (pending.skipCount || 0) + 1;
  writePending({ ...pending, skipCount, lastSkipAt: new Date().toISOString() });
  return { ok: true, skipCount };
});

// 启动时若用户已经更新过(应用版本 >= pending.version)→ 清理
ipcMain.handle('app:clearStaleUpdate', async () => {
  const pending = readPending();
  if (pending && compareVersions(pending.version, app.getVersion()) <= 0) {
    clearPending();
    return { cleared: true };
  }
  return { cleared: false };
});

// 检查更新（兼容旧调用）
ipcMain.handle('update:check', async () => {
  return checkForUpdates();
});

// 判断是否为教师
ipcMain.handle('auth:isTeacher', async (_e, { inputId }) => {
  return isTeacherId(inputId);
});

// 学生验证由 src/main/ipc/student.js 提供（避免重复注册）

// 教师验证（可选，允许离线）
ipcMain.handle('auth:validateTeacher', async (_e, { teacherId }) => {
  log('Validating teacher: ' + teacherId);
  const machine_id = ensureMachineId();

  // 教师端允许离线登录
  if (!isTeacherId(teacherId)) {
    return { ok: false, error: '无效的教师工号' };
  }

  // 尝试连接服务器获取数据
  try {
    const res = await http.post('/api/validateTeacherMachine', { teacher_id: teacherId, machine_id });
    return { ok: true, data: res.data };
  } catch (e) {
    log('Teacher validate warning: ' + e.message, 'warn');
    // 教师端允许离线，返回成功
    return { ok: true, data: { class_names: [], attendance_info: {} } };
  }
});

// 页面导航
ipcMain.on('navigate:page', (_e, { page, role }) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  // 兼容调用：如果传入了 role 但 page 没有前缀（例如 page='home', role='teacher'）
  let resolvedPage = page;
  try {
    const pageStr = String(page || '');
    const roleStr = typeof role === 'string' ? role.trim() : '';
    if (roleStr && pageStr && !pageStr.includes(':')) {
      resolvedPage = `${roleStr}:${pageStr}`;
    }
  } catch (_) {
    resolvedPage = page;
  }

  const pages = {
    'student:home': '../renderer/student/home.html',
    'student:course': '../renderer/student/course.html',
    'student:homework': '../renderer/student/homework.html',
    'student:ai-agents': '../renderer/student/ai-agents.html',
    'student:ai-course': '../renderer/student/ai-course.html',
    'student:final-submit': '../renderer/student/final-submit.html',
    'student:score-query': '../renderer/student/score-query.html',
    // 教师端首页应进入控制台（避免落到学生式的 base TabBar）
    'teacher:home': '../renderer/teacher/pages/teacher/dashboard/index.html',
    'teacher:dashboard': '../renderer/teacher/pages/teacher/dashboard/index.html',
    'login': '../renderer/login/index.html'
  };

  const pagePath = pages[resolvedPage];
  if (pagePath) {
    log('Navigating to: ' + resolvedPage);
    mainWindow.loadFile(path.join(__dirname, pagePath));
  } else {
    log(`Unknown navigation page: page=${String(page)} role=${String(role)} resolved=${String(resolvedPage)}`, 'warn');
  }
});

// 日志
ipcMain.on('log:write', (_e, message) => {
  log(message);
});

// 全屏设置
ipcMain.on('window:setFullscreen', (_e, enabled) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setFullScreen(!!enabled);
  }
});

// 退出应用
ipcMain.handle('app:quit', () => {
  app.quit();
});

// 打开外部链接
ipcMain.handle('sys:openExternal', async (_e, url) => {
  await shell.openExternal(url);
});

// 显示文件
ipcMain.handle('sys:showItem', async (_e, filePath) => {
  shell.showItemInFolder(filePath);
});

// ========== 加载学生端 IPC 处理器 ==========
try {
  log('Loading student IPC handlers...');
  const setupStudentIpc = require('./ipc/student');
  setupStudentIpc({
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
    os,
    FormData,
    getMainWindow: () => mainWindow,
    ensureMachineId,
    getIconPath,
    log
  });
  log('Student IPC handlers loaded');
} catch (err) {
  log('Failed to load student IPC handlers: ' + err.message, 'error');
}

// ========== 加载教师端 IPC 处理器 ==========
try {
  log('Loading teacher IPC handlers...');
  const setupTeacherIpc = require('./ipc/teacher');
  setupTeacherIpc({
    ipcMain,
    app,
    BrowserWindow,
    dialog,
    http,
    BASE_URL,
    BACKUP_BASE_URL,
    HTTP_FALLBACK_URL,
    getUserDataDir,
    tempDir,
    writeAtomic,
    spawn,
    execSync,
    extract,
    fs,
    path,
    os,
    FormData,
    getMainWindow: () => mainWindow,
    ensureMachineId,
    getIconPath,
    log
  });
  log('Teacher IPC handlers loaded');
} catch (err) {
  log('Failed to load teacher IPC handlers: ' + err.message, 'error');
}

// ========== 启动时从后端获取教师工号列表 ==========
async function fetchTeacherIdsFromServer() {
  try {
    const { setDynamicTeacherIds } = require('../shared/constants');
    const response = await http.get('/api/teacher_ids', { timeout: 5000 });
    const data = response.data;
    if (data && data.success && Array.isArray(data.data?.teacher_ids)) {
      setDynamicTeacherIds(data.data.teacher_ids);
      log(`从服务器加载了 ${data.data.teacher_ids.length} 个教师工号`);
    }
  } catch (e) {
    log('无法从服务器获取教师工号列表，使用本地硬编码列表', 'warn');
  }
}

// ========== 应用生命周期 ==========

// 退出流程控制:
//   1. 用户点关闭窗口 → 触发 before-quit
//   2. before-quit 拦截 → 检查 pending → 有则弹 1 次"立即更新/稍后再说"
//   3. 用户做选择后 → isQuitting = true → app.quit()
//   4. isQuitting = true 时,before-quit 不再拦截,直接放行
app.on('before-quit', async (event) => {
  if (isQuitting) return; // 已经在退出流程
  const pending = readPending();
  if (!pending) return;   // 没有待更新包,直接退出
  event.preventDefault();
  isQuitting = true;
  try {
    const result = await promptUpdateOnQuit();
    log('退出前更新提示结果: ' + JSON.stringify(result));
  } catch (e) {
    log('退出前更新提示异常: ' + e.message, 'error');
  }
  app.quit();
});

app.whenReady().then(async () => {
  app.setAppUserModelId(APP_NAME);
  log('App ready, baseUrl: ' + BASE_URL);

  // 从服务器获取最新教师工号列表
  await fetchTeacherIdsFromServer();

  // 设置 User-Agent
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['https://lab.uibe.edu.cn/*', 'https://www.uibe.online/*'] },
    (details, callback) => {
      details.requestHeaders['User-Agent'] = 'unified_client';
      callback({ requestHeaders: details.requestHeaders });
    }
  );

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // ========== C 方案 - 启动后静默检查更新 ==========
  // 延迟 3 秒开始,避免抢首屏资源
  setTimeout(() => {
    checkForUpdates().catch((e) =>
      log('启动静默更新异常: ' + e.message, 'error')
    );
  }, 3000);
});

app.on('window-all-closed', () => {
  log('window-all-closed');
  if (process.platform !== 'darwin') app.quit();
});
