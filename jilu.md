# 惠园教学APP 逆向分析笔记

## API 发现

### 排名接口

```
GET https://lab.uibe.edu.cn/api/getFinaltestRanking
参数: student_id, class_name, window
返回: { ok, class_name, student_id, my_rank, my_auc, total_students, above[], below[] }
```

### 排名查询脚本

见 `query_ranking.ps1`

### 发现：状态接口与排名接口不同步

通过对比状态接口返回的 `server_auc` 与排名接口返回的 `my_auc`，发现：
- 状态接口反映最新提交的 AUC
- 排名接口可能使用旧值/缓存
- 存在排行榜数据不同步的问题

## 文件说明

- `query_ranking.ps1` - PowerShell 脚本，用于查询排名接口
- `ranking_raw.json` - 排名接口原始返回示例
- `midterm_sample.json` - 期中考试提交代码示例（脱敏）
- `midterm_ranking.txt` - 期中排名数据（学号已脱敏）
