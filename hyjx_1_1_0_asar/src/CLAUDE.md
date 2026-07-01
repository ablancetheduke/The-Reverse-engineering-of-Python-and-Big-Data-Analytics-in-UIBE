# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

惠园教学客户端 - 基于 Electron 的桌面应用，整合学生端和教师端功能。通过登录时的工号/学号自动区分用户角色。

## 常用命令

### 开发与运行
```bash
# 启动应用（开发模式）
npm start

# 清理构建缓存
npm run clean

# 构建所有平台
npm run dist

# 仅构建 macOS（Universal）
npm run dist:mac

# 仅构建 Windows（x64）
npm run dist:win

# 打包到目录（不生成安装包）
npm pack
```

### 后端配置
应用会自动检测后端地址：
- 优先使用环境变量 `BACKEND_BASE_URL`
- 本地开发时检测 `../../../backend/main.py` 存在则使用 `http://127.0.0.1:3000`
- 默认生产地址：`https://lab.uibe.edu.cn`

## 架构概览

### 三层架构
```
┌─────────────────────────────────────────┐
│  Renderer Process (渲染进程)            │
│  - student/: 学生端页面                 │
│  - teacher/: 教师端页面                 │
│  - login/: 登录页面                     │
│  - shared/: 共享 UI 组件                │
└─────────────────────────────────────────┘
              ↕ (contextBridge)
┌─────────────────────────────────────────┐
│  Preload Script (预加载脚本)            │
│  - 暴露安全的 window.api 接口           │
│  - 集成 marked + highlight.js           │
└─────────────────────────────────────────┘
              ↕ (IPC)
┌─────────────────────────────────────────┐
│  Main Process (主进程)                  │
│  - main/index.js: 应用入口              │
│  - main/ipc/student.js: 学生端 IPC      │
│  - main/ipc/teacher.js: 教师端 IPC      │
└─────────────────────────────────────────┘
```

### 关键模块

**主进程 (`main/`)**
- `index.js`: 应用生命周期、窗口管理、日志系统、机器 ID 生成
- `ipc/student.js`: 学生端 IPC 处理器（作业提交、判分、期末考试）
- `ipc/teacher.js`: 教师端 IPC 处理器（班级管理、考试配置）

**预加载脚本 (`preload/`)**
- `preload.js`: 通过 contextBridge 暴露统一的 `window.api`，包含认证、作业、缓存、文件操作等接口

**渲染进程 (`renderer/`)**
- `student/`: 学生端页面（课程、作业、成绩查询、AI 辅助）
- `teacher/`: 教师端页面（班级详情、学生管理、考试配置）
- `login/`: 统一登录页面
- `shared/`: 共享工具（导航、认证、UI 组件、日志）

**共享模块 (`shared/`)**
- `constants.js`: 教师工号列表，用于区分用户角色
- `logger.js`: 统一日志工具

### 用户角色区分

登录时通过 `shared/constants.js` 中的 `TEACHER_IDS` 数组判断：
- 匹配教师工号 → 进入教师端
- 否则 → 进入学生端

当前教师工号：`57399`, `57401`, `57402`, `57408`, `57414`, `02393`

### 后端通信

**请求路径规则**
- 主进程通过 IPC 统一处理后端请求
- 教师端部分页面直接 `fetch` 到 `https://lab.uibe.edu.cn`
- 学生端部分页面混合使用 IPC 和直接 `fetch`

**兼容性路由**
后端同时支持带 `/api` 前缀和不带前缀的路由：
- `/api/uploadHomework` ✓
- `/uploadHomework` ✓（兼容旧版）

详细接口映射参见 `CLIENT_ROUTE_ANALYSIS.md`

### 本地存储

**用户数据目录**: `app.getPath('userData')/unified-education-client/`
- `students/{studentId}/`: 学生数据
- `students/{studentId}/{studentId}_courses/`: 课程文件
- `homework_zips/{studentId}/{className}/`: 作业压缩包缓存
- `client.log`: 应用日志

**缓存机制**
- 课程列表缓存在 `courses.json`
- 作业 ZIP 缓存避免重复下载
- 机器 ID 持久化用于设备绑定

## 重要约定

### 安全性
- 机器 ID 用于设备绑定验证（学生端）
- 教师端当前未强制机器码校验
- 所有后端请求通过 HTTPS（生产环境）

### 错误处理
- 主进程统一日志记录到 `client.log`
- IPC 响应格式：`{ ok: boolean, data?: any, error?: string, status?: number }`
- 前端需处理网络失败、404、权限错误等场景

### 代码风格
- 使用 ES6+ 语法
- 异步操作使用 async/await
- IPC 通信使用 `ipcRenderer.invoke` / `ipcMain.handle`
- 避免在渲染进程直接使用 Node.js API（通过 preload 暴露）

## 已知问题与兼容性

参见 `后端404排查与作业判分接口说明.md` 和 `CLIENT_ROUTE_ANALYSIS.md`：

1. **期末考试接口字段不一致**: FastAPI 返回 `exam_time/exam_duration`，客户端期待 `start_time/end_time/final_auc`
2. **排行榜格式不匹配**: 前端期待二维数组，后端返回对象结构
3. **缺失接口**: `getFinalValidateTime` 和 `getHomeworkVideo` 仅在旧版 Flask 备份中存在
4. **平台参数不一致**: 下载客户端时 IPC 传 `mac`，后端期待 `darwin`

## 调试技巧

### 查看日志
```bash
# macOS
tail -f ~/Library/Application\ Support/Electron/unified-education-client/client.log

# Windows
type %APPDATA%\Electron\unified-education-client\client.log
```

### 开发者工具
应用启动后按 `Cmd+Option+I` (macOS) 或 `Ctrl+Shift+I` (Windows) 打开 DevTools

### 测试后端连接
```javascript
// 在渲染进程控制台
const baseUrl = await window.api.getBaseUrl();
console.log('Backend URL:', baseUrl);
```

## 构建产物

- **macOS**: `release/*.dmg` (Universal binary)
- **Windows**: `release/*.exe` (Portable, x64)
- **图标**: `src/image/tupian.icns` (macOS), `src/image/tupian.ico` (Windows)
