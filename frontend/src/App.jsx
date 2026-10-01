import { useCallback, useEffect, useState } from "preact/hooks";

const TOKEN_KEY = "coldchain_token";
const USER_KEY = "coldchain_user";

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

function actionClass(action) {
  if (action === "挡回") return "tag fail";
  if (action === "关闸") return "tag fail";
  if (action === "开闸") return "tag pass";
  return "tag wait";
}

function useHashRoute() {
  const [route, setRoute] = useState(() =>
    window.location.hash.replace(/^#/, "")
  );
  useEffect(() => {
    const onHash = () => setRoute(window.location.hash.replace(/^#/, ""));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return route;
}

function fmtTime(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return iso;
  }
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
  const [loginForm, setLoginForm] = useState({ username: "logger", password: "log123456" });
  const [loading, setLoading] = useState(false);
  const [loginError, setLoginError] = useState("");
  const route = useHashRoute();

  // 全应用唯一的天气关闸开关态：开关、禁交灯、写口拦截都以此为准
  const [gate, setGate] = useState(null);

  const authHeaders = useCallback(() => {
    const h = { "Content-Type": "application/json" };
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  }, [token]);

  const loadGate = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch("/api/weather-gate", { headers: authHeaders() });
      if (res.ok) setGate(await res.json());
    } catch {
      /* 轮询失败保留下一次刷新 */
    }
  }, [token, authHeaders]);

  useEffect(() => {
    if (!token) {
      setGate(null);
      return undefined;
    }
    loadGate();
    const t = setInterval(loadGate, 3000);
    return () => clearInterval(t);
  }, [loadGate, token, route]);

  async function onLogin(e) {
    e.preventDefault();
    setLoginError("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(loginForm),
      });
      if (!res.ok) {
        setLoginError("用户名或密码错误");
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
    setGate(null);
    window.location.hash = "";
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
            {loginError && <p class="err">{loginError}</p>}
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

  return (
    <div class="wrap">
      <div class="topbar">
        <div>
          <h1>冷链探头超温台</h1>
          <p class="sub" style={{ marginBottom: 0 }}>
            温度不超过 8℃ 为合格，否则为超温。
          </p>
        </div>
        <div class="user">
          <span class={gateClosed ? "lamp on" : "lamp off"} title="天气关闸开关态（与服务端同步）">
            {gateClosed ? "关闸中" : "可报温"}
          </span>
          <a
            class={route === "/weather-gate" ? "nav active" : "nav"}
            href="#/weather-gate"
          >
            天气关闸
          </a>
          {user?.username}（{isWriter ? "记录员" : "值班员"}）
          <button type="button" class="secondary" style={{ marginLeft: "0.5rem" }} onClick={logout}>
            退出
          </button>
        </div>
      </div>

      {route === "/weather-gate" ? (
        <WeatherGatePage
          isWriter={isWriter}
          gate={gate}
          gateClosed={gateClosed}
          authHeaders={authHeaders}
          onChanged={loadGate}
        />
      ) : (
        <HomePage
          isWriter={isWriter}
          gateClosed={gateClosed}
          authHeaders={authHeaders}
          onGateChanged={loadGate}
        />
      )}
    </div>
  );
}

function HomePage({ isWriter, gateClosed, authHeaders, onGateChanged }) {
  const [submitForm, setSubmitForm] = useState({ probe_id: "", temp_c: "" });
  const [rows, setRows] = useState([]);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(false);

  const loadReadings = useCallback(async () => {
    const res = await fetch("/api/readings", { headers: authHeaders() });
    if (!res.ok) {
      setError("加载列表失败，请重新登录");
      return;
    }
    setRows(await res.json());
  }, [authHeaders]);

  useEffect(() => {
    loadReadings();
    const t = setInterval(loadReadings, 3000);
    return () => clearInterval(t);
  }, [loadReadings]);

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
        // 服务端是最终拦截方：即使页面灯态滞后，被挡后也要立即把灯拉成关闸
        if (data.gate_closed) onGateChanged();
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

  return (
    <>
      {isWriter && (
        <div class="card">
          <h2 style={{ marginTop: 0, fontSize: "1.1rem" }}>提交读数</h2>

          <div class={gateClosed ? "gate-banner closed" : "gate-banner open"}>
            <span class={gateClosed ? "dot red" : "dot green"} />
            {gateClosed ? (
              <span>
                <strong>雨雪天气关闸中</strong>：报温通道已临时关闭，服务端将挡回全部读数，解除关闸后立刻恢复写入。
              </span>
            ) : (
              <span>
                <strong>报温通道开放</strong>：可正常提交读数。
              </span>
            )}
          </div>

          <form onSubmit={onSubmit}>
            <div class="row">
              <label>
                探头编号
                <input
                  required
                  value={submitForm.probe_id}
                  disabled={gateClosed}
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
                  type="number"
                  step="0.1"
                  value={submitForm.temp_c}
                  disabled={gateClosed}
                  onInput={(e) =>
                    setSubmitForm({ ...submitForm, temp_c: e.target.value })
                  }
                />
              </label>
              <button type="submit" disabled={loading || gateClosed}>
                {gateClosed ? "关闸中·停止报温" : "提交"}
              </button>
            </div>
            {error && <p class="err">{error}</p>}
            {msg && <p class="ok">{msg}</p>}
          </form>
        </div>
      )}

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
    </>
  );
}

function WeatherGatePage({ isWriter, gate, gateClosed, authHeaders, onChanged }) {
  const [logs, setLogs] = useState([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const loadLogs = useCallback(async () => {
    const res = await fetch("/api/weather-gate/log", { headers: authHeaders() });
    if (res.ok) setLogs(await res.json());
  }, [authHeaders]);

  useEffect(() => {
    loadLogs();
    const t = setInterval(loadLogs, 3000);
    return () => clearInterval(t);
  }, [loadLogs]);

  async function flip(nextClosed) {
    setError("");
    setBusy(true);
    try {
      const res = await fetch("/api/weather-gate/toggle", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ closed: nextClosed }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.detail || "切换关闸失败");
        return;
      }
      await onChanged();
      await loadLogs();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div class="card">
        <div class="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ margin: 0, fontSize: "1.1rem" }}>天气关闸</h2>
          <a class="nav" href="#">
            返回报温台
          </a>
        </div>

        <div class={gateClosed ? "gate-banner closed" : "gate-banner open"} style={{ marginTop: "0.9rem" }}>
          <span class={gateClosed ? "dot red" : "dot green"} />
          <span>
            此刻状态：<strong>{gateClosed ? "已关闸（停止报温）" : "未关闸（可报温）"}</strong>
            {gate?.updated_by && (
              <span class="sub" style={{ marginLeft: "0.6rem" }}>
                最近由 {gate.updated_by} 于 {fmtTime(gate.updated_at)} 切换
              </span>
            )}
          </span>
        </div>

        {isWriter ? (
          <div class="switch-row">
            <button
              type="button"
              class={gateClosed ? "secondary" : "danger"}
              disabled={busy}
              onClick={() => flip(!gateClosed)}
            >
              {gateClosed ? "解除关闸，恢复报温" : "雨雪天气，关闭报温"}
            </button>
            <span class="sub" style={{ margin: 0 }}>
              {gateClosed
                ? "关闸期间所有读数由服务端挡回并记入流水；点击解除后立刻恢复写入。"
                : "点击后服务端立即挡回后续读数，挡回与流水在同一事务内落账。"}
            </span>
          </div>
        ) : (
          <p class="sub" style={{ marginBottom: 0 }}>
            值班员仅可查看开关状态与关闸流水，不能拨动开关。
          </p>
        )}
        {error && <p class="err">{error}</p>}
      </div>

      <div class="card">
        <h2 style={{ marginTop: 0, fontSize: "1.1rem" }}>关闸流水</h2>
        <table>
          <thead>
            <tr>
              <th>编号</th>
              <th>时间</th>
              <th>动作</th>
              <th>操作人</th>
              <th>探头</th>
              <th>温度℃</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((r) => (
              <tr key={r.id}>
                <td>{r.id}</td>
                <td>{fmtTime(r.created_at)}</td>
                <td>
                  <span class={actionClass(r.action)}>{r.action}</span>
                </td>
                <td>{r.operator}</td>
                <td>{r.probe_id || "—"}</td>
                <td>{r.temp_c == null ? "—" : r.temp_c}</td>
                <td>{r.detail || "—"}</td>
              </tr>
            ))}
            {logs.length === 0 && (
              <tr>
                <td colspan="7">暂无关闸流水</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
