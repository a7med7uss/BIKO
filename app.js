const SYNC_API = (window.BIKO_SYNC_API || "https://biko.qeshta.workers.dev").replace(/\/$/, "");
const $ = (id) => document.getElementById(id);
const SESSION_KEY = "biko-drive-session-v2";
const PENDING_KEY = "biko-drive-pending-file";
const home = $("home");
const roomPage = $("room-page");
const createForm = $("create-form");
const driveInput = $("drive-url");
const createButton = $("create-btn");
const driveAction = $("drive-action");
const homeError = $("home-error");
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
let currentMedia = null;
let playerReady = false;
let localTime = 0;
let localPlaying = false;
let lastProgressSent = 0;
let suppressDriveEventsUntil = 0;
let toastTimer = null;
let pickerPromise = null;
let pickerBusy = false;
let hostTicket = null;

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

function getSession() {
  try { return localStorage.getItem(SESSION_KEY) || ""; }
  catch (_) { return ""; }
}

function setSession(token) {
  try {
    if (token) localStorage.setItem(SESSION_KEY, token);
    else localStorage.removeItem(SESSION_KEY);
  } catch (_) {}
}

function homeMessage(message) { if (homeError) homeError.textContent = message || ""; }

function toast(message) {
  const node = $("room-toast");
  if (!node) return;
  node.textContent = message;
  node.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("visible"), 3000);
}

function authHeaders() {
  const token = getSession();
  return token ? { Authorization: "Bearer " + token } : {};
}

async function api(path, options = {}) {
  const response = await fetch(SYNC_API + path, {
    ...options,
    headers: { ...(options.headers || {}), ...authHeaders() },
    cache: "no-store"
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) {
      setSession("");
      updateDriveButton(false);
    }
    throw new Error(data.error || "حدث خطأ في الاتصال بالخدمة.");
  }
  return data;
}

function parseDriveId(input) {
  let url;
  try { url = new URL(String(input || "").trim()); }
  catch (_) { throw new Error("الصق رابط مشاركة Google Drive صحيحًا."); }
  if (url.protocol !== "https:" || !["drive.google.com", "www.drive.google.com"].includes(url.hostname.toLowerCase())) {
    throw new Error("BIKO يقبل روابط Google Drive فقط.");
  }
  let id = "";
  const match = url.pathname.match(/\/file\/d\/([A-Za-z0-9_-]{10,200})/);
  if (match) id = match[1];
  if (!id) id = url.searchParams.get("id") || "";
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(id)) throw new Error("لم أستطع استخراج معرّف الملف من الرابط.");
  return { fileId: id, resourceKey: url.searchParams.get("resourcekey") || "" };
}

function updateDriveButton(connected, email) {
  if (!driveAction) return;
  driveAction.textContent = connected ? "اختيار فيديو من Google Drive" : "ربط Google Drive";
  driveAction.classList.toggle("connected", !!connected);
  driveAction.disabled = false;
  const status = $("drive-account-status");
  if (status) status.textContent = connected ? (email || "الحساب متصل") : "";
}

async function checkDriveSession() {
  const token = getSession();
  if (!token) { updateDriveButton(false); return false; }
  try {
    const data = await api("/api/drive/session");
    updateDriveButton(true, data.email);
    return true;
  } catch (_) {
    setSession("");
    updateDriveButton(false);
    return false;
  }
}

async function startGoogleConnect() {
  const pending = driveInput?.value.trim();
  if (pending) {
    try { localStorage.setItem(PENDING_KEY, JSON.stringify(parseDriveId(pending))); } catch (_) {}
  }
  homeMessage("");
  driveAction.disabled = true;
  try {
    const response = await fetch(SYNC_API + "/api/drive/auth/status", { cache: "no-store" });
    const status = await response.json().catch(() => ({}));
    if (!response.ok || !status.enabled) {
      homeMessage("ربط Google Drive لم يُفعّل بعد. يحتاج مالك BIKO لإضافة بيانات تطبيق Google مرة واحدة.");
      driveAction.disabled = false;
      return;
    }
    location.href = SYNC_API + "/api/drive/auth/start";
  } catch (_) {
    homeMessage("تعذر الاتصال بخدمة BIKO. حاول مرة أخرى.");
    driveAction.disabled = false;
  }
}

async function loadGooglePicker() {
  if (pickerPromise) return pickerPromise;
  pickerPromise = Promise.all([
    loadScript("https://apis.google.com/js/api.js", "biko-gapi"),
    fetch(SYNC_API + "/api/drive/picker-config", { cache: "no-store" }).then(async response => {
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.enabled) throw new Error(data.error || "إعداد Google Drive غير مكتمل من إدارة BIKO.");
      return data;
    })
  ]).then(async ([, config]) => {
    await new Promise((resolve, reject) => {
      if (window.google?.picker) return resolve();
      window.gapi.load("picker", { callback: resolve, onerror: () => reject(new Error("تعذر تحميل نافذة اختيار Google Drive.")) });
    });
    return config;
  }).catch(error => {
    pickerPromise = null;
    throw error;
  });
  return pickerPromise;
}

function loadScript(src, id) {
  return new Promise((resolve, reject) => {
    const present = document.getElementById(id);
    if (present?.dataset.loaded === "true") return resolve();
    if (present) {
      present.addEventListener("load", resolve, { once: true });
      present.addEventListener("error", () => reject(new Error("تعذر تحميل مكتبات Google.")), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.id = id;
    script.src = src;
    script.async = true;
    script.defer = true;
    script.onload = () => { script.dataset.loaded = "true"; resolve(); };
    script.onerror = () => reject(new Error("تعذر تحميل مكتبات Google."));
    document.head.appendChild(script);
  });
}

async function openDrivePicker() {
  if (pickerBusy) return;
  if (!getSession()) return startGoogleConnect();
  pickerBusy = true;
  driveAction.disabled = true;
  homeMessage("");
  try {
    const [config, tokenData] = await Promise.all([
      loadGooglePicker(),
      api("/api/drive/picker-token", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
    ]);
    // Do not apply a MIME filter here. Google Picker's setMimeTypes expects
    // explicit MIME values, and video/* can hide valid Drive files.
    // Show all files so the host can find their video; the server validates
    // the selected file's actual MIME type before creating the room.
    // Default DocsView shows the user's regular My Drive.
    // setEnableDrives(true) switches this view to Shared Drives only,
    // which hides a user's personal My Drive files.
    const view = new google.picker.DocsView(google.picker.ViewId.DOCS)
      .setIncludeFolders(true);
    const picker = new google.picker.PickerBuilder()
      .addView(view)
      .setOAuthToken(tokenData.accessToken)
      .setDeveloperKey(config.apiKey)
      .setAppId(config.appId)
      .setOrigin(window.location.origin)
      .setTitle("اختر فيديو لمشاهدته مع المجموعة")
      .setCallback(async (data) => {
        if (data[google.picker.Response.ACTION] === google.picker.Action.PICKED) {
          const doc = (data[google.picker.Response.DOCUMENTS] || [])[0];
          if (doc) {
            const fileId = doc.id || doc[google.picker.Document.ID];
            const fileName = doc.name || doc[google.picker.Document.NAME];
            const mimeType = doc.mimeType || doc[google.picker.Document.MIME_TYPE] || "video/mp4";
            const resourceKey = doc.resourceKey || doc[google.picker.Document.RESOURCE_KEY] || "";
            await createDriveRoom({ fileId, fileName, mimeType, resourceKey });
          }
        }
        pickerBusy = false;
        driveAction.disabled = false;
      })
      .build();
    picker.setVisible(true);
  } catch (error) {
    pickerBusy = false;
    driveAction.disabled = false;
    homeMessage(error.message || "تعذر فتح Google Drive.");
  }
}

async function createDriveRoom(file) {
  createButton.disabled = true;
  driveAction.disabled = true;
  homeMessage("");
  try {
    const data = await api("/api/drive/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(file)
    });
    location.href = "/room/" + encodeURIComponent(data.roomId);
  } catch (error) {
    homeMessage(error.message || "تعذر إنشاء غرفة المشاهدة.");
    createButton.disabled = false;
    driveAction.disabled = false;
  }
}

async function createFromUrl(value) {
  const file = parseDriveId(value);
  if (!getSession()) {
    localStorage.setItem(PENDING_KEY, JSON.stringify(file));
    startGoogleConnect();
    return;
  }
  await createDriveRoom(file);
}

async function consumeGoogleAuthCode() {
  const match = location.hash.match(/(?:^#|&)biko_auth=([a-f0-9]{64})/i);
  if (!match) return;
  const code = match[1];
  history.replaceState(null, "", location.pathname + location.search);
  try {
    const result = await fetch(SYNC_API + "/api/drive/auth/consume", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code })
    });
    const data = await result.json().catch(() => ({}));
    if (!result.ok) throw new Error(data.error || "تعذر إكمال ربط Google.");
    setSession(data.sessionToken);
    updateDriveButton(true, data.email);
    let pending = null;
    try {
      pending = JSON.parse(localStorage.getItem(PENDING_KEY) || "null");
      localStorage.removeItem(PENDING_KEY);
    } catch (_) {}
    if (pending?.fileId) {
      await createDriveRoom(pending);
    }
  } catch (error) {
    homeMessage(error.message || "تعذر إكمال تسجيل الدخول إلى Google.");
  }
}

if (createForm) {
  createForm.addEventListener("submit", (event) => {
    event.preventDefault();
    createFromUrl(driveInput.value.trim()).catch(error => homeMessage(error.message));
  });
}
driveAction?.addEventListener("click", () => {
  if (getSession()) openDrivePicker();
  else startGoogleConnect();
});

async function obtainHostTicket(id) {
  if (!getSession()) return null;
  try {
    const data = await api("/api/rooms/" + encodeURIComponent(id) + "/host-ticket", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}"
    });
    return data.ticket || null;
  } catch (_) { return null; }
}

function setConnection(value) {
  const dot = $("connection-dot"), label = $("connection-label");
  if (!dot || !label) return;
  dot.classList.toggle("online", value === true);
  dot.classList.toggle("offline", value === false);
  label.textContent = value === true ? "متصل" : value === false ? "غير متصل" : "جارٍ الاتصال";
}

function setRole(nextRole) {
  role = nextRole === "host" ? "host" : "viewer";
  const pill = $("role-pill");
  if (pill) {
    pill.textContent = role === "host" ? "أنت المضيف" : "مشاهد";
    pill.classList.toggle("host", role === "host");
  }

  // The custom player uses the same video element; native Drive controls stay hidden.
  driveVideo.controls = false;
  document.querySelectorAll("#video-controls [data-action]").forEach(button => {
    button.disabled = role !== "host";
    button.classList.toggle("control-locked", role !== "host");
    button.title = role === "host" ? button.dataset.action : "المضيف يتحكم في التشغيل";
  });
  const seek = $("video-seek");
  if (seek) seek.disabled = role !== "host";
  const lock = $("video-role-lock");
  if (lock) lock.hidden = role === "host";
  const start = $("drive-start");
  if (start && role === "host") start.hidden = true;
  updatePlayerButtons();
}

function sendSocket(payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(payload));
  return true;
}

function connectRoom(ticket) {
  if (!roomId) return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  setConnection(null);
  const wsUrl = SYNC_API.replace(/^https:/, "wss:").replace(/^http:/, "ws:") +
    "/room/" + encodeURIComponent(roomId) + "/socket";
  try { socket = new WebSocket(wsUrl); }
  catch (_) { planReconnect(); return; }

  socket.addEventListener("open", () => {
    reconnectDelay = 1200;
    setConnection(true);
    sendSocket({ type: "hello", clientId, name: "مشاهد", hostTicket: ticket || "" });
  });
  socket.addEventListener("message", event => {
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
  socketRetry = setTimeout(async () => {
    hostTicket = await obtainHostTicket(roomId);
    connectRoom(hostTicket);
  }, reconnectDelay);
  reconnectDelay = Math.min(12000, Math.round(reconnectDelay * 1.6));
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
  if (message.type === "members") { updateMembers(message.members); return; }
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
  return item.isPlaying ? base + Math.max(0, Date.now() - (Number(item.updatedAt) || Date.now())) / 1000 : base;
}

function applyPlayback(item, force) {
  if (!item || role === "host" || !playerReady) return;
  const target = projectedTime(item);
  const drift = Math.abs((Number(driveVideo.currentTime) || 0) - target);
  suppressDriveEventsUntil = Date.now() + 1100;
  if ((drift > 1.5 || force) && Number.isFinite(target)) {
    try { driveVideo.currentTime = Math.max(0, target); } catch (_) {}
  }
  if (item.isPlaying) {
    driveVideo.play().then(() => {
      $("drive-start").hidden = true;
      updatePlayerButtons();
    }).catch(() => {
      $("drive-start").hidden = false;
    });
  } else {
    driveVideo.pause();
    $("drive-start").hidden = true;
    updatePlayerButtons();
  }
  updatePlayerTimeline();
  setTimeout(() => { suppressDriveEventsUntil = 0; }, 1150);
}

function publishHostEvent(action, time, isPlaying) {
  if (role !== "host") return;
  const now = Date.now();
  if (action === "progress" && now - lastProgressSent < 2200) return;
  if (action === "progress") lastProgressSent = now;
  sendSocket({
    type: "command", action,
    currentTime: Number.isFinite(Number(time)) ? Math.max(0, Number(time)) : localTime,
    isPlaying: typeof isPlaying === "boolean" ? isPlaying : localPlaying,
    clientId
  });
}

function initDriveVideo() {
  driveVideo.controls = false;
  driveVideo.addEventListener("loadedmetadata", () => {
    playerReady = true;
    localTime = driveVideo.currentTime || 0;
    updatePlayerTimeline();
    updatePlayerButtons();
    if (role !== "host" && playback) applyPlayback(playback, true);
    $("drive-start").hidden = role === "host" || !(playback && playback.isPlaying);
  });
  driveVideo.addEventListener("durationchange", updatePlayerTimeline);
  driveVideo.addEventListener("play", () => {
    localPlaying = true;
    $("drive-start").hidden = true;
    updatePlayerButtons();
    if (role === "host" && Date.now() > suppressDriveEventsUntil) {
      publishHostEvent("play", driveVideo.currentTime, true);
    }
  });
  driveVideo.addEventListener("pause", () => {
    localPlaying = false;
    updatePlayerButtons();
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
    updatePlayerTimeline();
    if (role === "host" && Date.now() > suppressDriveEventsUntil && !driveVideo.paused) {
      publishHostEvent("progress", driveVideo.currentTime, true);
    }
    if (role !== "host" && playback && Math.abs(driveVideo.currentTime - projectedTime(playback)) > 4.5) {
      applyPlayback(playback, false);
    }
  });
  driveVideo.addEventListener("error", () => {
    const errorCode = driveVideo.error?.code || 0;
    const text = errorCode === 3
      ? "المتصفح لا يدعم ترميز الفيديو. جرّب MP4 بترميز H.264 للفيديو وAAC للصوت."
      : errorCode === 2
        ? "Google Drive رفض تنزيل هذا الملف أو أن صاحب الملف ألغى صلاحية الوصول."
        : "تعذر بث الفيديو من Google Drive. تحقق من صلاحية حساب المضيف للملف ثم أعد إنشاء الغرفة.";
    const box = $("player-error");
    box.hidden = false;
    box.textContent = text + " (كود المشغل: " + errorCode + ")";
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
    if (currentMedia.provider !== "gdrive") throw new Error("هذه الغرفة لا تستخدم Google Drive. أنشئ غرفة جديدة.");
    $("room-title").textContent = currentMedia.fileName || "فيديو من Google Drive";
    $("room-subtitle").textContent = "Google Drive · بث مباشر ومتزامن";
    driveVideo.src = SYNC_API + "/media/" + encodeURIComponent(roomId);
    hostTicket = await obtainHostTicket(roomId);
    connectRoom(hostTicket);
  } catch (error) {
    $("room-title").textContent = "تعذر فتح الغرفة";
    $("room-subtitle").textContent = error.message || "حدث خطأ غير متوقع.";
    $("player-error").textContent = error.message || "حدث خطأ غير متوقع.";
    $("player-error").hidden = false;
  }
}

function hostAction(action) {
  if (role !== "host") {
    if (action === "toggle" && playback?.isPlaying) applyPlayback(playback, true);
    else toast("المضيف يتحكم في التشغيل والتقديم.");
    return;
  }
  if (action === "seek-back" || action === "seek-forward") {
    const next = Math.max(0, (driveVideo.currentTime || 0) + (action === "seek-back" ? -10 : 10));
    driveVideo.currentTime = next;
    publishHostEvent("seek", next, !driveVideo.paused);
  } else if (action === "toggle") {
    if (driveVideo.paused) {
      driveVideo.play().then(() => { $("drive-start").hidden = true; }).catch(() => toast("تعذر بدء الفيديو."));
    } else driveVideo.pause();
  }
}

function formatVideoTime(value) {
  if (!Number.isFinite(value) || value < 0) return "0:00";
  const seconds = Math.floor(value);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? hours + ":" + String(minutes).padStart(2,"0") + ":" + String(remainder).padStart(2,"0")
    : minutes + ":" + String(remainder).padStart(2,"0");
}

function updatePlayerButtons() {
  const button = $("player-play-button");
  if (!button) return;
  const isPlaying = !driveVideo.paused && !driveVideo.ended;
  button.classList.toggle("is-playing", isPlaying);
  button.setAttribute("aria-label", isPlaying ? "إيقاف مؤقت" : "تشغيل");
  button.title = isPlaying ? "إيقاف مؤقت" : "تشغيل";
}

function updatePlayerTimeline() {
  const duration = Number.isFinite(driveVideo.duration) ? driveVideo.duration : 0;
  const current = Number.isFinite(driveVideo.currentTime) ? driveVideo.currentTime : 0;
  const currentLabel = $("video-current-time");
  const durationLabel = $("video-duration");
  const seek = $("video-seek");
  if (currentLabel) currentLabel.textContent = formatVideoTime(current);
  if (durationLabel) durationLabel.textContent = formatVideoTime(duration);
  if (seek && document.activeElement !== seek) {
    seek.max = String(Math.max(1, Math.floor(duration * 10)));
    seek.value = String(Math.min(Number(seek.max), Math.floor(current * 10)));
    seek.style.setProperty("--seek-progress", duration > 0 ? (current / duration * 100) + "%" : "0%");
  }
}

document.addEventListener("click", event => {
  const button = event.target.closest("[data-action]");
  if (button) hostAction(button.dataset.action);
});

$("drive-start")?.addEventListener("click", () => {
  if (role === "host") {
    driveVideo.play().then(() => { $("drive-start").hidden = true; }).catch(() => toast("تعذر بدء الفيديو."));
  } else if (playback?.isPlaying) {
    applyPlayback(playback, true);
  } else {
    toast("انتظر تشغيل المضيف.");
  }
});

$("video-seek")?.addEventListener("input", event => {
  const seek = event.currentTarget;
  const duration = Number.isFinite(driveVideo.duration) ? driveVideo.duration : 0;
  const next = Number(seek.value) / 10;
  $("video-current-time").textContent = formatVideoTime(next);
  seek.style.setProperty("--seek-progress", duration > 0 ? (next / duration * 100) + "%" : "0%");
});
$("video-seek")?.addEventListener("change", event => {
  if (role !== "host") return;
  const next = Math.max(0, Number(event.currentTarget.value) / 10);
  if (Number.isFinite(driveVideo.duration)) driveVideo.currentTime = Math.min(next, driveVideo.duration);
  else driveVideo.currentTime = next;
  publishHostEvent("seek", driveVideo.currentTime, !driveVideo.paused);
});
$("player-volume")?.addEventListener("input", event => {
  driveVideo.volume = Number(event.currentTarget.value);
  driveVideo.muted = driveVideo.volume === 0;
  updateVolumeButton();
});
$("player-mute-button")?.addEventListener("click", () => {
  driveVideo.muted = !driveVideo.muted;
  if (!driveVideo.muted && driveVideo.volume === 0) {
    driveVideo.volume = 0.65;
    $("player-volume").value = "0.65";
  }
  updateVolumeButton();
});
function updateVolumeButton() {
  const button = $("player-mute-button");
  if (!button) return;
  const muted = driveVideo.muted || driveVideo.volume === 0;
  button.classList.toggle("is-muted", muted);
  button.setAttribute("aria-label", muted ? "إلغاء كتم الصوت" : "كتم الصوت");
  button.title = muted ? "إلغاء كتم الصوت" : "كتم الصوت";
}

$("copy-invite")?.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    toast("تم نسخ رابط دعوة الغرفة.");
  } catch (_) { toast("انسخ رابط الغرفة من شريط العنوان."); }
});
$("fullscreen-button")?.addEventListener("click", async () => {
  try {
    if (!document.fullscreenElement) await $("player-stage").requestFullscreen();
    else await document.exitFullscreen();
  } catch (_) { toast("تعذر تفعيل ملء الشاشة."); }
});

setInterval(() => {
  if (socket?.readyState === WebSocket.OPEN) sendSocket({ type: "ping" });
  if (role !== "host" && playback && playerReady &&
      Math.abs(driveVideo.currentTime - projectedTime(playback)) > 3) {
    applyPlayback(playback, false);
  }
}, 5000);

async function bootstrap() {
  if (roomId) return loadRoom();
  await consumeGoogleAuthCode();
  await checkDriveSession();
}
if (roomId) {
  loadRoom();
} else {
  bootstrap();
}