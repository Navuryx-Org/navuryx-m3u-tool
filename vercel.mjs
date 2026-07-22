const origin = String(process.env.NAVURYX_STREAM_ORIGIN || "").trim().replace(/\/$/, "");
const rewrites = origin ? [
  { source: "/playlist.m3u", destination: `${origin}/playlist.m3u` },
  { source: "/:channel/index.m3u8", destination: `${origin}/:channel/index.m3u8` },
  { source: "/:channel/:segment.ts", destination: `${origin}/:channel/:segment.ts` },
  { source: "/:channel/:segment.m4s", destination: `${origin}/:channel/:segment.m4s` },
  { source: "/:channel/:segment.mp4", destination: `${origin}/:channel/:segment.mp4` },
  { source: "/api/status", destination: "/api/bridge?path=status" },
  { source: "/api/channels", destination: "/api/bridge?path=channels" },
  { source: "/api/channels/:path*", destination: "/api/bridge?path=channels/:path*" }
] : [];

export const config = {
  buildCommand: "npm run build",
  outputDirectory: "dist",
  rewrites,
  headers: [
    {
      source: "/playlist.m3u",
      headers: [{ key: "Cache-Control", value: "no-store" }]
    },
    {
      source: "/:channel/index.m3u8",
      headers: [{ key: "Cache-Control", value: "no-store" }]
    }
  ]
};
