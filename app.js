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

function startGoogleConnect() {
  const pending = driveInput?.value.trim();
  if (pending) {
    try { localStorage.setItem(PENDING_KEY, JSON.stringify(parseDriveId(pending))); } catch (_) {}
  }
  location.href = SYNC_API + "/api/drive/auth/start";
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
    const view = new google.picker.DocsView(google.picker.ViewId.DOCS)
      .setMimeTypes("video/*")
      .setIncludeFolders(false);
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
  const pill = $("role-pill"), controls = $("host-controls"), hint = $("sync-hint");
  if (pill) {
    pill.textContent = role === "host" ? "أنت المضيف" : "مشاهد";
    pill.classList.toggle("host", role === "host");
  }
  if (controls) controls.hidden = role !== "host";
  if (hint) hint.textContent = role === "host"
    ? "أنت تتحكم في تشغيل الفيديو وإيقافه وتقديمه للمجموعة."
    : "المضيف يتحكم في المشاهدة. اضغط بدء المشاهدة عند الانضمام، واضبط الصوت محليًا.";
  if (driveVideo) driveVideo.controls = role === "host";
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
    driveVideo.play().then(() => { $("drive-start").hidden = true; }).catch(() => {
      $("drive-start").hidden = false;
    });
  } else {
    driveVideo.pause();
    $("drive-start").hidden = true;
  }
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
  driveVideo.addEventListener("loadedmetadata", () => {
    playerReady = true;
    localTime = driveVideo.currentTime || 0;
    if (role !== "host" && playback) applyPlayback(playback, true);
    $("drive-start").hidden = role !== "host" && !!(playback && playback.isPlaying);
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
  if (role !== "host") { toast("التحكم متاح للمضيف فقط."); return; }
  if (action === "seek-back" || action === "seek-forward") {
    const next = Math.max(0, (driveVideo.currentTime || 0) + (action === "seek-back" ? -10 : 10));
    driveVideo.currentTime = next;
    publishHostEvent("seek", next, !driveVideo.paused);
  } else if (action === "toggle") {
    if (driveVideo.paused) driveVideo.play().catch(() => { $("drive-start").hidden = false; });
    else driveVideo.pause();
  }
}
document.addEventListener("click", event => {
  const button = event.target.closest("[data-action]");
  if (button) hostAction(button.dataset.action);
});

$("drive-start")?.addEventListener("click", () => {
  if (role === "host") {
    driveVideo.play().catch(() => toast("تعذر بدء الفيديو."));
  } else if (playback?.isPlaying) {
    applyPlayback(playback, true);
  } else {
    toast("انتظر تشغيل المضيف.");
  }
});

$("local-volume")?.addEventListener("input", event => {
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