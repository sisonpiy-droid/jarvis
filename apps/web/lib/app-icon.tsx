import { ImageResponse } from "next/og";

// The JARVIS app icon, drawn at request time (no binary assets in the repo). `inset` keeps the mark inside the
// safe zone for maskable icons, which Android crops to a circle or squircle.
export function appIcon(size: number, opts: { inset?: boolean; rounded?: boolean } = {}) {
  const mark = Math.round(size * (opts.inset ? 0.46 : 0.62));
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "linear-gradient(145deg, #2f5bd3 0%, #1a2f73 100%)",
          borderRadius: opts.rounded ? Math.round(size * 0.22) : 0,
        }}
      >
        <div style={{ fontSize: mark, fontWeight: 700, color: "#ffffff", lineHeight: 1, display: "flex" }}>J</div>
      </div>
    ),
    { width: size, height: size },
  );
}
