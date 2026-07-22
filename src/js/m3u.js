(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.NavuryxM3U = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const supportedSchemes = new Set(["http:", "https:", "udp:", "rtp:", "rtsp:", "mms:", "file:"]);

  function normalizeText(text) {
    return String(text || "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  }

  function isHeader(line) {
    return /^#EXTM3U(?:\s|$)/i.test(line.trim());
  }

  function isExtinf(line) {
    return /^#EXTINF:/i.test(line.trim());
  }

  function normalizeHeaderLine(line) {
    const trimmed = String(line || "").trim();
    return trimmed ? `#EXTM3U${trimmed.slice(7)}` : "#EXTM3U";
  }

  function isMediaLocation(line) {
    const value = line.trim();
    return value.length > 0 && !value.startsWith("#");
  }

  function locationKey(location) {
    return location.trim();
  }

  function isHlsPlaylist(text) {
    return normalizeText(text).split("\n").some((line) => line.trim().toUpperCase().startsWith("#EXT-X-"));
  }

  function parseAttributes(metadata) {
    const attributes = {};
    const pattern = /([\w-]+)="([^"]*)"/g;
    let match = pattern.exec(metadata);
    while (match) {
      attributes[match[1].toLowerCase()] = match[2];
      match = pattern.exec(metadata);
    }
    return attributes;
  }

  function parseExtinf(line) {
    const trimmed = line.trim();
    const body = trimmed.slice(trimmed.indexOf(":") + 1);
    const commaIndex = body.indexOf(",");
    const metadata = commaIndex >= 0 ? body.slice(0, commaIndex).trim() : body.trim();
    const name = commaIndex >= 0 ? body.slice(commaIndex + 1).trim() : "";
    const durationMatch = metadata.match(/^([^\s]+)/);
    const duration = durationMatch ? durationMatch[1] : "-1";
    return {
      line: trimmed,
      duration,
      metadata,
      name,
      attributes: parseAttributes(metadata),
      hasComma: commaIndex >= 0,
      hasBalancedQuotes: (metadata.match(/"/g) || []).length % 2 === 0
    };
  }

  function deriveName(location, index) {
    const fallback = `Channel ${index}`;
    const value = String(location || "").trim();
    if (!value) {
      return fallback;
    }
    try {
      const url = new URL(value);
      const lastPart = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() || "");
      const cleanPart = lastPart.replace(/\.(m3u8?|mpd|ts|mp4|aac|mp3)$/i, "").replace(/[-_]+/g, " ").trim();
      return cleanPart || url.hostname || fallback;
    } catch {
      const lastPart = value.split(/[\\/]/).filter(Boolean).pop() || "";
      const cleanPart = lastPart.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim();
      return cleanPart || fallback;
    }
  }

  function validateLocation(location) {
    const value = location.trim();
    if (/^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("/") || value.startsWith("./") || value.startsWith("../")) {
      return { valid: true, local: true };
    }
    try {
      const url = new URL(value);
      return { valid: supportedSchemes.has(url.protocol), local: url.protocol === "file:", protocol: url.protocol };
    } catch {
      return { valid: false, local: false };
    }
  }

  function collectBlocks(text) {
    const lines = normalizeText(text).split("\n");
    const blocks = [];
    const globalDirectives = [];
    let pending = [];
    let headerPresent = false;
    let headerLine = "";
    let headerCount = 0;

    for (let index = 0; index < lines.length; index += 1) {
      const original = lines[index];
      const line = original.trim();
      if (!line) {
        pending.push({ value: original, lineNumber: index + 1, kind: "blank" });
        continue;
      }
      if (isHeader(line)) {
        headerPresent = true;
        headerCount += 1;
        if (!headerLine) {
          headerLine = original;
        }
        continue;
      }
      if (isMediaLocation(line)) {
        blocks.push({ directives: pending, location: original, lineNumber: index + 1 });
        pending = [];
        continue;
      }
      if (line.startsWith("#")) {
        pending.push({ value: original, lineNumber: index + 1, kind: isExtinf(line) ? "extinf" : "directive" });
      }
    }

    if (pending.length) {
      globalDirectives.push(...pending);
    }

    return { lines, blocks, globalDirectives, headerPresent, headerLine, headerCount };
  }

  function analyze(text) {
    const normalized = normalizeText(text);
    const collected = collectBlocks(normalized);
    const hls = isHlsPlaylist(normalized);
    const issues = [];
    const entries = [];
    const seen = new Map();
    const groups = new Set();

    if (!normalized.trim()) {
      return { entries, issues: [{ type: "empty", title: "Playlist is empty", detail: "Add or import playlist content before continuing.", line: 0 }], duplicates: 0, groups: 0, headerPresent: false };
    }

    if (!collected.headerPresent) {
      issues.push({ type: "header", title: "Missing #EXTM3U header", detail: "The playlist should begin with a single #EXTM3U header.", line: 1 });
    } else if (collected.headerCount > 1) {
      issues.push({ type: "header", title: "Multiple #EXTM3U headers", detail: "Only the first playlist header should be kept.", line: 1 });
    }

    let duplicates = 0;

    collected.blocks.forEach((block, index) => {
      const location = block.location.trim();
      const extinfRecords = block.directives.filter((item) => item.kind === "extinf");
      const extinfRecord = extinfRecords.length ? extinfRecords[extinfRecords.length - 1] : null;
      const extinf = extinfRecord ? parseExtinf(extinfRecord.value) : null;
      const name = extinf && extinf.name ? extinf.name : deriveName(location, index + 1);
      const group = extinf ? extinf.attributes["group-title"] || "" : "";
      const validation = validateLocation(location);
      const key = locationKey(location);

      if (!hls && !extinfRecord) {
        issues.push({ type: "metadata", title: "Missing #EXTINF metadata", detail: `A metadata line is missing before “${name}”.`, line: block.lineNumber });
      } else if (extinfRecord && !hls) {
        if (!extinf.hasComma) {
          issues.push({ type: "metadata", title: "Malformed #EXTINF line", detail: "The metadata line is missing the comma before the display name.", line: extinfRecord.lineNumber });
        }
        if (!extinf.name) {
          issues.push({ type: "metadata", title: "Missing entry name", detail: `The metadata line before “${name}” has no display name.`, line: extinfRecord.lineNumber });
        }
        if (!extinf.hasBalancedQuotes) {
          issues.push({ type: "metadata", title: "Unbalanced metadata quotes", detail: "One or more #EXTINF attribute values have an unmatched quote.", line: extinfRecord.lineNumber });
        }
        if (extinfRecords.length > 1) {
          issues.push({ type: "metadata", title: "Multiple #EXTINF records", detail: "More than one metadata line appears before a single media location.", line: extinfRecord.lineNumber });
        }
      }

      if (!validation.valid && !hls) {
        issues.push({ type: "location", title: "Unrecognized media location", detail: `The location for “${name}” is not a supported URL or local path.`, line: block.lineNumber });
      }

      if (seen.has(key)) {
        if (!hls) {
          duplicates += 1;
          issues.push({ type: "duplicate", title: "Duplicate media location", detail: `This location already appears on line ${seen.get(key)}.`, line: block.lineNumber });
        }
      } else {
        seen.set(key, block.lineNumber);
      }

      if (group) {
        groups.add(group);
      }

      entries.push({ name, group: group || "Ungrouped", location, line: block.lineNumber, duplicate: hls ? false : seen.get(key) !== block.lineNumber });
    });

    const trailingSignificant = collected.globalDirectives.filter((item) => item.kind !== "blank");
    if (trailingSignificant.length && !hls) {
      issues.push({ type: "orphan", title: "Orphaned directives", detail: "Directive lines at the end are not followed by a media location.", line: trailingSignificant[0].lineNumber });
    }

    if (!collected.blocks.length) {
      issues.push({ type: "entries", title: "No media entries found", detail: "The playlist does not contain any media locations.", line: 0 });
    }

    return { entries, issues, duplicates, groups: groups.size, headerPresent: collected.headerPresent, format: hls ? "hls" : "m3u" };
  }

  function sanitizeDuration(duration) {
    return /^-?\d+(?:\.\d+)?$/.test(duration) ? duration : "-1";
  }

  function repairExtinf(line, location, index) {
    const parsed = parseExtinf(line);
    const duration = sanitizeDuration(parsed.duration);
    let metadata = parsed.metadata;
    if (metadata.startsWith(parsed.duration)) {
      metadata = metadata.slice(parsed.duration.length).trim();
    }
    const attributes = metadata.match(/[\w-]+="[^"]*"/g) || [];
    const attributeText = attributes.length ? ` ${attributes.join(" ")}` : "";
    const name = parsed.name || deriveName(location, index);
    return `#EXTINF:${duration}${attributeText},${name}`;
  }

  function correct(text, options) {
    const settings = Object.assign({
      ensureHeader: true,
      repairMetadata: true,
      addMissingMetadata: true,
      removeDuplicates: true,
      removeEmptyLines: true,
      trimLines: true
    }, options || {});
    const normalized = normalizeText(text);
    const collected = collectBlocks(normalized);
    const output = [];
    const seen = new Set();

    if (isHlsPlaylist(normalized)) {
      if (settings.ensureHeader || collected.headerPresent) {
        output.push(normalizeHeaderLine(collected.headerLine));
      }
      normalized.split("\n").forEach((original) => {
        const value = settings.trimLines ? original.trim() : original;
        if (isHeader(value)) {
          return;
        }
        if (!settings.removeEmptyLines || value) {
          output.push(value);
        }
      });
      const cleaned = settings.removeEmptyLines ? output.filter((line) => line.trim()) : output;
      return { text: `${cleaned.join("\n").replace(/\n+$/g, "")}\n`, removedDuplicates: 0, repairedEntries: 0, format: "hls" };
    }
    let removedDuplicates = 0;
    let repairedEntries = 0;

    if (settings.ensureHeader || collected.headerPresent) {
      output.push(normalizeHeaderLine(collected.headerLine));
    }

    collected.blocks.forEach((block, index) => {
      const location = settings.trimLines ? block.location.trim() : block.location;
      const key = locationKey(location);
      if (settings.removeDuplicates && seen.has(key)) {
        removedDuplicates += 1;
        return;
      }
      seen.add(key);

      const meaningful = block.directives.filter((item) => !(settings.removeEmptyLines && item.kind === "blank"));
      const extinfIndex = meaningful.map((item) => item.kind).lastIndexOf("extinf");
      const directives = meaningful.filter((item, itemIndex) => item.kind !== "extinf" || itemIndex === extinfIndex);

      if (extinfIndex < 0 && settings.addMissingMetadata) {
        output.push(`#EXTINF:-1,${deriveName(location, index + 1)}`);
        repairedEntries += 1;
      }

      directives.forEach((item) => {
        let value = settings.trimLines ? item.value.trim() : item.value;
        if (item.kind === "extinf" && settings.repairMetadata) {
          value = repairExtinf(value, location, index + 1);
          repairedEntries += 1;
        }
        if (!settings.removeEmptyLines || value.trim()) {
          output.push(value);
        }
      });

      output.push(location);
    });

    collected.globalDirectives.forEach((item) => {
      const value = settings.trimLines ? item.value.trim() : item.value;
      if (!settings.removeEmptyLines || value) {
        output.push(value);
      }
    });

    const cleaned = settings.removeEmptyLines ? output.filter((line) => line.trim()) : output;
    return {
      text: `${cleaned.join("\n").replace(/\n+$/g, "")}\n`,
      removedDuplicates,
      repairedEntries,
      format: "m3u"
    };
  }

  return { analyze, correct, normalizeText, parseExtinf, deriveName, validateLocation };
});
