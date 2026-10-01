import json
import os
from datetime import datetime, timedelta, timezone

import asyncpg
import jwt
from aiohttp import web
from passlib.context import CryptContext

from db import create_pool, ensure_schema_async, seed_if_empty
from rules import judge_temp

SECRET = os.environ.get("JWT_SECRET", "coldchain-probe-dev-secret")
pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")

USERS = {
    "logger": {"role": "writer", "password_hash": pwd.hash("log123456")},
    "watcher": {"role": "reader", "password_hash": pwd.hash("watch123456")},
}


def _auth_header(request: web.Request) -> str | None:
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth[7:].strip()
    return None


def _decode_user(token: str | None) -> dict | None:
    if not token:
        return None
    try:
        payload = jwt.decode(token, SECRET, algorithms=["HS256"])
    except jwt.InvalidTokenError:
        return None
    sub = payload.get("sub")
    if sub not in USERS:
        return None
    return {"username": sub, "role": payload.get("role")}


def require_user(request: web.Request) -> dict:
    user = _decode_user(_auth_header(request))
    if not user:
        raise web.HTTPUnauthorized(text=json.dumps({"detail": "未登录"}, ensure_ascii=False), content_type="application/json")
    return user


def require_writer(request: web.Request) -> dict:
    user = require_user(request)
    if user["role"] != "writer":
        raise web.HTTPForbidden(
            text=json.dumps({"detail": "仅记录员可提交读数"}, ensure_ascii=False),
            content_type="application/json",
        )
    return user


async def health(_request: web.Request) -> web.Response:
    return web.json_response({"status": "ok", "service": "coldchain-probe-desk"})


async def login(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except json.JSONDecodeError as exc:
        raise web.HTTPBadRequest(text="invalid json") from exc
    username = str(body.get("username", "")).strip()
    password = str(body.get("password", ""))
    user = USERS.get(username)
    if not user or not pwd.verify(password, user["password_hash"]):
        raise web.HTTPUnauthorized(
            text=json.dumps({"detail": "用户名或密码错误"}, ensure_ascii=False),
            content_type="application/json",
        )
    exp = datetime.now(timezone.utc) + timedelta(hours=8)
    token = jwt.encode(
        {"sub": username, "role": user["role"], "exp": exp},
        SECRET,
        algorithm="HS256",
    )
    return web.json_response(
        {"access_token": token, "username": username, "role": user["role"]}
    )


async def list_readings(request: web.Request) -> web.Response:
    require_user(request)
    pool: asyncpg.Pool = request.app["pool"]
    rows = await pool.fetch(
        """
        SELECT id, probe_id, temp_c, verdict, reason, status, created_by, created_at, processed_at
        FROM probe_readings
        ORDER BY id DESC
        """
    )
    out = []
    for r in rows:
        out.append(
            {
                "id": r["id"],
                "probe_id": r["probe_id"],
                "temp_c": r["temp_c"],
                "verdict": r["verdict"],
                "reason": r["reason"],
                "status": r["status"],
                "created_by": r["created_by"],
                "created_at": r["created_at"].isoformat() if r["created_at"] else None,
                "processed_at": r["processed_at"].isoformat() if r["processed_at"] else None,
            }
        )
    return web.json_response(out)


GATE_BLOCK_DETAIL = "雨雪天气关闸中，报温通道已临时关闭，暂不收读数"


async def get_gate(request: web.Request) -> web.Response:
    require_user(request)
    pool: asyncpg.Pool = request.app["pool"]
    r = await pool.fetchrow(
        "SELECT closed, updated_by, updated_at FROM weather_gate_state WHERE id = 1"
    )
    return web.json_response(
        {
            "closed": bool(r["closed"]),
            "updated_by": r["updated_by"],
            "updated_at": r["updated_at"].isoformat() if r["updated_at"] else None,
        }
    )


async def toggle_gate(request: web.Request) -> web.Response:
    # 只有记录员可拨动开关；值班员能看不能改
    user = require_user(request)
    if user["role"] != "writer":
        raise web.HTTPForbidden(
            text=json.dumps({"detail": "天气关闸开关仅记录员可操作"}, ensure_ascii=False),
            content_type="application/json",
        )
    try:
        body = await request.json()
    except json.JSONDecodeError as exc:
        raise web.HTTPBadRequest(text="invalid json") from exc
    closed = bool(body.get("closed"))
    action = "关闸" if closed else "开闸"
    pool: asyncpg.Pool = request.app["pool"]
    async with pool.acquire() as conn:
        async with conn.transaction():
            r = await conn.fetchrow(
                """
                UPDATE weather_gate_state
                SET closed = $1, updated_by = $2, updated_at = now()
                WHERE id = 1
                RETURNING closed, updated_by, updated_at
                """,
                closed,
                user["username"],
            )
            await conn.execute(
                """
                INSERT INTO weather_gate_log (action, closed, operator, detail, created_at)
                VALUES ($1, $2, $3, $4, now())
                """,
                action,
                closed,
                user["username"],
                "记录员切换天气关闸开关",
            )
    return web.json_response(
        {
            "closed": bool(r["closed"]),
            "updated_by": r["updated_by"],
            "updated_at": r["updated_at"].isoformat() if r["updated_at"] else None,
            "message": f"已{action}，报温通道" + ("关闭" if closed else "恢复"),
        }
    )


async def gate_log(request: web.Request) -> web.Response:
    require_user(request)
    pool: asyncpg.Pool = request.app["pool"]
    rows = await pool.fetch(
        """
        SELECT id, action, closed, operator, probe_id, temp_c, detail, created_at
        FROM weather_gate_log
        ORDER BY id DESC
        LIMIT 200
        """
    )
    out = []
    for r in rows:
        out.append(
            {
                "id": r["id"],
                "action": r["action"],
                "closed": r["closed"],
                "operator": r["operator"],
                "probe_id": r["probe_id"],
                "temp_c": r["temp_c"],
                "detail": r["detail"],
                "created_at": r["created_at"].isoformat() if r["created_at"] else None,
            }
        )
    return web.json_response(out)


async def create_reading(request: web.Request) -> web.Response:
    user = require_writer(request)
    try:
        body = await request.json()
    except json.JSONDecodeError as exc:
        raise web.HTTPBadRequest(text="invalid json") from exc
    probe_id = str(body.get("probe_id", "")).strip()
    if not probe_id:
        raise web.HTTPBadRequest(
            text=json.dumps({"detail": "探头编号不能为空"}, ensure_ascii=False),
            content_type="application/json",
        )
    try:
        temp_c = float(body.get("temp_c"))
    except (TypeError, ValueError) as exc:
        raise web.HTTPBadRequest(
            text=json.dumps({"detail": "温度必须是数字"}, ensure_ascii=False),
            content_type="application/json",
        ) from exc

    pool: asyncpg.Pool = request.app["pool"]
    # 关闸判断、流水落账、读数写入在同一事务内：
    # 行锁锁定开关态，关闸则只写流水（随事务正常提交落账），读数绝不插入；
    # 任一语句失败整体回滚，不允许半截流水或半截写入。
    # 注意：403 必须在事务块提交之后再抛，否则异常会连带回滚流水。
    blocked = False
    row = None
    async with pool.acquire() as conn:
        async with conn.transaction():
            gate = await conn.fetchrow(
                "SELECT closed FROM weather_gate_state WHERE id = 1 FOR UPDATE"
            )
            if gate is not None and gate["closed"]:
                await conn.execute(
                    """
                    INSERT INTO weather_gate_log
                        (action, closed, operator, probe_id, temp_c, detail, created_at)
                    VALUES ('挡回', true, $1, $2, $3, $4, now())
                    """,
                    user["username"],
                    probe_id,
                    temp_c,
                    GATE_BLOCK_DETAIL,
                )
                blocked = True
            else:
                row = await conn.fetchrow(
                    """
                    INSERT INTO probe_readings (probe_id, temp_c, status, created_by, created_at)
                    VALUES ($1, $2, 'pending', $3, now())
                    RETURNING id, probe_id, temp_c, verdict, reason, status, created_by, created_at, processed_at
                    """,
                    probe_id,
                    temp_c,
                    user["username"],
                )
    if blocked:
        raise web.HTTPForbidden(
            text=json.dumps(
                {
                    "detail": GATE_BLOCK_DETAIL,
                    "gate_closed": True,
                },
                ensure_ascii=False,
            ),
            content_type="application/json",
        )
    return web.json_response(
        {
            "id": row["id"],
            "probe_id": row["probe_id"],
            "temp_c": row["temp_c"],
            "verdict": row["verdict"],
            "reason": row["reason"],
            "status": row["status"],
            "created_by": row["created_by"],
            "created_at": row["created_at"].isoformat() if row["created_at"] else None,
            "processed_at": None,
            "message": "已入队，后台工人将认领并判定",
        },
        status=201,
    )


async def on_startup(app: web.Application) -> None:
    pool = await create_pool()
    app["pool"] = pool
    await ensure_schema_async(pool)
    await seed_if_empty(pool)


async def on_cleanup(app: web.Application) -> None:
    pool: asyncpg.Pool = app.get("pool")
    if pool:
        await pool.close()


def create_app() -> web.Application:
    app = web.Application()
    app.router.add_get("/api/health", health)
    app.router.add_post("/api/auth/login", login)
    app.router.add_get("/api/readings", list_readings)
    app.router.add_post("/api/readings", create_reading)
    app.router.add_get("/api/weather-gate", get_gate)
    app.router.add_post("/api/weather-gate/toggle", toggle_gate)
    app.router.add_get("/api/weather-gate/log", gate_log)
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    return app


if __name__ == "__main__":
    web.run_app(create_app(), host="0.0.0.0", port=8000)
