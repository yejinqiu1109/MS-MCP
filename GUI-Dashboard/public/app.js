const $ = (id) => document.getElementById(id);

const canvas = $("structureCanvas");
const ctx = canvas.getContext("2d");
let statusData = null;
let rotation = { x: -0.35, y: 0.6 };
let zoom = 1.8;
let atomScale = 1.25;
let bondScale = 1.35;
let dragging = false;
let lastPointer = null;

const colors = {
  H: "#fbffff",
  C: "#9eaab0",
  N: "#5f8dff",
  O: "#ff5b58",
  F: "#adfff1",
  S: "#f4df67",
  P: "#ffad69",
  Cl: "#7ff394",
  Br: "#c47b47",
  I: "#a27ded",
  Ti: "#d3dce8",
};

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2600);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

function setDot(dot, state) {
  dot.className = `status-dot ${state}`;
}

function shortPath(value) {
  if (!value) return "-";
  return String(value);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderStatus(data) {
  statusData = data;
  setDot($("mcpDot"), data.mcp?.connected ? "ok" : "bad");
  $("mcpText").textContent = data.mcp?.connected ? "已连接到本地 MS-MCP" : "未连接";

  setDot($("loopDot"), data.loop?.running ? "ok" : data.loop?.reason === "stop requested" ? "warn" : "bad");
  $("loopText").textContent = data.loop?.running ? `运行中：${data.loop.reason}` : `未运行：${data.loop?.reason || "unknown"}`;

  $("docText").textContent = data.state?.currentDocument || "未设置";
  $("sessionText").textContent = data.config?.projectFolderName || "-";
  $("workspaceText").textContent = shortPath(data.config?.workRoot);
  $("projectRootText").textContent = shortPath(data.config?.projectRoot);
  $("stateFileText").textContent = shortPath(data.config?.stateFile);
  renderSessions(data.sessions || [], data.config?.projectFolderName);
  renderXsdDocuments(data.xsdDocuments || [], data.state?.dashboardSelectedXsd || data.structure?.file);

  const queue = data.queue || {};
  for (const name of ["pending", "running", "done", "failed"]) {
    $(`${name}Count`).textContent = queue[name]?.length || 0;
  }
  const queueItems = Object.entries(queue)
    .flatMap(([name, files]) => (files || []).slice(-4).map((file) => ({ name, file })))
    .slice(-12);
  $("queueList").innerHTML = queueItems.length
    ? queueItems.map((item) => `<li><span class="pill">${item.name}</span> ${item.file}</li>`).join("")
    : `<li>队列为空</li>`;

  renderCalculations(data.calculations || []);
  renderStructure();
}

function renderCalculations(items) {
  $("calcList").innerHTML = items.length
    ? items
        .map(
          (item) => `
        <div class="calc-item">
          <span class="pill">${item.module}</span>
          <div>
            <strong>${item.name}</strong>
            <p class="viewer-hint">${item.files.length} 个文件</p>
          </div>
          <span>${item.status}</span>
        </div>`,
        )
        .join("")
    : `<p class="viewer-hint">当前会话还没有计算文件夹</p>`;
}

function renderSessions(sessions, activeName) {
  const select = $("sessionSelect");
  const previous = select.value;
  select.innerHTML = sessions.length
    ? sessions.map((item) => `<option value="${item.name}">${item.name}${item.active ? " 当前" : ""}</option>`).join("")
    : `<option value="">没有任务会话</option>`;
  select.value = sessions.some((item) => item.name === previous) ? previous : activeName || sessions[0]?.name || "";
}

function renderXsdDocuments(documents, selectedPath) {
  const select = $("xsdSelect");
  if (!select) return;
  const previous = select.value;
  select.innerHTML = documents.length
    ? documents
        .map((item) => `<option value="${escapeHtml(item.relativePath)}">${escapeHtml(item.relativePath)}</option>`)
        .join("")
    : `<option value="">No XSD files in this session</option>`;

  const selected = documents.find((item) => selectedPath && item.path?.toLowerCase() === String(selectedPath).toLowerCase());
  if (documents.some((item) => item.relativePath === previous)) {
    select.value = previous;
  } else {
    select.value = selected?.relativePath || documents[0]?.relativePath || "";
  }
  $("switchXsdBtn").disabled = !documents.length;
}

function fitAtoms(atoms) {
  if (!atoms?.length) return [];
  const cx = atoms.reduce((sum, atom) => sum + atom.x, 0) / atoms.length;
  const cy = atoms.reduce((sum, atom) => sum + atom.y, 0) / atoms.length;
  const cz = atoms.reduce((sum, atom) => sum + atom.z, 0) / atoms.length;
  let maxR = 1;
  for (const atom of atoms) {
    maxR = Math.max(maxR, Math.hypot(atom.x - cx, atom.y - cy, atom.z - cz));
  }
  return atoms.map((atom) => ({ ...atom, x: (atom.x - cx) / maxR, y: (atom.y - cy) / maxR, z: (atom.z - cz) / maxR }));
}

function project(atom) {
  const sx = Math.sin(rotation.x);
  const cx = Math.cos(rotation.x);
  const sy = Math.sin(rotation.y);
  const cy = Math.cos(rotation.y);
  const x1 = atom.x * cy + atom.z * sy;
  const z1 = -atom.x * sy + atom.z * cy;
  const y1 = atom.y * cx - z1 * sx;
  const z2 = atom.y * sx + z1 * cx;
  const scale = Math.min(canvas.width, canvas.height) * 0.38 * zoom;
  const depth = 2.8 + z2;
  return {
    ...atom,
    sx: canvas.width / 2 + (x1 * scale) / depth,
    sy: canvas.height / 2 - (y1 * scale) / depth,
    depth,
    radius: Math.max(5, Math.min(56, (14 / depth) * atomScale)),
  };
}

function drawBackdrop() {
  const w = canvas.width;
  const h = canvas.height;
  ctx.save();
  ctx.clearRect(0, 0, w, h);

  const bg = ctx.createLinearGradient(0, 0, w, h);
  bg.addColorStop(0, "#a8c8d7");
  bg.addColorStop(0.46, "#8fb5c8");
  bg.addColorStop(1, "#789caf");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  const centerLift = ctx.createRadialGradient(w * 0.52, h * 0.46, 0, w * 0.52, h * 0.46, Math.max(w, h) * 0.58);
  centerLift.addColorStop(0, "rgba(255,255,255,0.22)");
  centerLift.addColorStop(0.40, "rgba(198,235,240,0.14)");
  centerLift.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = centerLift;
  ctx.fillRect(0, 0, w, h);

  const vignette = ctx.createRadialGradient(w * 0.5, h * 0.5, Math.min(w, h) * 0.24, w * 0.5, h * 0.5, Math.max(w, h) * 0.74);
  vignette.addColorStop(0, "rgba(0,0,0,0)");
  vignette.addColorStop(0.72, "rgba(25,68,88,0.06)");
  vignette.addColorStop(1, "rgba(15,43,62,0.30)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, w, h);

  ctx.restore();
}

function depthAlpha(depth) {
  return Math.max(0.5, Math.min(1, 1.18 - (depth - 2.1) * 0.18));
}

function drawSphere(x, y, r, color, depth = 2.8) {
  const alpha = depthAlpha(depth);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.shadowColor = "rgba(168,223,255,0.18)";
  ctx.shadowBlur = Math.max(5, r * 0.42);
  ctx.fillStyle = "rgba(0,3,10,0.30)";
  ctx.beginPath();
  ctx.ellipse(x + r * 0.22, y + r * 0.62, r * 0.86, r * 0.26, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;

  const g = ctx.createRadialGradient(x - r * 0.34, y - r * 0.42, r * 0.08, x, y, r);
  g.addColorStop(0, "rgba(255,255,255,0.98)");
  g.addColorStop(0.22, color);
  g.addColorStop(0.66, color);
  g.addColorStop(1, "#111820");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();

  const shine = ctx.createRadialGradient(x - r * 0.42, y - r * 0.48, 0, x - r * 0.42, y - r * 0.48, r * 0.42);
  shine.addColorStop(0, "rgba(255,255,255,0.78)");
  shine.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = shine;
  ctx.beginPath();
  ctx.arc(x - r * 0.30, y - r * 0.34, r * 0.38, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = "rgba(240,255,255,0.44)";
  ctx.lineWidth = Math.max(0.8, r * 0.06);
  ctx.beginPath();
  ctx.arc(x, y, r * 0.98, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawCylinderLine(p1, p2, width, offsetX, offsetY) {
  const x1 = p1.sx + offsetX;
  const y1 = p1.sy + offsetY;
  const x2 = p2.sx + offsetX;
  const y2 = p2.sy + offsetY;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.max(1, Math.hypot(dx, dy));
  const nx = -dy / len;
  const ny = dx / len;

  ctx.save();
  ctx.globalAlpha = depthAlpha((p1.depth + p2.depth) / 2);
  ctx.lineCap = "round";

  ctx.shadowColor = "rgba(146,218,255,0.20)";
  ctx.shadowBlur = Math.max(4, width * 0.85);
  ctx.strokeStyle = "rgba(0,4,12,0.30)";
  ctx.lineWidth = width * 1.22;
  ctx.beginPath();
  ctx.moveTo(x1 + nx * width * 0.26, y1 + ny * width * 0.26);
  ctx.lineTo(x2 + nx * width * 0.26, y2 + ny * width * 0.26);
  ctx.stroke();

  const body = ctx.createLinearGradient(x1 + nx * width, y1 + ny * width, x1 - nx * width, y1 - ny * width);
  body.addColorStop(0, "rgba(244,254,255,0.92)");
  body.addColorStop(0.48, "rgba(178,224,234,0.82)");
  body.addColorStop(1, "rgba(86,122,138,0.76)");
  ctx.strokeStyle = body;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  ctx.shadowBlur = 0;
  ctx.strokeStyle = "rgba(255,255,255,0.50)";
  ctx.lineWidth = Math.max(1, width * 0.20);
  ctx.beginPath();
  ctx.moveTo(x1 - nx * width * 0.26, y1 - ny * width * 0.26);
  ctx.lineTo(x2 - nx * width * 0.26, y2 - ny * width * 0.26);
  ctx.stroke();
  ctx.restore();
}

function renderStructure() {
  drawBackdrop();
  const structure = statusData?.structure;
  if (!structure?.atoms?.length) {
    $("viewerHint").textContent = "当前会话没有可读取的 xsd 结构";
    ctx.fillStyle = "rgba(221,244,246,0.56)";
    ctx.font = "24px Segoe UI";
    ctx.textAlign = "center";
    ctx.fillText("No structure file", canvas.width / 2, canvas.height / 2);
    return;
  }

  $("viewerHint").textContent = `${structure.atoms.length} atoms / ${structure.bonds?.length || 0} bonds | ${shortPath(structure.file)}`;
  const atoms = fitAtoms(structure.atoms).map(project);
  const bonds = structure.bonds || [];

  ctx.lineCap = "round";
  for (const bond of bonds) {
    const [a, b, rawOrder = 1] = Array.isArray(bond) ? bond : [bond.a, bond.b, bond.order || 1];
    const order = Math.max(1, Math.min(3, Number(rawOrder) || 1));
    const p1 = atoms[a];
    const p2 = atoms[b];
    if (!p1 || !p2) continue;
    const dx = p2.sx - p1.sx;
    const dy = p2.sy - p1.sy;
    const len = Math.max(1, Math.hypot(dx, dy));
    const nx = -dy / len;
    const ny = dx / len;
    const gap = 4.8 * bondScale;
    const offsets = order === 1 ? [0] : order === 2 ? [-gap, gap] : [-gap * 1.35, 0, gap * 1.35];
    const width = Math.max(2, Math.min(24, (5.8 / ((p1.depth + p2.depth) / 2)) * bondScale));
    for (const offset of offsets) {
      drawCylinderLine(p1, p2, width, nx * offset, ny * offset);
    }
  }

  atoms
    .slice()
    .sort((a, b) => b.depth - a.depth)
    .forEach((atom) => drawSphere(atom.sx, atom.sy, atom.radius, colors[atom.element] || "#c3ced3", atom.depth));
}

async function refresh() {
  try {
    renderStatus(await api("/api/status"));
  } catch (error) {
    toast(error.message);
  }
}

async function postAndRefresh(path, body, message) {
  try {
    const result = await api(path, { method: "POST", body });
    toast(message || result.queued || "已提交");
    await refresh();
  } catch (error) {
    toast(error.message);
  }
}

function setZoom(next) {
  zoom = Math.max(0.8, Math.min(4, next));
  renderStructure();
}

$("refreshBtn").addEventListener("click", refresh);
$("stopLoopBtn").addEventListener("click", () => postAndRefresh("/api/loop/stop", {}, "已请求停止 GUI loop"));
$("newSessionBtn").addEventListener("click", () => postAndRefresh("/api/session/new", {}, "已创建新任务会话"));
$("switchSessionBtn").addEventListener("click", () => {
  const folderName = $("sessionSelect").value;
  if (!folderName) return toast("没有可切换的任务会话");
  postAndRefresh("/api/session/select", { folderName }, `已切换到 ${folderName}`);
});
$("switchXsdBtn").addEventListener("click", () => {
  const relativePath = $("xsdSelect").value;
  if (!relativePath) return toast("No XSD file selected");
  postAndRefresh("/api/document/select", { relativePath }, `Previewing ${relativePath}`);
});
$("snapshotBtn").addEventListener("click", () => postAndRefresh("/api/structure/snapshot", {}, "已读取当前 GUI 结构"));
$("resetViewBtn").addEventListener("click", () => {
  rotation = { x: -0.35, y: 0.6 };
  zoom = 1.8;
  atomScale = 1.25;
  bondScale = 1.35;
  $("atomSlider").value = String(atomScale);
  $("bondSlider").value = String(bondScale);
  renderStructure();
});

$("atomSlider").addEventListener("input", (event) => {
  atomScale = Number(event.target.value);
  renderStructure();
});
$("bondSlider").addEventListener("input", (event) => {
  bondScale = Number(event.target.value);
  renderStructure();
});

canvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  setZoom(zoom + (event.deltaY < 0 ? 0.18 : -0.18));
}, { passive: false });

for (const button of document.querySelectorAll("[data-model-action]")) {
  button.addEventListener("click", () => postAndRefresh("/api/action/model", { action: button.dataset.modelAction }, "建模操作已入队"));
}

for (const button of document.querySelectorAll("[data-calc-module]")) {
  button.addEventListener("click", () => postAndRefresh("/api/action/calc", { module: button.dataset.calcModule }, "计算任务已入队"));
}

canvas.addEventListener("pointerdown", (event) => {
  dragging = true;
  lastPointer = { x: event.clientX, y: event.clientY };
  canvas.setPointerCapture(event.pointerId);
});

canvas.addEventListener("pointermove", (event) => {
  if (!dragging || !lastPointer) return;
  const dx = event.clientX - lastPointer.x;
  const dy = event.clientY - lastPointer.y;
  rotation.y += dx * 0.008;
  rotation.x += dy * 0.008;
  lastPointer = { x: event.clientX, y: event.clientY };
  renderStructure();
});

canvas.addEventListener("pointerup", () => {
  dragging = false;
  lastPointer = null;
});

function animate() {
  if ($("spinToggle").checked && !dragging && statusData?.structure?.atoms?.length) {
    rotation.y += 0.004;
    renderStructure();
  }
  requestAnimationFrame(animate);
}

let remoteBatches = [];
let remoteRefreshing = false;

function remoteStateLabel(state) {
  const labels = {
    completed: "已完成",
    processed: "已处理",
    running: "运行中",
    queued: "等待中",
    failed: "失败",
  };
  return labels[state] || state || "未知";
}

function renderRemoteTasks(tasks = []) {
  const grid = $("remoteTaskGrid");
  grid.innerHTML = tasks.length
    ? tasks
        .map(
          (task) => `<div class="remote-task ${escapeHtml(task.state)}" title="${escapeHtml(task.calculationName)}">
            <strong>${task.index}. ${escapeHtml(task.calculationName)}</strong>
            <span>${remoteStateLabel(task.state)}${task.result?.Message ? ` · ${escapeHtml(task.result.Message)}` : ""}</span>
          </div>`,
        )
        .join("")
    : `<p class="viewer-hint">该批次没有任务清单。</p>`;
}

function renderRemoteProgress(data) {
  const total = Number(data.totalCount || 0);
  const completed = Number(data.completedCount || 0);
  const progress = total ? Math.min(100, Math.max(0, (completed / total) * 100)) : 0;
  $("remoteJobId").textContent = data.batch?.jobId || "-";
  $("remoteProgressText").textContent = `${completed} / ${total}`;
  $("remoteCurrentTask").textContent = data.currentCalculation
    ? `${data.currentIndex || "?"}/${total} · ${data.currentCalculation}`
    : completed >= total && total
      ? "全部任务已处理"
      : "未检测到运行中的 CASTEP 进程";
  $("remoteProgressBar").style.width = `${progress}%`;
  $("remoteSshState").textContent = data.connected ? "已连接" : "连接失败";
  $("remoteSshState").className = data.connected ? "remote-ok" : "remote-bad";
  $("remoteMessage").classList.toggle("error", !data.connected);

  if (data.connected) {
    const checkedAt = data.remote?.checked_at || "刚刚";
    const csvNote = data.remote?.csv ? `结果表：${data.remote.csv}` : "结果CSV尚未生成或尚未找到";
    $("remoteMessage").textContent = `${checkedAt} · ${csvNote}`;
    renderRemoteTasks(data.taskStates || []);
    $("remoteCastepTail").textContent = data.castepTail?.length
      ? data.castepTail.join("\n")
      : "当前没有可读取的 CASTEP 输出。";
  } else {
    const setup = data.needsKeyAuthentication
      ? "请先在本机为配置的 user@host 设置 SSH 密钥登录；Dashboard 不会保存服务器密码。"
      : "请检查 SSH 网络、远程用户名和服务器路径。";
    $("remoteMessage").textContent = `${setup} 详细信息：${data.error || "未知错误"}`;
    renderRemoteTasks(data.taskStates || []);
    $("remoteCastepTail").textContent = data.error || "SSH连接失败";
  }
}

async function loadRemoteBatches() {
  try {
    const data = await api("/api/remote-batches");
    remoteBatches = data.batches || [];
    const select = $("remoteBatchSelect");
    const previous = select.value;
    select.innerHTML = remoteBatches.length
      ? remoteBatches
          .map((batch) => `<option value="${escapeHtml(batch.batchName)}">${escapeHtml(batch.jobId || "未提交")} · ${escapeHtml(batch.batchName)} · ${batch.taskCount}项</option>`)
          .join("")
      : `<option value="">没有已提交的远程批次</option>`;
    const preferred = remoteBatches.find((batch) => batch.jobId === "NSMA4")?.batchName;
    select.value = remoteBatches.some((batch) => batch.batchName === previous)
      ? previous
      : preferred || remoteBatches[0]?.batchName || "";
  } catch (error) {
    $("remoteMessage").textContent = `读取远程批次失败：${error.message}`;
    $("remoteMessage").classList.add("error");
  }
}

async function refreshRemoteMonitor() {
  if (remoteRefreshing) return;
  const batch = $("remoteBatchSelect").value;
  if (!batch) return;
  remoteRefreshing = true;
  $("remoteRefreshBtn").disabled = true;
  $("remoteRefreshBtn").textContent = "查询中…";
  try {
    renderRemoteProgress(await api(`/api/remote-monitor?batch=${encodeURIComponent(batch)}`));
  } catch (error) {
    $("remoteMessage").textContent = `远程查询失败：${error.message}`;
    $("remoteMessage").classList.add("error");
  } finally {
    remoteRefreshing = false;
    $("remoteRefreshBtn").disabled = false;
    $("remoteRefreshBtn").textContent = "立即查询";
  }
}

$("remoteRefreshBtn").addEventListener("click", refreshRemoteMonitor);
$("remoteBatchSelect").addEventListener("change", refreshRemoteMonitor);

refresh();
setInterval(refresh, 5000);
loadRemoteBatches().then(refreshRemoteMonitor);
setInterval(() => {
  if ($("remoteAutoRefresh").checked) refreshRemoteMonitor();
}, 30000);
animate();

