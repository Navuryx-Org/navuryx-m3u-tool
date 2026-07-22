const { Readable } = require("stream");

function cleanOrigin(value) {
  const text = String(value || "").trim().replace(/\/$/, "");
  if (!text) {
    return "";
  }
  const parsed = new URL(text);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error("NAVURYX_STREAM_ORIGIN must use HTTP or HTTPS");
  }
  return parsed.toString().replace(/\/$/, "");
}

function cleanPath(value) {
  const text = Array.isArray(value) ? value.join("/") : String(value || "");
  const decoded = decodeURIComponent(text).replace(/^\/+/, "");
  if (!decoded || decoded.includes("..") || decoded.includes("\\") || decoded.includes("\0")) {
    throw new Error("Invalid proxy path");
  }
  return decoded;
}

module.exports = async function bridge(request, response) {
  try {
    const origin = cleanOrigin(process.env.NAVURYX_STREAM_ORIGIN);
    if (!origin) {
      response.status(503).json({ error: "NAVURYX_STREAM_ORIGIN is not configured" });
      return;
    }
    const targetPath = cleanPath(request.query.path);
    const target = new URL(`${origin}/${targetPath}`);
    for (const [key, value] of Object.entries(request.query)) {
      if (key === "path") {
        continue;
      }
      for (const item of Array.isArray(value) ? value : [value]) {
        target.searchParams.append(key, String(item));
      }
    }
    const headers = new Headers();
    for (const name of ["accept", "content-type", "x-file-name"]) {
      const value = request.headers[name];
      if (value) {
        headers.set(name, String(value));
      }
    }
    const method = String(request.method || "GET").toUpperCase();
    const options = { method, headers, redirect: "manual" };
    if (!['GET', 'HEAD'].includes(method)) {
      options.body = request;
      options.duplex = "half";
    }
    const upstream = await fetch(target, options);
    response.statusCode = upstream.status;
    for (const name of ["content-type", "cache-control", "etag", "last-modified"]) {
      const value = upstream.headers.get(name);
      if (value) {
        response.setHeader(name, value);
      }
    }
    if (!upstream.body || method === "HEAD") {
      response.end();
      return;
    }
    Readable.fromWeb(upstream.body).pipe(response);
  } catch (error) {
    response.status(502).json({ error: error.message || "The stream server could not be reached" });
  }
};

module.exports.config = {
  api: {
    bodyParser: false,
    responseLimit: false
  }
};
