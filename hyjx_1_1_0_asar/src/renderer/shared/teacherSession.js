function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function setTeacherRole() {
  localStorage.setItem('userRole', 'teacher');
}

export function saveTeacherSession({
  teacherId,
  classNames = [],
  attendanceInfo = {},
  studentCounts = {},
  machineVerified = false,
}) {
  if (teacherId != null) {
    localStorage.setItem('teacherId', String(teacherId));
  }
  setTeacherRole();
  localStorage.setItem('classNames', JSON.stringify(classNames || []));
  localStorage.setItem('attendanceInfo', JSON.stringify(attendanceInfo || {}));
  localStorage.setItem('studentCounts', JSON.stringify(studentCounts || {}));
  localStorage.setItem('machineVerified', JSON.stringify(Boolean(machineVerified)));
}

export function saveTeacherSessionFromResponse(teacherId, response) {
  // 兼容响应格式：支持直接返回数据或包裹在data字段中
  const responseData = response?.data || response;
  
  saveTeacherSession({
    teacherId,
    classNames: responseData?.class_names || [],
    attendanceInfo: responseData?.attendance_info || {},
    studentCounts: responseData?.student_counts || {},
    machineVerified: responseData?.machine_verified || false,
  });
}

export function updateTeacherSessionFromResponse(teacherId, response) {
  // 兼容响应格式：支持直接返回数据或包裹在data字段中
  const responseData = response?.data || response;
  
  const existing = loadTeacherSession();
  const nextMachineVerified =
    responseData && Object.prototype.hasOwnProperty.call(responseData, 'machine_verified')
      ? Boolean(responseData.machine_verified)
      : Boolean(existing.machineVerified);

  saveTeacherSession({
    teacherId,
    classNames: responseData?.class_names || existing.classNames || [],
    attendanceInfo: responseData?.attendance_info || existing.attendanceInfo || {},
    studentCounts: responseData?.student_counts || existing.studentCounts || {},
    machineVerified: nextMachineVerified,
  });
}

export function loadTeacherId() {
  return localStorage.getItem('teacherId') || '';
}

export function loadTeacherSession() {
  return {
    teacherId: loadTeacherId(),
    classNames: safeJsonParse(localStorage.getItem('classNames') || '[]', []),
    attendanceInfo: safeJsonParse(localStorage.getItem('attendanceInfo') || '{}', {}),
    studentCounts: safeJsonParse(localStorage.getItem('studentCounts') || '{}', {}),
    machineVerified: safeJsonParse(localStorage.getItem('machineVerified') || 'false', false),
  };
}
