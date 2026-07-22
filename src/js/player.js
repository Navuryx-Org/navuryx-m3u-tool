(function () {
  const state = {
    entries: [],
    hls: null,
    sourceUrl: ""
  };

  const elements = {
    url: document.getElementById("playerUrl"),
    load: document.getElementById("loadPlayerUrl"),
    channel: document.getElementById("playerChannel"),
    play: document.getElementById("playSelectedChannel"),
    stop: document.getElementById("stopPlayer"),
    video: document.getElementById("videoPlayer"),
    placeholder: document.getElementById("videoPlaceholder"),
    status: document.getElementById("playerStatus"),
    message: document.getElementById("playerMessage"),
    nowPlaying: document.getElementById("nowPlaying"),
    masterButton: document.getElementById("watchMasterPlaylist"),
    masterUrl: document.getElementById("masterPlaylistUrl")
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

  function setStatus(label, mode) {
    elements.status.textContent = label;
    elements.status.classList.toggle("good", mode === "good");
    elements.status.classList.toggle("warning", mode === "warning");
  }

  function stopPlayback() {
    if (state.hls) {
      state.hls.destroy();
      state.hls = null;
    }
    elements.video.pause();
    elements.video.removeAttribute("src");
    elements.video.load();
    elements.placeholder.hidden = false;
    elements.stop.disabled = true;
    elements.nowPlaying.textContent = "Nothing selected";
    setStatus("Ready", "");
  }

  function resolveLocation(location, baseUrl) {
    try {
      return new URL(location, baseUrl).toString();
    } catch {
      return location;
    }
  }

  async function playUrl(url, name) {
    stopPlayback();
    const value = String(url || "").trim();
    if (!value) {
      notify("Select a channel to play", true);
      return;
    }
    elements.placeholder.hidden = true;
    elements.nowPlaying.textContent = name || value;
    elements.stop.disabled = false;
    setStatus("Loading", "warning");
    const nativeHls = elements.video.canPlayType("application/vnd.apple.mpegurl");
    try {
      if (/\.m3u8(?:$|[?#])/i.test(value) && window.Hls && window.Hls.isSupported()) {
        state.hls = new window.Hls({ enableWorker: true, lowLatencyMode: true });
        state.hls.loadSource(value);
        state.hls.attachMedia(elements.video);
        state.hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
          elements.video.play().catch(() => null);
          setStatus("Playing", "good");
        });
        state.hls.on(window.Hls.Events.ERROR, (_, data) => {
          if (data.fatal) {
            setStatus("Playback failed", "warning");
            elements.message.textContent = data.details || "The HLS stream could not be played.";
          }
        });
      } else if (/\.m3u8(?:$|[?#])/i.test(value) && nativeHls) {
        elements.video.src = value;
        await elements.video.play();
        setStatus("Playing", "good");
      } else {
        elements.video.src = value;
        await elements.video.play();
        setStatus("Playing", "good");
      }
      elements.message.textContent = value;
    } catch (error) {
      setStatus("Playback failed", "warning");
      elements.message.textContent = error.message || "The stream could not be played.";
      notify(elements.message.textContent, true);
    }
  }

  function populate(entries) {
    state.entries = entries;
    elements.channel.replaceChildren();
    if (!entries.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "No playable channels found";
      elements.channel.append(option);
      elements.channel.disabled = true;
      elements.play.disabled = true;
      return;
    }
    entries.forEach((entry, index) => {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = entry.group && entry.group !== "Ungrouped" ? `${entry.name} — ${entry.group}` : entry.name;
      elements.channel.append(option);
    });
    elements.channel.disabled = false;
    elements.play.disabled = false;
  }

  async function fetchPlaylistText(url) {
    try {
      const direct = await fetch(url, { credentials: "omit", redirect: "follow" });
      if (!direct.ok) {
        throw new Error(`Request failed with status ${direct.status}`);
      }
      return await direct.text();
    } catch {
      const proxy = await fetch(`/api/player/playlist?url=${encodeURIComponent(url)}`, { credentials: "omit" });
      if (!proxy.ok) {
        let message = `Request failed with status ${proxy.status}`;
        try {
          const body = await proxy.json();
          message = body.error || message;
        } catch {
        }
        throw new Error(message);
      }
      return await proxy.text();
    }
  }

  async function loadPlaylistUrl(urlOverride) {
    const raw = String(urlOverride || elements.url.value || "").trim();
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      notify("Enter a valid M3U or M3U8 URL", true);
      return;
    }
    if (!new Set(["http:", "https:"]).has(parsed.protocol) || parsed.username || parsed.password) {
      notify("Use an HTTP or HTTPS URL without embedded credentials", true);
      return;
    }
    state.sourceUrl = parsed.toString();
    elements.url.value = state.sourceUrl;
    elements.load.disabled = true;
    setStatus("Loading", "warning");
    elements.message.textContent = "Loading playlist";
    try {
      const text = await fetchPlaylistText(state.sourceUrl);
      if (/^\s*#EXTM3U[\s\S]*#EXT-X-/i.test(text) || /\.m3u8(?:$|[?#])/i.test(parsed.pathname)) {
        populate([{ name: parsed.hostname, group: "HLS", location: state.sourceUrl }]);
        await playUrl(state.sourceUrl, parsed.hostname);
        return;
      }
      const analysis = NavuryxM3U.analyze(text);
      const entries = analysis.entries.map((entry) => ({
        name: entry.name,
        group: entry.group,
        location: resolveLocation(entry.location, state.sourceUrl)
      }));
      populate(entries);
      setStatus(entries.length ? "Playlist loaded" : "No channels", entries.length ? "good" : "warning");
      elements.message.textContent = entries.length ? `${entries.length} channel${entries.length === 1 ? "" : "s"} available` : "No playable entries were found.";
      if (entries.length === 1) {
        await playUrl(entries[0].location, entries[0].name);
      }
    } catch (error) {
      populate([]);
      setStatus("Load failed", "warning");
      elements.message.textContent = `${error.message || "The playlist could not be loaded"}. The source may block browser access.`;
      notify(elements.message.textContent, true);
    } finally {
      elements.load.disabled = false;
    }
  }

  elements.load.addEventListener("click", () => void loadPlaylistUrl());
  elements.url.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void loadPlaylistUrl();
    }
  });
  elements.play.addEventListener("click", () => {
    const entry = state.entries[Number(elements.channel.value)];
    if (entry) {
      void playUrl(entry.location, entry.name);
    }
  });
  elements.channel.addEventListener("change", () => {
    const entry = state.entries[Number(elements.channel.value)];
    elements.message.textContent = entry ? entry.location : "Select a channel.";
  });
  elements.stop.addEventListener("click", stopPlayback);
  elements.masterButton.addEventListener("click", () => {
    if (!elements.masterUrl.value.trim()) {
      notify("The master playlist URL is not available", true);
      return;
    }
    const url = new URL("/playlist.m3u", window.location.origin).toString();
    document.getElementById("player").scrollIntoView({ behavior: "smooth", block: "start" });
    void loadPlaylistUrl(url);
  });
  window.addEventListener("navuryx:play", (event) => {
    const detail = event.detail || {};
    document.getElementById("player").scrollIntoView({ behavior: "smooth", block: "start" });
    elements.url.value = detail.url || "";
    populate([{ name: detail.name || "Channel", group: detail.group || "", location: detail.url || "" }]);
    void playUrl(detail.url, detail.name);
  });
  elements.video.addEventListener("playing", () => setStatus("Playing", "good"));
  elements.video.addEventListener("waiting", () => setStatus("Buffering", "warning"));
  elements.video.addEventListener("ended", () => setStatus("Ended", ""));
}());
