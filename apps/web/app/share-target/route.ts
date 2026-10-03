import { NextResponse, type NextRequest } from "next/server";

// The share sheet posts here only when the service worker didn't catch it (first open after installing, or an
// old worker). Nothing can be kept from the post, so the share page asks to share again.
export function POST(req: NextRequest) {
  return NextResponse.redirect(new URL("/share?failed=1", req.url), 303);
}

export function GET(req: NextRequest) {
  return NextResponse.redirect(new URL("/share", req.url), 303);
}
