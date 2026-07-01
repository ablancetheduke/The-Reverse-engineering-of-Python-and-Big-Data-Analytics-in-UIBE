// 期末大作业管理页面逻辑
import { navigateToTeacherDashboard } from '../../../../shared/navigation.js';

const $ = (id) => document.getElementById(id);
const showLoading = (v) => $('loadingOverlay')?.classList.toggle('show', !!v);

let className = '';
let statusCache = null;
let submissionsCache = [];
let filteredSubmissions = [];
let currentRole = null;
let timeStateEl = null;
let timeStateTimer = null;

const ROLE_LABEL = {
  zip:      '期末大作业.zip',
  html:     '大作业描述.html',
  test_csv: 'test.csv',
  true_y:   'Test_True_Y.csv',
};

const FILE_EXT = {
  zip:      '.zip',
  html:     ['.html', '.htm'],
  test_csv: '.csv',
  true_y:   '.csv',
};

// ========== 初始化 ==========
document.addEventListener('DOMContentLoaded', async () => {
  const teacherId = localStorage.getItem('teacherId');
  if (!teacherId) {
    window.location.href = '../login/index.html';
    return;
  }

  className = sessionStorage.getItem('selectedClass') || '';
  if (!className) {
    navigateToTeacherDashboard('../dashboard/index.html');
    return;
  }

  // Back
  document.querySelector('.back-chip')?.addEventListener('click', (e) => {
    e.preventDefault();
    navigateToTeacherDashboard('../class-detail/index.html');
  });

  // 时间按钮
  $('saveTimeBtn')?.addEventListener('click', saveTime);
  $('clearTimeBtn')?.addEventListener('click', clearTime);
  timeStateEl = $('timeState');

  // 上传按钮
  document.querySelectorAll('.upload-btn').forEach(btn => {
    btn.addEventListener('click', () => triggerUpload(btn.dataset.role));
  });
  document.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', () => deleteFile(btn.dataset.role));
  });
  $('hiddenFileInput')?.addEventListener('change', handleFileSelected);

  // 表格筛选
  $('statusFilter')?.addEventListener('change', applyFilters);
  $('searchInput')?.addEventListener('input', debounce(applyFilters, 300));
  $('downloadAllBtn')?.addEventListener('click', downloadAllSubmissions);

  // Modal 关闭
  document.querySelectorAll('[data-close]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.close;
      const m = $(id);
      if (m) m.style.display = 'none';
    });
  });

  // 应用到所有班级按钮
  $('applyToAllBtn')?.addEventListener('click', applyToAllClasses);

  // 班级名显示
  $('className').textContent = className;

  await loadAll();
  setInterval(refreshWindowState, 30000);
});

async function loadAll() {
  showLoading(true);
  try {
    await Promise.all([loadStatus(), loadSubmissions()]);
  } catch (e) {
    console.error(e);
    alert('加载失败: ' + e.message);
  } finally {
    showLoading(false);
  }
}

async function loadStatus() {
  const r = await window.api.finalAssignment.status(className);
  if (!r || !r.success) {
    throw new Error(r?.message || '获取状态失败');
  }
  statusCache = r;
  // 子目录显示
  $('sharedSubdir').textContent = r.shared_subdir || '(未匹配)';
  // 统计
  $('studentCount').textContent = r.student_count;
  $('submittedCount').textContent = r.submitted_count;
  $('submissionRate').textContent = `${r.submission_rate}%`;
  // 时间窗
  fillTimeInputs(r.start_time, r.end_time);
  refreshWindowState();
  // 文件
  renderFiles(r.files || {});
}

function fillTimeInputs(start, end) {
  if (start) $('startTime').value = toLocalInput(start);
  if (end) $('endTime').value = toLocalInput(end);
}

function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function refreshWindowState() {
  const el = $('windowState');
  if (!el) return;
  el.classList.add('compact');
  const start = $('startTime').value;
  const end = $('endTime').value;
  if (!start || !end) {
    el.textContent = '未设置';
    el.style.color = '#94a3b8';
    return;
  }
  const s = new Date(start);
  const e = new Date(end);
  const now = new Date();
  if (now < s) {
    el.textContent = `⏳ 未开始(${formatCountdown(s - now)})`;
    el.style.color = '#f59e0b';
  } else if (now > e) {
    el.textContent = '🔴 已结束';
    el.style.color = '#dc2626';
  } else {
    el.textContent = `🟢 进行中(剩 ${formatCountdown(e - now)})`;
    el.style.color = '#16a34a';
  }
}

function formatCountdown(ms) {
  if (ms <= 0) return '0分';
  const totalSec = Math.floor(ms / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d}天`);
  if (h) parts.push(`${h}时`);
  parts.push(`${m}分`);
  return parts.join('');
}

function renderFiles(files) {
  Object.keys(ROLE_LABEL).forEach(role => {
    const meta = $(`meta-${role}`);
    const delBtn = document.querySelector(`.delete-btn[data-role="${role}"]`);
    const info = files[role];
    if (info) {
      const sizeKB = (info.size / 1024).toFixed(1);
      const sizeMB = (info.size / 1024 / 1024).toFixed(2);
      const sizeStr = info.size > 1024 * 1024 ? `${sizeMB} MB` : `${sizeKB} KB`;
      meta.textContent = `已上传 · ${sizeStr}`;
      if (delBtn) delBtn.disabled = false;
    } else {
      meta.textContent = '未上传';
      if (delBtn) delBtn.disabled = true;
    }
  });

  // HTML 预览按钮(在 html card 旁)
  const htmlCard = document.querySelector('.file-card[data-role="html"]');
  if (htmlCard && !htmlCard.querySelector('.preview-html-btn')) {
    const btn = document.createElement('button');
    btn.className = 'upload-btn preview-html-btn';
    btn.textContent = '预览';
    btn.style.marginTop = '4px';
    btn.addEventListener('click', previewHtml);
    if (files.html) htmlCard.querySelector('.file-actions').appendChild(btn);
  }
}

async function previewHtml() {
  try {
    showLoading(true);
    $('loadingText').textContent = '加载描述...';
    const r = await window.api.finalAssignment.previewHtml(className);
    if (!r || !r.success) {
      alert(r?.message || '获取失败');
      return;
    }
    const body = $('htmlPreviewBody');
    body.innerHTML = sanitizeHtml(r.html || '');
    $('htmlPreviewModal').style.display = 'flex';
  } catch (e) {
    alert('预览失败: ' + e.message);
  } finally {
    showLoading(false);
    $('loadingText').textContent = '正在加载数据...';
  }
}

function sanitizeHtml(html) {
  // 极简清洗:去掉 <script>、on* 事件
  let s = String(html || '');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
  s = s.replace(/\son\w+="[^"]*"/gi, '');
  s = s.replace(/\son\w+='[^']*'/gi, '');
  return s;
}

// ========== 时间窗 ==========
async function saveTime() {
  const start = $('startTime').value;
  const end = $('endTime').value;
  if (start && end && new Date(start) >= new Date(end)) {
    showTimeState('结束时间必须晚于开始时间', 'error');
    return;
  }
  try {
    showLoading(true);
    $('loadingText').textContent = '保存中...';
    const r = await window.api.finalAssignment.setTime({
      className,
      start: start ? new Date(start).toISOString() : null,
      end: end ? new Date(end).toISOString() : null,
    });
    if (!r || !r.success) throw new Error(r?.message || '保存失败');
    showTimeState(`已更新 ${r.affected_count || 0} 名学生`, 'success');
    refreshWindowState();
  } catch (e) {
    showTimeState('保存失败: ' + e.message, 'error');
  } finally {
    showLoading(false);
    $('loadingText').textContent = '正在加载数据...';
  }
}

async function clearTime() {
  if (!confirm('确认清空该班级所有学生的大作业时间窗?')) return;
  try {
    showLoading(true);
    $('loadingText').textContent = '清空中...';
    const r = await window.api.finalAssignment.setTime({
      className, start: null, end: null,
    });
    if (!r || !r.success) throw new Error(r?.message || '清空失败');
    $('startTime').value = '';
    $('endTime').value = '';
    showTimeState('已清空', 'success');
    refreshWindowState();
  } catch (e) {
    showTimeState('清空失败: ' + e.message, 'error');
  } finally {
    showLoading(false);
    $('loadingText').textContent = '正在加载数据...';
  }
}

function showTimeState(msg, kind) {
  if (!timeStateEl) return;
  timeStateEl.textContent = msg;
  timeStateEl.className = `time-state ${kind || ''}`;
  if (timeStateTimer) clearTimeout(timeStateTimer);
  timeStateTimer = setTimeout(() => {
    timeStateEl.textContent = '';
    timeStateEl.className = 'time-state';
  }, 4000);
}

// ========== 文件上传/删除 ==========
function triggerUpload(role) {
  currentRole = role;
  const input = $('hiddenFileInput');
  const exts = FILE_EXT[role];
  input.accept = Array.isArray(exts) ? exts.join(',') : exts;
  input.click();
}

async function handleFileSelected(e) {
  const file = e.target.files?.[0];
  e.target.value = ''; // 允许重复选同一文件
  if (!file || !currentRole) return;
  try {
    showLoading(true);
    $('loadingText').textContent = `上传 ${file.name}...`;
    const r = await window.api.finalAssignment.upload({
      className,
      role: currentRole,
      filePath: file.path,
    });
    if (!r || !r.success) throw new Error(r?.message || '上传失败');
    showTimeState(`✓ 上传成功 ${(r.size / 1024).toFixed(1)} KB`, 'success');
    await loadStatus();
  } catch (err) {
    alert('上传失败: ' + err.message);
  } finally {
    showLoading(false);
    $('loadingText').textContent = '正在加载数据...';
  }
}

async function deleteFile(role) {
  const label = ROLE_LABEL[role];
  if (!confirm(`确认删除 ${label}?`)) return;
  try {
    showLoading(true);
    $('loadingText').textContent = '删除中...';
    const r = await window.api.finalAssignment.delete({ className, role });
    if (!r || !r.success) throw new Error(r?.message || '删除失败');
    showTimeState(`已删除 ${label}`, 'success');
    await loadStatus();
  } catch (e) {
    alert('删除失败: ' + e.message);
  } finally {
    showLoading(false);
    $('loadingText').textContent = '正在加载数据...';
  }
}

// ========== 学生提交 ==========
async function loadSubmissions() {
  const r = await window.api.finalAssignment.submissions(className);
  if (!r || !r.success) throw new Error(r?.message || '查询失败');
  submissionsCache = r.submissions || [];
  applyFilters();
}

function applyFilters() {
  const statusValue = $('statusFilter')?.value || 'all';
  const searchText = ($('searchInput')?.value || '').trim().toLowerCase();
  filteredSubmissions = submissionsCache.filter(s => {
    if (statusValue === 'submitted' && !s.submitted) return false;
    if (statusValue === 'pending' && s.submitted) return false;
    if (searchText && !s.student_id.toLowerCase().includes(searchText)) return false;
    return true;
  });
  renderTable();
}

function renderTable() {
  const tbody = $('submissionsTableBody');
  if (!tbody) return;
  if (filteredSubmissions.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="loading-cell">暂无数据</td></tr>';
    return;
  }
  tbody.innerHTML = '';
  filteredSubmissions.forEach(s => {
    const tr = document.createElement('tr');
    const lastTime = s.last_time ? new Date(s.last_time).toLocaleString() : '--';
    tr.innerHTML = `
      <td>${escapeHtml(s.student_id)}</td>
      <td>${s.count}</td>
      <td>${lastTime}</td>
      <td><span class="status-badge ${s.submitted ? 'submitted' : 'pending'}">${s.submitted ? '已提交' : '未提交'}</span></td>
      <td>
        <button class="action-btn" ${s.submitted ? '' : 'disabled'} data-sid="${escapeHtml(s.student_id)}">下载</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('.action-btn:not([disabled])').forEach(btn => {
    btn.addEventListener('click', () => downloadStudent(btn.dataset.sid));
  });
}

async function downloadStudent(sid) {
  try {
    showLoading(true);
    $('loadingText').textContent = '下载中...';
    const r = await window.api.finalAssignment.downloadStudent({ className, studentId: sid });
    if (!r || !r.ok) throw new Error(r?.error || '下载失败');
    showTimeState(`已下载 ${sid} 的提交`, 'success');
  } catch (e) {
    alert('下载失败: ' + e.message);
  } finally {
    showLoading(false);
    $('loadingText').textContent = '正在加载数据...';
  }
}

async function downloadAllSubmissions() {
  try {
    showLoading(true);
    $('loadingText').textContent = '打包中...';
    const r = await window.api.finalAssignment.downloadAll(className);
    if (!r || !r.ok) throw new Error(r?.error || '批量下载失败');
    showTimeState('已下载全部学生提交', 'success');
  } catch (e) {
    alert('批量下载失败: ' + e.message);
  } finally {
    showLoading(false);
    $('loadingText').textContent = '正在加载数据...';
  }
}

// ========== 工具 ==========
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function debounce(func, wait) {
  let timeout;
  return function (...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  };
}

// ========== 应用到同课程所有班级 ==========
async function applyToAllClasses() {
  const stateEl = $('applyToAllState');
  const btn = $('applyToAllBtn');
  if (!btn || !className) return;

  // 确认
  if (!confirm(`确认将当前班级的所有期末大作业设置应用到同课程所有班级？\n\n此操作将：\n• 同步时间窗到同课程其他班级\n• 清空其他班级学生的旧提交`)) {
    return;
  }

  btn.disabled = true;
  btn.textContent = '⏳ 同步中...';
  stateEl.textContent = '';
  stateEl.className = 'time-state';

  try {
    showLoading(true);
    $('loadingText').textContent = '同步中...';
    const r = await window.api.finalAssignment.applyToAll(className);
    showLoading(false);

    if (!r || !r.success) {
      showTimeState('同步失败: ' + (r?.message || r?.error || '未知错误'), 'error');
      return;
    }

    const total = r.total_related || 0;
    const applied = r.applied_count || 0;

    let summaryHtml = `<div style="text-align:left;font-size:0.9rem;">`;
    summaryHtml += `<p>✅ 同步完成：${applied}/${total} 个班级成功</p>`;

    if (r.results && r.results.length > 0) {
      summaryHtml += `<div class="sync-result-card">`;
      r.results.forEach(res => {
        const cls = res.class_name || '?';
        if (res.success) {
          const timeInfo = res.time_window_applied ? ', 时间窗已同步' : '';
          const clearInfo = res.submissions_cleared > 0 ? `, 已清理 ${res.submissions_cleared} 名提交` : '';
          summaryHtml += `<div class="result-item ok">✓ ${cls}${timeInfo}${clearInfo}</div>`;
        } else {
          summaryHtml += `<div class="result-item fail">✗ ${cls}: ${res.error || '失败'}</div>`;
        }
      });
      summaryHtml += `</div>`;
    }
    summaryHtml += `</div>`;

    stateEl.innerHTML = summaryHtml;
    stateEl.className = 'time-state success';
    showTimeState(`已同步到 ${applied} 个班级`, 'success');

    // 刷新页面数据
    await loadStatus();
  } catch (e) {
    showLoading(false);
    showTimeState('同步失败: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '📤 应用到所有相同班级';
  }
}
