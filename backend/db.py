import os

import asyncpg
import psycopg
from psycopg.rows import dict_row

from rules import judge_temp

DSN = os.environ.get(
    "DATABASE_URL", "postgresql://app:app@localhost:54397/coldchain"
)

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS probe_readings (
    id serial PRIMARY KEY,
    probe_id text NOT NULL,
    temp_c double precision NOT NULL,
    verdict text,
    reason text,
    status text NOT NULL DEFAULT 'pending',
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    processed_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_probe_readings_status ON probe_readings (status, id);

-- 天气关闸：全表只允许一行（id = 1），closed 为前后端共用的唯一开关态
CREATE TABLE IF NOT EXISTS weather_gate (
    id smallint PRIMARY KEY DEFAULT 1,
    closed boolean NOT NULL DEFAULT false,
    reason text NOT NULL DEFAULT '',
    updated_by text NOT NULL DEFAULT '',
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT weather_gate_singleton CHECK (id = 1)
);
INSERT INTO weather_gate (id, closed, reason, updated_by, updated_at)
VALUES (1, false, '', '', now())
ON CONFLICT (id) DO NOTHING;

-- 关闸流水：close 关闸 / open 开闸 / reject 关闸期间挡回提交（与写口同事务）
CREATE TABLE IF NOT EXISTS weather_gate_log (
    id serial PRIMARY KEY,
    action text NOT NULL,
    actor text NOT NULL,
    detail text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_weather_gate_log_id ON weather_gate_log (id);
"""


def connect_sync():
    return psycopg.connect(DSN, row_factory=dict_row)


def ensure_schema_sync(conn) -> None:
    conn.execute(SCHEMA_SQL)


async def create_pool() -> asyncpg.Pool:
    return await asyncpg.create_pool(DSN, min_size=1, max_size=5)


async def ensure_schema_async(pool: asyncpg.Pool) -> None:
    async with pool.acquire() as conn:
        await conn.execute(SCHEMA_SQL)


async def seed_if_empty(pool: asyncpg.Pool) -> None:
    async with pool.acquire() as conn:
        n = await conn.fetchval("SELECT COUNT(*) FROM probe_readings")
        if n and n > 0:
            return
        samples = [
            ("探头A01", 4.2),
            ("探头B02", 12.5),
        ]
        for probe_id, temp_c in samples:
            verdict, reason = judge_temp(temp_c)
            await conn.execute(
                """
                INSERT INTO probe_readings
                    (probe_id, temp_c, verdict, reason, status, created_by, processed_at)
                VALUES ($1, $2, $3, $4, 'done', 'logger', now())
                """,
                probe_id,
                temp_c,
                verdict,
                reason,
            )


def seed_if_empty_sync(conn) -> None:
    row = conn.execute("SELECT COUNT(*) AS n FROM probe_readings").fetchone()
    if row["n"] > 0:
        return
    samples = [
        ("探头A01", 4.2),
        ("探头B02", 12.5),
    ]
    for probe_id, temp_c in samples:
        verdict, reason = judge_temp(temp_c)
        conn.execute(
            """
            INSERT INTO probe_readings
                (probe_id, temp_c, verdict, reason, status, created_by, processed_at)
            VALUES (%s, %s, %s, %s, 'done', 'logger', now())
            """,
            (probe_id, temp_c, verdict, reason),
        )
    conn.commit()
