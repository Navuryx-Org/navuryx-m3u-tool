(function () {
  const MAX_FILE_SIZE = 10 * 1024 * 1024;
  const FETCH_TIMEOUT = 15000;
  const state = {
    fileName: "playlist.m3u",
    sourceText: "",
    correctedText: "",
    analysis: null,
    toastTimer: null
  };

  const elements = {
    tabs: [
      { button: document.getElementById("fileTab"), panel: document.getElementById("filePanel") },
      { button: document.getElementById("urlTab"), panel: document.getElementById("urlPanel") },
      { button: document.getElementById("pasteTab"), panel: document.getElementById("pastePanel") }
    ],
    fileInput: document.getElementById("fileInput"),
    dropZone: document.getElementById("dropZone"),
    playlistInput: document.getElementById("playlistInput"),
    playlistOutput: document.getElementById("playlistOutput"),
    urlForm: document.getElementById("urlForm"),
    urlInput: document.getElementById("urlInput"),
    fetchButton: document.getElementById("fetchButton"),
    fileSummary: document.getElementById("fileSummary"),
    fileName: document.getElementById("fileName"),
    fileSize: document.getElementById("fileSize"),
    removeFileButton: document.getElementById("removeFileButton"),
    sampleButton: document.getElementById("sampleButton"),
    clearButton: document.getElementById("clearButton"),
    analyzeButton: document.getElementById("analyzeButton"),
    repairButton: document.getElementById("repairButton"),
    downloadButton: document.getElementById("downloadButton"),
    downloadFileLabel: document.getElementById("downloadFileLabel"),
    copyButton: document.getElementById("copyButton"),
    outputSection: document.getElementById("outputSection"),
    resultState: document.getElementById("resultState"),
    entryCount: document.getElementById("entryCount"),
    issueCount: document.getElementById("issueCount"),
    duplicateCount: document.getElementById("duplicateCount"),
    groupCount: document.getElementById("groupCount"),
    issueBadge: document.getElementById("issueBadge"),
    issuesEmpty: document.getElementById("issuesEmpty"),
    issueList: document.getElementById("issueList"),
    previewEmpty: document.getElementById("previewEmpty"),
    previewTableWrap: document.getElementById("previewTableWrap"),
    previewBody: document.getElementById("previewBody"),
    entrySearch: document.getElementById("entrySearch"),
    toast: document.getElementById("toast"),
    optionInputs: {
      ensureHeader: document.getElementById("ensureHeader"),
      repairMetadata: document.getElementById("repairMetadata"),
      addMissingMetadata: document.getElementById("addMissingMetadata"),
      removeDuplicates: document.getElementById("removeDuplicates"),
      removeEmptyLines: document.getElementById("removeEmptyLines"),
      trimLines: document.getElementById("trimLines")
    }
  };

  async function analyzeSource(text) {
    return NavuryxM3U.analyze(text);
  }

  async function correctSource(text, options) {
    return NavuryxM3U.correct(text, options);
  }

  function showToast(message, isError) {
    window.clearTimeout(state.toastTimer);
    elements.toast.textContent = message;
    elements.toast.classList.toggle("error", Boolean(isError));
    elements.toast.classList.add("visible");
    state.toastTimer = window.setTimeout(() => elements.toast.classList.remove("visible"), 3200);
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) {
      return "0 KB";
    }
    const units = ["B", "KB", "MB"];
    const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / 1024 ** unitIndex).toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
  }

  function safeFileName(name) {
    const base = String(name || "playlist.m3u").replace(/\.(m3u8?|txt)$/i, "");
    const safe = base.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    return `${safe || "playlist"}-corrected.m3u`;
  }

  function switchTab(selectedButton) {
    elements.tabs.forEach(({ button, panel }) => {
      const selected = button === selectedButton;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-selected", String(selected));
      panel.hidden = !selected;
    });
  }

  function setSource(text, name, size) {
    state.sourceText = NavuryxM3U.normalizeText(text);
    state.fileName = name || "playlist.m3u";
    state.correctedText = "";
    elements.playlistInput.value = state.sourceText;
    elements.playlistOutput.value = "";
    elements.downloadButton.disabled = true;
    elements.outputSection.hidden = true;
    elements.fileName.textContent = state.fileName;
    elements.downloadFileLabel.textContent = safeFileName(state.fileName);
    elements.fileSize.textContent = formatBytes(size || new Blob([state.sourceText]).size);
    elements.fileSummary.hidden = false;
    void runAnalysis(false);
  }

  function clearAll() {
    state.fileName = "playlist.m3u";
    state.sourceText = "";
    state.correctedText = "";
    state.analysis = null;
    elements.fileInput.value = "";
    elements.playlistInput.value = "";
    elements.playlistOutput.value = "";
    elements.urlInput.value = "";
    elements.fileSummary.hidden = true;
    elements.outputSection.hidden = true;
    elements.downloadButton.disabled = true;
    elements.downloadFileLabel.textContent = "playlist.m3u";
    renderAnalysis(null);
    showToast("Workspace cleared");
  }

  async function readFile(file) {
    if (!file) {
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      showToast("The selected file is larger than 10 MB", true);
      return;
    }
    if (!/\.(m3u8?)$/i.test(file.name)) {
      showToast("Choose a file ending in .m3u or .m3u8", true);
      return;
    }
    try {
      const text = await file.text();
      setSource(text, file.name, file.size);
      showToast("Playlist loaded");
    } catch {
      showToast("The file could not be read", true);
    }
  }

  function getCurrentSource() {
    const activePaste = !document.getElementById("pastePanel").hidden;
    if (activePaste) {
      state.sourceText = elements.playlistInput.value;
    }
    return state.sourceText || elements.playlistInput.value;
  }

  function getOptions() {
    return Object.fromEntries(Object.entries(elements.optionInputs).map(([key, input]) => [key, input.checked]));
  }

  async function runAnalysis(showMessage) {
    const source = getCurrentSource();
    try {
      state.analysis = await analyzeSource(source);
      renderAnalysis(state.analysis);
      if (showMessage) {
        showToast(state.analysis.issues.length ? `${state.analysis.issues.length} issue${state.analysis.issues.length === 1 ? "" : "s"} found` : "No issues found");
      }
    } catch (error) {
      showToast(error.message || String(error) || "The playlist could not be analyzed", true);
    }
  }

  function renderAnalysis(analysis) {
    const hasAnalysis = Boolean(analysis);
    const entries = hasAnalysis ? analysis.entries : [];
    const issues = hasAnalysis ? analysis.issues : [];
    elements.entryCount.textContent = String(entries.length);
    elements.issueCount.textContent = String(issues.length);
    elements.duplicateCount.textContent = String(hasAnalysis ? analysis.duplicates : 0);
    elements.groupCount.textContent = String(hasAnalysis ? analysis.groups : 0);
    elements.issueBadge.textContent = `${issues.length} found`;
    elements.resultState.textContent = !hasAnalysis ? "No playlist loaded" : issues.length ? "Needs attention" : "Ready to download";
    elements.resultState.classList.toggle("warning", hasAnalysis && issues.length > 0);
    elements.resultState.classList.toggle("good", hasAnalysis && issues.length === 0);
    elements.issuesEmpty.textContent = hasAnalysis ? "No issues found in this playlist." : "Analyze a playlist to see validation results.";
    elements.issuesEmpty.hidden = hasAnalysis && issues.length > 0;
    elements.issueList.hidden = !hasAnalysis || issues.length === 0;
    elements.issueList.replaceChildren(...issues.map(createIssueItem));
    elements.entrySearch.disabled = entries.length === 0;
    renderEntries(entries);
  }

  function createIssueItem(issue) {
    const item = document.createElement("li");
    item.className = "issue-item";
    const symbol = document.createElement("span");
    symbol.className = "issue-symbol";
    symbol.textContent = "!";
    const content = document.createElement("span");
    const title = document.createElement("strong");
    const detail = document.createElement("small");
    title.textContent = issue.line ? `${issue.title} · line ${issue.line}` : issue.title;
    detail.textContent = issue.detail;
    content.append(title, detail);
    item.append(symbol, content);
    return item;
  }

  function renderEntries(entries) {
    const query = elements.entrySearch.value.trim().toLowerCase();
    const filtered = entries.filter((entry) => `${entry.name} ${entry.group} ${entry.location}`.toLowerCase().includes(query));
    elements.previewEmpty.hidden = entries.length > 0;
    elements.previewTableWrap.hidden = entries.length === 0;
    elements.previewBody.replaceChildren(...filtered.slice(0, 250).map(createEntryRow));
    if (entries.length > 0 && filtered.length === 0) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 3;
      cell.textContent = "No entries match this search.";
      row.append(cell);
      elements.previewBody.append(row);
    }
  }

  function createEntryRow(entry) {
    const row = document.createElement("tr");
    [entry.name, entry.group, entry.location].forEach((value) => {
      const cell = document.createElement("td");
      cell.textContent = value;
      cell.title = value;
      row.append(cell);
    });
    return row;
  }

  async function repairPlaylist() {
    const source = getCurrentSource();
    if (!source.trim()) {
      showToast("Add a playlist before correcting it", true);
      return;
    }
    elements.repairButton.disabled = true;
    try {
      const result = await correctSource(source, getOptions());
      state.correctedText = result.text;
      elements.playlistOutput.value = result.text;
      elements.outputSection.hidden = false;
      elements.downloadButton.disabled = false;
      state.analysis = await analyzeSource(result.text);
      renderAnalysis(state.analysis);
      elements.outputSection.scrollIntoView({ behavior: "smooth", block: "start" });
      const actions = [];
      if (result.repairedEntries) {
        actions.push(`${result.repairedEntries} metadata record${result.repairedEntries === 1 ? "" : "s"} normalized`);
      }
      if (result.removedDuplicates) {
        actions.push(`${result.removedDuplicates} duplicate${result.removedDuplicates === 1 ? "" : "s"} removed`);
      }
      showToast(result.format === "hls" ? "HLS manifest normalized without changing its stream directives" : actions.length ? actions.join("; ") : "Playlist normalized");
    } catch (error) {
      showToast(error.message || String(error) || "The playlist could not be corrected", true);
    } finally {
      elements.repairButton.disabled = false;
    }
  }

  async function downloadCorrected() {
    const text = elements.playlistOutput.value || state.correctedText;
    if (!text.trim()) {
      showToast("Correct the playlist before downloading", true);
      return;
    }
    const blob = new Blob([text], { type: "audio/x-mpegurl;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = safeFileName(state.fileName);
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    showToast("Corrected playlist downloaded");
  }

  async function copyOutput() {
    const text = elements.playlistOutput.value;
    if (!text) {
      showToast("There is no corrected output to copy", true);
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      showToast("Corrected playlist copied");
    } catch {
      elements.playlistOutput.select();
      document.execCommand("copy");
      showToast("Corrected playlist copied");
    }
  }

  async function importFromUrl(event) {
    event.preventDefault();
    let parsed;
    try {
      parsed = new URL(elements.urlInput.value.trim());
    } catch {
      showToast("Enter a valid playlist URL", true);
      return;
    }
    if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
      showToast("Only HTTP and HTTPS URLs can be imported", true);
      return;
    }
    if (parsed.username || parsed.password) {
      showToast("URLs containing embedded usernames or passwords are not accepted", true);
      return;
    }
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    elements.fetchButton.disabled = true;
    elements.fetchButton.textContent = "Importing";
    try {
      const response = await fetch(parsed.toString(), { signal: controller.signal, credentials: "omit", redirect: "follow" });
      if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`);
      }
      const length = Number(response.headers.get("content-length") || 0);
      if (length > MAX_FILE_SIZE) {
        throw new Error("The remote playlist is larger than 10 MB");
      }
      const text = await response.text();
      if (new Blob([text]).size > MAX_FILE_SIZE) {
        throw new Error("The remote playlist is larger than 10 MB");
      }
      const pathName = parsed.pathname.split("/").filter(Boolean).pop() || "remote-playlist.m3u";
      setSource(text, /\.m3u8?$/i.test(pathName) ? pathName : `${pathName}.m3u`);
      showToast("Remote playlist imported");
    } catch (error) {
      const message = error.name === "AbortError" ? "The remote request timed out" : error.message || String(error) || "The remote playlist could not be imported";
      showToast(`${message}. The source may block browser access.`, true);
    } finally {
      window.clearTimeout(timeout);
      elements.fetchButton.disabled = false;
      elements.fetchButton.textContent = "Import";
    }
  }

  function loadSample() {
    const sample = `#EXTM3U\n#EXTINF:-1 tvg-id="news.one" group-title="News",News One\nhttps://example.com/live/news-one.m3u8\n#EXTINF:-1 group-title="Sports",Sports Central\nhttps://example.com/live/sports.m3u8\nhttps://example.com/live/film-room.m3u8\n#EXTINF:-1 group-title="News",News One duplicate\nhttps://example.com/live/news-one.m3u8\n`;
    setSource(sample, "navuryx-sample.m3u");
    switchTab(document.getElementById("pasteTab"));
    showToast("Sample playlist loaded");
  }

  function bindEvents() {
    elements.tabs.forEach(({ button }) => button.addEventListener("click", () => switchTab(button)));
    elements.dropZone.addEventListener("click", () => elements.fileInput.click());
    elements.fileInput.addEventListener("change", () => readFile(elements.fileInput.files[0]));
    ["dragenter", "dragover"].forEach((eventName) => elements.dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      elements.dropZone.classList.add("dragging");
    }));
    ["dragleave", "drop"].forEach((eventName) => elements.dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      elements.dropZone.classList.remove("dragging");
    }));
    elements.dropZone.addEventListener("drop", (event) => readFile(event.dataTransfer.files[0]));
    elements.urlForm.addEventListener("submit", importFromUrl);
    elements.playlistInput.addEventListener("input", () => {
      state.sourceText = elements.playlistInput.value;
      state.correctedText = "";
      elements.downloadButton.disabled = true;
    });
    elements.playlistOutput.addEventListener("input", () => {
      state.correctedText = elements.playlistOutput.value;
      elements.downloadButton.disabled = !state.correctedText.trim();
    });
    elements.removeFileButton.addEventListener("click", clearAll);
    elements.sampleButton.addEventListener("click", loadSample);
    elements.clearButton.addEventListener("click", clearAll);
    elements.analyzeButton.addEventListener("click", () => void runAnalysis(true));
    elements.repairButton.addEventListener("click", () => void repairPlaylist());
    elements.downloadButton.addEventListener("click", () => void downloadCorrected());
    elements.copyButton.addEventListener("click", copyOutput);
    elements.entrySearch.addEventListener("input", () => renderEntries(state.analysis ? state.analysis.entries : []));
  }


  bindEvents();
  renderAnalysis(null);
})();
