import { useCallback, useEffect, useState } from "preact/hooks";

const TOKEN_KEY = "coldchain_token";
const USER_KEY = "coldchain_user";
const GATE_ROUTE = "#/weather-gate";

function verdictClass(v, status) {
  if (v === "合格") return "tag pass";
  if (v === "超温") return "tag fail";
  if (status === "pending" || status === "processing") return "tag wait";
  return "tag wait";
}

function displayVerdict(row) {
  if (row.verdict) return row.verdict;
  if (row.status === "pending") return "待处理";
  if (row.status === "processing") return "处理中";
  return "—";
}

function gateActionLabel(action) {
  if (action === "close") return "关闸";
  if (action === "open") return "开闸";
  if (action === "reject") return "挡回";
  return action;
}

function gateActionClass(action) {
  if (action === "close" || action === "reject") return "tag fail";
  if (action === "open") return "tag pass";
  return "tag wait";
}

function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(
    d.getHours()
  )}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function App() {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY));
  const [user, setUser] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(USER_KEY) || "null");
    } catch {
      return null;
    }
  });
  const [route, setRoute] = useState(() => window.location.hash || "#/");
  const [loginForm, setLoginForm] = useState({ username: "logger", password: "log123456" });
  const [submitForm, setSubmitForm] = useState({ probe_id: "", temp_c: "" });
  const [rows, setRows] = useState([]);
  const [gate, setGate] = useState(null);
  const [gateLogs, setGateLogs] = useState([]);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const onHash = () => setRoute(window.location.hash || "#/");
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const authHeaders = useCallback(() => {
    const h = { "Content-Type": "application/json" };
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  }, [token]);

  const loadReadings = useCallback(async () => {
    if (!token) return;
    const res = await fetch("/api/readings", { headers: authHeaders() });
    if (!res.ok) {
      setError("加载列表失败，请重新登录");
      return;
    }
    setRows(await res.json());
  }, [token, authHeaders]);

  // 开关态一律以服务端 /api/weather-gate 为准，首页禁交灯与关闸页共用这一份状态
  const loadGate = useCallback(async () => {
    if (!token) return;
    const res = await fetch("/api/weather-gate", { headers: authHeaders() });
    if (res.ok) setGate(await res.json());
  }, [token, authHeaders]);

  const loadGateLogs = useCallback(async () => {
    if (!token) return;
    const res = await fetch("/api/weather-gate/logs", { headers: authHeaders() });
    if (res.ok) setGateLogs(await res.json());
  }, [token, authHeaders]);

  useEffect(() => {
    if (!token) return undefined;
    loadReadings();
    loadGate();
    const t = setInterval(() => {
      loadReadings();
      loadGate();
    }, 3000);
    return () => clearInterval(t);
  }, [loadReadings, loadGate, token]);

  useEffect(() => {
    if (!token || route !== GATE_ROUTE) return undefined;
    loadGateLogs();
    const t = setInterval(loadGateLogs, 3000);
    return () => clearInterval(t);
  }, [loadGateLogs, route, token]);

  async function onLogin(e) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(loginForm),
      });
      if (!res.ok) {
        setError("用户名或密码错误");
        return;
      }
      const data = await res.json();
      localStorage.setItem(TOKEN_KEY, data.access_token);
      localStorage.setItem(
        USER_KEY,
        JSON.stringify({ username: data.username, role: data.role })
      );
      setToken(data.access_token);
      setUser({ username: data.username, role: data.role });
    } finally {
      setLoading(false);
    }
  }

  function logout() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    setToken(null);
    setUser(null);
    setRows([]);
    setGate(null);
    setGateLogs([]);
  }

  async function onSubmit(e) {
    e.preventDefault();
    setError("");
    setMsg("");
    setLoading(true);
    try {
      const res = await fetch("/api/readings", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          probe_id: submitForm.probe_id,
          temp_c: parseFloat(submitForm.temp_c),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // 服务端挡回（天气关闸）：立刻同步开关态，点亮禁交灯，绝不靠改文案放过
        if (data.gate_closed) setGate((g) => ({ ...(g || {}), closed: true }));
        setError(data.detail || "提交失败");
        return;
      }
      setMsg(data.message || "已提交");
      setSubmitForm({ probe_id: "", temp_c: "" });
      await loadReadings();
    } finally {
      setLoading(false);
    }
  }

  async function onToggleGate(nextClosed) {
    setError("");
    setMsg("");
    setLoading(true);
    try {
      const res = await fetch("/api/weather-gate", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ closed: nextClosed }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.detail || "切换关闸失败");
        return;
      }
      setGate(data);
      await loadGateLogs();
      setMsg(nextClosed ? "已关闸，报温写入已暂停" : "已打开关闸，报温写入立即恢复");
    } finally {
      setLoading(false);
    }
  }

  if (!token) {
    return (
      <div class="wrap">
        <h1>冷链探头超温台</h1>
        <p class="sub">记录员提交探头编号与摄氏温度，后台工人认领后判定合格或超温。</p>
        <div class="card">
          <form onSubmit={onLogin}>
            <div class="row">
              <label>
                用户名
                <input
                  value={loginForm.username}
                  onInput={(e) =>
                    setLoginForm({ ...loginForm, username: e.target.value })
                  }
                />
              </label>
              <label>
                密码
                <input
                  type="password"
                  value={loginForm.password}
                  onInput={(e) =>
                    setLoginForm({ ...loginForm, password: e.target.value })
                  }
                />
              </label>
              <button type="submit" disabled={loading}>
                登录
              </button>
            </div>
            {error && <p class="err">{error}</p>}
          </form>
          <p class="sub" style={{ marginBottom: 0 }}>
            记录员 logger / log123456 · 值班员 watcher / watch123456
          </p>
        </div>
      </div>
    );
  }

  const isWriter = user?.role === "writer";
  const gateClosed = !!gate?.closed;
  const onGatePage = route === GATE_ROUTE;

  function topNav() {
    return (
      <nav class="nav">
        <a href="#/" class={onGatePage ? "" : "active"}>
          报温台
        </a>
        <a href={GATE_ROUTE} class={onGatePage ? "active" : ""}>
          天气关闸
        </a>
      </nav>
    );
  }

  function submitCard() {
    return (
      <div class="card">
        <div class="card-head">
          <h2 style={{ margin: 0, fontSize: "1.1rem" }}>提交读数</h2>
          <span class={gateClosed ? "lamp red" : "lamp green"}>
            <i />
            {gateClosed ? "天气关闸中 · 禁交" : "关闸未启用 · 可交"}
          </span>
        </div>
        {gateClosed && (
          <p class="gate-banner">
            雨雪天气关闸已开启，服务端暂停接收报温；关闸打开后立即恢复写入。
          </p>
        )}
        <form onSubmit={onSubmit}>
          <div class="row">
            <label>
              探头编号
              <input
                required
                disabled={gateClosed}
                value={submitForm.probe_id}
                onInput={(e) =>
                  setSubmitForm({ ...submitForm, probe_id: e.target.value })
                }
                placeholder="例如 探头C03"
              />
            </label>
            <label>
              温度（℃）
              <input
                required
                disabled={gateClosed}
                type="number"
                step="0.1"
                value={submitForm.temp_c}
                onInput={(e) =>
                  setSubmitForm({ ...submitForm, temp_c: e.target.value })
                }
              />
            </label>
            <button type="submit" disabled={loading || gateClosed}>
              {gateClosed ? "禁止提交" : "提交"}
            </button>
          </div>
          {error && <p class="err">{error}</p>}
          {msg && <p class="ok">{msg}</p>}
        </form>
      </div>
    );
  }

  function readingsCard() {
    return (
      <div class="card">
        <h2 style={{ marginTop: 0, fontSize: "1.1rem" }}>读数列表</h2>
        <table>
          <thead>
            <tr>
              <th>编号</th>
              <th>探头</th>
              <th>温度℃</th>
              <th>结论</th>
              <th>说明</th>
              <th>状态</th>
              <th>提交人</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.id}</td>
                <td>{r.probe_id}</td>
                <td>{r.temp_c}</td>
                <td>
                  <span class={verdictClass(r.verdict, r.status)}>
                    {displayVerdict(r)}
                  </span>
                </td>
                <td>{r.reason || "—"}</td>
                <td>{r.status}</td>
                <td>{r.created_by}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colspan="7">暂无数据</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    );
  }

  function gatePage() {
    return (
      <>
        <div class="card">
          <div class="card-head">
            <h2 style={{ margin: 0, fontSize: "1.1rem" }}>天气关闸</h2>
            <span class={gateClosed ? "lamp red" : "lamp green"}>
              <i />
              {gateClosed ? "此刻：关闸中" : "此刻：未关闸"}
            </span>
          </div>
          <p class="sub" style={{ marginTop: "0.5rem", marginBottom: "0.5rem" }}>
            {gateClosed
              ? "雨雪天气临时关闸，记录员报温一律由服务端挡回并记入流水；关掉关闸后立即恢复写入。"
              : "当前未关闸，记录员可正常提交报温。雨雪天气可开启关闸临时暂停写入。"}
          </p>
          <p class="sub" style={{ marginBottom: "0.75rem" }}>
            最近操作：{gate?.updated_by ? `${gate.updated_by} · ${fmtTime(gate.updated_at)}` : "—"}
            {gate?.reason ? ` · ${gate.reason}` : ""}
          </p>
          <div class="switch-row">
            <button
              type="button"
              class={gateClosed ? "secondary" : "danger"}
              disabled={loading || !isWriter || gateClosed}
              onClick={() => onToggleGate(true)}
              title={!isWriter ? "仅记录员可操作" : ""}
            >
              开启关闸（暂停报温）
            </button>
            <button
              type="button"
              class={gateClosed ? "" : "secondary"}
              disabled={loading || !isWriter || !gateClosed}
              onClick={() => onToggleGate(false)}
            >
              关掉关闸（恢复写入）
            </button>
            {!isWriter && <span class="hint">值班员为观察账号：可查看开关与流水，不能操作开关。</span>}
          </div>
          {error && <p class="err">{error}</p>}
          {msg && <p class="ok">{msg}</p>}
        </div>

        <div class="card">
          <h2 style={{ marginTop: 0, fontSize: "1.1rem" }}>关闸流水</h2>
          <table>
            <thead>
              <tr>
                <th>编号</th>
                <th>动作</th>
                <th>操作人</th>
                <th>说明</th>
                <th>时间</th>
              </tr>
            </thead>
            <tbody>
              {gateLogs.map((l) => (
                <tr key={l.id}>
                  <td>{l.id}</td>
                  <td>
                    <span class={gateActionClass(l.action)}>
                      {gateActionLabel(l.action)}
                    </span>
                  </td>
                  <td>{l.actor}</td>
                  <td>{l.detail || "—"}</td>
                  <td>{fmtTime(l.created_at)}</td>
                </tr>
              ))}
              {gateLogs.length === 0 && (
                <tr>
                  <td colspan="5">暂无流水</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </>
    );
  }

  return (
    <div class="wrap">
      <div class="topbar">
        <div>
          <h1>冷链探头超温台</h1>
          <div class="topline">
            <p class="sub" style={{ margin: 0 }}>
              温度不超过 8℃ 为合格，否则为超温。
            </p>
            {topNav()}
          </div>
        </div>
        <div class="user">
          {user?.username}（{isWriter ? "记录员" : "值班员"}）
          <button type="button" class="secondary" style={{ marginLeft: "0.5rem" }} onClick={logout}>
            退出
          </button>
        </div>
      </div>

      {onGatePage ? gatePage() : (
        <>
          {isWriter && submitCard()}
          {readingsCard()}
        </>
      )}
    </div>
  );
}
