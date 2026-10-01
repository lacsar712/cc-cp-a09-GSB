# 冷链探头超温台

记录员上报探头编号与摄氏温度，后台工人用数据库行锁认领待处理队列，按 **8℃** 上限判定 **合格** 或 **超温**。

## 雨雪天气关闸

雨雪天气可临时关闭报温：

- 记录员在顶栏进入 **天气关闸** 专页（`#/weather-gate`），可开关关闸；页面展示此刻是否关闸与完整关闸流水。
- 关闸后服务端写口（`POST /api/readings`）一律 **403 挡回**并说明"雨雪天气关闸中…"，挡回与流水在**同一数据库事务**内落账（行锁读开关态，流水失败整体回滚，不允许半截），读数绝不插入；解除关闸后立刻恢复写入。
- 开关、主页禁交灯（输入框与提交按钮禁用）、写口拦截三环共用数据库中同一个开关态：前端只做提示，最终以后端拦截为准。
- 值班员可查看开关状态与关闸流水，但拨动开关返回 403。

| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| GET | `/api/weather-gate` | 登录用户 | 当前开关态 |
| POST | `/api/weather-gate/toggle` | 记录员 | 拨动开关（body `{"closed": true/false}`），同事务写流水 |
| GET | `/api/weather-gate/log` | 登录用户 | 关闸/开闸/挡回流水 |

## 技术栈

| 层 | 选型 |
|----|------|
| 接口 | Python aiohttp + asyncpg |
| 工人 | `worker.py`（psycopg，`FOR UPDATE SKIP LOCKED`） |
| 页面 | Preact + Vite，nginx 反代 `/api` |
| 数据库 | PostgreSQL 16 |

## 端口

| 服务 | 地址 |
|------|------|
| 页面 | http://localhost:3197 |
| 接口 | http://localhost:8197 |
| PostgreSQL | localhost:54397（库名 `coldchain`） |

## 账号

| 用户 | 密码 | 权限 |
|------|------|------|
| logger | log123456 | 记录员，可提交读数 |
| watcher | watch123456 | 值班员，只读列表 |

## 启动

```bash
cd projects/18-coldchain-probe-desk
docker compose up --build
```

健康检查：`GET http://localhost:8197/api/health` → `{"status":"ok","service":"coldchain-probe-desk"}`

## 种子数据

| 探头 | 温度 | 结论 |
|------|------|------|
| 探头A01 | 4.2℃ | 合格 |
| 探头B02 | 12.5℃ | 超温 |

## 本地开发（可选）

```bash
# 需本机 PostgreSQL 或仅起 db 容器
cd backend && pip install -r requirements.txt && python api.py
cd backend && python worker.py
cd frontend && npm install && npm run dev
```

接口进程默认监听容器内 **8000**，对外映射 **8197**。
