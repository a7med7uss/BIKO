const SYNC_API = (window.BIKO_SYNC_API || "https://biko.qeshta.workers.dev").replace(/\/$/, "");
const CINEMAOS_ORIGIN = "https://cinemaos.tech";
const $ = (id) => document.getElementById(id);

const home = $("home");
const roomPage = $("room-page");
const createForm = $("create-form");
const cinemaInput = $("cinema-url");
const createButton = $("create-btn");
const homeError = $("home-error");
const browseToggle = $("browse-toggle");
const browsePanel = $("browse-panel");
const drivePickerButton = $("drive-picker-button");
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
let playerProvider = "cinemaos";
let suppressDriveEventsUntil = 0;
let driveAccessToken = null;
let googleTokenClient = null;
let pickerReadyPromise = null;

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
  const pill = $("role-pill");
  const controls = $("host-controls");
  const hint = $("sync-hint");
  if (pill) {
    pill.textContent = role === "host" ? "أنت المضيف" : "مشاهد";
    pill.classList.toggle("host", role === "host");
  }
  if (controls) controls.hidden = role !== "host";
  if (hint) hint.textContent = playerProvider === "gdrive"
    ? (role === "host" ? "أنت تتحكم في تشغيل الفيديو وتقديمه وإيقافه للمجموعة." : "تحكم المشاهدة للمضيف فقط. يمكنك ضبط مستوى الصوت محليًا.")
    : (role === "host" ? "أنت تتحكم في مشاهدة المجموعة." : "المضيف فقط يتحكم في المشاهدة. الترجمة والصوت من إعدادات CinemaOS.");
  if (driveVideo && playerProvider === "gdrive") driveVideo.controls = role === "host";
}

function parseCinemaUrl(value) {
  let url;
  try { url = new URL(value.trim()); }
  catch (_) { throw new Error("الصق رابط CinemaOS كاملًا."); }
  if (url.protocol !== "https:" || !["cinemaos.tech", "www.cinemaos.tech"].includes(url.hostname)) {
    throw new Error("الرابط لازم يكون من CinemaOS (cinemaos.tech).");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "player" || !/^\d+$/.test(parts[1] || "")) {
    throw new Error("استخدم رابط المشغّل بالشكل: cinemaos.tech/player/رقم الفيلم");
  }
  const mediaId = parts[1];
  let mediaType = "movie";
  let season = null;
  let episode = null;
  if (parts.length >= 4) {
    if (!/^\d+$/.test(parts[2]) || !/^\d+$/.test(parts[3])) {
      throw new Error("رابط المسلسل لازم يحتوي على رقم الموسم والحلقة.");
    }
    mediaType = "tv";
    season = Number(parts[2]);
    episode = Number(parts[3]);
  } else if (parts.length > 2) {
    throw new Error("رابط المسلسل غير مكتمل؛ أضف الموسم والحلقة.");
  }
  return { mediaId, mediaType, season, episode, sourceUrl: url.toString() };
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
      const media = parseCinemaUrl(cinemaInput.value);
      createRoom({ provider: "cinemaos", ...media });
    } catch (error) {
      homeMessage(error.message);
    }
  });
}

function loadScript(src, id) {
  return new Promise((resolve, reject) => {
    if (document.getElementById(id)) {
      const existing = document.getElementById(id);
      if (existing.dataset.loaded === "true") return resolve();
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("تعذر تحميل مكتبات Google.")), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.id = id;
    script.src = src;
    script.async = true;
    script.defer = true;
    script.onload = () => { script.dataset.loaded = "true"; resolve(); };
    script.onerror = () => reject(new Error("تعذر تحميل مكتبات Google. تحقق من الاتصال."));
    document.head.appendChild(script);
  });
}

async function ensureGooglePicker() {
  if (pickerReadyPromise) return pickerReadyPromise;
  pickerReadyPromise = (async () => {
    const response = await fetch("/api/google-drive-config", { cache: "no-store" });
    const config = await response.json().catch(() => ({}));
    if (!response.ok || !config.enabled || !config.clientId || !config.apiKey || !config.appId) {
      throw new Error("ربط Google Drive لم يتم تفعيله من إدارة BIKO بعد. لا تحتاج لإعداد أي مفاتيح بنفسك.");
    }
    await Promise.all([
      loadScript("https://apis.google.com/js/api.js", "biko-gapi"),
      loadScript("https://accounts.google.com/gsi/client", "biko-gis")
    ]);
    await new Promise((resolve, reject) => {
      if (window.google?.picker) return resolve();
      window.gapi.load("picker", { callback: resolve, onerror: () => reject(new Error("تعذر تحميل Google Picker.")) });
    });
    return config;
  })().catch((error) => {
    pickerReadyPromise = null;
    throw error;
  });
  return pickerReadyPromise;
}

function getGoogleAccessToken(config) {
  return new Promise((resolve, reject) => {
    try {
      if (!googleTokenClient) {
        googleTokenClient = google.accounts.oauth2.initTokenClient({
          client_id: config.clientId,
          scope: "https://www.googleapis.com/auth/drive.file",
          callback: () => {}
        });
      }
      googleTokenClient.callback = (response) => {
        if (response.error) {
          reject(new Error("لم تتم الموافقة على صلاحية الوصول إلى Google Drive."));
          return;
        }
        driveAccessToken = response.access_token;
        resolve(driveAccessToken);
      };
      googleTokenClient.error_callback = () => reject(new Error("تعذر تسجيل الدخول إلى Google. حاول مرة أخرى."));
      googleTokenClient.requestAccessToken({ prompt: driveAccessToken ? "" : "consent" });
    } catch (error) {
      reject(error);
    }
  });
}

async function googleDriveRequest(url, token, options = {}) {
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: {
      Authorization: "Bearer " + token,
      ...(options.body ? { "Content-Type": "application/json" } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = data.error?.message || "تعذر الوصول إلى Google Drive.";
    throw new Error(reason);
  }
  return data;
}

async function handleGoogleFile(doc, token) {
  const fileId = String(doc.id || "");
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(fileId)) throw new Error("معرّف ملف Google Drive غير صالح.");
  const metadata = await googleDriveRequest(
    "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(fileId) +
      "?fields=id,name,mimeType,size,webContentLink,webViewLink,capabilities(canDownload)&supportsAllDrives=true",
    token
  );
  if (!String(metadata.mimeType || "").startsWith("video/")) {
    throw new Error("الملف المحدد ليس فيديو. اختر ملفًا من نوع Video.");
  }
  if (metadata.capabilities && metadata.capabilities.canDownload === false) {
    throw new Error("مالك الملف لا يسمح بتنزيله أو تشغيله عبر تطبيق خارجي.");
  }

  const finalMetadata = await googleDriveRequest(
    "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(fileId) +
      "?fields=id,name,mimeType,size,webContentLink,webViewLink&supportsAllDrives=true",
    token
  );
  const mediaUrl = finalMetadata.webContentLink ||
    ("https://drive.google.com/uc?export=download&id=" + encodeURIComponent(fileId));
  if (!/^https:\/\/(drive\.google\.com|drive\.usercontent\.google\.com|[\w.-]+\.googleusercontent\.com)\//i.test(mediaUrl)) {
    throw new Error("Google لم يُرجع رابط تشغيل مباشر متوافقًا للملف.");
  }

  let permissionId = null;
  let permissionCreated = false;
  if ($("drive-share-consent").checked) {
    const existingPermissions = await googleDriveRequest(
      "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(fileId) +
        "/permissions?supportsAllDrives=true&pageSize=100&fields=permissions(id,type,role)",
      token
    );
    const existingAnyone = (existingPermissions.permissions || []).find((permission) =>
      permission.type === "anyone" && permission.role === "reader"
    );
    if (existingAnyone) {
      permissionId = existingAnyone.id || null;
    } else {
      const permission = await googleDriveRequest(
        "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(fileId) +
          "/permissions?supportsAllDrives=true&fields=id,type,role",
        token,
        { method: "POST", body: { type: "anyone", role: "reader", allowFileDiscovery: false } }
      );
      permissionId = permission.id || null;
      permissionCreated = Boolean(permissionId);
    }
  }

  const roomCreated = await createRoom({
    provider: "gdrive",
    mediaId: fileId,
    fileName: finalMetadata.name || doc.name || "Google Drive video",
    mimeType: finalMetadata.mimeType,
    fileSize: Number(finalMetadata.size || 0),
    mediaUrl,
    webViewLink: finalMetadata.webViewLink || "",
    permissionId,
    shareMode: permissionId ? "anyone-reader" : "pre-shared"
  });
  if (!roomCreated && permissionCreated && permissionId) {
    try {
      await googleDriveRequest(
        "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(fileId) +
          "/permissions/" + encodeURIComponent(permissionId) + "?supportsAllDrives=true",
        token,
        { method: "DELETE" }
      );
    } catch (_) {
      homeMessage("تعذر إنشاء الغرفة وتمت إضافة مشاركة عامة للملف. راجع إعدادات مشاركة الملف في Google Drive وألغِ الرابط العام يدويًا.");
    }
  }
}
async function openGooglePicker() {
  if (drivePickerButton.disabled) return;
  drivePickerButton.disabled = true;
  drivePickerButton.classList.add("loading");
  homeMessage("");
  try {
    const config = await ensureGooglePicker();
    const token = await getGoogleAccessToken(config);
    const view = new google.picker.DocsView(google.picker.ViewId.DOCS)
      .setMimeTypes("video/mp4,video/webm,video/quicktime,video/x-matroska,video/x-msvideo,video/mpeg,video/3gpp")
      .setIncludeFolders(false);
    const picker = new google.picker.PickerBuilder()
      .addView(view)
      .setOAuthToken(token)
      .setDeveloperKey(config.apiKey)
      .setAppId(config.appId)
      .setCallback(async (data) => {
        if (data[google.picker.Response.ACTION] !== google.picker.Action.PICKED) return;
        try {
          const docs = data[google.picker.Response.DOCUMENTS] || [];
          if (!docs.length) return;
          drivePickerButton.disabled = true;
          await handleGoogleFile(docs[0], token);
        } catch (error) {
          homeMessage(error.message || "تعذر تجهيز فيديو Drive.");
        } finally {
          drivePickerButton.disabled = false;
          drivePickerButton.classList.remove("loading");
        }
      })
      .setTitle("اختر فيديو لمشاهدته مع المجموعة")
      .build();
    picker.setVisible(true);
  } catch (error) {
    homeMessage(error.message || "تعذر فتح Google Picker.");
  } finally {
    drivePickerButton.disabled = false;
    drivePickerButton.classList.remove("loading");
  }
}
drivePickerButton?.addEventListener("click", openGooglePicker);

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

function postPlayerCommand(command, value) {
  if (!playerFrame?.contentWindow) return;
  const payload = command === "seek"
    ? { command: "seek", time: Math.max(0, Number(value) || 0) }
    : { command };
  try { playerFrame.contentWindow.postMessage(payload, CINEMAOS_ORIGIN); } catch (_) {}
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

function applyPlayback(item, force) {
  if (!item || role === "host") return;
  if (playerProvider === "gdrive") {
    applyDrivePlayback(item, force);
    return;
  }
  const target = projectedTime(item);
  if (!playerReady) return;
  const drift = localTime == null ? Number.POSITIVE_INFINITY : Math.abs(localTime - target);
  if (drift > 2.3 || force && localTime == null) postPlayerCommand("seek", target);
  postPlayerCommand(item.isPlaying ? "play" : "pause");
}

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

function normalizePlayerEvent(raw) {
  if (!raw || typeof raw !== "object") return null;
  let payload = raw.data && typeof raw.data === "object" ? raw.data : raw;
  if (payload.data && typeof payload.data === "object") payload = payload.data;
  const eventName = String(payload.event || payload.action || payload.player_status || payload.status || payload.state || "").toLowerCase();
  const candidates = [payload.currentTime, payload.current_time, payload.time, payload.progress, payload.player_progress];
  let time = null;
  for (const value of candidates) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) { time = parsed; break; }
  }
  let playing = typeof payload.playing === "boolean" ? payload.playing :
    (typeof payload.isPlaying === "boolean" ? payload.isPlaying : null);
  if (["play", "playing", "resumed"].includes(eventName)) playing = true;
  if (["pause", "paused"].includes(eventName)) playing = false;
  let action = null;
  if (["play", "playing", "resumed"].includes(eventName)) action = "play";
  else if (["pause", "paused"].includes(eventName)) action = "pause";
  else if (["seek", "seeked", "seeking"].includes(eventName)) action = "seek";
  else if (time !== null) action = "progress";
  if (playing !== null) localPlaying = playing;
  if (time !== null) localTime = time;
  if (["ready", "loadedmetadata", "player_ready"].includes(eventName)) playerReady = true;
  return { action, time, playing, eventName };
}

window.addEventListener("message", (event) => {
  if (playerProvider !== "cinemaos" || !playerFrame || event.origin !== CINEMAOS_ORIGIN || event.source !== playerFrame.contentWindow) return;
  let raw = event.data;
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch (_) { return; }
  }
  if (!raw || typeof raw !== "object") return;
  const type = String(raw.type || "").toUpperCase();
  if (type && !["PLAYER_EVENT", "CINEMAOS_EVENT", "PLAYER_STATUS"].includes(type) &&
      !raw.event && raw.currentTime == null && raw.playing == null) return;
  playerReady = true;
  const parsed = normalizePlayerEvent(raw);
  if (!parsed) return;
  if (role === "host" && parsed.action) {
    publishHostEvent(parsed.action, parsed.time, parsed.playing);
  } else if (role !== "host" && playback && localTime != null) {
    const target = projectedTime(playback);
    if (Math.abs(localTime - target) > 4.5) applyPlayback(playback, false);
  }
});

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

    if (media.provider === "gdrive") {
      playerProvider = "gdrive";
      playerFrame.hidden = true;
      driveVideo.hidden = false;
      $("local-media-controls").hidden = false;
      $("room-title").textContent = media.fileName || "فيديو من Google Drive";
      $("room-subtitle").textContent = "Google Drive · تشغيل مباشر لكل عضو";
      if (!media.mediaUrl) throw new Error("رابط تشغيل فيديو Google Drive غير موجود.");
      driveVideo.src = media.mediaUrl;
      driveVideo.controls = false;
      $("drive-start").hidden = true;
    } else {
      playerProvider = "cinemaos";
      driveVideo.hidden = true;
      playerFrame.hidden = false;
      $("local-media-controls").hidden = true;
      const id = String(media.mediaId || "");
      if (!/^\d+$/.test(id)) throw new Error("بيانات الفيلم في هذه الغرفة غير صالحة.");
      const type = media.mediaType === "tv" ? "tv" : "movie";
      let url = media.playerUrl || CINEMAOS_ORIGIN + "/player/" + encodeURIComponent(id);
      if (!media.playerUrl && type === "tv") url += "/" + media.season + "/" + media.episode;
      url += url.includes("?") ? "" : "?theme=090b10";
      $("room-title").textContent = media.title || (type === "tv" ? "مسلسل على CinemaOS" : "فيلم على CinemaOS");
      $("room-subtitle").textContent = type === "tv"
        ? "CinemaOS · الموسم " + media.season + " · الحلقة " + media.episode
        : "CinemaOS · تشغيل مباشر لكل عضو";
      playerFrame.src = url;
      playerFrame.addEventListener("load", () => {
        playerReady = true;
        if (role !== "host" && playback) setTimeout(() => applyPlayback(playback, true), 800);
      }, { once: true });
    }

    connectRoom();
  } catch (error) {
    $("room-title").textContent = "تعذر فتح الغرفة";
    $("room-subtitle").textContent = error.message || "حدث خطأ غير متوقع.";
    $("player-error").textContent = error.message || "حدث خطأ غير متوقع.";
    $("player-error").hidden = false;
  }
}

function hostAction(action) {
  if (role !== "host") {
    toast("التحكم متاح للمضيف فقط.");
    return;
  }
  if (playerProvider === "gdrive") {
    if (action === "seek-back" || action === "seek-forward") {
      const next = Math.max(0, (driveVideo.currentTime || 0) + (action === "seek-back" ? -10 : 10));
      driveVideo.currentTime = next;
      publishHostEvent("seek", next, !driveVideo.paused);
    } else if (action === "toggle") {
      if (driveVideo.paused) {
        driveVideo.play().catch(() => $("drive-start").hidden = false);
      } else {
        driveVideo.pause();
      }
    }
    return;
  }
  if (action === "seek-back" || action === "seek-forward") {
    const next = Math.max(0, (localTime || 0) + (action === "seek-back" ? -10 : 10));
    postPlayerCommand("seek", next);
    publishHostEvent("seek", next, localPlaying);
  } else if (action === "toggle") {
    const nextAction = localPlaying === true ? "pause" : "play";
    localPlaying = nextAction === "play";
    postPlayerCommand(nextAction);
    publishHostEvent(nextAction, localTime, localPlaying);
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
    if (playerProvider === "gdrive" && Number.isFinite(driveVideo.currentTime)) {
      if (Math.abs(driveVideo.currentTime - projectedTime(playback)) > 3.5) applyDrivePlayback(playback, false);
    } else if (playerProvider === "cinemaos" && localTime != null) {
      if (Math.abs(localTime - projectedTime(playback)) > 4) applyPlayback(playback, false);
    }
  }
}, 5000);

if (roomId) loadRoom();
else if (roomPage) roomPage.hidden = true;