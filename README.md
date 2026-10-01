# 冷链探头超温台

记录员上报探头编号与摄氏温度，后台工人用数据库行锁认领待处理队列，按 **8℃** 上限判定 **合格** 或 **超温**。

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

## 天气关闸

雨雪天气可临时关闭报温：记录员在顶栏 **天气关闸** 专页开启关闸后，服务端写口
（`POST /api/readings`）一律挡回 `403` 并说明“天气关闸已关闭……关闸打开后立即恢复写入”，
同时在同一数据库事务内写入一条 `reject` 流水——挡回与流水同成同败，不会半截；关闸期间读数绝不落库。
关掉关闸后提交立即恢复 `201`。

- 开关态以服务端 `GET /api/weather-gate` 为唯一来源，提交页“禁交灯”与关闸页共用同一份状态；
  仅前端变文案/可交不禁交不算数，服务端始终按开关拦截。
- `POST /api/weather-gate`（body `{"closed": true|false}`）仅记录员可用；开关翻转与
  `close`/`open` 流水同事务提交。
- 关闸流水见 `GET /api/weather-gate/logs`（`close` / `open` / `reject`）。
- 值班员 watcher 为观察账号：可查看开关与流水，开关按钮禁用，改开关、提交读数均返回 `403`。

## 本地开发（可选）

```bash
# 需本机 PostgreSQL 或仅起 db 容器
cd backend && pip install -r requirements.txt && python api.py
cd backend && python worker.py
cd frontend && npm install && npm run dev
```

接口进程默认监听容器内 **8000**，对外映射 **8197**。
