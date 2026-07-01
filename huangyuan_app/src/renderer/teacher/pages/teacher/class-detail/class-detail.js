import { navigateToTeacherDashboard } from '../../../../shared/navigation.js';
import {
  getStudentSubmissionStatus,
  getStudentMidtermExamTime,
  updateMidtermExam,
  getStudentFinalExamTime,
  updateFinalExam,
  getClassReport,
  getClassTopAbsentees,
  getRecordingReports,
  getTeacherHtmlReportUrl,
  getCurrentBaseUrl,
  updateAssignmentDeadline,
  getAssignmentDeadline,
  getFinalAssignmentTime,
  updateFinalAssignmentTime
} from '../../../core/api.js';

const $ = (id) => document.getElementById(id);
const showLoading = (v) => $('loadingOverlay')?.classList.toggle('show', !!v);
const displayStatus = (t, type='ok') => { 
  const el = $('serverStatus'); 
  if(!el) return; 
  el.className = `server-status ${type}`; 
  el.textContent = t||''; 
  setTimeout(() => { el.textContent = ''; el.className = 'server-status'; }, 3000);
};

// --- Modal Logic ---

function setupModals(className) {
  // Generic Modal Close
  document.querySelectorAll('.close-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const modalId = btn.getAttribute('data-close');
      const modal = $(modalId);
      if (modal) modal.style.display = 'none';
    });
  });

  window.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal')) {
      e.target.style.display = 'none';
    }
  });

  // Midterm Exam Settings
  const midtermIcon = $('midtermIcon');
  if (midtermIcon) {
    midtermIcon.addEventListener('click', async () => {
      const modal = $('midtermModal');
      modal.style.display = 'flex';
      
      // Defaults
      const now = new Date();
      const pad = v => String(v).padStart(2,'0');
      const defaultDt = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
      $('midtermDateTime').value = defaultDt;
      $('midtermDurationHours').value = 1;
      $('midtermDurationMinutes').value = 35;

      try {
        const data = await getStudentMidtermExamTime(className);
        if (data.success) {
          if (data.exam_time) $('midtermDateTime').value = data.exam_time;
          if (data.exam_duration) {
            $('midtermDurationHours').value = data.exam_duration.hours || 0;
            $('midtermDurationMinutes').value = data.exam_duration.minutes || 0;
          }
        }
      } catch (e) {
        console.error('Error fetching midterm settings:', e);
      }
    });
  }

  $('midtermSubmit')?.addEventListener('click', async () => {
    const dateTime = $('midtermDateTime').value;
    const hours = parseInt($('midtermDurationHours').value) || 0;
    const minutes = parseInt($('midtermDurationMinutes').value) || 0;

    if (!dateTime) {
      alert('请选择考试时间');
      return;
    }
    if (hours === 0 && minutes === 0) {
      alert('请设置考试时长');
      return;
    }

    try {
      const res = await updateMidtermExam({
        course_name: className,
        midterm_exam_time: dateTime,
        midterm_exam_duration: { hours, minutes }
      });
      if (res.success) {
        alert('期中考试设置已更新！');
        $('midtermModal').style.display = 'none';
      } else {
        alert(res.message || '更新失败');
      }
    } catch (e) {
      console.error(e);
      alert('提交失败，请重试');
    }
  });

  // Student Midterm Adjustment
  const studentMidtermIcon = $('studentMidtermIcon');
  if (studentMidtermIcon) {
    studentMidtermIcon.addEventListener('click', () => {
      const modal = $('studentMidtermModal');
      modal.style.display = 'flex';
      
      const now = new Date();
      const pad = v => String(v).padStart(2,'0');
      const defaultDt = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
      $('studentExamDateTime').value = defaultDt;
      $('studentIdInput').value = '';
    });
  }

  $('studentMidtermSubmit')?.addEventListener('click', async () => {
    const studentId = $('studentIdInput').value;
    const examTime = $('studentExamDateTime').value;

    if (!studentId) {
      alert('请输入学号');
      return;
    }
    if (!examTime) {
      alert('请选择考试时间');
      return;
    }

    try {
      const res = await updateMidtermExam({
        student_id: studentId,
        class_name: className,
        exam_time: examTime
      });
      if (res.success) {
        alert('学生考试时间已更新！');
        $('studentMidtermModal').style.display = 'none';
      } else {
        alert(res.message || '更新失败');
      }
    } catch (e) {
      console.error(e);
      alert('提交失败，请重试');
    }
  });

  // Final Exam Settings
  const finalIcon = $('finalIcon');
  if (finalIcon) {
    finalIcon.addEventListener('click', async () => {
      const modal = $('finalModal');
      modal.style.display = 'flex';
      
      const now = new Date();
      const pad = v => String(v).padStart(2,'0');
      const defaultDt = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
      $('finalDateTime').value = defaultDt;
      $('finalDurationHours').value = 2;
      $('finalDurationMinutes').value = 0;

      try {
        const data = await getStudentFinalExamTime(className);
        if (data.success) {
          if (data.exam_time) $('finalDateTime').value = data.exam_time;
          if (data.exam_duration) {
            $('finalDurationHours').value = data.exam_duration.hours || 0;
            $('finalDurationMinutes').value = data.exam_duration.minutes || 0;
          }
        }
      } catch (e) {
        console.error('Error fetching final settings:', e);
      }
    });
  }

  $('finalSubmit')?.addEventListener('click', async () => {
    const dateTime = $('finalDateTime').value;
    const hours = parseInt($('finalDurationHours').value) || 0;
    const minutes = parseInt($('finalDurationMinutes').value) || 0;

    if (!dateTime) {
      alert('请选择考试时间');
      return;
    }

    try {
      const res = await updateFinalExam({
        course_name: className,
        final_exam_time: dateTime,
        final_exam_duration: { hours, minutes }
      });
      if (res.success) {
        alert('期末考试设置已更新！');
        $('finalModal').style.display = 'none';
      } else {
        alert(res.message || '更新失败');
      }
    } catch (e) {
      console.error(e);
      alert('提交失败，请重试');
    }
  });

  // Assignment Deadline Settings
  const deadlineIcon = $('deadlineIcon');
  if (deadlineIcon) {
    deadlineIcon.addEventListener('click', async () => {
      const modal = $('deadlineModal');
      modal.style.display = 'flex';

      // 加载当前 deadline 设置
      try {
        const data = await getAssignmentDeadline(className);
        if (data.success && data.data && data.data.default_deadline) {
          const dl = new Date(data.data.default_deadline);
          const pad = v => String(v).padStart(2, '0');
          $('deadlineDateTime').value = `${dl.getFullYear()}-${pad(dl.getMonth() + 1)}-${pad(dl.getDate())}T${pad(dl.getHours())}:${pad(dl.getMinutes())}`;
        } else {
          // 默认：期中考试当周周日 23:59
          const now = new Date();
          const daysUntilSunday = (7 - now.getDay()) % 7 || 7;
          const nextSunday = new Date(now);
          nextSunday.setDate(now.getDate() + daysUntilSunday);
          nextSunday.setHours(23, 59, 0, 0);
          const pad = v => String(v).padStart(2, '0');
          $('deadlineDateTime').value = `${nextSunday.getFullYear()}-${pad(nextSunday.getMonth() + 1)}-${pad(nextSunday.getDate())}T23:59`;
        }
      } catch (e) {
        console.error('加载 deadline 失败:', e);
      }
    });
  }

  $('deadlineSubmit')?.addEventListener('click', async () => {
    const dateTime = $('deadlineDateTime').value;
    const applyAll = $('deadlineApplyAll').checked;

    if (!dateTime) {
      alert('请选择截止时间');
      return;
    }

    try {
      const res = await updateAssignmentDeadline(
        className,
        new Date(dateTime).toISOString(),
        applyAll ? null : null  // applyAll=true 时 task_id 为 null，更新所有作业
      );
      if (res.success) {
        alert('作业截止时间已更新！');
        $('deadlineModal').style.display = 'none';
      } else {
        alert(res.message || '更新失败');
      }
    } catch (e) {
      console.error(e);
      alert('提交失败，请重试');
    }
  });

  // Final Assignment Time Settings (期末大作业时间设置)
  const finalAssignIcon = $('finalAssignIcon');
  if (finalAssignIcon) {
    finalAssignIcon.addEventListener('click', async () => {
      const modal = $('finalAssignModal');
      modal.style.display = 'flex';

      // Defaults
      const now = new Date();
      const pad = v => String(v).padStart(2, '0');
      const defaultStart = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
      const defaultEnd = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      const defaultEndStr = `${defaultEnd.getFullYear()}-${pad(defaultEnd.getMonth()+1)}-${pad(defaultEnd.getDate())}T23:59`;

      $('finalAssignStart').value = defaultStart;
      $('finalAssignEnd').value = defaultEndStr;

      try {
        const data = await getFinalAssignmentTime(className);
        if (data.success) {
          if (data.start_time) {
            const s = new Date(data.start_time);
            $('finalAssignStart').value = `${s.getFullYear()}-${pad(s.getMonth()+1)}-${pad(s.getDate())}T${pad(s.getHours())}:${pad(s.getMinutes())}`;
          }
          if (data.end_time) {
            const e = new Date(data.end_time);
            $('finalAssignEnd').value = `${e.getFullYear()}-${pad(e.getMonth()+1)}-${pad(e.getDate())}T${pad(e.getHours())}:${pad(e.getMinutes())}`;
          }
        }
      } catch (err) {
        console.error('加载期末大作业时间失败:', err);
      }
    });
  }

  $('finalAssignSubmit')?.addEventListener('click', async () => {
    const startDt = $('finalAssignStart').value;
    const endDt = $('finalAssignEnd').value;

    if (!startDt || !endDt) {
      alert('请设置开始时间和截止时间');
      return;
    }

    if (new Date(startDt) >= new Date(endDt)) {
      alert('开始时间必须早于截止时间');
      return;
    }

    try {
      const res = await updateFinalAssignmentTime({
        course_name: className,
        start_time: new Date(startDt).toISOString(),
        end_time: new Date(endDt).toISOString()
      });
      if (res.success) {
        alert('期末大作业时间已更新！');
        $('finalAssignModal').style.display = 'none';
      } else {
        alert(res.message || '更新失败');
      }
    } catch (e) {
      console.error(e);
      alert('提交失败，请重试');
    }
  });
}

// 简单的 Markdown → HTML 渲染（Electron 环境使用 window.md，浏览器环境回退）
function renderMarkdown(mdText) {
  // 优先使用 Electron preload 暴露的 marked 渲染器
  if (window.md?.renderLocal) {
    return window.md.renderLocal(mdText, '');
  }
  // 简单回退渲染
  let html = mdText
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/^---$/gm, '<hr>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^[-*] (.+)$/gm, '<li>$1</li>')
    .replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>')
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/\n/g, '<br>');
  html = '<p>' + html + '</p>';
  // 包裹连续的 <li> 成 <ul>（支持 <br> 分隔的相邻 li）
  html = html.replace(/((?:<li>.*?<\/li>(?:<br>)?)+)/g, '<ul>$1</ul>');
  return html;
}

async function showReport(className, reportType) {
  const titles = { academic: '学情分析报告', score: '成绩分析报告' };
  const modal = $('reportModal');
  const titleEl = $('reportModalTitle');
  const bodyEl = $('reportModalBody');

  if (!modal || !bodyEl) return;
  titleEl.textContent = titles[reportType] || '分析报告';
  bodyEl.innerHTML = '<p style="color: #86868b; text-align: center; padding: 40px 0;">正在生成报告...</p>';
  modal.style.display = 'flex';

  try {
    const resp = await getClassReport(className, reportType);
    if (resp.success && resp.report) {
      bodyEl.innerHTML = renderMarkdown(resp.report);
    } else {
      bodyEl.innerHTML = `<p style="color: #d93025;">生成报告失败: ${resp.message || '未知错误'}</p>`;
    }
  } catch (e) {
    console.error('报告加载失败:', e);
    bodyEl.innerHTML = `<p style="color: #d93025;">报告加载失败: ${e.message}</p>`;
  }
}

// ═══════════ AI 课堂反馈相关 ═══════════

let teacherReportsData = [];

function showReportSection() {
  const pc = $('page-container');
  const rc = $('reportContainer');
  if (pc) pc.style.display = 'none';
  if (rc) rc.style.display = 'block';
  const title = $('reportListTitle');
  if (title) {
    const cn = sessionStorage.getItem('selectedClass') || '';
    title.textContent = cn ? cn + ' · AI 课堂反馈' : 'AI 课堂反馈';
  }
}

function hideReportSection() {
  const pc = $('page-container');
  const rc = $('reportContainer');
  if (pc) pc.style.display = '';
  if (rc) rc.style.display = 'none';
  $('reportDetailView')?.classList.remove('active');
}

function setReportState(state) {
  const ids = ['reportLoadingBox', 'teacherReportList', 'reportEmptyBox', 'reportErrorBox', 'reportDetailView'];
  ids.forEach(id => {
    const el = $(id);
    if (!el) return;
    if (id === state) {
      el.style.display = id === 'reportDetailView' ? 'flex' : '';
    } else {
      el.style.display = 'none';
    }
  });
}

async function loadTeacherReports() {
  setReportState('reportLoadingBox');
  const className = sessionStorage.getItem('selectedClass') || '';
  if (!className) { setReportState('reportErrorBox'); $('reportErrorMsg').textContent = '未选择班级'; return; }
  try {
    const data = await getRecordingReports(className);
    teacherReportsData = data.reports || [];
    if (teacherReportsData.length === 0) {
      setReportState('reportEmptyBox');
    } else {
      renderTeacherReportList();
      setReportState('teacherReportList');
    }
  } catch (err) {
    console.error('Failed to load teacher reports:', err);
    $('reportErrorMsg').textContent = '加载失败：' + err.message;
    setReportState('reportErrorBox');
  }
}

let teacherReportRefreshTimer = null;

function renderTeacherReportList() {
  const container = $('reportListBody');
  if (!container) return;
  container.innerHTML = teacherReportsData.map((r, i) => {
    const dateStr = r.created_at ? new Date(r.created_at).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }) : '';
    const hasReport = r.has_report;
    const status = r.status || '';
    const isProcessing = !hasReport && (status === 'generating' || status === 'transcribing' || status === 'summarizing');
    const tagClass = hasReport ? 'complete' : (isProcessing ? 'processing' : 'partial');
    const tagText = hasReport ? '已生成' : (isProcessing ? 'AI 分析中' : '等待处理');
    return '<div class="report-card" onclick="window.viewTeacherReport(' + i + ')" role="button" tabindex="0">' +
      '<div class="left">' +
        '<div class="week-badge">' + (r.week_no || '?') + '</div>' +
        '<div class="info">' +
          '<div class="title">第 ' + (r.week_no || '?') + ' 周</div>' +
          '<div class="sub">' + dateStr + (r.recording_count ? ' · ' + r.recording_count + ' 段录音' : '') + '</div>' +
        '</div>' +
      '</div>' +
      '<span class="status-tag ' + tagClass + '">' + tagText + '</span>' +
    '</div>';
  }).join('');

  // 自动刷新：如果有任何报告在处理中，每 10 秒刷新列表
  const hasProcessing = teacherReportsData.some(r => !r.has_report && (r.status === 'generating' || r.status === 'transcribing' || r.status === 'summarizing'));
  if (hasProcessing && !teacherReportRefreshTimer) {
    teacherReportRefreshTimer = setInterval(async () => {
      try {
        const data = await getRecordingReports(sessionStorage.getItem('selectedClass') || '');
        teacherReportsData = data.reports || [];
        renderTeacherReportList();
        const stillProcessing = teacherReportsData.some(r => !r.has_report && (r.status === 'generating' || r.status === 'transcribing' || r.status === 'summarizing'));
        if (!stillProcessing) { clearInterval(teacherReportRefreshTimer); teacherReportRefreshTimer = null; }
      } catch (e) { console.warn('Auto-refresh failed', e); }
    }, 10000);
  }
}

// 挂载到 window 以便 HTML 中的 onclick 调用
window.loadTeacherReports = loadTeacherReports;

window.backToTeacherReportList = function() {
  $('reportDetailView')?.classList.remove('active');
  $('teacherReportList').style.display = '';
};

window.viewTeacherReport = async function(index) {
  const r = teacherReportsData[index];
  if (!r) return;
  const weekNo = r.week_no;
  $('reportDetailTitle').textContent = '第 ' + (weekNo || '?') + ' 周 · 教学诊断报告';
  $('teacherReportList').style.display = 'none';
  $('reportDetailView').classList.add('active');
  $('reportDetailView').style.display = '';  // 清除 setReportState 设置的行内 display:none，让 .active CSS 生效

  const iframe = $('teacherReportIframe');
  const loading = $('teacherIframeLoading');
  if (loading) loading.style.display = 'block';
  if (iframe) iframe.style.display = 'none';

  try {
    const className = sessionStorage.getItem('selectedClass') || '';
    // 优先使用 Electron IPC 获取后端地址（支持开发环境），回退到 api.js 的默认值
    let baseUrl = getCurrentBaseUrl();
    try {
      if (window.api?.getBaseUrl) {
        const ipcUrl = await window.api.getBaseUrl();
        if (ipcUrl) baseUrl = ipcUrl;
      }
    } catch (_) {}
    const reportUrl = getTeacherHtmlReportUrl(baseUrl, className, weekNo);
    const resp = await fetch(reportUrl);
    if (!resp.ok) {
      if (resp.status === 404) throw new Error('该周报告尚未生成，请等待处理完成');
      throw new Error('HTTP ' + resp.status + ': ' + resp.statusText);
    }
    const htmlContent = await resp.text();
    if (iframe) {
      iframe.srcdoc = htmlContent;
      iframe.style.display = '';
    }
    if (loading) loading.style.display = 'none';
  } catch (err) {
    console.error('Failed to load teacher HTML report:', err);
    if (loading) {
      loading.innerHTML =
        '<div style="text-align:center;padding:40px 20px;color:#6b7280;">' +
          '<div style="font-size:48px;margin-bottom:16px;">⚠️</div>' +
          '<div style="font-size:16px;margin-bottom:8px;">加载失败</div>' +
          '<div style="font-size:14px;color:#9ca3af;">' + err.message + '</div>' +
          '<button onclick="window.viewTeacherReport(' + index + ')" style="margin-top:20px;padding:8px 24px;border-radius:12px;border:1px solid #4f46e5;background:#eef2ff;color:#4f46e5;font-size:14px;cursor:pointer;">重试</button>' +
        '</div>';
    }
  }
};

// --- Navigation Logic ---

function setupNavigation(className) {
  // 学情分析
  $('academicIcon')?.addEventListener('click', () => {
    showReport(className, 'academic');
  });

  // 作业管理
  $('homeworkIcon')?.addEventListener('click', () => {
    window.location.href = `../homework-management/index.html`;
  });

  // 期末大作业管理
  $('finalAssignmentManageIcon')?.addEventListener('click', () => {
    window.location.href = `../final-assignment-management/index.html`;
  });

  // 成绩分析
  $('scoreIcon')?.addEventListener('click', () => {
    showReport(className, 'score');
  });

  // AI 课堂反馈（录音转写AI概要）
  $('reportIcon')?.addEventListener('click', () => {
    showReportSection();
    loadTeacherReports();
  });
}

// --- Render Logic ---

function renderStudentsTable(students) {
  const tbody = $('studentStatusTable');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (!Array.isArray(students) || students.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8">暂无数据</td></tr>';
    return;
  }

  let row;
  students.forEach((student, index) => {
    if (index % 2 === 0) {
      row = document.createElement('tr');
      tbody.appendChild(row);
    }

    // Student 1
    const idCell = document.createElement('td');
    idCell.textContent = student.id;
    row.appendChild(idCell);

    const hwCell = document.createElement('td');
    hwCell.textContent = student.homework_status || "未知";
    row.appendChild(hwCell);

    const midCell = document.createElement('td');
    midCell.textContent = student.midterm_status || student.status || "未知";
    row.appendChild(midCell);

    const finCell = document.createElement('td');
    finCell.textContent = student.final_status || "未知";
    row.appendChild(finCell);
  });

  // Fill empty cells if odd number of students
  if (students.length % 2 !== 0 && row) {
    for (let i = 0; i < 4; i++) {
      row.appendChild(document.createElement('td'));
    }
  }
}

function fillSummary(className, students, attendance) {
  // class-summary 卡片已移除, 此函数保留为空函数以兼容旧调用点
  // 原逻辑已通过 $('xxx') && ... 的 null 检查安全跳过
  if (!$('classTitle')) return;  // 卡片不存在则完全跳过
  $('classTitle').textContent = className;
  $('className') && ($('className').textContent = className);
  $('studentCount') && ($('studentCount').textContent = Array.isArray(students) ? students.length : 0);

  const totalAbs = Object.values(attendance||{}).reduce((s,v)=>s+Number(v||0),0);
  $('absenceTotal') && ($('absenceTotal').textContent = totalAbs);
}

async function loadStudents(className) {
  const resp = await getStudentSubmissionStatus(className);
  return Array.isArray(resp?.students) ? resp.students : (Array.isArray(resp) ? resp : []);
}

// ===== Page Initialization =====
document.addEventListener('DOMContentLoaded', async () => {
  const className = sessionStorage.getItem('selectedClass') || '';
  if (!className) {
    displayStatus('未选择班级，即将返回仪表盘', 'error');
    setTimeout(() => window.location.href = '../dashboard/index.html', 1500);
    return;
  }

  showLoading(true);

  try {
    const students = await loadStudents(className);
    const attendanceData = JSON.parse(sessionStorage.getItem('classAttendanceData') || '{}');

    fillSummary(className, students, attendanceData);
    renderStudentsTable(students);
    setupModals(className);
    setupNavigation(className);

    // 加载缺勤TOP3
    try {
      const absenteeData = await getClassTopAbsentees(className);
      const container = $('topAbsentees');
      if (container && absenteeData.success) {
        const top = absenteeData.top_absentees || [];
        if (top.length > 0) {
          container.innerHTML = '<strong>缺勤TOP3</strong><br>' +
            top.map((s, i) =>
              `${i + 1}. 学号 ${s.student_id} — 缺勤 ${s.absent_count} 周`
            ).join('<br>');
        } else {
          container.innerHTML = '<span class="empty">本周无缺勤学生</span>';
        }
      }
    } catch (e) {
      console.error('加载缺勤TOP3失败:', e);
    }

    // AI 课堂反馈 - 返回按钮
    $('reportBackToClass')?.addEventListener('click', hideReportSection);
    $('reportEmptyBack')?.addEventListener('click', hideReportSection);
    $('reportErrorBack')?.addEventListener('click', hideReportSection);
    $('reportDetailBack')?.addEventListener('click', () => window.backToTeacherReportList());

    displayStatus('数据加载完成', 'ok');
    window.electronAPI?.logToFile?.(`[ClassDetail] 班级 ${className} 数据加载成功`);
  } catch (e) {
    console.error('班级详情加载失败:', e);
    displayStatus('数据加载失败: ' + e.message, 'error');
    const tbody = document.getElementById('studentStatusTable');
    if (tbody) tbody.innerHTML = '<tr><td colspan="8">加载失败</td></tr>';
  } finally {
    showLoading(false);
  }
});