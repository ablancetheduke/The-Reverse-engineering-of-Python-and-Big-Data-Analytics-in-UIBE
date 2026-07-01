/**
 * 统一登录页逻辑
 * 根据输入判断是教师工号还是学生学号，然后跳转到对应端
 */

(function () {
  'use strict';

  // ===== DOM 元素 =====
  const userIdInput = document.getElementById('userId');
  const errDiv = document.getElementById('err');
  const loadingDiv = document.getElementById('loading');

  // ===== 初始化 =====
  async function init() {
    // 获取版本号
    try {
      if (window.api && typeof window.api.getAppVersion === 'function') {
        const v = await window.api.getAppVersion();
        const el = document.getElementById('app-ver');
        if (el && v) el.textContent = v;
      }
    } catch (e) {
      console.warn('获取版本号失败:', e);
    }

    // 恢复上次登录的学号/工号
    try {
      const lastStudentId = localStorage.getItem('lastStudentId');
      const lastTeacherId = localStorage.getItem('lastTeacherId');
      
      if (lastStudentId) {
        userIdInput.value = lastStudentId;
        updateInputState();
        console.log('恢复了上次登录的学生学号:', lastStudentId);
      } else if (lastTeacherId) {
        userIdInput.value = lastTeacherId;
        updateInputState();
        console.log('恢复了上次登录的教师工号:', lastTeacherId);
      }
    } catch (e) {
      console.warn('恢复上次登录信息失败:', e);
    }

    // 设置焦点
    setTimeout(() => userIdInput.focus(), 100);
  }

  // ===== 验证输入 =====
  function isValidInput(v) {
    const trimmed = v.trim();
    // 允许 1-20 位数字或字母
    const isValid = /^[a-zA-Z0-9]{1,20}$/.test(trimmed);
    return {
      valid: isValid,
      message: isValid ? '' : '请输入有效的学号或工号'
    };
  }

  // ===== 更新输入框状态 =====
  function updateInputState() {
    const v = userIdInput.value.trim();
    const validation = isValidInput(v);

    userIdInput.classList.remove('valid', 'invalid');
    errDiv.textContent = '';
    errDiv.classList.remove('success');

    if (v === '') return;

    if (validation.valid) {
      userIdInput.classList.add('valid');
    } else {
      userIdInput.classList.add('invalid');
      errDiv.textContent = validation.message;
    }
  }

  // ===== 显示消息 =====
  function showMessage(text, type = 'error') {
    errDiv.textContent = text;
    errDiv.classList.remove('success');
    if (type === 'success') {
      errDiv.classList.add('success');
    }
  }

  // ===== 显示/隐藏加载 =====
  function setLoading(show) {
    loadingDiv.style.display = show ? 'block' : 'none';
    loadingDiv.setAttribute('aria-hidden', !show);
    userIdInput.disabled = show;
  }

  let updateCheckedThisSession = false;

  function triggerSilentUpdateCheck() {
    if (updateCheckedThisSession) return;
    updateCheckedThisSession = true;
    try {
      window.api.checkUpdate?.();
    } catch (e) {
      console.warn('静默更新检查失败（已忽略）:', e);
    }
  }

  // ===== 登录处理 =====
  async function handleLogin() {
    const inputId = userIdInput.value.trim();
    const validation = isValidInput(inputId);

    if (!validation.valid) {
      showMessage(validation.message);
      userIdInput.classList.add('invalid');
      userIdInput.focus();
      return;
    }

    setLoading(true);
    showMessage('');

    try {
      // 判断是教师还是学生（通过 IPC 调用主进程判断）
      const isTeacher = await window.api.isTeacher(inputId);

      if (isTeacher) {
        // === 教师登录 ===
        await handleTeacherLogin(inputId);
      } else {
        // === 学生登录 ===
        await handleStudentLogin(inputId);
      }
    } catch (e) {
      console.error('登录异常:', e);
      showMessage('登录失败: ' + (e.message || '未知错误'));
      setLoading(false);
      userIdInput.focus();
    }
  }

  // ===== 教师登录处理 =====
  async function handleTeacherLogin(teacherId) {
    showMessage('正在进入教师端...', 'success');

    // 保存教师信息
    localStorage.setItem('teacherId', teacherId);
    localStorage.setItem('userRole', 'teacher');
    // 记住上次登录的教师工号
    localStorage.setItem('lastTeacherId', teacherId);
    // 清除上次登录的学生学号（避免混淆）
    localStorage.removeItem('lastStudentId');

    // 尝试获取机器码并验证（可选）
    try {
      const machineId = await window.api.getMachineId();
      console.log('机器码:', machineId);

      // 可以在这里调用后端验证教师
      // const res = await window.api.validateTeacher(teacherId);
    } catch (e) {
      console.warn('获取机器码失败:', e);
    }

    // 跳转到教师端首页（教师控制台）
    triggerSilentUpdateCheck();
    setTimeout(() => {
      if (window.api && typeof window.api.navigateTo === 'function') {
        window.api.navigateTo('teacher:home');
      } else {
        window.location.href = '../teacher/pages/teacher/dashboard/index.html';
      }
    }, 500);
  }

  // ===== 学生登录处理 =====
  async function handleStudentLogin(studentId) {
    showMessage('正在验证学号...', 'success');

    try {
      // 调用后端验证学生
      const res = await window.api.validate(studentId);

      if (res && res.ok) {
        showMessage('验证成功，正在进入...', 'success');

        // 保存学生信息
        localStorage.setItem('studentId', studentId);
        localStorage.setItem('userRole', 'student');
        // 记住上次登录的学号
        localStorage.setItem('lastStudentId', studentId);
        // 清除上次登录的教师工号（避免混淆）
        localStorage.removeItem('lastTeacherId');
        
        // 学生端页面使用 sessionStorage 的 student_id 做登录态判定
        sessionStorage.setItem('student_id', studentId);

        // 缓存课程数据（兼容不同返回字段：data / payload）
        let courseData = res.data || res.payload;
        // 兼容 validateStudentMachine 返回外壳：{ success, data: { ... } }
        if (courseData && courseData.data && typeof courseData.data === 'object') {
          const d = courseData.data;
          if (d.current_semester_classes || d.all_classes || d.courses) courseData = d;
          else if (d.data && typeof d.data === 'object') {
            const dd = d.data;
            if (dd.current_semester_classes || dd.all_classes || dd.courses) courseData = dd;
          }
        }

        if (courseData) {
          try {
            await window.api.cacheWrite(studentId, 'courses.json', JSON.stringify(courseData));
            // 作为课程页兜底数据，兼容学生端旧页面逻辑
            sessionStorage.setItem('validate_payload', JSON.stringify(courseData));
          } catch (e) {
            console.warn('缓存课程数据失败:', e);
          }
        }

        triggerSilentUpdateCheck();

        // 跳转到学生端首页
        setTimeout(() => {
          window.location.href = '../student/home.html';
        }, 500);
      } else {
        showMessage(res?.error || '学号验证失败，请检查输入');
        setLoading(false);
        userIdInput.classList.add('invalid');
        userIdInput.focus();
      }
    } catch (e) {
      showMessage('网络连接失败: ' + (e && e.message ? e.message : '请检查网络'));
      setLoading(false);
      userIdInput.classList.add('invalid');
      userIdInput.focus();
    }
  }

  // ===== 事件绑定 =====
  userIdInput.addEventListener('input', updateInputState);

  userIdInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleLogin();
    }
  });

  userIdInput.addEventListener('blur', () => {
    if (!userIdInput.disabled && userIdInput.value.trim()) {
      updateInputState();
    }
  });

  // 窗口获得焦点时恢复输入
  window.addEventListener('focus', () => {
    if (!userIdInput.disabled) {
      userIdInput.focus();
    }
  });

  // 初始化
  init();
})();
