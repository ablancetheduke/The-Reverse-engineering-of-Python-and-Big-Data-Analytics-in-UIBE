import { navigateToTeacherDashboard } from '../../../../shared/navigation.js';
import { getStudentSubmissionStatus } from '../../../core/api.js';

const $ = (id) => document.getElementById(id);
const showLoading = (v) => $('loadingOverlay')?.classList.toggle('show', !!v);

// State
let className = '';
let allStudents = [];
let filteredStudents = [];

// --- Initialization ---

document.addEventListener('DOMContentLoaded', async () => {
  const teacherId = localStorage.getItem('teacherId');
  if (!teacherId) { 
    window.location.href = '../login/index.html'; 
    return; 
  }

  className = sessionStorage.getItem('selectedClass');
  if (!className) { 
    navigateToTeacherDashboard('../dashboard/index.html'); 
    return; 
  }

  // Back button
  const backBtn = document.querySelector('.back-chip');
  backBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    navigateToTeacherDashboard('../class-detail/index.html');
  });

  // Setup filters
  setupFilters();

  // Load data
  await loadData();
});

// --- Data Loading ---

async function loadData() {
  showLoading(true);
  try {
    const resp = await getStudentSubmissionStatus(className);
    allStudents = Array.isArray(resp?.students) ? resp.students : [];
    
    console.log('[HomeworkManagement] Loaded students:', allStudents.length);
    
    // Update UI
    updateClassInfo();
    updateStatistics();
    renderTable();
  } catch (error) {
    console.error('[HomeworkManagement] Failed to load data:', error);
    alert('加载数据失败: ' + error.message);
  } finally {
    showLoading(false);
  }
}

// --- UI Updates ---

function updateClassInfo() {
  $('className').textContent = className;
  $('totalStudents').textContent = allStudents.length;
  
  // Set emoji based on class name hash
  const emojis = ['📚', '📖', '📘', '📙', '📗'];
  const hash = className.split('').reduce((a, b) => a + b.charCodeAt(0), 0);
  $('classEmoji').textContent = emojis[hash % emojis.length];
}

function updateStatistics() {
  const submittedCount = allStudents.filter(s => {
    const hwStatus = s.homework_status;
    return hwStatus !== '未提交' && hwStatus !== 0;
  }).length;
  
  const pendingCount = allStudents.length - submittedCount;
  const submissionRate = allStudents.length > 0 
    ? Math.round((submittedCount / allStudents.length) * 100) 
    : 0;
  
  // Calculate average score (placeholder - would need actual scores from backend)
  const avgScore = '--';
  
  $('submittedCount').textContent = submittedCount;
  $('pendingCount').textContent = pendingCount;
  $('submissionRate').textContent = `${submissionRate}%`;
  $('avgScore').textContent = avgScore;
}

// --- Table Rendering ---

function renderTable() {
  const tbody = $('submissionsTableBody');
  if (!tbody) return;
  
  tbody.innerHTML = '';
  
  if (filteredStudents.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="loading-cell">暂无数据</td></tr>';
    return;
  }
  
  filteredStudents.forEach(student => {
    const row = document.createElement('tr');
    
    const isSubmitted = student.homework_status !== '未提交' && student.homework_status !== 0;
    const homeworkCount = isSubmitted ? student.homework_status : 0;
    
    row.innerHTML = `
      <td>${escapeHtml(student.id)}</td>
      <td>${homeworkCount}</td>
      <td>--</td>
      <td>--</td>
      <td>
        <span class="status-badge ${isSubmitted ? 'submitted' : 'pending'}">
          ${isSubmitted ? '已提交' : '未提交'}
        </span>
      </td>
      <td>
        <button class="action-btn" onclick="viewStudentDetails('${escapeHtml(student.id)}')">
          查看详情
        </button>
      </td>
    `;
    
    tbody.appendChild(row);
  });
}

// --- Filter Logic ---

function setupFilters() {
  const statusFilter = $('statusFilter');
  const searchInput = $('searchInput');
  
  statusFilter?.addEventListener('change', applyFilters);
  searchInput?.addEventListener('input', debounce(applyFilters, 300));
}

function applyFilters() {
  const statusValue = $('statusFilter')?.value || 'all';
  const searchText = ($('searchInput')?.value || '').trim().toLowerCase();
  
  filteredStudents = allStudents.filter(student => {
    // Status filter
    if (statusValue !== 'all') {
      const isSubmitted = student.homework_status !== '未提交' && student.homework_status !== 0;
      if (statusValue === 'submitted' && !isSubmitted) return false;
      if (statusValue === 'pending' && isSubmitted) return false;
    }
    
    // Search filter
    if (searchText && !student.id.toLowerCase().includes(searchText)) {
      return false;
    }
    
    return true;
  });
  
  renderTable();
}

// --- Utility Functions ---

function viewStudentDetails(studentId) {
  alert(`查看学生 ${studentId} 的详细作业情况（功能开发中）`);
  // TODO: Navigate to student detail page or open modal
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}
