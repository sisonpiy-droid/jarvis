// Observed during discovery on 2026-09-28 (see docs/MESA_INTEGRATION.md).
// The web app is a Next.js frontend; its own /api/auth/* routes hold the
// session cookie, and data comes from a separate REST API with a Bearer JWT.

export const MESA_WEB_ORIGIN = "https://students.mesaschool.co.in";
export const MESA_API_BASE = "https://api-students.mesaschool.co.in/api/v1";
export const MESA_LOGIN_URL = `${MESA_WEB_ORIGIN}/login`;
export const MESA_REFRESH_URL = `${MESA_WEB_ORIGIN}/api/auth/refresh`;
export const MESA_TIMEZONE = "Asia/Kolkata";

export const assignmentUrl = (id: string) => `${MESA_WEB_ORIGIN}/student/lms/assignments/${id}`;
export const courseUrl = (id: string) => `${MESA_WEB_ORIGIN}/student/lms/courses/${id}`;
