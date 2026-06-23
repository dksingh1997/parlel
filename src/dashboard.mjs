// Parlel — control-plane dashboard.
//
// A single self-contained HTML page (vanilla JS, no build step, no CDN, no
// dependencies) served by the control plane at GET / for browsers. It is a pure
// client of the existing control-plane JSON API (/services, /reset,
// /services/:slug/{reset,state,requests}) — it adds no new server behavior.
//
// Kept as one string so the control plane stays zero-dependency and there is no
// static-asset pipeline to maintain.

export function dashboardHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Parlel — control plane</title>
<style>
  :root {
    --bg: #0b0e14; --panel: #11151f; --panel-2: #161b27; --line: #232a3a;
    --text: #e6e9ef; --muted: #8a93a6; --accent: #5ad1a0; --accent-2: #6aa8ff;
    --danger: #ff6b6b; --warn: #ffb454; --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
  header { display: flex; align-items: center; gap: 16px; padding: 16px 24px;
    border-bottom: 1px solid var(--line); position: sticky; top: 0; background: var(--bg); z-index: 5; }
  header h1 { font-size: 16px; margin: 0; letter-spacing: .3px; }
  header .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 8px var(--accent); }
  header .meta { color: var(--muted); font-family: var(--mono); font-size: 12px; }
  header .spacer { flex: 1; }
  button { font: inherit; cursor: pointer; border: 1px solid var(--line); background: var(--panel-2);
    color: var(--text); padding: 6px 12px; border-radius: 7px; transition: .12s; }
  button:hover { border-color: var(--accent-2); }
  button.danger { color: var(--danger); border-color: #3a2230; }
  button.danger:hover { border-color: var(--danger); }
  button.ghost { background: transparent; }
  .wrap { padding: 20px 24px; max-width: 1200px; margin: 0 auto; }
  .toolbar { display: flex; gap: 10px; align-items: center; margin-bottom: 18px; }
  .toolbar input { font: inherit; background: var(--panel); border: 1px solid var(--line);
    color: var(--text); padding: 7px 10px; border-radius: 7px; min-width: 220px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 14px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; }
  .card .top { display: flex; align-items: center; gap: 8px; }
  .card .slug { font-weight: 600; font-size: 15px; }
  .badge { font-family: var(--mono); font-size: 11px; padding: 2px 7px; border-radius: 20px;
    border: 1px solid var(--line); color: var(--muted); }
  .badge.http { color: var(--accent-2); border-color: #1f3a5a; }
  .badge.tcp { color: var(--warn); border-color: #4a3a1f; }
  .conn { font-family: var(--mono); font-size: 12px; color: var(--muted); margin: 10px 0 6px;
    word-break: break-all; user-select: all; }
  .row { display: flex; gap: 8px; align-items: center; color: var(--muted); font-size: 12px; }
  .caps { display: flex; gap: 6px; margin: 8px 0 12px; flex-wrap: wrap; }
  .cap { font-size: 10px; font-family: var(--mono); padding: 1px 6px; border-radius: 4px;
    border: 1px solid var(--line); color: #4f5a70; }
  .cap.on { color: var(--accent); border-color: #1f3a30; }
  .actions { display: flex; gap: 8px; }
  .empty { color: var(--muted); text-align: center; padding: 60px 0; }
  dialog { background: var(--panel); color: var(--text); border: 1px solid var(--line);
    border-radius: 12px; max-width: 760px; width: 90vw; padding: 0; }
  dialog::backdrop { background: rgba(0,0,0,.6); }
  dialog .dlg-head { display: flex; align-items: center; padding: 14px 18px; border-bottom: 1px solid var(--line); }
  dialog .dlg-head .spacer { flex: 1; }
  dialog .dlg-body { padding: 16px 18px; max-height: 70vh; overflow: auto; }
  pre { font-family: var(--mono); font-size: 12px; background: var(--panel-2); border: 1px solid var(--line);
    border-radius: 8px; padding: 12px; overflow: auto; margin: 0; white-space: pre-wrap; word-break: break-word; }
  .req { border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; margin-bottom: 8px; background: var(--panel-2); }
  .req .line { display: flex; gap: 8px; align-items: baseline; font-family: var(--mono); font-size: 12px; }
  .m { font-weight: 700; }
  .m.GET { color: var(--accent-2); } .m.POST { color: var(--accent); }
  .m.DELETE { color: var(--danger); } .m.PUT, .m.PATCH { color: var(--warn); }
  .st { margin-left: auto; color: var(--muted); }
  .st.ok { color: var(--accent); } .st.err { color: var(--danger); }
  .toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
    background: var(--panel-2); border: 1px solid var(--accent); color: var(--text);
    padding: 10px 16px; border-radius: 8px; opacity: 0; transition: .2s; pointer-events: none; }
  .toast.show { opacity: 1; }
</style>
</head>
<body>
<header>
  <span class="dot"></span>
  <h1>Parlel</h1>
  <span class="meta" id="summary">connecting…</span>
  <span class="spacer"></span>
  <button class="ghost" id="refresh">Refresh</button>
  <button class="danger" id="resetAll">Reset all</button>
</header>

<div class="wrap">
  <div class="toolbar">
    <input id="filter" placeholder="Filter services…" autocomplete="off" />
    <span class="meta" id="count"></span>
  </div>
  <div class="grid" id="grid"></div>
  <div class="empty" id="empty" hidden>No services running. Start some with <code>parlel up &lt;slug&gt;</code>.</div>
</div>

<dialog id="dlg">
  <div class="dlg-head"><strong id="dlgTitle"></strong><span class="spacer"></span>
    <button class="ghost" id="dlgClose">Close</button></div>
  <div class="dlg-body" id="dlgBody"></div>
</dialog>

<div class="toast" id="toast"></div>

<script>
const $ = (s) => document.querySelector(s);
const grid = $("#grid"), empty = $("#empty"), summary = $("#summary"), countEl = $("#count");
let services = [], filter = "";

function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove("show"), 1600);
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok && res.status !== 501) throw new Error(path + " -> " + res.status);
  return res;
}

function fmtUptime(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60); if (m < 60) return m + "m " + (s % 60) + "s";
  const h = Math.floor(m / 60); return h + "h " + (m % 60) + "m";
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function load() {
  try {
    const { services: list } = await (await api("/services")).json();
    services = list || [];
    summary.textContent = services.length + " service" + (services.length === 1 ? "" : "s") + " · :" + location.port;
    render();
  } catch (e) {
    summary.textContent = "control plane unreachable";
  }
}

function render() {
  const shown = services.filter((s) => !filter || s.slug.includes(filter));
  countEl.textContent = filter ? shown.length + " / " + services.length : "";
  empty.hidden = services.length !== 0;
  grid.innerHTML = shown.map(cardHtml).join("");
}

function cardHtml(s) {
  const caps = ["reset", "dump", "seed", "requests"]
    .map((c) => '<span class="cap ' + (s.supports && s.supports[c] ? "on" : "") + '">' + c + "</span>").join("");
  const conn = s.connection_string || (s.host || "127.0.0.1") + ":" + s.port;
  return '<div class="card" data-slug="' + esc(s.slug) + '">' +
    '<div class="top"><span class="slug">' + esc(s.slug) + '</span>' +
      '<span class="badge ' + esc(s.protocol) + '">' + esc(s.protocol) + '</span>' +
      '<span class="badge">:' + esc(s.port) + '</span></div>' +
    '<div class="conn">' + esc(conn) + '</div>' +
    '<div class="row">uptime ' + fmtUptime(s.uptime_ms || 0) + '</div>' +
    '<div class="caps">' + caps + '</div>' +
    '<div class="actions">' +
      (s.supports && s.supports.requests ? '<button data-act="requests">Requests</button>' : '') +
      (s.supports && s.supports.dump ? '<button data-act="state">State</button>' : '') +
      (s.supports && s.supports.reset ? '<button class="danger" data-act="reset">Reset</button>' : '') +
    '</div></div>';
}

grid.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]"); if (!btn) return;
  const slug = btn.closest(".card").dataset.slug;
  const act = btn.dataset.act;
  if (act === "reset") {
    await api("/services/" + slug + "/reset", { method: "POST" });
    toast("Reset " + slug); load();
  } else if (act === "requests") {
    openRequests(slug);
  } else if (act === "state") {
    openState(slug);
  }
});

async function openRequests(slug) {
  const { requests } = await (await api("/services/" + slug + "/requests?limit=50")).json();
  const body = (requests && requests.length)
    ? requests.slice().reverse().map((r) =>
        '<div class="req"><div class="line">' +
          '<span class="m ' + esc(r.method) + '">' + esc(r.method) + '</span>' +
          '<span>' + esc(r.path) + '</span>' +
          '<span class="st ' + (r.status < 400 ? "ok" : "err") + '">' + esc(r.status) + " · " + (r.durationMs ?? 0) + 'ms</span>' +
        '</div></div>').join("")
    : '<div class="empty">No requests recorded yet.</div>';
  showDialog(slug + " — request log", body);
}

async function openState(slug) {
  const res = await api("/services/" + slug + "/state");
  if (res.status === 501) return showDialog(slug + " — state", '<div class="empty">This service does not expose state (no dump()).</div>');
  const { state } = await res.json();
  showDialog(slug + " — state", "<pre>" + esc(JSON.stringify(state, null, 2)) + "</pre>");
}

function showDialog(title, html) {
  $("#dlgTitle").textContent = title; $("#dlgBody").innerHTML = html; $("#dlg").showModal();
}
$("#dlgClose").onclick = () => $("#dlg").close();

$("#refresh").onclick = load;
$("#resetAll").onclick = async () => {
  const r = await (await api("/reset", { method: "POST" })).json();
  toast("Reset " + (r.reset ? r.reset.length : 0) + " services"); load();
};
$("#filter").oninput = (e) => { filter = e.target.value.trim().toLowerCase(); render(); };

load();
setInterval(load, 2000);
</script>
</body>
</html>`;
}
