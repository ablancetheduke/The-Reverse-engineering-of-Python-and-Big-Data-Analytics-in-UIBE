import { validateTeacherMachine } from '../../../core/api.js';
import { createMessageBox, setButtonLoading } from '../../../../shared/ui.js';
import { strictValidateTeacherMachine } from '../../../../shared/teacherAuth.js';
import { navigateToTeacherDashboard } from '../../../../shared/navigation.js';
import { saveTeacherSessionFromResponse } from '../../../../shared/teacherSession.js';

document.getElementById('teacherLoginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const teacherId = document.getElementById('teacherId').value.trim();
  const loginBtn = document.getElementById('loginBtn');
  const messageBox = createMessageBox(document.getElementById('message'));
  
  // 重置消息状态
  messageBox.hide();
  
  // 验证输入
  if (!teacherId) {
    messageBox.show('请输入教师工号', 'error');
    return;
  }
  
  // 禁用按钮并显示加载状态
  setButtonLoading(loginBtn, true);
  
  try {
    const { deviceId, response } = await strictValidateTeacherMachine(validateTeacherMachine, teacherId, {
      logLabel: 'TeacherLogin',
    });
    console.log('设备ID:', deviceId);
    
    if (response.success) {
      messageBox.show('验证成功，正在跳转...', 'success');
      
      // 保存教师信息到本地存储
      saveTeacherSessionFromResponse(teacherId, response);
      
      // 跳转到教师控制台
      setTimeout(() => {
        navigateToTeacherDashboard('../dashboard/index.html');
      }, 1000);
    } else {
      messageBox.show(response.message || '验证失败，请检查教师工号', 'error');
    }
  } catch (error) {
    console.error('验证失败:', error);
    messageBox.show(error.message || '验证过程中发生错误，请稍后重试', 'error');
  } finally {
    // 恢复按钮状态
    setButtonLoading(loginBtn, false);
  }
});

// 角色切换按钮
document.getElementById('switchToStudent').addEventListener('click', () => {
  localStorage.setItem('userRole', 'student');
  window.location.href = '../../login/index.html';
});
