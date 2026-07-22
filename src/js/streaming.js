(function () {
  const state = {
    sourceMode: "file",
    selectedFile: null,
    timer: null,
    busy: false
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

  function setMode(mode) {
    state.sourceMode = mode;
    const fileMode = mode === "file";
    elements.mediaFileTab.classList.toggle("active", fileMode);
    elements.mediaFileTab.setAttribute("aria-selected", String(fileMode));
    elements.liveInputTab.classList.toggle("active", !fileMode);
    elements.liveInputTab.setAttribute("aria-selected", String(!fileMode));
    elements.mediaFilePanel.hidden = !fileMode;
    elements.liveInputPanel.hidden = fileMode;
  }

  function setBusy(busy, label) {
    state.busy = busy;
    elements.createStreamButton.disabled = busy;
    elements.createStreamButton.textContent = busy ? label : "Create HLS channel";
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
    meta.append(dot, document.createTextNode(`${statusLabel(channel.status)} · ${channel.group} · ${channel.kind}`));
    identity.append(name, meta);

    const url = document.createElement("div");
    url.className = "channel-url";
    const label = document.createElement("span");
    label.textContent = channel.error || "HLS stream URL";
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
      actionButton("Copy URL", async () => {
        await navigator.clipboard.writeText(channel.hlsUrl);
        notify("HLS URL copied");
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
      elements.channelsEmpty.textContent = error.message || "The channel list could not be loaded";
    }
  }

  async function checkStatus() {
    try {
      const status = await api("/api/status");
      elements.ffmpegState.textContent = status.ffmpeg ? "FFmpeg ready" : "FFmpeg missing";
      elements.ffmpegState.classList.toggle("good", status.ffmpeg);
      elements.ffmpegState.classList.toggle("warning", !status.ffmpeg);
      elements.createStreamButton.disabled = !status.ffmpeg;
      elements.masterPlaylistUrl.value = status.playlistUrl || "";
      if (!status.ffmpeg) {
        notify("Install FFmpeg before creating HLS streams", true);
      }
    } catch (error) {
      elements.ffmpegState.textContent = "Host unavailable";
      elements.ffmpegState.classList.add("warning");
    }
  }

  async function createChannel() {
    if (state.busy) {
      return;
    }
    const name = elements.streamName.value.trim();
    const group = elements.streamGroup.value.trim() || "Navuryx";
    if (!name) {
      notify("Enter a channel name", true);
      elements.streamName.focus();
      return;
    }
    setBusy(true, state.sourceMode === "file" ? "Uploading media" : "Starting stream");
    try {
      if (state.sourceMode === "file") {
        if (!state.selectedFile) {
          throw new Error("Choose a video file");
        }
        if (location.hostname === "navuryx-m3u-tool.vercel.app" && state.selectedFile.size > 4 * 1024 * 1024) {
          throw new Error("Add files larger than 4 MB with the native app or the local npm server");
        }
        const query = new URLSearchParams({ name, group });
        await api(`/api/channels/file?${query}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
            "X-File-Name": state.selectedFile.name
          },
          body: state.selectedFile
        });
      } else {
        const sourceUrl = elements.liveSourceUrl.value.trim();
        if (!sourceUrl) {
          throw new Error("Enter an authorized live input URL");
        }
        await api("/api/channels/live", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, group, sourceUrl })
        });
      }
      notify("Channel added. HLS generation has started.");
      elements.streamName.value = "";
      elements.liveSourceUrl.value = "";
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
  elements.liveInputTab.addEventListener("click", () => setMode("live"));
  elements.mediaFileInput.addEventListener("change", () => {
    state.selectedFile = elements.mediaFileInput.files && elements.mediaFileInput.files[0] || null;
    elements.mediaFileLabel.textContent = state.selectedFile ? state.selectedFile.name : "Choose a video file";
    if (state.selectedFile && !elements.streamName.value.trim()) {
      elements.streamName.value = state.selectedFile.name.replace(/\.[^.]+$/, "");
    }
  });
  elements.createStreamButton.addEventListener("click", createChannel);
  elements.refreshChannels.addEventListener("click", refresh);
  elements.copyPlaylistUrl.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(elements.masterPlaylistUrl.value);
      notify("Master M3U URL copied");
    } catch {
      notify("The URL could not be copied", true);
    }
  });

  void checkStatus();
  void refresh();
}());
