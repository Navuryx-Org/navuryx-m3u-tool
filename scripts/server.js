const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const dns = require("dns").promises;
const net = require("net");
const { spawn, spawnSync } = require("child_process");

const projectRoot = path.join(__dirname, "..");
const sourceRoot = path.join(projectRoot, "src");
const dataRoot = path.resolve(process.env.NAVURYX_DATA_DIR || path.join(projectRoot, "data"));
const uploadsRoot = path.join(dataRoot, "uploads");
const hlsRoot = path.join(dataRoot, "hls");
const channelsFile = path.join(dataRoot, "channels.json");
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "0.0.0.0";
const maxUploadBytes = Number(process.env.NAVURYX_MAX_UPLOAD_BYTES || 20 * 1024 * 1024 * 1024);
const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";
const toolsRoot = path.join(dataRoot, "tools");
const configuredYtDlpPath = String(process.env.NAVURYX_YTDLP_PATH || "").trim();
const allowedOrigin = String(process.env.NAVURYX_ALLOWED_ORIGIN || "https://navuryx-m3u-tool.vercel.app").trim();
const processes = new Map();
const logs = new Map();
const publicFiles = new Set([
  "/index.html",
  "/css/styles.css",
  "/js/navigation.js",
  "/js/m3u.js",
  "/js/app.js",
  "/js/streaming.js",
  "/js/player.js"
]);
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".m3u": "audio/x-mpegurl; charset=utf-8",
  ".m3u8": "application/vnd.apple.mpegurl; charset=utf-8",
  ".ts": "video/mp2t",
  ".m4s": "video/iso.segment",
  ".mp4": "video/mp4"
};
const mediaExtensions = new Set([".mp4", ".mov", ".mkv", ".webm", ".m4v", ".avi", ".ts", ".m2ts"]);


function localAddresses() {
  const values = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const item of interfaces || []) {
      if (item && !item.internal) {
        values.add(item.address);
        if (item.family === "IPv4") {
          values.add(`::ffff:${item.address}`);
        }
      }
    }
  }
  return values;
}

const hostAddresses = localAddresses();

function preferredAddress() {
  for (const address of hostAddresses) {
    if (/^\d+\.\d+\.\d+\.\d+$/.test(address) && !address.startsWith("127.")) {
      return address;
    }
  }
  return "127.0.0.1";
}

fs.mkdirSync(uploadsRoot, { recursive: true });
fs.mkdirSync(hlsRoot, { recursive: true });
fs.mkdirSync(toolsRoot, { recursive: true });

function ffmpegAvailable() {
  const result = spawnSync(ffmpegPath, ["-version"], { stdio: "ignore" });
  return result.status === 0;
}

function commandWorks(command, args) {
  if (!command) {
    return false;
  }
  const result = spawnSync(command, args, { stdio: "ignore", windowsHide: true });
  return result.status === 0;
}

function ytDlpAsset() {
  if (process.platform === "win32") {
    return { name: "yt-dlp.exe", url: "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe" };
  }
  if (process.platform === "darwin") {
    return { name: "yt-dlp_macos", url: "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos" };
  }
  if (process.platform === "linux" && process.arch === "arm64") {
    return { name: "yt-dlp_linux_aarch64", url: "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux_aarch64" };
  }
  if (process.platform === "linux") {
    return { name: "yt-dlp_linux", url: "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux" };
  }
  return { name: "yt-dlp", url: "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp" };
}

let ytDlpPromise = null;

async function ensureYtDlp() {
  if (configuredYtDlpPath && commandWorks(configuredYtDlpPath, ["--version"])) {
    return configuredYtDlpPath;
  }
  if (commandWorks("yt-dlp", ["--version"])) {
    return "yt-dlp";
  }
  const asset = ytDlpAsset();
  const target = path.join(toolsRoot, asset.name);
  if (commandWorks(target, ["--version"])) {
    return target;
  }
  if (!ytDlpPromise) {
    ytDlpPromise = (async () => {
      const temporary = `${target}.download`;
      let response;
      try {
        response = await fetch(asset.url, { redirect: "follow", signal: AbortSignal.timeout(120000) });
      } catch {
        throw new Error("The site resolver could not be downloaded");
      }
      if (!response.ok) {
        throw new Error(`The site resolver download failed with status ${response.status}`);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length < 1024 * 1024) {
        throw new Error("The site resolver download was incomplete");
      }
      fs.writeFileSync(temporary, bytes);
      if (process.platform !== "win32") {
        fs.chmodSync(temporary, 0o755);
      }
      fs.rmSync(target, { force: true });
      fs.renameSync(temporary, target);
      if (!commandWorks(target, ["--version"])) {
        throw new Error("The site resolver could not be started");
      }
      return target;
    })().finally(() => {
      ytDlpPromise = null;
    });
  }
  return ytDlpPromise;
}

function runCommand(command, args, timeout) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        child.kill("SIGTERM");
        settled = true;
        reject(new Error("The site resolver timed out"));
      }
    }, timeout || 90000);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
    child.on("exit", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      const output = Buffer.concat(stdout).toString("utf8").trim();
      const detail = Buffer.concat(stderr).toString("utf8").trim();
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(detail || `The site resolver exited with code ${code}`));
      }
    });
  });
}

async function resolveSiteSource(value) {
  const source = validateWebUrl(value);
  const executable = await ensureYtDlp();
  const output = await runCommand(executable, ["--no-playlist", "--no-warnings", "--dump-single-json", "--format", "best", source], 120000);
  let metadata;
  try {
    metadata = JSON.parse(output);
  } catch {
    throw new Error("The site resolver returned invalid media information");
  }
  const mediaUrl = String(metadata.url || "").trim();
  if (!mediaUrl) {
    throw new Error("The site did not provide a playable media URL");
  }
  return {
    source,
    mediaUrl,
    title: sanitizeText(metadata.title, automaticNameFromUrl(source), 120),
    isLive: Boolean(metadata.is_live || metadata.live_status === "is_live"),
    headers: metadata.http_headers && typeof metadata.http_headers === "object" ? metadata.http_headers : {}
  };
}

function sanitizeText(value, fallback, maxLength) {
  const cleaned = String(value || "").replace(/[\r\n\0]/g, " ").trim().slice(0, maxLength);
  return cleaned || fallback;
}

function slugify(value) {
  const slug = sanitizeText(value, "channel", 80)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "channel";
}

function titleCase(value) {
  return String(value || "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .trim();
}

function automaticNameFromUrl(value) {
  try {
    const parsed = new URL(String(value || "").trim());
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const parts = parsed.pathname.split("/").filter(Boolean);
    const youtubeId = host === "youtu.be" ? parts[0] : host.endsWith("youtube.com") ? parsed.searchParams.get("v") || parts.at(-1) : "";
    if (youtubeId) {
      return `YouTube ${youtubeId}`;
    }
    if (host.endsWith("twitch.tv")) {
      return titleCase(parts[0] || "Twitch Stream");
    }
    const file = decodeURIComponent(parts.at(-1) || "").replace(/\.[a-z0-9]{2,6}$/i, "");
    return titleCase(file || host.split(".")[0] || "Channel");
  } catch {
    return "Channel";
  }
}

function validateWebUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || "").trim());
  } catch {
    throw new Error("Enter a valid website URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("Use an HTTP or HTTPS website URL without embedded credentials");
  }
  return parsed.toString();
}

function directMediaInput(value) {
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return true;
    }
    const extension = path.extname(parsed.pathname).toLowerCase();
    return new Set([".m3u8", ".mp4", ".m4v", ".mov", ".webm", ".mkv", ".avi", ".ts", ".m2ts", ".mpd"]).has(extension);
  } catch {
    return false;
  }
}

function escapeM3u(value) {
  return String(value || "").replace(/[\r\n"]/g, " ").trim();
}

function loadChannels() {
  try {
    const parsed = JSON.parse(fs.readFileSync(channelsFile, "utf8"));
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.map((channel) => {
      const indexPath = path.join(hlsRoot, String(channel.id || ""), "index.m3u8");
      const isFile = channel.kind === "file";
      return {
        id: String(channel.id || ""),
        name: sanitizeText(channel.name, "Untitled channel", 120),
        group: sanitizeText(channel.group, "Navuryx", 80),
        kind: isFile ? "file" : "live",
        resolver: channel.resolver === "ytdlp" ? "ytdlp" : "direct",
        source: String(channel.source || ""),
        status: isFile && fs.existsSync(indexPath) ? "ready" : "stopped",
        createdAt: String(channel.createdAt || new Date().toISOString()),
        updatedAt: new Date().toISOString(),
        error: ""
      };
    }).filter((channel) => channel.id);
  } catch {
    return [];
  }
}

let channels = loadChannels();

function saveChannels() {
  fs.mkdirSync(dataRoot, { recursive: true });
  const temporary = `${channelsFile}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(channels, null, 2));
  fs.rmSync(channelsFile, { force: true });
  fs.renameSync(temporary, channelsFile);
}

saveChannels();

function appendLog(id, text) {
  const current = logs.get(id) || [];
  const lines = `${text}`.split(/\r?\n/).filter(Boolean);
  const next = current.concat(lines).slice(-40);
  logs.set(id, next);
}

function updateChannel(id, changes) {
  const channel = channels.find((item) => item.id === id);
  if (!channel) {
    return null;
  }
  Object.assign(channel, changes, { updatedAt: new Date().toISOString() });
  saveChannels();
  return channel;
}

function publicChannel(channel, request) {
  const base = getAdvertisedBaseUrl(request);
  return {
    ...channel,
    source: channel.kind === "file" && channel.resolver === "direct" ? path.basename(channel.source) : channel.resolver === "ytdlp" ? "Site URL" : "Direct input",
    hlsUrl: `${base}/${encodeURIComponent(channel.id)}/index.m3u8`,
    log: logs.get(channel.id) || []
  };
}

function getBaseUrl(request) {
  const forwardedProto = String(request.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const protocol = forwardedProto === "https" ? "https" : "http";
  const requestHost = sanitizeText(request.headers.host, `127.0.0.1:${port}`, 255);
  return `${protocol}://${requestHost}`;
}

function getAdvertisedBaseUrl(request) {
  const configured = String(process.env.NAVURYX_PUBLIC_BASE_URL || "").trim().replace(/\/$/, "");
  if (configured) {
    return configured;
  }
  const base = getBaseUrl(request);
  try {
    const parsed = new URL(base);
    if (["127.0.0.1", "localhost", "0.0.0.0"].includes(parsed.hostname)) {
      return `${parsed.protocol}//${preferredAddress()}:${parsed.port || port}`;
    }
  } catch {
  }
  return base;
}

function sendHeaders(response, status, type, extra) {
  response.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": type.includes("mpegurl") ? "no-store" : "no-cache",
    "Access-Control-Allow-Origin": allowedOrigin || "*",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,X-File-Name",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self' https://cdn.jsdelivr.net; connect-src 'self' http: https:; media-src 'self' http: https: blob:; object-src 'none'; base-uri 'none'; frame-src https://player.twitch.tv https://clips.twitch.tv https://www.youtube.com https://www.youtube-nocookie.com; frame-ancestors 'none'",
    ...(extra || {})
  });
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  sendHeaders(response, status, "application/json; charset=utf-8", { "Content-Length": Buffer.byteLength(body) });
  response.end(body);
}

function sendText(response, status, message, type) {
  const body = String(message);
  sendHeaders(response, status, type || "text/plain; charset=utf-8", { "Content-Length": Buffer.byteLength(body) });
  response.end(body);
}

function readJson(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("Request body is too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new Error("Request body must contain valid JSON"));
      }
    });
    request.on("error", reject);
  });
}

function writeUpload(request, targetPath) {
  return new Promise((resolve, reject) => {
    const declared = Number(request.headers["content-length"] || 0);
    if (declared > maxUploadBytes) {
      reject(new Error("The media file exceeds the configured upload limit"));
      return;
    }
    const output = fs.createWriteStream(targetPath, { flags: "wx" });
    let size = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      output.destroy();
      fs.rmSync(targetPath, { force: true });
      reject(error);
    };
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxUploadBytes) {
        fail(new Error("The media file exceeds the configured upload limit"));
        request.destroy();
      }
    });
    request.on("error", fail);
    output.on("error", fail);
    output.on("finish", () => {
      if (!settled) {
        settled = true;
        resolve(size);
      }
    });
    request.pipe(output);
  });
}

function createChannel(name, group, kind, source, resolver) {
  const base = slugify(name);
  const id = `${base}-${crypto.randomBytes(4).toString("hex")}`;
  const channel = {
    id,
    name: sanitizeText(name, "Untitled channel", 120),
    group: sanitizeText(group, "Navuryx", 80),
    kind,
    resolver: resolver === "ytdlp" ? "ytdlp" : "direct",
    source,
    status: "starting",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    error: ""
  };
  channels.push(channel);
  saveChannels();
  return channel;
}

function hlsArguments(channel, outputDirectory, inputSource) {
  const output = path.join(outputDirectory, "index.m3u8");
  const segmentPattern = path.join(outputDirectory, "segment-%06d.ts");
  const common = [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-y",
    "-i",
    inputSource,
    "-map",
    "0:v:0?",
    "-map",
    "0:a:0?",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-ar",
    "48000",
    "-f",
    "hls",
    "-hls_time",
    "6",
    "-hls_segment_filename",
    segmentPattern
  ];
  if (channel.kind === "file") {
    return common.concat(["-hls_playlist_type", "vod", output]);
  }
  return common.concat([
    "-hls_list_size",
    "8",
    "-hls_flags",
    "delete_segments+append_list+omit_endlist+independent_segments",
    output
  ]);
}

async function startFfmpeg(channel, preparedSource) {
  if (!ffmpegAvailable()) {
    updateChannel(channel.id, { status: "failed", error: "The streaming engine is unavailable" });
    return;
  }
  const outputDirectory = path.join(hlsRoot, channel.id);
  fs.rmSync(outputDirectory, { recursive: true, force: true });
  fs.mkdirSync(outputDirectory, { recursive: true });
  logs.set(channel.id, []);
  let inputSource = channel.source;
  let inputHeaders = {};
  if (channel.resolver === "ytdlp") {
    updateChannel(channel.id, { status: "starting", error: "" });
    try {
      const resolved = preparedSource || await resolveSiteSource(channel.source);
      inputSource = resolved.mediaUrl;
      inputHeaders = resolved.headers;
      if (resolved.title && (!channel.name || /^YouTube |^Channel$/i.test(channel.name))) {
        channel.name = resolved.title;
      }
      channel.kind = resolved.isLive ? "live" : "file";
      updateChannel(channel.id, { name: channel.name, kind: channel.kind, status: channel.kind === "file" ? "processing" : "starting", error: "" });
    } catch (error) {
      appendLog(channel.id, error.message || String(error));
      updateChannel(channel.id, { status: "failed", error: error.message || "The site URL could not be resolved" });
      return;
    }
  }
  const args = hlsArguments(channel, outputDirectory, inputSource);
  const userAgent = String(inputHeaders["User-Agent"] || inputHeaders["user-agent"] || "").trim();
  if (userAgent) {
    const inputIndex = args.indexOf("-i");
    if (inputIndex >= 0) {
      args.splice(inputIndex, 0, "-user_agent", userAgent);
    }
  }
  const child = spawn(ffmpegPath, args, {
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"]
  });
  processes.set(channel.id, { ffmpeg: child });
  updateChannel(channel.id, { status: channel.kind === "file" ? "processing" : "starting", error: "" });
  let readyObserved = false;
  const readyTimer = setInterval(() => {
    if (fs.existsSync(path.join(outputDirectory, "index.m3u8"))) {
      readyObserved = true;
      updateChannel(channel.id, { status: channel.kind === "file" ? "processing" : "streaming", error: "" });
      if (channel.kind === "live") {
        clearInterval(readyTimer);
      }
    }
  }, 500);
  child.stderr.on("data", (chunk) => appendLog(channel.id, chunk.toString("utf8")));
  child.on("error", (error) => {
    clearInterval(readyTimer);
    processes.delete(channel.id);
    appendLog(channel.id, error.message);
    updateChannel(channel.id, { status: "failed", error: "The streaming engine could not be started" });
  });
  child.on("exit", (code, signal) => {
    clearInterval(readyTimer);
    processes.delete(channel.id);
    const current = channels.find((item) => item.id === channel.id);
    if (!current || current.status === "stopped") {
      return;
    }
    if (channel.kind === "file" && code === 0 && fs.existsSync(path.join(outputDirectory, "index.m3u8"))) {
      updateChannel(channel.id, { status: "ready", error: "" });
      return;
    }
    const detail = (logs.get(channel.id) || []).slice(-1)[0] || `Streaming process exited with code ${code ?? "unknown"}${signal ? ` (${signal})` : ""}`;
    updateChannel(channel.id, { status: readyObserved ? "stopped" : "failed", error: detail });
  });
}


function validateLiveUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || "").trim());
  } catch {
    throw new Error("Enter a valid live input URL");
  }
  const allowed = new Set(["http:", "https:", "rtmp:", "rtmps:", "rtsp:", "srt:", "udp:", "rtp:"]);
  if (!allowed.has(parsed.protocol)) {
    throw new Error("Use an HTTP, HTTPS, RTMP, RTMPS, RTSP, SRT, UDP, or RTP input URL");
  }
  if (parsed.username || parsed.password) {
    throw new Error("URLs with embedded usernames or passwords are not accepted");
  }
  return parsed.toString();
}


function remoteVideoFileUrl(value) {
  try {
    const parsed = new URL(value);
    return new Set([".mp4", ".m4v", ".mov", ".webm", ".mkv", ".avi"]).has(path.extname(parsed.pathname).toLowerCase());
  } catch {
    return false;
  }
}

function stopChannel(id) {
  const running = processes.get(id);
  if (running) {
    running.ffmpeg.kill("SIGTERM");
    processes.delete(id);
  }
  return updateChannel(id, { status: "stopped", error: "" });
}

function removeChannel(id) {
  stopChannel(id);
  const index = channels.findIndex((item) => item.id === id);
  if (index < 0) {
    return false;
  }
  const [channel] = channels.splice(index, 1);
  saveChannels();
  fs.rmSync(path.join(hlsRoot, id), { recursive: true, force: true });
  if (channel.kind === "file" && channel.source.startsWith(uploadsRoot)) {
    fs.rmSync(channel.source, { force: true });
  }
  logs.delete(id);
  return true;
}

function isPrivateAddress(address) {
  if (net.isIP(address) === 4) {
    const parts = address.split(".").map(Number);
    const [a, b] = parts;
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (net.isIP(address) === 6) {
    const normalized = address.toLowerCase();
    return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb") || normalized.startsWith("::ffff:127.") || normalized.startsWith("::ffff:10.") || normalized.startsWith("::ffff:192.168.");
  }
  return true;
}

async function validateRemotePlaylistUrl(value) {
  const parsed = new URL(String(value || "").trim());
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("Use an HTTP or HTTPS URL without embedded credentials");
  }
  if (parsed.hostname.toLowerCase() === "localhost") {
    throw new Error("Local network addresses are not accepted by the playlist proxy");
  }
  const records = await dns.lookup(parsed.hostname, { all: true });
  if (!records.length || records.some((record) => isPrivateAddress(record.address))) {
    throw new Error("Private or reserved network addresses are not accepted by the playlist proxy");
  }
  return parsed;
}

async function fetchRemotePlaylist(value) {
  const parsed = await validateRemotePlaylistUrl(value);
  const response = await fetch(parsed, {
    headers: { Accept: "audio/x-mpegurl,application/vnd.apple.mpegurl,text/plain,*/*" },
    redirect: "follow",
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > 10 * 1024 * 1024) {
    throw new Error("The remote playlist is larger than 10 MB");
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > 10 * 1024 * 1024) {
    throw new Error("The remote playlist is larger than 10 MB");
  }
  return text;
}

function playlistText(request) {
  const base = getAdvertisedBaseUrl(request);
  const entries = channels.filter((channel) => ["ready", "streaming"].includes(channel.status));
  const lines = ["#EXTM3U"];
  for (const channel of entries) {
    lines.push(`#EXTINF:-1 group-title="${escapeM3u(channel.group)}",${escapeM3u(channel.name)}`);
    lines.push(`${base}/${encodeURIComponent(channel.id)}/index.m3u8`);
  }
  return `${lines.join("\r\n")}\r\n`;
}

function serveFile(response, filePath, requestMethod) {
  fs.stat(filePath, (error, stats) => {
    if (error || !stats.isFile()) {
      sendText(response, 404, "Not found");
      return;
    }
    const type = contentTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    sendHeaders(response, 200, type, { "Content-Length": stats.size });
    if (requestMethod === "HEAD") {
      response.end();
      return;
    }
    fs.createReadStream(filePath).on("error", () => response.destroy()).pipe(response);
  });
}

async function handleApi(request, response, pathname, parsedUrl) {
  if (request.method === "OPTIONS") {
    sendHeaders(response, 204, "text/plain; charset=utf-8");
    response.end();
    return true;
  }
  if (pathname === "/api/player/playlist" && request.method === "GET") {
    try {
      const text = await fetchRemotePlaylist(parsedUrl.searchParams.get("url"));
      sendText(response, 200, text, "audio/x-mpegurl; charset=utf-8");
    } catch (error) {
      sendJson(response, 400, { error: error.message || "The remote playlist could not be loaded" });
    }
    return true;
  }
  if (pathname === "/api/source-metadata" && request.method === "GET") {
    try {
      const source = validateLiveUrl(parsedUrl.searchParams.get("url"));
      if (directMediaInput(source)) {
        sendJson(response, 200, { title: automaticNameFromUrl(source), resolver: "direct", live: !remoteVideoFileUrl(source) });
      } else {
        const metadata = await resolveSiteSource(source);
        sendJson(response, 200, { title: metadata.title, resolver: "ytdlp", live: metadata.isLive });
      }
    } catch (error) {
      sendJson(response, 400, { error: error.message || "The source could not be inspected" });
    }
    return true;
  }
  if (pathname === "/api/status" && request.method === "GET") {
    sendJson(response, 200, {
      ffmpeg: ffmpegAvailable(),
      playlistUrl: `${getAdvertisedBaseUrl(request)}/playlist.m3u`,
      channelCount: channels.length
    });
    return true;
  }
  if (pathname === "/api/channels" && request.method === "GET") {
    sendJson(response, 200, {
      playlistUrl: `${getAdvertisedBaseUrl(request)}/playlist.m3u`,
      channels: channels.map((channel) => publicChannel(channel, request))
    });
    return true;
  }
  if (pathname === "/api/channels/file" && request.method === "POST") {
    if (!ffmpegAvailable()) {
      sendJson(response, 503, { error: "FFmpeg is required to create HLS streams" });
      return true;
    }
    const requestedName = String(parsedUrl.searchParams.get("name") || "").trim();
    const group = sanitizeText(parsedUrl.searchParams.get("group"), "Navuryx", 80);
    const suppliedName = sanitizeText(request.headers["x-file-name"], "media.mp4", 180);
    const name = sanitizeText(requestedName, titleCase(path.basename(suppliedName, path.extname(suppliedName))) || "Uploaded channel", 120);
    const extension = path.extname(suppliedName).toLowerCase();
    if (!mediaExtensions.has(extension)) {
      sendJson(response, 400, { error: "Upload a supported video file" });
      return true;
    }
    const temporaryId = crypto.randomBytes(8).toString("hex");
    const target = path.join(uploadsRoot, `${temporaryId}${extension}`);
    try {
      const size = await writeUpload(request, target);
      if (size === 0) {
        fs.rmSync(target, { force: true });
        throw new Error("The uploaded file is empty");
      }
      const channel = createChannel(name, group, "file", target, "direct");
      await startFfmpeg(channel);
      sendJson(response, 202, { channel: publicChannel(channel, request), playlistUrl: `${getAdvertisedBaseUrl(request)}/playlist.m3u` });
    } catch (error) {
      fs.rmSync(target, { force: true });
      sendJson(response, 400, { error: error.message || "The media file could not be uploaded" });
    }
    return true;
  }
  if (pathname === "/api/channels/live" && request.method === "POST") {
    if (!ffmpegAvailable()) {
      sendJson(response, 503, { error: "FFmpeg is required to create HLS streams" });
      return true;
    }
    try {
      const body = await readJson(request, 64 * 1024);
      const source = validateLiveUrl(body.sourceUrl);
      const group = sanitizeText(body.group, "Navuryx", 80);
      const resolver = directMediaInput(source) ? "direct" : "ytdlp";
      let preparedSource = null;
      let title = automaticNameFromUrl(source);
      let kind = remoteVideoFileUrl(source) ? "file" : "live";
      if (resolver === "ytdlp") {
        preparedSource = await resolveSiteSource(source);
        title = preparedSource.title || title;
        kind = preparedSource.isLive ? "live" : "file";
      }
      const requestedName = body.nameAuto === false ? body.name : "";
      const name = sanitizeText(requestedName, title || "Channel", 120);
      const channel = createChannel(name, group, kind, source, resolver);
      await startFfmpeg(channel, preparedSource);
      sendJson(response, 202, { channel: publicChannel(channel, request), playlistUrl: `${getAdvertisedBaseUrl(request)}/playlist.m3u` });
    } catch (error) {
      sendJson(response, 400, { error: error.message || "The live input could not be added" });
    }
    return true;
  }
  const actionMatch = pathname.match(/^\/api\/channels\/([a-z0-9-]+)\/(stop|restart)$/);
  if (actionMatch && request.method === "POST") {
    const channel = channels.find((item) => item.id === actionMatch[1]);
    if (!channel) {
      sendJson(response, 404, { error: "Channel not found" });
      return true;
    }
    if (actionMatch[2] === "stop") {
      stopChannel(channel.id);
    } else {
      stopChannel(channel.id);
      await startFfmpeg(channel);
    }
    sendJson(response, 200, { channel: publicChannel(channel, request) });
    return true;
  }
  const deleteMatch = pathname.match(/^\/api\/channels\/([a-z0-9-]+)$/);
  if (deleteMatch && request.method === "DELETE") {
    if (!removeChannel(deleteMatch[1])) {
      sendJson(response, 404, { error: "Channel not found" });
      return true;
    }
    sendJson(response, 200, { removed: true });
    return true;
  }
  return false;
}

const server = http.createServer(async (request, response) => {
  let parsedUrl;
  try {
    parsedUrl = new URL(request.url || "/", "http://127.0.0.1");
  } catch {
    sendText(response, 400, "Bad request");
    return;
  }
  const pathname = decodeURIComponent(parsedUrl.pathname);
  try {
    if (await handleApi(request, response, pathname, parsedUrl)) {
      return;
    }
  } catch (error) {
    sendJson(response, 500, { error: error.message || "Internal server error" });
    return;
  }
  if (pathname === "/playlist.m3u" && ["GET", "HEAD"].includes(request.method)) {
    const body = playlistText(request);
    if (request.method === "HEAD") {
      sendHeaders(response, 200, contentTypes[".m3u"], { "Content-Length": Buffer.byteLength(body) });
      response.end();
    } else {
      sendText(response, 200, body, contentTypes[".m3u"]);
    }
    return;
  }
  const hlsMatch = pathname.match(/^\/([a-z0-9-]+)\/(index\.m3u8|[a-zA-Z0-9._-]+\.(?:ts|m4s|mp4))$/);
  if (hlsMatch && ["GET", "HEAD"].includes(request.method)) {
    const directory = path.join(hlsRoot, hlsMatch[1]);
    const filePath = path.join(directory, hlsMatch[2]);
    if (!filePath.startsWith(`${directory}${path.sep}`)) {
      sendText(response, 403, "Forbidden");
      return;
    }
    serveFile(response, filePath, request.method);
    return;
  }
  const requested = pathname === "/" ? "/index.html" : pathname;
  if (!["GET", "HEAD"].includes(request.method) || !publicFiles.has(requested)) {
    sendText(response, 404, "Not found");
    return;
  }
  serveFile(response, path.join(sourceRoot, requested), request.method);
});

function shutdown() {
  for (const running of processes.values()) {
    running.ffmpeg.kill("SIGTERM");
  }
  processes.clear();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
server.on("error", (error) => {
  process.stderr.write(`Navuryx server error: ${error.message}
`);
  process.exitCode = 1;
});

server.listen(port, host, () => {
  process.stdout.write(`Navuryx is running at http://127.0.0.1:${port}\n`);
  process.stdout.write(`M3U playlist: http://127.0.0.1:${port}/playlist.m3u\n`);
});
