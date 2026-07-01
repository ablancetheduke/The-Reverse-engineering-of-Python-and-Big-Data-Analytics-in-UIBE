async function getMachineIdRaw() {
  if (!window?.electronAPI?.getMachineId) {
    throw new Error('electronAPI.getMachineId 不可用');
  }
  return await window.electronAPI.getMachineId();
}

export async function getMachineIdRequired() {
  const deviceId = await getMachineIdRaw();
  if (!deviceId) {
    throw new Error('无法获取设备标识');
  }
  return deviceId;
}

export async function getMachineIdOptional() {
  try {
    return await getMachineIdRaw();
  } catch (err) {
    console.warn('获取设备ID失败:', err);
    return '';
  }
}

export async function strictValidateTeacherMachine(validateTeacherMachine, teacherId, { logLabel } = {}) {
  const deviceId = await getMachineIdRequired();
  if (logLabel) {
    window.electronAPI?.logToFile?.(`[${logLabel}] start { teacherId: ${teacherId}, machine_id: ${deviceId} }`);
  }
  const response = await validateTeacherMachine(teacherId, deviceId);
  return { deviceId, response };
}

export async function lenientValidateTeacherMachine(validateTeacherMachine, teacherId, { logLabel } = {}) {
  const deviceId = await getMachineIdOptional();
  try {
    if (logLabel) {
      window.electronAPI?.logToFile?.(`[${logLabel}] try { teacherId: ${teacherId}, machine_id: ${deviceId} }`);
    }
    const response = await validateTeacherMachine(teacherId, deviceId);
    return { deviceId, response };
  } catch (err) {
    console.warn('获取服务器数据失败，继续流程:', err);
    if (logLabel) {
      window.electronAPI?.logToFile?.(`[${logLabel}] error ${err?.message || err}`);
    }
    return { deviceId, response: { success: false } };
  }
}
