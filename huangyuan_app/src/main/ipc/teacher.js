/**
 * 教师端 IPC 处理器
 * 提供教师端所需的所有 IPC 功能
 */
const { shell } = require('electron');

function setupTeacherIpc({
  ipcMain,
  app,
  BrowserWindow,
  dialog,
  http,
  BASE_URL,
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
  getMainWindow,
  ensureMachineId,
  getIconPath,
  log
}) {
  // 存储教师信息
  let teacherData = {
    teacherId: '',
    classNames: [],
    attendanceInfo: {},
    currentClass: null
  };

  // 日志辅助函数
  const scope = (name) => ({
    info: (msg, data) => log(`[${name}] ${msg}${data ? ' ' + JSON.stringify(data) : ''}`),
    warn: (msg, data) => log(`[${name}] WARN ${msg}${data ? ' ' + JSON.stringify(data) : ''}`),
    error: (msg, data) => log(`[${name}] ERROR ${msg}${data ? ' ' + JSON.stringify(data) : ''}`)
  });

  // ========== 基础数据管理 ==========

  // 设置教师 ID
  ipcMain.on('set-teacher-id', (_e, id) => {
    teacherData.teacherId = id;
    log('Teacher ID saved: ' + id);
  });

  // 获取教师 ID
  ipcMain.handle('get-teacher-id', () => {
    return teacherData.teacherId || '';
  });

  // 设置教师数据
  ipcMain.handle('teacher:setData', (_e, data) => {
    teacherData = { ...teacherData, ...data };
    log('Teacher data updated: ' + JSON.stringify(data));
    return true;
  });

  // 获取教师数据
  ipcMain.handle('teacher:getData', () => {
    return teacherData;
  });

  // ========== 班级管理 ==========

  const classLog = scope('teacher:class');

  // 获取教师班级列表
  ipcMain.handle('teacher:getClasses', async () => {
    try {
      classLog.info('获取班级列表');
      if (!teacherData.teacherId) {
        return { success: false, error: '教师未登录' };
      }

      const response = await http.post('/api/validateTeacherMachine', {
        teacher_id: teacherData.teacherId,
        machine_id: ensureMachineId()
      });

      const data = response.data || {};
      if (data.success) {
        teacherData.classNames = data.data?.class_names || [];
        teacherData.attendanceInfo = data.data?.attendance_info || {};
      }

      return {
        success: data.success !== false,
        classNames: teacherData.classNames,
        attendanceInfo: teacherData.attendanceInfo
      };
    } catch (error) {
      classLog.error('获取班级列表失败', { error: error.message });
      return { success: false, error: error.message || '获取班级列表失败' };
    }
  });

  // 获取班级学生提交状态
  ipcMain.handle('teacher:getStudentSubmissions', async (_e, className) => {
    try {
      classLog.info('获取学生提交状态', { className });
      if (!className) {
        return { success: false, error: '班级名称不能为空' };
      }

      const response = await http.get('/api/student_submission_status', {
        params: { class_name: className }
      });

      return {
        success: true,
        students: response.data?.students || [],
        updatedCount: response.data?.updated_count || 0
      };
    } catch (error) {
      classLog.error('获取学生提交状态失败', { className, error: error.message });
      return { success: false, error: error.message || '获取学生提交状态失败' };
    }
  });

  // ========== 考勤管理 ==========

  const attendanceLog = scope('teacher:attendance');

  // 获取考勤信息
  ipcMain.handle('teacher:getAttendance', async (_e, className) => {
    try {
      attendanceLog.info('获取考勤信息', { className });

      const response = await http.post('/api/getAttendance', {
        class_name: className
      });

      return {
        success: response.data?.success !== false,
        attendance: response.data?.attendance || {},
        currentWeek: response.data?.current_week || 1
      };
    } catch (error) {
      attendanceLog.error('获取考勤信息失败', { className, error: error.message });
      return { success: false, error: error.message || '获取考勤信息失败' };
    }
  });

  // 更新考勤
  ipcMain.handle('teacher:updateAttendance', async (_e, { className, studentId, week, status }) => {
    try {
      attendanceLog.info('更新考勤', { className, studentId, week, status });

      const response = await http.post('/api/updateAttendance', {
        class_name: className,
        student_id: studentId,
        week: week,
        status: status
      });

      return {
        success: response.data?.success !== false,
        message: response.data?.message || '更新成功'
      };
    } catch (error) {
      attendanceLog.error('更新考勤失败', { className, studentId, error: error.message });
      return { success: false, error: error.message || '更新考勤失败' };
    }
  });

  // 生成考勤验证码
  ipcMain.handle('teacher:generateVerificationCode', async (_e, className) => {
    try {
      attendanceLog.info('生成考勤验证码', { className });

      const response = await http.post('/api/generateVerificationCode', {
        class_name: className
      });

      return {
        success: response.data?.success !== false,
        code: response.data?.code,
        expiresAt: response.data?.expires_at
      };
    } catch (error) {
      attendanceLog.error('生成验证码失败', { className, error: error.message });
      return { success: false, error: error.message || '生成验证码失败' };
    }
  });

  // ========== 考试管理 ==========

  const examLog = scope('teacher:exam');

  // 更新期中考试设置
  ipcMain.handle('teacher:updateMidtermExam', async (_e, { courseName, examTime, duration }) => {
    try {
      examLog.info('更新期中考试设置', { courseName, examTime, duration });

      const response = await http.post('/api/update_midterm_exam', {
        course_name: courseName,
        midterm_exam_time: examTime,
        midterm_exam_duration: duration
      });

      return {
        success: response.data?.success !== false,
        message: response.data?.message || '设置成功',
        affectedStudents: response.data?.affected_students || []
      };
    } catch (error) {
      examLog.error('更新期中考试设置失败', { courseName, error: error.message });
      return { success: false, error: error.message || '更新期中考试设置失败' };
    }
  });

  // 更新期末考试设置
  ipcMain.handle('teacher:updateFinalExam', async (_e, { courseName, examTime, duration }) => {
    try {
      examLog.info('更新期末考试设置', { courseName, examTime, duration });

      const response = await http.post('/api/update_final_exam', {
        course_name: courseName,
        final_exam_time: examTime,
        final_exam_duration: duration
      });

      return {
        success: response.data?.success !== false,
        message: response.data?.message || '设置成功',
        affectedStudents: response.data?.affected_students || []
      };
    } catch (error) {
      examLog.error('更新期末考试设置失败', { courseName, error: error.message });
      return { success: false, error: error.message || '更新期末考试设置失败' };
    }
  });

  // 获取考试时间设置
  ipcMain.handle('teacher:getExamTimeSettings', async (_e, className) => {
    try {
      examLog.info('获取考试时间设置', { className });

      // 并行获取期中和期末设置
      const [midtermResponse, finalResponse] = await Promise.all([
        http.get('/api/student_midterm_exam_time', { params: { class_name: className } }).catch(() => ({ data: {} })),
        http.get('/api/student_final_exam_time', { params: { class_name: className } }).catch(() => ({ data: {} }))
      ]);

      return {
        success: true,
        midterm: {
          examTime: midtermResponse.data?.exam_time,
          duration: midtermResponse.data?.exam_duration
        },
        final: {
          examTime: finalResponse.data?.exam_time,
          duration: finalResponse.data?.exam_duration
        }
      };
    } catch (error) {
      examLog.error('获取考试时间设置失败', { className, error: error.message });
      return { success: false, error: error.message || '获取考试时间设置失败' };
    }
  });

  // ========== 作业评分 ==========

  const gradingLog = scope('teacher:grading');

  // 触发 Python 作业判分
  ipcMain.handle('teacher:gradePythonHomework', async (_e, { className, testName, pathFiles, withFeedback }) => {
    try {
      gradingLog.info('开始Python作业判分', { className, testName });

      const response = await http.get('/api/getPyEvaluate', {
        params: {
          class_name: className,
          test_name: testName,
          path_files: pathFiles ? pathFiles.join(',') : undefined,
          with_feedback: withFeedback ? 'true' : 'false'
        }
      });

      return {
        success: response.data?.success !== false,
        results: response.data?.results || {}
      };
    } catch (error) {
      gradingLog.error('Python作业判分失败', { className, testName, error: error.message });
      return { success: false, error: error.message || 'Python作业判分失败' };
    }
  });

  // 获取作业评分详情
  ipcMain.handle('teacher:getGradingDetails', async (_e, { studentId, taskId }) => {
    try {
      gradingLog.info('获取作业评分详情', { studentId, taskId });

      const response = await http.post('/api/homework/grading_details', {
        student_id: studentId,
        task_id: taskId
      });

      return {
        success: response.data?.success !== false,
        details: response.data?.details || []
      };
    } catch (error) {
      gradingLog.error('获取评分详情失败', { studentId, taskId, error: error.message });
      return { success: false, error: error.message || '获取评分详情失败' };
    }
  });

  // ========== 学生设备管理 ==========

  const deviceLog = scope('teacher:device');

  // 重置学生设备绑定
  ipcMain.handle('teacher:resetStudentDevice', async (_e, studentId) => {
    try {
      deviceLog.info('重置学生设备绑定', { studentId });

      const response = await http.post('/api/resetStudentMachineId', {
        student_id: studentId
      });

      return {
        success: response.data?.success !== false,
        message: response.data?.message || '设备重置成功',
        oldMachineId: response.data?.data?.old_machine_id
      };
    } catch (error) {
      deviceLog.error('重置设备失败', { studentId, error: error.message });
      return { success: false, error: error.message || '重置设备失败' };
    }
  });

  // 批量重置学生设备
  ipcMain.handle('teacher:batchResetStudentDevices', async (_e, studentIds) => {
    try {
      deviceLog.info('批量重置学生设备', { count: studentIds.length });

      const results = [];
      for (const studentId of studentIds) {
        try {
          const result = await http.post('/api/resetStudentMachineId', {
            student_id: studentId
          });
          results.push({
            studentId,
            success: result.data?.success !== false,
            message: result.data?.message
          });
        } catch (error) {
          results.push({
            studentId,
            success: false,
            error: error.message
          });
        }
      }

      const successCount = results.filter(r => r.success).length;
      return {
        success: true,
        results,
        summary: {
          total: studentIds.length,
          success: successCount,
          failed: studentIds.length - successCount
        }
      };
    } catch (error) {
      deviceLog.error('批量重置设备失败', { error: error.message });
      return { success: false, error: error.message || '批量重置设备失败' };
    }
  });

  // ========== 文件操作 ==========

  const fileLog = scope('teacher:file');

  // 打开文件选择对话框
  ipcMain.handle('teacher:selectFiles', async () => {
    try {
      const win = BrowserWindow.getFocusedWindow() || getMainWindow();
      const result = await dialog.showOpenDialog(win, {
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: 'Python 文件', extensions: ['py'] },
          { name: '所有文件', extensions: ['*'] }
        ]
      });

      return {
        success: !result.canceled,
        filePaths: result.filePaths || []
      };
    } catch (error) {
      fileLog.error('选择文件失败', { error: error.message });
      return { success: false, error: error.message };
    }
  });

  // 打开文件夹选择对话框
  ipcMain.handle('teacher:selectFolder', async () => {
    try {
      const win = BrowserWindow.getFocusedWindow() || getMainWindow();
      const result = await dialog.showOpenDialog(win, {
        properties: ['openDirectory']
      });

      return {
        success: !result.canceled,
        folderPath: result.filePaths?.[0] || null
      };
    } catch (error) {
      fileLog.error('选择文件夹失败', { error: error.message });
      return { success: false, error: error.message };
    }
  });

  // 打开外部文件或文件夹
  ipcMain.handle('teacher:openExternal', async (_e, filePath) => {
    try {
      await shell.openPath(filePath);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // 读取文件内容
  ipcMain.handle('teacher:readFile', async (_e, filePath) => {
    try {
      if (!fs.existsSync(filePath)) {
        return { success: false, error: '文件不存在' };
      }

      const content = fs.readFileSync(filePath, 'utf-8');
      return { success: true, content };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // ========== 数据导出 ==========

  const exportLog = scope('teacher:export');

  // 导出班级成绩
  ipcMain.handle('teacher:exportGrades', async (_e, { className, data }) => {
    try {
      exportLog.info('导出班级成绩', { className });

      const win = BrowserWindow.getFocusedWindow() || getMainWindow();
      const result = await dialog.showSaveDialog(win, {
        defaultPath: `${className}_成绩.csv`,
        filters: [
          { name: 'CSV 文件', extensions: ['csv'] },
          { name: 'Excel 文件', extensions: ['xlsx'] }
        ]
      });

      if (result.canceled || !result.filePath) {
        return { success: false, canceled: true };
      }

      // 简单的 CSV 生成
      const headers = ['学号', '姓名', '作业状态', '期中状态', '期末状态'];
      const rows = data.map(student => [
        student.id,
        student.name || '',
        student.homework_status,
        student.midterm_status,
        student.final_status
      ]);

      const csvContent = [
        headers.join(','),
        ...rows.map(row => row.join(','))
      ].join('\n');

      fs.writeFileSync(result.filePath, csvContent, 'utf-8');

      return { success: true, filePath: result.filePath };
    } catch (error) {
      exportLog.error('导出成绩失败', { className, error: error.message });
      return { success: false, error: error.message || '导出成绩失败' };
    }
  });

  // ========== 系统功能 ==========

  // 获取后端版本信息
  ipcMain.handle('teacher:getBackendInfo', async () => {
    try {
      const response = await http.get('/api/health', { timeout: 5000 }).catch(() => null);
      return {
        success: !!response,
        baseUrl: BASE_URL,
        backendStatus: response ? 'online' : 'offline',
        version: response?.data?.version || 'unknown'
      };
    } catch (error) {
      return {
        success: false,
        baseUrl: BASE_URL,
        backendStatus: 'offline',
        error: error.message
      };
    }
  });

  // ========== 期末大作业管理 ==========
  const finalLog = scope('teacher:finalAssignment');

  // 获取状态
  ipcMain.handle('finalAssignment:status', async (_e, className) => {
    try {
      if (!className) return { success: false, error: '缺少班级名称' };
      finalLog.info('获取状态', { className });
      const r = await http.get('/api/final_assignment/status', { params: { class_name: className } });
      return r.data || r;
    } catch (e) {
      finalLog.error('获取状态失败', { className, error: e.message });
      return { success: false, error: e.message || '获取状态失败' };
    }
  });

  // 上传文件
  ipcMain.handle('finalAssignment:upload', async (_e, { className, role, filePath }) => {
    try {
      if (!className || !role || !filePath) {
        return { success: false, error: '缺少参数' };
      }
      if (!fs.existsSync(filePath)) {
        return { success: false, error: '文件不存在: ' + filePath };
      }
      const fd = new FormData();
      fd.append('class_name', className);
      fd.append('file_role', role);
      fd.append('file', fs.createReadStream(filePath), path.basename(filePath));
      finalLog.info('上传文件', { className, role, filePath });
      const r = await http.post('/api/final_assignment/upload', fd, {
        headers: fd.getHeaders ? fd.getHeaders() : {},
        maxContentLength: 200 * 1024 * 1024,
        maxBodyLength: 200 * 1024 * 1024,
      });
      return r.data || r;
    } catch (e) {
      finalLog.error('上传失败', { className, role, error: e.message });
      return { success: false, error: e.message || '上传失败' };
    }
  });

  // 删除文件
  ipcMain.handle('finalAssignment:delete', async (_e, { className, role }) => {
    try {
      if (!className || !role) return { success: false, error: '缺少参数' };
      finalLog.info('删除文件', { className, role });
      const r = await http.delete('/api/final_assignment/file', { params: { class_name: className, file_role: role } });
      return r.data || r;
    } catch (e) {
      finalLog.error('删除失败', { className, role, error: e.message });
      return { success: false, error: e.message || '删除失败' };
    }
  });

  // 设置时间窗
  ipcMain.handle('finalAssignment:setTime', async (_e, { className, start, end }) => {
    try {
      if (!className) return { success: false, error: '缺少班级名称' };
      finalLog.info('设置时间窗', { className, start, end });
      const r = await http.post('/api/update_final_assignment_time', {
        course_name: className,
        start_time: start,
        end_time: end,
      });
      return r.data || r;
    } catch (e) {
      finalLog.error('设置时间窗失败', { className, error: e.message });
      return { success: false, error: e.message || '设置时间窗失败' };
    }
  });

  // 学生提交情况
  ipcMain.handle('finalAssignment:submissions', async (_e, className) => {
    try {
      if (!className) return { success: false, error: '缺少班级名称' };
      finalLog.info('查询学生提交', { className });
      const r = await http.get('/api/final_assignment/submissions', { params: { class_name: className } });
      return r.data || r;
    } catch (e) {
      finalLog.error('查询学生提交失败', { className, error: e.message });
      return { success: false, error: e.message || '查询学生提交失败' };
    }
  });

  // 下载单个学生提交(弹窗另存为)
  ipcMain.handle('finalAssignment:downloadStudent', async (_e, { className, studentId }) => {
    try {
      if (!className || !studentId) return { ok: false, error: '缺少参数' };
      finalLog.info('下载学生提交', { className, studentId });
      const r = await http.get('/api/final_assignment/download_student', {
        params: { class_name: className, student_id: studentId },
        responseType: 'arraybuffer',
      });
      const win = BrowserWindow.getFocusedWindow() || getMainWindow();
      const { filePath, canceled } = await dialog.showSaveDialog(win, {
        title: `保存 ${studentId} 的提交`,
        defaultPath: path.join(app.getPath('downloads'), `${studentId}_finaltest.zip`),
        filters: [{ name: 'ZIP', extensions: ['zip'] }],
      });
      if (canceled || !filePath) return { ok: false, error: '用户取消保存' };
      fs.writeFileSync(filePath, Buffer.from(r.data));
      return { ok: true, file: filePath };
    } catch (e) {
      finalLog.error('下载学生提交失败', { className, studentId, error: e.message });
      return { ok: false, error: e.message || '下载失败' };
    }
  });

  // 批量下载
  ipcMain.handle('finalAssignment:downloadAll', async (_e, className) => {
    try {
      if (!className) return { ok: false, error: '缺少班级名称' };
      finalLog.info('批量下载班级提交', { className });
      const r = await http.get('/api/final_assignment/download_all', {
        params: { class_name: className },
        responseType: 'arraybuffer',
      });
      const win = BrowserWindow.getFocusedWindow() || getMainWindow();
      const { filePath, canceled } = await dialog.showSaveDialog(win, {
        title: '保存班级全部提交',
        defaultPath: path.join(app.getPath('downloads'), `${className}_finaltest_all.zip`),
        filters: [{ name: 'ZIP', extensions: ['zip'] }],
      });
      if (canceled || !filePath) return { ok: false, error: '用户取消保存' };
      fs.writeFileSync(filePath, Buffer.from(r.data));
      return { ok: true, file: filePath };
    } catch (e) {
      finalLog.error('批量下载失败', { className, error: e.message });
      return { ok: false, error: e.message || '下载失败' };
    }
  });

  // 应用到同课程所有班级
  ipcMain.handle('finalAssignment:applyToAll', async (_e, className) => {
    try {
      if (!className) return { success: false, error: '缺少班级名称' };
      finalLog.info('应用到同课程所有班级', { className });
      const r = await http.post('/api/final_assignment/apply_to_all', { class_name: className });
      return r.data || r;
    } catch (e) {
      finalLog.error('应用到同课程所有班级失败', { className, error: e.message });
      return { success: false, error: e.message || '同步失败' };
    }
  });

  // 预览 HTML 描述
  ipcMain.handle('finalAssignment:previewHtml', async (_e, className) => {
    try {
      if (!className) return { success: false, error: '缺少班级名称' };
      finalLog.info('预览HTML', { className });
      const r = await http.get('/finaltestmd', { params: { student_id: '_teacher_preview' } });
      // 教师预览用任意学号(不校验学生)
      const d = r.data || r;
      return { success: true, html: d.html || '', markdown: d.markdown || '' };
    } catch (e) {
      // 回退: 任意学生接口需登录,改用 download html
      try {
        const r2 = await http.get('/api/finalAssignment/download', {
          params: { class_name: className, kind: 'html' },
          responseType: 'text',
        });
        return { success: true, html: String(r2.data || '') };
      } catch (e2) {
        finalLog.error('预览HTML失败', { className, error: e2.message });
        return { success: false, error: e2.message || '预览失败' };
      }
    }
  });

  // 显示消息对话框
  ipcMain.handle('teacher:showMessage', async (_e, { type, title, message, buttons }) => {
    try {
      const win = BrowserWindow.getFocusedWindow() || getMainWindow();
      const result = await dialog.showMessageBox(win, {
        type: type || 'info',
        title: title || '提示',
        message: message,
        buttons: buttons || ['确定']
      });
      return { success: true, response: result.response };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // ===== 建议反馈（教师查看） =====

  const suggestLog = scope('suggestion:list');
  ipcMain.handle('suggestion:list', async (_e, { status } = {}) => {
    suggestLog.info('fetch', { status });
    try {
      const params = status ? `?status=${encodeURIComponent(status)}` : '';
      const res = await http.get(`/api/suggestions${params}`);
      const raw = res.data;
      if (!raw || raw.success === false) {
        throw new Error((raw && (raw.message || raw.msg)) || '获取失败');
      }
      // 为图片路径补充完整的 BASE_URL
      if (raw.data && raw.data.suggestions) {
        raw.data.suggestions = raw.data.suggestions.map(s => ({
          ...s,
          image_url: s.image_path ? `${BASE_URL}/${s.image_path}` : null
        }));
      }
      return { ok: true, data: raw.data };
    } catch (err) {
      const msg = err?.response?.data?.message || err?.response?.data?.msg || err.message || '网络异常';
      suggestLog.error('fetch failed', { error: msg });
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle('suggestion:review', async (_e, { suggestionId }) => {
    suggestLog.info('review', { suggestionId });
    try {
      const res = await http.put(`/api/suggestions/${suggestionId}/review`);
      const raw = res.data;
      return { ok: raw?.success !== false, data: raw?.data };
    } catch (err) {
      const msg = err?.response?.data?.message || err.message || '操作失败';
      suggestLog.error('review failed', { suggestionId, error: msg });
      return { ok: false, error: msg };
    }
  });

  log('Teacher IPC handlers initialized with full functionality');
}

module.exports = setupTeacherIpc;
