import { validateTeacherMachine, resetStudentMachineId, incrementTotalVisits, getTotalVisits } from '../../../core/api.js';
import { strictValidateTeacherMachine } from '../../../../shared/teacherAuth.js';
import { loadTeacherSession, updateTeacherSessionFromResponse } from '../../../../shared/teacherSession.js';

class TeacherDashboard {
  constructor() {
    const session = loadTeacherSession();
    this.teacherId = session.teacherId;
    this.classNames = session.classNames;
    this.attendanceInfo = session.attendanceInfo;
    this.studentCounts = session.studentCounts;
    this.filteredClasses = [...this.classNames];
    
    // Palette for course cards
    this.palette = [
      { bg: 'linear-gradient(135deg, #fef6e4, #fde7c8)', tint: 'rgba(255, 255, 255, 0.65)', border: 'rgba(255, 221, 179, 0.6)' },
      { bg: 'linear-gradient(135deg, #e0f2ff, #cfe5ff)', tint: 'rgba(255, 255, 255, 0.7)', border: 'rgba(174, 198, 255, 0.6)' },
      { bg: 'linear-gradient(135deg, #fce7f3, #fbcfe8)', tint: 'rgba(255, 255, 255, 0.6)', border: 'rgba(251, 207, 232, 0.8)' },
      { bg: 'linear-gradient(135deg, #ecfccb, #d9f99d)', tint: 'rgba(255, 255, 255, 0.55)', border: 'rgba(202, 247, 120, 0.7)' }
    ];

    this.courseEmojiCategories = {
      flowers: ['🌸', '🌼', '🌺', '🌻', '🌷'],
      dinosaurs: ['🦖', '🦕'],
      animals: ['🐶', '🐱', '🐼', '🦊', '🐻', '🐨', '🐯', '🐰']
    };
    this.courseEmojiPool = [
      ...this.courseEmojiCategories.flowers,
      ...this.courseEmojiCategories.dinosaurs,
      ...this.courseEmojiCategories.animals
    ];
    this.init();
  }

  async init() {
    if (!this.teacherId) {
      this.redirectToLogin();
      return;
    }

    this.initEventListeners();
    this.renderClasses();
    await this.refreshData();

    // Initialize footer interactions
    this.initFooterInteractions();

    // Load visit counter
    this.loadVisitCounter();
  }

  initEventListeners() {
    // document.getElementById('logoutBtn')?.addEventListener('click', () => this.logout());
    // document.getElementById('refreshBtn')?.addEventListener('click', () => this.refreshData());
  }

  initFooterInteractions() {
    const imgs = document.querySelectorAll('img.footer-tip');
    const notes = document.querySelectorAll('.footer-note');
    const hideAll = () => notes.forEach(n => n.style.display = 'none');

    // 点击空白处隐藏全部
    document.addEventListener('click', hideAll);

    imgs.forEach(img => {
      const noteId = img.getAttribute('data-note');
      const note = document.getElementById(noteId);
      if (!note) return;

      img.addEventListener('click', (e) => {
        e.stopPropagation();
        const visible = note.style.display === 'block';
        hideAll();
        note.style.display = visible ? 'none' : 'block';
      });

      // 防止点击文本框自身关闭
      note.addEventListener('click', (e) => e.stopPropagation());
    });
  }

  async refreshData() {
    this.showLoading(true);
    try {
      const { response } = await strictValidateTeacherMachine(validateTeacherMachine, this.teacherId, {
        logLabel: 'Dashboard',
      });
      if (!response.success) {
        throw new Error(response.message || '数据刷新失败');
      }

      // 兼容响应格式：支持直接返回数据或包裹在data字段中
      const responseData = response.data || response;
      
      this.classNames = responseData.class_names || [];
      this.attendanceInfo = responseData.attendance_info || {};
      this.studentCounts = responseData.student_counts || {};
      updateTeacherSessionFromResponse(this.teacherId, response);
      this.filteredClasses = [...this.classNames];
      this.renderClasses();
      window.electronAPI?.logToFile?.(`[Dashboard] 刷新成功 班级: ${this.classNames.length}`);
    } catch (error) {
      console.error(error);
      // alert(`数据刷新失败：${error.message}`); // Suppress alert for better UX
      window.electronAPI?.logToFile?.(`[Dashboard] 刷新失败: ${error.message}`);
    } finally {
      this.showLoading(false);
    }
  }

  renderClasses() {
    const grid = document.getElementById('classesGrid');
    if (!grid) return;

    if (this.filteredClasses.length === 0) {
      grid.innerHTML = '<div class="tile" style="width: 100%; aspect-ratio: auto; background: none; box-shadow: none; border: none;"><p class="empty-hint">暂时没有课程数据</p></div>';
      return;
    }

    grid.innerHTML = '';
    grid.appendChild(this.createResetTile());
    this.filteredClasses.forEach((className, index) => {
        const card = this.createClassCard(className, index);
        grid.appendChild(card);
    });
  }

  createClassCard(className, index) {
    const raw = this.attendanceInfo[className] || {};
    const entries = Object.entries(raw);
    const studentCount = this.studentCounts[className] || 0;
    const courseEmoji = this.getCourseEmoji(className);
    // 显示完整课程信息：课序号-课程名称-教师
    const displayName = this.formatFullCourseName(className);

    // Calculate colors based on index
    const colors = this.palette[index % this.palette.length];

    // 获取缺勤人员前3名
    const topAbsentees = this.getTopAbsentees(raw, 3);
    const absenteesHTML = topAbsentees.length > 0
      ? topAbsentees.map(item =>
          `<div class="absentee-item">${this.escape(item.studentId)}:${item.count}次</div>`
        ).join('')
      : '<div class="absentee-item empty">暂无缺勤</div>';

    const el = document.createElement('div');
    el.className = 'tile';
    el.style.background = colors.bg;
    el.style.borderColor = colors.border;

    el.innerHTML = `
      <div class="icon-bubble" style="background:${colors.tint}">${courseEmoji}</div>
      <div class="title" title="${this.escape(className)}">${this.escape(displayName)}</div>
      <div class="stats-row">
        <div class="stat-column">
          <div class="stat-label">学生</div>
          <div class="stat-value">${studentCount}人</div>
        </div>
        <div class="stat-column">
          <div class="stat-label">缺勤</div>
          <div class="absentees-list">${absenteesHTML}</div>
        </div>
      </div>
    `;

    el.onclick = () => {
        this.openClassDetail(className);
    };

    return el;
  }

  getTopAbsentees(attendanceData, limit = 3) {
    const entries = Object.entries(attendanceData || {});

    // 过滤出缺勤次数大于0的学生，并按次数降序排序
    const sorted = entries
      .filter(([_, count]) => count > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([studentId, count]) => ({ studentId, count }));

    return sorted;
  }

  // Helper methods
  openClassDetail(className) {
    if (!className) return;
    sessionStorage.setItem('selectedClass', className);
    sessionStorage.setItem('classAttendanceData', JSON.stringify(this.attendanceInfo[className] || {}));
    window.location.href = '../class-detail/index.html';
  }

  parseClassNameDetails(className = '') {
    const raw = String(className || '').trim();
    // Simplified parsing logic, just to get a display name if possible
    // Assuming format like "2024-2025-2-CMP245-4-Python与大数据分析-刘宁宁"
    const parts = raw.split('-');
    if (parts.length >= 4) {
        // Try to find the course name (usually after the code)
        // This is heuristic.
        // Let's reuse the existing logic if it was robust, or simplify.
        // Existing logic was complex. Let's try to extract the most meaningful part.
        // Usually index 4 is course name in the example above.
        // But let's just use the full string if parsing fails or return the original logic.
    }
    
    // Reusing the original logic for consistency
    const segments = raw.split('-').map(part => part.trim()).filter(Boolean);
    if (!segments.length) {
      return { teacherName: '', courseName: raw };
    }

    let teacherName = '';
    let workingSegments = [...segments];
    const potentialTeacher = workingSegments[workingSegments.length - 1];
    if (this.isTeacherSegment(potentialTeacher)) {
      teacherName = potentialTeacher;
      workingSegments = workingSegments.slice(0, -1);
    }
    
    const courseSegments = [];
    for (const segment of workingSegments) {
        if (!this.isMetadataSegment(segment)) {
            courseSegments.push(segment);
        }
    }
    
    if (!courseSegments.length && teacherName) {
        courseSegments.push(teacherName);
        teacherName = '';
    }
    
    const courseName = courseSegments.join('-') || raw;
    return { courseName, teacherName };
  }

  isMetadataSegment(segment = '') {
    if (!segment) return false;
    const numeric = /^\d+$/.test(segment);
    const courseCode = /^[A-Za-z]{2,}\d{2,}$/.test(segment);
    const classMarker = /^[A-Za-z]?\d{1,3}$/.test(segment);
    return numeric || courseCode || classMarker;
  }

  isTeacherSegment(segment = '') {
    if (!segment) return false;
    if (this.containsChinese(segment)) return true;
    return /[A-Za-z]/.test(segment) && !/^\d+$/.test(segment);
  }

  containsChinese(value = '') {
    return /[\u4e00-\u9fff]/.test(value);
  }

  formatClassName(className = '') {
    const { courseName } = this.parseClassNameDetails(className);
    return courseName || className;
  }

  formatFullCourseName(className = '') {
    // 直接返回完整的班级名称（含学年学期信息）
    return className;
  }

  getCourseEmoji(className = '') {
    const pool = this.courseEmojiPool;
    if (!pool.length) return '🌸';
    const normalizedKey = String(className || '').toLowerCase();
    const hash = this.hashString(normalizedKey);
    return pool[hash % pool.length];
  }

  hashString(value = '') {
    let hash = 0;
    for (let i = 0; i < value.length; i += 1) {
      hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
    }
    return hash;
  }

  escape(str = '') {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  showLoading(show) {
    const overlay = document.getElementById('loadingOverlay');
    if (!overlay) return;
    overlay.classList.toggle('show', !!show);
  }

  redirectToLogin() {
    window.location.replace('../../login/index.html');
  }

  // 重置学生设备卡片（tile 样式，放在网格第一个位置）
  createResetTile() {
    const colors = this.palette[0];
    const el = document.createElement('div');
    el.className = 'tile reset-tile';
    el.style.background = colors.bg;
    el.style.borderColor = colors.border;

    const emoji = '🔧';

    el.innerHTML = `
      <div class="icon-bubble" style="background:${colors.tint}">${emoji}</div>
      <div class="title" style="-webkit-line-clamp:2">重置学生设备</div>
      <div class="reset-form">
        <input type="text" class="reset-input" placeholder="输入学号重置设备" />
        <button class="reset-button">重置</button>
      </div>
      <div class="reset-result"></div>
    `;

    const input = el.querySelector('.reset-input');
    const btn = el.querySelector('.reset-button');
    const resultDiv = el.querySelector('.reset-result');

    const doReset = async () => {
      const studentId = input.value.trim();
      if (!studentId) {
        this.showResetResultOn(resultDiv, '请输入学生学号', 'error');
        return;
      }
      btn.disabled = true;
      btn.textContent = '...';
      resultDiv.style.display = 'none';
      try {
        const response = await resetStudentMachineId(studentId);
        if (response.success) {
          this.showResetResultOn(resultDiv, `学生 ${studentId} 的设备已成功重置`, 'success');
          input.value = '';
          window.electronAPI?.logToFile?.(`[Dashboard] 重置学生设备成功: ${studentId}`);
        } else {
          throw new Error(response.message || '重置失败');
        }
      } catch (error) {
        this.showResetResultOn(resultDiv, `重置失败: ${error.message}`, 'error');
        window.electronAPI?.logToFile?.(`[Dashboard] 重置学生设备失败: ${studentId} - ${error.message}`);
      } finally {
        btn.disabled = false;
        btn.textContent = '重置';
      }
    };

    btn.addEventListener('click', doReset);
    input.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') doReset();
    });

    return el;
  }

  showResetResultOn(el, message, type) {
    el.textContent = message;
    el.className = `reset-result ${type}`;
    el.style.display = 'block';
  }

  async loadVisitCounter() {
    try {
      let fingerprint = sessionStorage.getItem('visit_fingerprint');
      if (!fingerprint) {
        fingerprint = crypto.randomUUID
          ? crypto.randomUUID()
          : Math.random().toString(36).slice(2);
        sessionStorage.setItem('visit_fingerprint', fingerprint);
      }

      let data;
      try {
        data = await incrementTotalVisits(fingerprint);
      } catch {
        data = await getTotalVisits();
      }

      if (data && data.total_visits) {
        const el = document.getElementById('visitCounterDisplay');
        if (el) el.textContent = `累计服务 ${Number(data.total_visits).toLocaleString('en-US')} 次`;
      }
    } catch {
      // 静默失败
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.teacherDashboard = new TeacherDashboard();
});
