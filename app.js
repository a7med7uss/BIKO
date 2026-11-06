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
const browseFrame = $("browse-frame");

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
let lastAppliedRevision = 0;
let toastTimer = null;
let browserLoaded = false;
let currentMedia = null;

function getClientId() {
  const key = "biko-client-id";
  try {
    let value = localStorage.getItem(key);
    if (!value) {
      value = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
      localStorage.setItem(key, value);
    }
    return value;
  } catch (_) {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
}

function showToast(message) {
  const toast = $("room-toast");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 2600);
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
  if (hint) hint.textContent = role === "host"
    ? "أنت تتحكم في مشاهدة المجموعة. كل عضو يختار الترجمة والصوت محليًا."
    : "المضيف فقط يتحكم في المشاهدة. يمكنك تغيير الترجمة والصوت من إعدادات CinemaOS.";
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
    throw new Error("استخدم رابط صفحة المشغل بالشكل: cinemaos.tech/player/رقم الفيلم");
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

function playerUrl(media) {
  let path = CINEMAOS_ORIGIN + "/player/" + encodeURIComponent(media.mediaId);
  if (media.mediaType === "tv") path += "/" + media.season + "/" + media.episode;
  return path + "?theme=090b10";
}

async function createRoom(media) {
  createButton.disabled = true;
  createButton.innerHTML = '<span class="spinner"></span>';
  homeError.textContent = "";

  try {
    const response = await fetch(SYNC_API + "/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "cinemaos",
        mediaId: media.mediaId,
        mediaType: media.mediaType,
        season: media.season,
        episode: media.episode,
        sourceUrl: media.sourceUrl
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "تعذر إنشاء الغرفة.");
    location.href = "/room/" + encodeURIComponent(data.roomId);
  } catch (error) {
    homeError.textContent = error.message || "حدث خطأ أثناء إنشاء الغرفة.";
    createButton.disabled = false;
    createButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
  }
}

if (createForm) {
  createForm.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      const media = parseCinemaUrl(cinemaInput.value);
      createRoom(media);
    } catch (error) {
      homeError.textContent = error.message;
    }
  });
}

if (browseToggle && browsePanel) {
  browseToggle.addEventListener("click", () => {
    const open = browsePanel.hidden;
    browsePanel.hidden = !open;
    browseToggle.setAttribute("aria-expanded", String(open));
    if (open && !browserLoaded) {
      browseFrame.src = CINEMAOS_ORIGIN + "/";
      browserLoaded = true;
    }
    if (open) browsePanel.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

function extractSelection(data) {
  const queue = [data];
  const seen = new Set();
  while (queue.length) {
    const item = queue.shift();
    if (!item || typeof item !== "object" || seen.has(item)) continue;
    seen.add(item);
    for (const key of ["url", "href", "link", "playerUrl", "embedUrl", "src", "path"]) {
      if (typeof item[key] === "string" && item[key].includes("cinemaos.tech/player/")) {
        return item[key].startsWith("/") ? CINEMAOS_ORIGIN + item[key] : item[key];
      }
    }
    if (item.mediaId && /^\d+$/.test(String(item.mediaId))) {
      const type = String(item.mediaType || item.type || "movie").toLowerCase();
      const id = String(item.mediaId);
      if (type === "tv" || type === "show" || type === "series") {
        if (item.season != null && item.episode != null) {
          return CINEMAOS_ORIGIN + "/player/" + id + "/" + item.season + "/" + item.episode;
        }
      } else {
        return CINEMAOS_ORIGIN + "/player/" + id;
      }
    }
    for (const value of Object.values(item)) {
      if (value && typeof value === "object") queue.push(value);
      else if (typeof value === "string" && value.includes("cinemaos.tech/player/")) return value;
    }
  }
  return null;
}

window.addEventListener("message", (event) => {
  if (event.origin !== CINEMAOS_ORIGIN || !browseFrame || event.source !== browseFrame.contentWindow) return;
  const selected = extractSelection(event.data);
  if (!selected) return;
  try {
    const media = parseCinemaUrl(selected);
    cinemaInput.value = media.sourceUrl;
    homeError.textContent = "";
    showHomeNotice("تم التقاط رابط الفيلم من CinemaOS. اضغط زر إنشاء الغرفة.");
  } catch (_) {}
});

function showHomeNotice(message) {
  let note = $("browse-selection-note");
  if (!note) {
    note = document.createElement("p");
    note.id = "browse-selection-note";
    note.className = "browse-help";
    browsePanel.appendChild(note);
  }
  note.textContent = message;
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
    setRole(message.role);
    updateMembers(message.members);
    if (message.room) currentMedia = message.room;
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

  if (message.type === "error") {
    showToast(message.message || "تعذر تنفيذ الأمر.");
  }
}

function updatePlaybackLabel() {
  const el = $("playback-status");
  if (!el || !playback) return;
  el.textContent = playback.isPlaying ? "المشاهدة مستمرة" : "متوقف مؤقتًا";
}

function postPlayerCommand(command, value) {
  const frame = $("player-frame");
  if (!frame || !frame.contentWindow) return;
  let payload;
  if (command === "seek") payload = { command: "seek", time: Math.max(0, Number(value) || 0) };
  else payload = { command };
  try { frame.contentWindow.postMessage(payload, CINEMAOS_ORIGIN); } catch (_) {}
}

function projectedTime(item) {
  const base = Math.max(0, Number(item.currentTime) || 0);
  if (!item.isPlaying) return base;
  const updatedAt = Number(item.updatedAt) || Date.now();
  return base + Math.max(0, Date.now() - updatedAt) / 1000;
}

function applyPlayback(item, force) {
  if (!item || role === "host") return;
  const target = projectedTime(item);
  const drift = localTime == null ? Number.POSITIVE_INFINITY : Math.abs(localTime - target);

  if (!playerReady && !force) return;
  if (drift > 2.3 || force && localTime == null) {
    postPlayerCommand("seek", target);
  }
  postPlayerCommand(item.isPlaying ? "play" : "pause");
  lastAppliedRevision = Number(item.revision) || lastAppliedRevision;
}

function publishHostEvent(action, time, isPlaying) {
  if (role !== "host") return;
  const now = Date.now();
  if (action === "progress" && now - lastProgressSent < 3500) return;
  if (action === "progress") lastProgressSent = now;

  sendSocket({
    type: "command",
    action,
    currentTime: Number.isFinite(time) ? Math.max(0, time) : localTime,
    isPlaying: typeof isPlaying === "boolean" ? isPlaying : localPlaying,
    clientId
  });
}

function normalizePlayerEvent(raw) {
  if (!raw || typeof raw !== "object") return null;
  let payload = raw.data && typeof raw.data === "object" ? raw.data : raw;
  if (payload.data && typeof payload.data === "object") payload = payload.data;

  const eventName = String(
    payload.event || payload.action || payload.player_status || payload.status || payload.state || ""
  ).toLowerCase();

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
  if (eventName === "ready" || eventName === "loadedmetadata" || eventName === "player_ready") playerReady = true;

  return { action, time, playing, eventName };
}

window.addEventListener("message", (event) => {
  const playerFrame = $("player-frame");
  if (!playerFrame || event.origin !== CINEMAOS_ORIGIN || event.source !== playerFrame.contentWindow) return;

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
  } else if (role !== "host" && playback) {
    const target = projectedTime(playback);
    if (localTime != null && Math.abs(localTime - target) > 4.5) {
      applyPlayback(playback, false);
    }
  }
});

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
    const id = String(media.mediaId || "");
    if (!/^\d+$/.test(id)) throw new Error("بيانات الفيلم في هذه الغرفة غير صالحة.");

    const type = media.mediaType === "tv" ? "tv" : "movie";
    const url = media.playerUrl || playerUrl({
      mediaId: id,
      mediaType: type,
      season: media.season,
      episode: media.episode
    });

    $("room-title").textContent = media.title || (type === "tv" ? "مسلسل على CinemaOS" : "فيلم على CinemaOS");
    $("room-subtitle").textContent = type === "tv"
      ? "CinemaOS · الموسم " + media.season + " · الحلقة " + media.episode
      : "CinemaOS · تشغيل مباشر لكل عضو";
    $("player-frame").src = url;
    $("player-frame").addEventListener("load", () => {
      playerReady = true;
      if (role !== "host" && playback) setTimeout(() => applyPlayback(playback, true), 800);
    }, { once: true });

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
    showToast("التحكم متاح للمضيف فقط.");
    return;
  }
  if (action === "seek-back" || action === "seek-forward") {
    const next = Math.max(0, (localTime || 0) + (action === "seek-back" ? -10 : 10));
    postPlayerCommand("seek", next);
    publishHostEvent("seek", next, localPlaying);
  } else if (action === "toggle") {
    const nextAction = localPlaying === true ? "pause" : "play";
    postPlayerCommand(nextAction);
    publishHostEvent(nextAction, localTime, nextAction === "play");
  }
}

document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (button) hostAction(button.dataset.action);
});

const inviteButton = $("copy-invite");
if (inviteButton) {
  inviteButton.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      showToast("تم نسخ رابط دعوة الغرفة.");
    } catch (_) {
      showToast("انسخ رابط الغرفة من شريط العنوان.");
    }
  });
}

const fullscreenButton = $("fullscreen-button");
if (fullscreenButton) {
  fullscreenButton.addEventListener("click", async () => {
    const stage = $("player-stage");
    try {
      if (!document.fullscreenElement) await stage.requestFullscreen();
      else await document.exitFullscreen();
    } catch (_) {
      showToast("استخدم زر ملء الشاشة داخل CinemaOS.");
    }
  });
}

setInterval(() => {
  if (socket && socket.readyState === WebSocket.OPEN) sendSocket({ type: "ping" });
  if (role !== "host" && playback && playerReady && localTime != null) {
    const expected = projectedTime(playback);
    if (Math.abs(localTime - expected) > 4) applyPlayback(playback, false);
  }
}, 5000);

if (roomId) loadRoom();
else if (roomPage) roomPage.hidden = true;