(function () {
  const state = {
    sourceMode: "file",
    selectedFile: null,
    timer: null,
    metadataTimer: null,
    metadataRequest: 0,
    busy: false,
    ffmpegAvailable: false,
    nameTouched: false,
    automaticName: ""
  };

  const elements = {
    ffmpegState: document.getElementById("ffmpegState"),
    streamName: document.getElementById("streamName"),
    streamGroup: document.getElementById("streamGroup"),
    mediaFileTab: document.getElementById("mediaFileTab"),
    liveInputTab: document.getElementById("liveInputTab"),
    mediaFilePanel: document.getElementById("mediaFilePanel"),
    liveInputPanel: document.getElementById("liveInputPanel"),
    mediaFileInput: document.getElementById("mediaFileInput"),
    mediaFileLabel: document.getElementById("mediaFileLabel"),
    liveSourceUrl: document.getElementById("liveSourceUrl"),
    sourceUrlNote: document.getElementById("sourceUrlNote"),
    createStreamButton: document.getElementById("createStreamButton"),
    masterPlaylistUrl: document.getElementById("masterPlaylistUrl"),
    copyPlaylistUrl: document.getElementById("copyPlaylistUrl"),
    channelTotal: document.getElementById("channelTotal"),
    refreshChannels: document.getElementById("refreshChannels"),
    channelsEmpty: document.getElementById("channelsEmpty"),
    channelList: document.getElementById("channelList")
  };

  function notify(message, error) {
    const toast = document.getElementById("toast");
    if (!toast) {
      return;
    }
    toast.textContent = message;
    toast.classList.toggle("error", Boolean(error));
    toast.classList.add("visible");
    window.setTimeout(() => toast.classList.remove("visible"), 3200);
  }

  async function api(path, options) {
    const response = await fetch(path, options);
    let body;
    try {
      body = await response.json();
    } catch {
      body = {};
    }
    if (!response.ok) {
      throw new Error(body.error || `Request failed with status ${response.status}`);
    }
    return body;
  }

  function cleanName(value) {
    return String(value || "")
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase())
      .trim()
      .slice(0, 120);
  }

  function fallbackNameFromUrl(value) {
    try {
      const parsed = new URL(value);
      const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
      const youtubeId = host === "youtu.be"
        ? parsed.pathname.split("/").filter(Boolean)[0]
        : host.endsWith("youtube.com")
          ? parsed.searchParams.get("v") || parsed.pathname.split("/").filter(Boolean).at(-1)
          : "";
      if (youtubeId) {
        return `YouTube ${youtubeId}`;
      }
      if (host.endsWith("twitch.tv")) {
        const channel = parsed.pathname.split("/").filter(Boolean)[0];
        return cleanName(channel || "Twitch Stream");
      }
      const file = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).at(-1) || "").replace(/\.[a-z0-9]{2,6}$/i, "");
      return cleanName(file || host.split(".")[0] || "Channel");
    } catch {
      return "";
    }
  }

  function setAutomaticName(value) {
    const name = cleanName(value);
    if (!name) {
      return;
    }
    state.automaticName = name;
    if (!state.nameTouched || !elements.streamName.value.trim()) {
      elements.streamName.value = name;
    }
  }

  function resetName() {
    state.nameTouched = false;
    state.automaticName = "";
    elements.streamName.value = "";
  }

  function setMode(mode) {
    state.sourceMode = mode;
    const modes = [
      ["file", elements.mediaFileTab, elements.mediaFilePanel],
      ["url", elements.liveInputTab, elements.liveInputPanel]
    ];
    for (const [value, button, panel] of modes) {
      const selected = value === mode;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-selected", String(selected));
      panel.hidden = !selected;
    }
  }

  function setBusy(busy, label) {
    state.busy = busy;
    elements.createStreamButton.disabled = busy || !state.ffmpegAvailable;
    elements.createStreamButton.textContent = busy ? label : "Create channel";
  }

  function statusLabel(status) {
    return String(status || "unknown").replace(/(^|[-_])([a-z])/g, (_, prefix, letter) => `${prefix ? " " : ""}${letter.toUpperCase()}`);
  }

  function channelItem(channel) {
    const item = document.createElement("div");
    item.className = "channel-item";

    const identity = document.createElement("div");
    identity.className = "channel-identity";
    const name = document.createElement("strong");
    name.textContent = channel.name;
    const meta = document.createElement("small");
    const dot = document.createElement("span");
    dot.className = `status-dot ${channel.status}`;
    const sourceLabel = channel.resolver === "ytdlp" ? "site" : channel.kind;
    meta.append(dot, document.createTextNode(`${statusLabel(channel.status)} · ${channel.group} · ${sourceLabel}`));
    identity.append(name, meta);

    const url = document.createElement("div");
    url.className = "channel-url";
    const label = document.createElement("span");
    label.textContent = channel.error || "Stream URL";
    const code = document.createElement("code");
    code.textContent = channel.hlsUrl;
    code.title = channel.hlsUrl;
    url.append(label, code);

    const actions = document.createElement("div");
    actions.className = "channel-actions";
    actions.append(
      actionButton("Watch", async () => {
        const advertised = new URL(channel.hlsUrl);
        const playbackUrl = new URL(`${advertised.pathname}${advertised.search}`, window.location.origin).toString();
        window.dispatchEvent(new CustomEvent("navuryx:play", { detail: { url: playbackUrl, name: channel.name, group: channel.group } }));
      }),
      actionButton("Copy", async () => {
        await navigator.clipboard.writeText(channel.hlsUrl);
        notify("Stream URL copied");
      }),
      actionButton(channel.status === "stopped" || channel.status === "failed" ? "Restart" : "Stop", async () => {
        const action = channel.status === "stopped" || channel.status === "failed" ? "restart" : "stop";
        await api(`/api/channels/${encodeURIComponent(channel.id)}/${action}`, { method: "POST" });
        await refresh();
      }),
      actionButton("Remove", async () => {
        await api(`/api/channels/${encodeURIComponent(channel.id)}`, { method: "DELETE" });
        await refresh();
      }, true)
    );

    item.append(identity, url, actions);
    return item;
  }

  function actionButton(label, handler, danger) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `button button-ghost${danger ? " danger" : ""}`;
    button.textContent = label;
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await handler();
      } catch (error) {
        notify(error.message || "Action failed", true);
      } finally {
        button.disabled = false;
      }
    });
    return button;
  }

  function render(data) {
    const channels = Array.isArray(data.channels) ? data.channels : [];
    elements.masterPlaylistUrl.value = data.playlistUrl || "";
    elements.channelTotal.textContent = `${channels.length} channel${channels.length === 1 ? "" : "s"}`;
    elements.channelsEmpty.hidden = channels.length > 0;
    elements.channelList.replaceChildren(...channels.map(channelItem));
    const active = channels.some((channel) => ["starting", "processing"].includes(channel.status));
    window.clearTimeout(state.timer);
    state.timer = window.setTimeout(refresh, active ? 1200 : 5000);
  }

  async function refresh() {
    try {
      const data = await api("/api/channels");
      render(data);
    } catch (error) {
      elements.channelsEmpty.hidden = false;
      elements.channelsEmpty.textContent = error.message || "Channels could not be loaded";
    }
  }

  async function checkStatus() {
    try {
      const status = await api("/api/status");
      state.ffmpegAvailable = Boolean(status.ffmpeg);
      elements.createStreamButton.disabled = !state.ffmpegAvailable;
      elements.masterPlaylistUrl.value = status.playlistUrl || "";
      elements.ffmpegState.hidden = state.ffmpegAvailable;
      elements.ffmpegState.textContent = state.ffmpegAvailable ? "" : "Streaming host unavailable";
    } catch {
      state.ffmpegAvailable = false;
      elements.createStreamButton.disabled = true;
      elements.ffmpegState.hidden = false;
      elements.ffmpegState.textContent = "Streaming host unavailable";
    }
  }

  async function updateUrlMetadata() {
    const sourceUrl = elements.liveSourceUrl.value.trim();
    const requestId = ++state.metadataRequest;
    if (!sourceUrl) {
      elements.sourceUrlNote.textContent = "Direct media is used immediately. Supported site links are resolved automatically.";
      return;
    }
    setAutomaticName(fallbackNameFromUrl(sourceUrl));
    elements.sourceUrlNote.textContent = "Checking source…";
    try {
      const metadata = await api(`/api/source-metadata?url=${encodeURIComponent(sourceUrl)}`);
      if (requestId !== state.metadataRequest) {
        return;
      }
      setAutomaticName(metadata.title);
      elements.sourceUrlNote.textContent = metadata.resolver === "ytdlp"
        ? "Site link recognized. The media URL will be resolved automatically."
        : "Direct media URL recognized.";
    } catch (error) {
      if (requestId === state.metadataRequest) {
        elements.sourceUrlNote.textContent = error.message || "The source could not be inspected.";
      }
    }
  }

  async function createChannel() {
    if (state.busy) {
      return;
    }
    let name = elements.streamName.value.trim();
    const group = elements.streamGroup.value.trim() || "Navuryx";
    setBusy(true, state.sourceMode === "file" ? "Uploading" : "Starting");
    try {
      if (state.sourceMode === "file") {
        if (!state.selectedFile) {
          throw new Error("Choose a video file");
        }
        name = name || cleanName(state.selectedFile.name.replace(/\.[^.]+$/, ""));
        if (location.hostname === "navuryx-m3u-tool.vercel.app" && state.selectedFile.size > 4 * 1024 * 1024) {
          throw new Error("Add files larger than 4 MB with the native app or local server");
        }
        const query = new URLSearchParams({ name, group });
        await api(`/api/channels/file?${query}`, {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream", "X-File-Name": state.selectedFile.name },
          body: state.selectedFile
        });
      } else {
        const sourceUrl = elements.liveSourceUrl.value.trim();
        if (!sourceUrl) {
          throw new Error("Enter a media or site URL");
        }
        name = name || fallbackNameFromUrl(sourceUrl) || "Channel";
        await api("/api/channels/live", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, group, sourceUrl, nameAuto: !state.nameTouched })
        });
      }
      notify("Channel creation started");
      resetName();
      elements.liveSourceUrl.value = "";
      elements.sourceUrlNote.textContent = "Direct media is used immediately. Supported site links are resolved automatically.";
      elements.mediaFileInput.value = "";
      elements.mediaFileLabel.textContent = "Choose a video file";
      state.selectedFile = null;
      await refresh();
    } catch (error) {
      notify(error.message || "The channel could not be created", true);
    } finally {
      setBusy(false, "");
    }
  }

  elements.mediaFileTab.addEventListener("click", () => setMode("file"));
  elements.liveInputTab.addEventListener("click", () => setMode("url"));
  elements.streamName.addEventListener("input", () => {
    const value = elements.streamName.value.trim();
    state.nameTouched = Boolean(value) && value !== state.automaticName;
  });
  elements.mediaFileInput.addEventListener("change", () => {
    state.selectedFile = elements.mediaFileInput.files && elements.mediaFileInput.files[0] || null;
    elements.mediaFileLabel.textContent = state.selectedFile ? state.selectedFile.name : "Choose a video file";
    if (state.selectedFile) {
      setAutomaticName(state.selectedFile.name.replace(/\.[^.]+$/, ""));
    }
  });
  elements.liveSourceUrl.addEventListener("input", () => {
    window.clearTimeout(state.metadataTimer);
    state.metadataTimer = window.setTimeout(() => void updateUrlMetadata(), 550);
  });
  elements.liveSourceUrl.addEventListener("blur", () => void updateUrlMetadata());
  elements.createStreamButton.addEventListener("click", createChannel);
  elements.refreshChannels.addEventListener("click", refresh);
  elements.copyPlaylistUrl.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(elements.masterPlaylistUrl.value);
      notify("Playlist URL copied");
    } catch {
      notify("The URL could not be copied", true);
    }
  });

  void checkStatus();
  void refresh();
}());
