// 教师端专用API配置，所有请求都会自动添加 User-Agent: exam_client

const PRIMARY_URL = 'https://lab.uibe.edu.cn';
const BACKUP_URL = 'https://www.uibe.online';
let currentBaseUrl = PRIMARY_URL;

// 自动检测开发环境：优先使用 Electron IPC 获取后端地址（与学生端一致）
(async function initBaseUrl() {
  try {
    if (typeof window !== 'undefined' && window.api?.getBaseUrl) {
      const url = await window.api.getBaseUrl();
      if (url && url !== PRIMARY_URL) {
        currentBaseUrl = url;
      }
    }
  } catch (e) {
    // 保持默认值 PRIMARY_URL
  }
})();

const normalizePlatformForBackend = (platform) => {
  const value = String(platform || '').toLowerCase();
  if (value.includes('darwin') || value.includes('mac')) return 'darwin';
  if (value.includes('linux')) return 'linux';
  return 'win32';
};

// 创建统一的fetch配置
const createFetchConfig = (options = {}) => {
  const defaultHeaders = {
    'User-Agent': 'exam_client',
    'Content-Type': 'application/json',
    ...options.headers
  };

  // 如果是FormData，移除Content-Type让浏览器自动设置
  if (options.body instanceof FormData) {
    delete defaultHeaders['Content-Type'];
  }

  return {
    ...options,
    headers: defaultHeaders
  };
};

// 获取当前使用的base URL
export function getCurrentBaseUrl() {
  return currentBaseUrl;
}

// 重置base URL到主URL（用于手动重置）
export function resetBaseUrl() {
  currentBaseUrl = PRIMARY_URL;
  window.electronAPI?.logToFile?.(`[API] Base URL重置为主URL: ${PRIMARY_URL}`);
}

// 切换到备用URL
function switchToBackupUrl() {
  currentBaseUrl = BACKUP_URL;
  window.electronAPI?.logToFile?.(`[API] 切换到备用URL: ${BACKUP_URL}`);
}

// 统一的API请求封装，支持自动切换到备用URL
export async function apiRequest(url, options = {}, retryCount = 0) {
  const fullUrl = url.startsWith('http') ? url : `${currentBaseUrl}${url}`;
  const config = createFetchConfig(options);
  const method = config.method || 'GET';

  // 记录请求日志
  let reqLog = `[API Request] ${method} ${fullUrl}`;
  if (config.body) {
    try {
      // 尝试格式化 JSON body 以便阅读，如果不是 JSON 则原样输出
      const bodyStr = typeof config.body === 'string' ? config.body : JSON.stringify(config.body);
      reqLog += `\nBody: ${bodyStr}`;
    } catch (e) {
      reqLog += `\nBody: [无法序列化]`;
    }
  }
  window.electronAPI?.logToFile(reqLog);

  try {
    const response = await fetch(fullUrl, config);

    // 克隆响应以读取内容记录日志
    const clone = response.clone();
    let resBodyText = '';
    try {
      resBodyText = await clone.text();
    } catch (e) {
      resBodyText = '[无法读取响应内容]';
    }

    // 记录响应日志 (截取前2000个字符避免日志过大)
    const logContent = resBodyText.length > 2000 ? resBodyText.substring(0, 2000) + '...' : resBodyText;
    const resLog = `[API Response] ${method} ${fullUrl}\nStatus: ${response.status}\nBody: ${logContent}`;
    window.electronAPI?.logToFile(resLog);

    if (!response.ok) {
      let errorMessage = `请求失败: ${response.status} ${response.statusText}`;

      // 尝试解析错误响应中的JSON信息
      try {
        const errorData = JSON.parse(resBodyText);
        // 如果服务器返回了具体的 message 字段，优先使用该字段
        if (errorData && errorData.message) {
          errorMessage = errorData.message;
        } else if (errorData && errorData.error) {
          errorMessage = errorData.error;
        }
      } catch (e) {
        // 解析失败，回退到默认错误信息，附加部分响应体以便调试
        errorMessage += ` - ${resBodyText.substring(0, 100)}`;
      }

      throw new Error(errorMessage);
    }

    // 如果响应为空，返回空对象
    if (!resBodyText.trim()) return {};

    try {
      return JSON.parse(resBodyText);
    } catch (e) {
      // 如果不是JSON，且调用方期望JSON，这里可能会抛错。
      // 但考虑到有些API可能不返回JSON，这里做个兼容或者直接抛错。
      // 原逻辑是 await response.json()，所以这里应该尽可能模拟。
      // 如果 response.json() 失败，通常意味着返回的不是 JSON。
      console.warn('响应不是有效的JSON:', resBodyText);
      throw new Error('响应格式错误: 非 JSON 数据');
    }
  } catch (error) {
    window.electronAPI?.logToFile(`[API Error] ${method} ${fullUrl} - ${error.message}`);
    console.error('API请求错误:', error);

    // 检查是否为网络错误，如果是且未尝试过备用URL，则切换到备用URL重试
    const isNetworkError = error.name === 'TypeError' ||
                          error.message.includes('fetch') ||
                          error.message.includes('network') ||
                          error.message.includes('Failed to fetch');

    if (isNetworkError && retryCount === 0 && currentBaseUrl === PRIMARY_URL) {
      window.electronAPI?.logToFile(`[API] 主URL请求失败，尝试备用URL...`);
      switchToBackupUrl();
      return apiRequest(url, options, retryCount + 1);
    }

    throw error;
  }
}

// 教师登录验证
export async function validateTeacherMachine(teacherId, machineId) {
  return await apiRequest('/api/validateTeacherMachine', {
    method: 'POST',
    body: JSON.stringify({
      teacher_id: teacherId,
      machine_id: machineId
    })
  });
}

// 获取学生提交状态
export async function getStudentSubmissionStatus(className) {
  return await apiRequest(`/api/student_submission_status?class_name=${encodeURIComponent(className)}`);
}

// 获取期中考试时间设置
export async function getStudentMidtermExamTime(className) {
  return await apiRequest(`/api/student_midterm_exam_time?class_name=${encodeURIComponent(className)}`);
}

// 获取期末考试时间设置
export async function getStudentFinalExamTime(className) {
  return await apiRequest(`/api/student_final_exam_time?class_name=${encodeURIComponent(className)}`);
}

// 更新期中考试信息
export async function updateMidtermExam(courseData) {
  return await apiRequest('/api/update_midterm_exam', {
    method: 'POST',
    body: JSON.stringify(courseData)
  });
}

// 更新期末考试信息
export async function updateFinalExam(courseData) {
  return await apiRequest('/api/update_final_exam', {
    method: 'POST',
    body: JSON.stringify(courseData)
  });
}

// Python作业/考试自动判分
export async function getPyEvaluate(className, testName, withFeedback = false) {
  const url = `/getPyEvaluate?class_name=${encodeURIComponent(className)}&test_name=${encodeURIComponent(testName)}&with_feedback=${withFeedback}`;
  return await apiRequest(url);
}

// 重置学生machine_id
export async function resetStudentMachineId(studentId) {
  return await apiRequest('/api/resetStudentMachineId', {
    method: 'POST',
    body: JSON.stringify({ student_id: studentId })
  });
}

// 获取班级分析报告（MD格式）
export async function getClassReport(className, reportType = 'academic') {
  return await apiRequest(`/api/class_report?class_name=${encodeURIComponent(className)}&report_type=${reportType}`);
}

// 获取班级缺勤TOP3
export async function getClassTopAbsentees(className, topN = 3) {
  return await apiRequest(`/api/class_top_absentees?class_name=${encodeURIComponent(className)}&top_n=${topN}`);
}

// 获取课堂录音报告列表（周度）
export async function getRecordingReports(className) {
  return await apiRequest(`/api/recording/report/list?class_name=${encodeURIComponent(className)}`);
}

// 获取教师端 HTML 报告 URL（用于 iframe 嵌入）
export function getTeacherHtmlReportUrl(baseUrl, className, weekNo) {
  return `${baseUrl}/api/recording/report/html/${encodeURIComponent(className)}/${weekNo}?report_type=teacher`;
}

// 获取系统总访问次数
export async function getTotalVisits() {
  return await apiRequest('/api/stats/visits');
}

// 增加系统总访问次数
export async function incrementTotalVisits(fingerprint = '') {
  return await apiRequest('/api/stats/visits/increment', {
    method: 'POST',
    body: JSON.stringify({ fingerprint })
  });
}

// 设置作业截止时间
export async function updateAssignmentDeadline(courseName, deadline, taskId = null) {
  return await apiRequest('/api/update_assignment_deadline', {
    method: 'POST',
    body: JSON.stringify({ course_name: courseName, deadline, task_id: taskId })
  });
}

// 查询作业截止时间
export async function getAssignmentDeadline(courseName) {
  return await apiRequest(`/api/assignment_deadline?course_name=${encodeURIComponent(courseName)}`);
}

// 获取期末大作业时间设置
export async function getFinalAssignmentTime(className) {
  return await apiRequest(`/api/final_assignment_time?class_name=${encodeURIComponent(className)}`);
}

// 更新期末大作业时间设置
export async function updateFinalAssignmentTime(courseData) {
  return await apiRequest('/api/update_final_assignment_time', {
    method: 'POST',
    body: JSON.stringify(courseData)
  });
}
