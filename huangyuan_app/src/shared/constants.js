/**
 * 教师工号列表 - 用于区分教师端和学生端登录
 *
 * 支持动态加载：应用启动时从后端 API 获取最新工号列表，
 * 合并到硬编码列表中使用。添加新教师无需更新客户端。
 */

// 静态回退列表（应用启动时会被动态列表合并）
const HARDCODED_TEACHER_IDS = [
  '57399',
  '57401',
  '57402',
  '57408',
  '57414',
  '02393'
];

// 动态加载的教师工号（启动时从后端获取）
let _dynamicTeacherIds = new Set();

// 合并后的完整列表缓存
let _mergedList = null;

function _buildMergedList() {
  const all = new Set(HARDCODED_TEACHER_IDS);
  for (const id of _dynamicTeacherIds) {
    all.add(id);
  }
  _mergedList = Array.from(all);
  return _mergedList;
}

/**
 * 设置动态加载的教师工号（由主进程在启动时调用）
 * @param {string[]} ids - 从后端获取的教师工号数组
 */
function setDynamicTeacherIds(ids) {
  if (!Array.isArray(ids)) return;
  _dynamicTeacherIds = new Set(ids.map(id => String(id).trim()).filter(Boolean));
  _mergedList = null; // 清除缓存
}

/**
 * 获取所有教师工号（硬编码 + 动态加载）
 * @returns {string[]}
 */
function getAllTeacherIds() {
  if (_mergedList) return _mergedList;
  return _buildMergedList();
}

/**
 * 检查输入是否为教师工号
 * @param {string} input - 用户输入的工号/学号
 * @returns {boolean} - 是否为教师工号
 */
function isTeacherId(input) {
  if (!input || typeof input !== 'string') return false;
  const trimmed = input.trim();

  // 检查硬编码列表
  if (HARDCODED_TEACHER_IDS.includes(trimmed)) return true;

  // 检查动态加载列表
  if (_dynamicTeacherIds.has(trimmed)) return true;

  return false;
}

/**
 * 获取教师工号列表（兼容旧接口）
 * @returns {string[]}
 */
function getTeacherIds() {
  return getAllTeacherIds();
}

module.exports = {
  TEACHER_IDS: HARDCODED_TEACHER_IDS,
  isTeacherId,
  getTeacherIds,
  setDynamicTeacherIds,
  getAllTeacherIds
};
