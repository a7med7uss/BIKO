const SYNC_API = (window.BIKO_SYNC_API || "https://biko.qeshta.workers.dev").replace(/\/$/, "");
const $ = (id) => document.getElementById(id);

const home = $("home");
const roomPage = $("room-page");
const createForm = $("create-form");
const cinemaInput = $("cinema-url");
const createButton = $("create-btn");
const homeError = $("home-error");
const browseToggle = $("browse-toggle");
const browsePanel = $("browse-panel");
const driveVideo = $("drive-video");
const playerFrame = $("player-frame");

const roomMatch = location.pathname.match(/^\/room\/([a-zA-Z0-9_-]{8,40})\/?$/);
const roomId = roomMatch ? roomMatch[1] : null;

let socket = null;
let socketRetry = null;
let reconnectDelay = 1200;
let clientId = getClientId();
let role = "viewer";
let playback = null;
let playerReady = false;
let localTime = null;
let localPlaying = null;
let lastProgressSent = 0;
let toastTimer = null;
let currentMedia = null;
let playerProvider = "gdrive";
let suppressDriveEventsUntil = 0;
let driveAccessToken = null;
let googleTokenClient = null;
let pickerReadyPromise = null;
let googleConfig = null;
let googleConfigError = null;

function getClientId() {
  const key = "biko-client-id";
  try {
    let value = localStorage.getItem(key);
    if (!value) {
      value = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem(key, value);
    }
    return value;
  } catch (_) {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
}

function toast(message) {
  const node = $("room-toast");
  if (!node) return;
  node.textContent = message;
  node.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("visible"), 3000);
}

function homeMessage(message) {
  homeError.textContent = message || "";
}


if (browseToggle && browsePanel) {
  browseToggle.addEventListener("click", () => {
    const opening = browsePanel.hidden;
    browsePanel.hidden = !opening;
    browseToggle.setAttribute("aria-expanded", String(opening));
    if (opening) browsePanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  });
}

function setConnection(value) {
  const dot = $("connection-dot");
  const label = $("connection-label");
  if (!dot || !label) return;
  dot.classList.toggle("online", value === true);
  dot.classList.toggle("offline", value === false);
  label.textContent = value === true ? "متصل" : value === false ? "غير متصل" : "جارٍ الاتصال";
}

function setRole(nextRole) {
  role = nextRole === "host" ? "host" : "viewer";
  const pill = $("role-pill"), controls = $("host-controls"), hint = $("sync-hint");
  if (pill) { pill.textContent = role === "host" ? "أنت المضيف" : "مشاهد"; pill.classList.toggle("host", role === "host"); }
  if (controls) controls.hidden = role !== "host";
  if (hint) hint.textContent = role === "host" ? "أنت تتحكم في تشغيل الفيديو وإيقافه وتقديمه للمجموعة." : "المضيف يتحكم في المشاهدة. يمكنك ضبط الصوت محليًا.";
  if (driveVideo) driveVideo.controls = role === "host";
  if ($("drive-start")) $("drive-start").hidden = role === "host" || !(playback && playback.isPlaying);
}
function parseMediaInput(value) {
  const raw = String(value || "").trim();
  let url;
  try { url = new URL(raw); } catch (_) { throw new Error("الصق رابط مشاركة Google Drive صحيحًا."); }
  if (url.protocol !== "https:" || !["drive.google.com", "www.drive.google.com"].includes(url.hostname.toLowerCase())) throw new Error("استخدم رابط فيديو من Google Drive فقط.");
  let fileId = "";
  const match = url.pathname.match(/\/file\/d\/([A-Za-z0-9_-]{10,200})/);
  if (match) fileId = match[1];
  if (!fileId) fileId = url.searchParams.get("id") || "";
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(fileId)) throw new Error("لم أستطع استخراج معرّف الفيديو. انسخ رابط المشاركة من Google Drive.");
  const mediaUrl = "https://drive.google.com/uc?export=download&id=" + encodeURIComponent(fileId);
  return { provider: "gdrive", mediaId: fileId, fileName: "Google Drive video", mimeType: "video/mp4", fileSize: 0, mediaUrl, webViewLink: "https://drive.google.com/file/d/" + encodeURIComponent(fileId) + "/view", shareMode: "pre-shared" };
}

async function createRoom(payload) {
  createButton.disabled = true;
  createButton.innerHTML = '<span class="spinner"></span>';
  homeMessage("");
  try {
    const response = await fetch(SYNC_API + "/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "تعذر إنشاء الغرفة.");
    location.href = "/room/" + encodeURIComponent(data.roomId);
    return true;
  } catch (error) {
    homeMessage(error.message || "حدث خطأ أثناء إنشاء الغرفة.");
    createButton.disabled = false;
    createButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
    return false;
  }
}

if (createForm) {
  createForm.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      const media = parseMediaInput(cinemaInput.value);
      createRoom(media);
    } catch (error) {
      homeMessage(error.message);
    }
  });
}

function sendSocket(payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(payload));
  return true;
}

function connectRoom() {
  if (!roomId) return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  setConnection(null);
  const wsUrl = SYNC_API.replace(/^https:/, "wss:").replace(/^http:/, "ws:") +
    "/room/" + encodeURIComponent(roomId) + "/socket";
  try {
    socket = new WebSocket(wsUrl);
  } catch (_) {
    planReconnect();
    return;
  }
  socket.addEventListener("open", () => {
    reconnectDelay = 1200;
    setConnection(true);
    sendSocket({ type: "hello", clientId, name: "مشاهد" });
  });
  socket.addEventListener("message", (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch (_) { return; }
    handleRoomMessage(message);
  });
  socket.addEventListener("close", () => {
    socket = null;
    setConnection(false);
    planReconnect();
  });
  socket.addEventListener("error", () => setConnection(false));
}

function planReconnect() {
  clearTimeout(socketRetry);
  socketRetry = setTimeout(connectRoom, reconnectDelay);
  reconnectDelay = Math.min(10000, Math.round(reconnectDelay * 1.6));
}

function updateMembers(members) {
  if (Array.isArray(members) && $("member-count")) {
    $("member-count").textContent = String(Math.max(1, members.length));
  }
}

function handleRoomMessage(message) {
  if (message.type === "snapshot") {
    setConnection(true);
    if (message.room) currentMedia = message.room;
    setRole(message.role);
    updateMembers(message.members);
    if (message.playback) {
      playback = message.playback;
      updatePlaybackLabel();
      if (role !== "host") applyPlayback(playback, true);
    }
    return;
  }
  if (message.type === "members") {
    updateMembers(message.members);
    return;
  }
  if (message.type === "playback" && message.playback) {
    playback = message.playback;
    updatePlaybackLabel();
    if (role !== "host") applyPlayback(playback, false);
    return;
  }
  if (message.type === "error") toast(message.message || "تعذر تنفيذ الأمر.");
}

function updatePlaybackLabel() {
  const el = $("playback-status");
  if (!el || !playback) return;
  el.textContent = playback.isPlaying ? "المشاهدة مستمرة" : "متوقف مؤقتًا";
}

function projectedTime(item) {
  const base = Math.max(0, Number(item.currentTime) || 0);
  if (!item.isPlaying) return base;
  return base + Math.max(0, Date.now() - (Number(item.updatedAt) || Date.now())) / 1000;
}

function applyDrivePlayback(item, force) {
  if (!item || role === "host" || playerProvider !== "gdrive") return;
  const target = projectedTime(item);
  if (!playerReady) return;
  suppressDriveEventsUntil = Date.now() + 900;
  const drift = Math.abs((Number(driveVideo.currentTime) || 0) - target);
  if ((drift > 1.8 || force) && Number.isFinite(target)) {
    try { driveVideo.currentTime = Math.max(0, target); } catch (_) {}
  }
  if (item.isPlaying) {
    driveVideo.play().then(() => $("drive-start").hidden = true).catch(() => {
      $("drive-start").hidden = false;
    });
  } else {
    driveVideo.pause();
    $("drive-start").hidden = true;
  }
  setTimeout(() => { suppressDriveEventsUntil = 0; }, 950);
}

function applyPlayback(item, force) { applyDrivePlayback(item, force); }

function publishHostEvent(action, time, isPlaying) {
  if (role !== "host") return;
  const now = Date.now();
  if (action === "progress" && now - lastProgressSent < 2600) return;
  if (action === "progress") lastProgressSent = now;
  sendSocket({
    type: "command",
    action,
    currentTime: Number.isFinite(Number(time)) ? Math.max(0, Number(time)) : localTime,
    isPlaying: typeof isPlaying === "boolean" ? isPlaying : localPlaying,
    clientId
  });
}

function initDriveVideo() {
  driveVideo.addEventListener("loadedmetadata", () => {
    playerReady = true;
    localTime = driveVideo.currentTime || 0;
    if (role !== "host" && playback) applyDrivePlayback(playback, true);
    $("drive-start").hidden = role === "host" || !(playback && playback.isPlaying);
  });
  driveVideo.addEventListener("canplay", () => { playerReady = true; });
  driveVideo.addEventListener("play", () => {
    localPlaying = true;
    if (role === "host" && Date.now() > suppressDriveEventsUntil) {
      publishHostEvent("play", driveVideo.currentTime, true);
    }
  });
  driveVideo.addEventListener("pause", () => {
    localPlaying = false;
    if (role === "host" && Date.now() > suppressDriveEventsUntil && !driveVideo.ended) {
      publishHostEvent("pause", driveVideo.currentTime, false);
    }
  });
  driveVideo.addEventListener("seeked", () => {
    localTime = driveVideo.currentTime;
    if (role === "host" && Date.now() > suppressDriveEventsUntil) {
      publishHostEvent("seek", driveVideo.currentTime, !driveVideo.paused);
    }
  });
  driveVideo.addEventListener("timeupdate", () => {
    localTime = driveVideo.currentTime;
    if (role === "host" && Date.now() > suppressDriveEventsUntil && !driveVideo.paused) {
      publishHostEvent("progress", driveVideo.currentTime, true);
    }
    if (role !== "host" && playback && Math.abs(driveVideo.currentTime - projectedTime(playback)) > 5) {
      applyDrivePlayback(playback, false);
    }
  });
  driveVideo.addEventListener("error", () => {
    $("player-error").hidden = false;
    $("player-error").textContent = "تعذر تشغيل ملف Drive. تأكد أن الملف فيديو قابل للتنزيل وأنه مشارك مع أعضاء الغرفة. يمكن فتحه في Google Drive للتحقق من الوصول.";
  });
}
initDriveVideo();

async function loadRoom() {
  home.hidden = true;
  roomPage.hidden = false;
  document.title = "BIKO — غرفة مشاهدة";
  setConnection(null);

  try {
    const response = await fetch(SYNC_API + "/api/rooms/" + encodeURIComponent(roomId), { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "الغرفة غير موجودة أو انتهت صلاحيتها.");
    currentMedia = data.room || data;
    const media = currentMedia;

    if (media.provider !== "gdrive") throw new Error("هذه الغرفة لا تستخدم Google Drive. أنشئ غرفة جديدة برابط Drive عام.");
    playerProvider = "gdrive";
    playerFrame.hidden = true;
    driveVideo.hidden = false;
    $("local-media-controls").hidden = false;
    $("room-title").textContent = media.fileName || "فيديو من Google Drive";
    $("room-subtitle").textContent = "Google Drive · تشغيل متزامن للمجموعة";
    if (!media.mediaUrl) throw new Error("رابط تشغيل فيديو Google Drive غير موجود.");
    driveVideo.src = media.mediaUrl;
    driveVideo.controls = false;
    $("drive-start").hidden = false;

    connectRoom();
  } catch (error) {
    $("room-title").textContent = "تعذر فتح الغرفة";
    $("room-subtitle").textContent = error.message || "حدث خطأ غير متوقع.";
    $("player-error").textContent = error.message || "حدث خطأ غير متوقع.";
    $("player-error").hidden = false;
  }
}

function hostAction(action) {
  if (role !== "host") { toast("التحكم متاح للمضيف فقط."); return; }
  if (action === "seek-back" || action === "seek-forward") {
    const next = Math.max(0, (driveVideo.currentTime || 0) + (action === "seek-back" ? -10 : 10));
    driveVideo.currentTime = next; publishHostEvent("seek", next, !driveVideo.paused);
  } else if (action === "toggle") {
    if (driveVideo.paused) driveVideo.play().catch(() => $("drive-start").hidden = false);
    else driveVideo.pause();
  }
}
document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (button) hostAction(button.dataset.action);
});

$("drive-start")?.addEventListener("click", () => {
  if (role === "host") driveVideo.play().catch(() => toast("تعذر بدء الفيديو."));
  else if (playback) applyDrivePlayback(playback, true);
});

$("local-volume")?.addEventListener("input", (event) => {
  driveVideo.volume = Number(event.target.value);
  driveVideo.muted = Number(event.target.value) === 0;
});
$("local-mute")?.addEventListener("click", () => {
  driveVideo.muted = !driveVideo.muted;
  $("local-mute").textContent = driveVideo.muted ? "إلغاء الكتم" : "كتم الصوت";
});

$("copy-invite")?.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    toast("تم نسخ رابط دعوة الغرفة.");
  } catch (_) {
    toast("انسخ رابط الغرفة من شريط العنوان.");
  }
});

$("fullscreen-button")?.addEventListener("click", async () => {
  const stage = $("player-stage");
  try {
    if (!document.fullscreenElement) await stage.requestFullscreen();
    else await document.exitFullscreen();
  } catch (_) {
    toast("استخدم زر ملء الشاشة داخل المشغل.");
  }
});

setInterval(() => {
  if (socket && socket.readyState === WebSocket.OPEN) sendSocket({ type: "ping" });
  if (role !== "host" && playback && playerReady) {
    if (Number.isFinite(driveVideo.currentTime) && Math.abs(driveVideo.currentTime - projectedTime(playback)) > 2.5) applyDrivePlayback(playback, false);
  }
}, 5000);

if (roomId) loadRoom();
else if (roomPage) roomPage.hidden = true;