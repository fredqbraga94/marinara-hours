import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}


function pinLockedResponse(retryAfterSeconds: number) {
  const retryMinutes = Math.max(
    1,
    Math.ceil(retryAfterSeconds / 60)
  );

  return json(
    {
      error:
        `Too many incorrect PIN attempts. Try again in ${retryMinutes} minute${retryMinutes === 1 ? "" : "s"}.`,
      code: "PIN_TEMPORARILY_LOCKED",
      retry_after_seconds: retryAfterSeconds,
    },
    429
  );
}


const SESSION_HOURS = 12;

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes)
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(value: string) {
  const encoded =
    new TextEncoder().encode(value);

  const digest =
    await crypto.subtle.digest(
      "SHA-256",
      encoded
    );

  return bytesToHex(
    new Uint8Array(digest)
  );
}

function createSessionToken() {
  const bytes =
    crypto.getRandomValues(
      new Uint8Array(32)
    );

  return bytesToHex(bytes);
}

async function validateStaffSession(
  supabase: any,
  token: string,
  deviceHash: string | null = null
) {
  if (!token) {
    return { ok: false, error: "Session token is required" };
  }

  const tokenHash = await sha256Hex(token);

  // One database call: session, staff and device checks (see auth_session).
  const { data, error } = await supabase.rpc("auth_session", {
    p_token_hash: tokenHash,
    p_device_hash: deviceHash,
  });

  if (error) throw error;
  if (!data?.ok) {
    return { ok: false, error: data?.error || "Invalid or expired session" };
  }

  return {
    ok: true,
    staff: data.staff,
    expires_at: data.expires_at,
  };
}

function calculateHours(shift: any) {
  if (!shift?.clock_in) return 0;

  const start = new Date(shift.clock_in).getTime();
  const end = shift.clock_out
    ? new Date(shift.clock_out).getTime()
    : Date.now();

  let breakMs = 0;

  for (const b of shift.breaks || []) {
    if (!b.break_start) continue;

    const breakStart = new Date(b.break_start).getTime();
    const breakEnd = b.break_end
      ? new Date(b.break_end).getTime()
      : Date.now();

    breakMs += Math.max(0, breakEnd - breakStart);
  }

  return Math.max(
    0,
    (end - start - breakMs) / 3600000
  );
}

function getBrisbaneWeekRange(requestedDate?: string) {
  let year: number;
  let month: number;
  let dayOfMonth: number;

  if (requestedDate) {
    const match =
      /^(\d{4})-(\d{2})-(\d{2})$/.exec(
        requestedDate
      );

    if (!match) {
      throw new Error("INVALID_WEEK_DATE");
    }

    year = Number(match[1]);
    month = Number(match[2]) - 1;
    dayOfMonth = Number(match[3]);

    const check =
      new Date(
        Date.UTC(
          year,
          month,
          dayOfMonth
        )
      );

    if (
      check.getUTCFullYear() !== year ||
      check.getUTCMonth() !== month ||
      check.getUTCDate() !== dayOfMonth
    ) {
      throw new Error("INVALID_WEEK_DATE");
    }
  }

  else {
    const now = new Date();

    const brisbane =
      new Date(
        now.getTime() +
        10 * 60 * 60 * 1000
      );

    year =
      brisbane.getUTCFullYear();

    month =
      brisbane.getUTCMonth();

    dayOfMonth =
      brisbane.getUTCDate();
  }

  const referenceBrisbane =
    new Date(
      Date.UTC(
        year,
        month,
        dayOfMonth,
        0,
        0,
        0,
        0
      )
    );

  const weekday =
    referenceBrisbane.getUTCDay();

  const daysFromMonday =
    (weekday + 6) % 7;

  const mondayBrisbane =
    new Date(
      Date.UTC(
        referenceBrisbane.getUTCFullYear(),
        referenceBrisbane.getUTCMonth(),
        referenceBrisbane.getUTCDate() -
          daysFromMonday,
        0,
        0,
        0,
        0
      )
    );

  const nextMondayBrisbane =
    new Date(
      mondayBrisbane.getTime() +
      7 * 24 * 60 * 60 * 1000
    );

  const offsetMs =
    10 * 60 * 60 * 1000;

  return {
    week_start:
      new Date(
        mondayBrisbane.getTime() -
        offsetMs
      ).toISOString(),

    week_end:
      new Date(
        nextMondayBrisbane.getTime() -
        offsetMs
      ).toISOString(),

    week_start_date:
      mondayBrisbane
        .toISOString()
        .slice(0, 10),
  };
}

function getBrisbaneWeekStart() {
  return getBrisbaneWeekRange().week_start;
}

// =========================
// AUTHORISED DEVICES AND ERRORS (v38)
// The app keeps a random secret per device (43 base64url characters) and
// sends it as body.device. Only its SHA-256 is sent to the database.
// IP addresses and other request headers are never used for security
// decisions and never logged. PINs, tokens and device secrets are never logged.
// =========================

async function deviceHashFrom(body: any): Promise<string | null> {
  const device = typeof body?.device === "string" ? body.device.trim() : "";
  if (!/^[A-Za-z0-9_-]{43}$/.test(device)) return null;
  return await sha256Hex(device);
}

const PAIRING_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function createPairingCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let code = "";
  for (const b of bytes) code += PAIRING_ALPHABET[b % PAIRING_ALPHABET.length];
  return code;
}

function normalisePairingCode(value: unknown) {
  return typeof value === "string"
    ? value.toUpperCase().replace(/[^A-Z0-9]/g, "")
    : "";
}

function authLog(event: string, fields: Record<string, string | number | boolean | null>) {
  try {
    const parts = Object.entries(fields).map(([k, v]) => `${k}=${v}`);
    console.log(`[auth] ${event} ${parts.join(" ")}`.trim());
  } catch (_) {
    // Logging is best-effort and must never break a request.
  }
}

function waitMinutes(seconds: number) {
  const minutes = Math.max(1, Math.ceil(Number(seconds || 0) / 60));
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

// Database error codes raised by the SQL functions -> stable code.
function dbErrorCode(error: any): string {
  const message = String(error?.message || "");
  if (/^[A-Z][A-Z_]+$/.test(message)) return message;
  if (error?.code === "23P01") return "OVERLAP";
  if (error?.code === "23505" && message.includes("breaks_one_open_per_shift")) return "BREAK_ALREADY_STARTED";
  if (error?.code === "23505" && message.includes("shifts_one_open_per_staff")) return "SHIFT_ALREADY_OPEN";
  return "";
}

const CLOCK_MESSAGES: Record<string, string> = {
  SHIFT_ALREADY_OPEN: "You are already clocked in.",
  NO_WORKING_SHIFT: "You can only start a break while you are clocked in and not on a break.",
  BREAK_ALREADY_STARTED: "Your break has already started.",
  NO_ACTIVE_BREAK: "You are not on a break.",
  END_BREAK_REQUIRED: "End your break before clocking out.",
  NO_OPEN_SHIFT: "You are not clocked in.",
  STAFF_NOT_FOUND: "Staff account is inactive or unavailable",
  OVERLAP: "This would overlap another shift.",
};

const MANAGER_MESSAGES: Record<string, [number, string]> = {
  SHIFT_NOT_FOUND: [404, "Shift not found"],
  STAFF_NOT_FOUND: [404, "Staff member not found"],
  DEPARTMENT_DENIED: [403, "Access denied for this department"],
  GM_REQUIRED: [403, "Only the General Manager can manage manager accounts"],
  MANAGER_REQUIRED: [403, "Manager access required"],
  SHIFT_APPROVED: [400, "Approved shifts cannot be changed. Reopen the shift first."],
  SHIFT_STILL_OPEN: [400, "Active shifts cannot be changed here"],
  SHIFT_OVERLAP: [409, "This shift overlaps another shift for the same person."],
  OVERLAP: [409, "This shift overlaps another shift for the same person."],
  INVALID_BREAK: [400, "Break must be shorter than the shift"],
  CLOCK_OUT_BEFORE_CLOCK_IN: [400, "Clock Out must be after Clock In"],
  PIN_IN_USE: [409, "This PIN is already used by another person. Choose a different PIN."],
  CANNOT_DEACTIVATE_SELF: [400, "You cannot deactivate your own manager account"],
  INVALID_ROLE: [400, "Invalid account role"],
  DEVICE_NOT_FOUND: [404, "Device not found"],
  ON_LEAVE: [409, "This person is on approved leave that day."],
  LEAVE_OVERLAP: [409, "There is already a request for some of these days."],
  LEAVE_NOT_FOUND: [404, "Request not found"],
  LEAVE_NOT_PENDING: [409, "This request was already decided."],
  LEAVE_IN_PAST: [400, "Choose a date from today onwards."],
  LEAVE_NOT_CANCELLABLE: [409, "This request can no longer be cancelled."],
  TOO_MANY_ACTIVE_CODES: [429, "Too many unused device codes. Wait for them to expire."],
  INVALID_INPUT: [400, "Invalid request"],
  STOCK_ITEM_NOT_FOUND: [404, "Item not found"],
};

// VISA-HOURS-START
// Student visa (subclass 500, condition 8105): at most 48 worked hours per
// fortnight while the course is in session. A fortnight is 14 days starting
// on a Monday, and every Monday starts one, so any two consecutive Mon-Sun
// weeks must stay within 48h. This counts worked time (breaks removed) from
// Monday 00:00 of LAST week (Brisbane time) up to `now`, i.e. last week +
// this week so far, including a shift still in progress. Only this
// workplace's hours are known; other jobs also count toward the limit.
const VISA_LIMIT_HOURS = 48;
const VISA_WINDOW_DAYS = 14;
const BRISBANE_OFFSET_MS = 10 * 60 * 60 * 1000; // UTC+10, no daylight saving
const DAY_MS = 24 * 60 * 60 * 1000;

function visaFortnightStart(now: number) {
  const local = now + BRISBANE_OFFSET_MS;
  const localMidnight = Math.floor(local / DAY_MS) * DAY_MS;
  const daysSinceMonday = (new Date(localMidnight).getUTCDay() + 6) % 7;
  const thisMonday = localMidnight - daysSinceMonday * DAY_MS;
  return thisMonday - 7 * DAY_MS - BRISBANE_OFFSET_MS;
}

function computeVisaHours(visaStaff: any[], shifts: any[], now: number) {
  const windowStart = visaFortnightStart(now);
  const windowEnd = windowStart + VISA_WINDOW_DAYS * DAY_MS;
  const overlap = (start: number, end: number) =>
    Math.max(0, Math.min(end, now) - Math.max(start, windowStart));

  const minutesByStaff: Record<string, number> = {};
  for (const shift of shifts || []) {
    if (!shift || !shift.clock_in) continue;
    const start = new Date(shift.clock_in).getTime();
    const end = shift.clock_out ? new Date(shift.clock_out).getTime() : now;
    let worked = overlap(start, end);
    for (const b of shift.breaks || []) {
      if (!b || !b.break_start) continue;
      const bs = Math.max(new Date(b.break_start).getTime(), start);
      const be = Math.min(b.break_end ? new Date(b.break_end).getTime() : now, end);
      if (be > bs) worked -= overlap(bs, be);
    }
    minutesByStaff[shift.staff_id] =
      (minutesByStaff[shift.staff_id] || 0) + Math.max(0, worked) / 60000;
  }

  return (visaStaff || []).map((m: any) => {
    const hours = Math.round(((minutesByStaff[m.id] || 0) / 60) * 100) / 100;
    return {
      staff_id: m.id,
      hours_14d: hours,
      limit_hours: VISA_LIMIT_HOURS,
      remaining_hours: Math.max(0, Math.round((VISA_LIMIT_HOURS - hours) * 100) / 100),
      course_break: !!m.visa_course_break,
      window_start: new Date(windowStart).toISOString(),
      window_end: new Date(windowEnd).toISOString(),
    };
  });
}
// VISA-HOURS-END

// ROSTER-HOURS-START
// Planned hours from the roster. Kitchen cells are L / D / LD, turned into
// hours with the unit's usual service times; Floor cells are SHIFT with a
// start and end (an end not after the start finishes the next day). OFF = 0.
function hmToMinutes(hm: string | null | undefined) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hm || ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function spanMinutes(start: string | null | undefined, end: string | null | undefined) {
  const s = hmToMinutes(start);
  const e = hmToMinutes(end);
  if (s === null || e === null || s === e) return 0;
  return e > s ? e - s : e + 24 * 60 - s;
}

// A person's role (Chef, Dishwasher...) can have its own service times; they
// win over the department's.
function plannedMinutes(entry: any, department: string, services: any[], position?: string | null) {
  if (!entry || !entry.code || entry.code === "OFF") return 0;
  if (entry.code === "SHIFT") return spanMinutes(entry.start_time, entry.end_time);
  const svc = (name: string) => {
    const s = (position && (services || []).find((x: any) => x.position === position && x.service === name)) ||
      (services || []).find((x: any) => !x.position && x.department === department && x.service === name);
    return s ? spanMinutes(s.start_time, s.end_time) : 0;
  };
  if (entry.code === "L") return svc("L");
  if (entry.code === "D") return svc("D");
  if (entry.code === "LD") return svc("L") + svc("D");
  return 0;
}

function brisbaneDayStart(dateStr: string) {
  return Date.parse(`${dateStr}T00:00:00+10:00`);
}

function addDays(dateStr: string, days: number) {
  return new Date(brisbaneDayStart(dateStr) + days * DAY_MS + BRISBANE_OFFSET_MS)
    .toISOString().slice(0, 10);
}

// Hours per person for the roster week starting `weekStart` (a Monday):
// planned hours for everyone, and for student-visa staff the fortnight
// "previous week + this week" against 48h. Days already over use the hours
// actually worked (time clock, breaks removed); today and later use the
// roster (today: whichever is higher).
function computeRosterHours(
  team: any[], entries: any[], shifts: any[], services: any[], weekStart: string, now: number
) {
  const byCell: Record<string, any> = {};
  for (const e of entries || []) byCell[`${e.staff_id}|${e.work_date}`] = e;

  const workedByDay = (staffId: string, dayStart: number) => {
    const dayEnd = dayStart + DAY_MS;
    const clip = (a: number, b: number) =>
      Math.max(0, Math.min(b, dayEnd, now) - Math.max(a, dayStart));
    let ms = 0;
    for (const s of shifts || []) {
      if (s.staff_id !== staffId || !s.clock_in) continue;
      const a = new Date(s.clock_in).getTime();
      const b = s.clock_out ? new Date(s.clock_out).getTime() : now;
      let w = clip(a, b);
      for (const br of s.breaks || []) {
        if (!br || !br.break_start) continue;
        const ba = Math.max(new Date(br.break_start).getTime(), a);
        const bb = Math.min(br.break_end ? new Date(br.break_end).getTime() : now, b);
        if (bb > ba) w -= clip(ba, bb);
      }
      ms += Math.max(0, w);
    }
    return ms / 60000;
  };

  const r2 = (minutes: number) => Math.round((minutes / 60) * 100) / 100;
  const planned: Record<string, number> = {};
  const visa: any[] = [];

  for (const m of team || []) {
    let weekPlanned = 0;
    for (let i = 0; i < 7; i++) {
      weekPlanned += plannedMinutes(byCell[`${m.id}|${addDays(weekStart, i)}`], m.department, services, m.position);
    }
    planned[m.id] = r2(weekPlanned);

    if (!m.student_visa) continue;
    let prev = 0;
    let cur = 0;
    for (let i = -7; i < 7; i++) {
      const date = addDays(weekStart, i);
      const dayStart = brisbaneDayStart(date);
      const plan = plannedMinutes(byCell[`${m.id}|${date}`], m.department, services, m.position);
      let minutes: number;
      if (dayStart + DAY_MS <= now) minutes = workedByDay(m.id, dayStart);
      else if (dayStart > now) minutes = plan;
      else minutes = Math.max(plan, workedByDay(m.id, dayStart));
      if (i < 0) prev += minutes; else cur += minutes;
    }
    const total = r2(prev + cur);
    visa.push({
      staff_id: m.id,
      prev_week_hours: r2(prev),
      week_hours: r2(cur),
      fortnight_hours: total,
      limit_hours: VISA_LIMIT_HOURS,
      over: !m.visa_course_break && total > VISA_LIMIT_HOURS,
      course_break: !!m.visa_course_break,
    });
  }
  return { planned_hours: planned, visa };
}
// ROSTER-HOURS-END

function managerDbError(error: any, fallback: string, fallbackStatus = 400) {
  const code = dbErrorCode(error);
  const known = MANAGER_MESSAGES[code];
  if (known) return json({ error: known[1], code }, known[0]);
  console.error("Manager database error:", error?.code || "", error?.message || "");
  return json({ error: fallback }, fallbackStatus);
}

function pickShift(shift: any, breaks: any[] | null) {
  const out: any = {
    id: shift.id,
    staff_id: shift.staff_id,
    clock_in: shift.clock_in,
    clock_out: shift.clock_out,
    status: shift.status,
    approved: shift.approved,
    notes: shift.notes,
  };
  if (breaks) {
    out.breaks = breaks.map((b: any) => ({
      id: b.id,
      break_start: b.break_start,
      break_end: b.break_end,
    }));
  }
  return out;
}

Deno.serve(async (req) => {

  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: corsHeaders,
    });
  }

  if (req.method !== "POST") {
    return json(
      { error: "Method not allowed" },
      405
    );
  }

  try {

    const supabaseUrl =
      Deno.env.get("SUPABASE_URL");

    const serviceRoleKey =
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !serviceRoleKey) {

      console.error(
        "Missing Supabase environment variables"
      );

      return json(
        { error: "Server configuration error" },
        500
      );
    }

    const supabase = createClient(
      supabaseUrl,
      serviceRoleKey,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
        },
      }
    );

    const body =
      await req.json().catch(() => null);

    if (!body) {
      return json(
        { error: "Invalid JSON body" },
        400
      );
    }

    const action =
      typeof body.action === "string"
        ? body.action.trim()
        : "";

    const deviceHash = await deviceHashFrom(body);

    // =========================
    // DEVICE STATUS / PAIRING (no session needed)
    // =========================

    if (action === "device_status") {
      const { data, error } = await supabase.rpc("auth_device_status", {
        p_device_hash: deviceHash,
      });
      if (error) {
        console.error("Device status error:", error.code || "");
        return json({ error: "Unable to check this device" }, 503);
      }
      return json({
        success: true,
        action,
        data: {
          mode: data?.mode || "grace",
          device: deviceHash ? data?.device || "unknown" : "missing",
        },
      });
    }

    if (action === "device_pair") {
      if (!deviceHash) {
        return json({ error: "This browser cannot be authorised. Please reload the app.", code: "DEVICE_ID_MISSING" }, 400);
      }
      const code = normalisePairingCode(body.code);
      if (!/^[A-Z0-9]{8}$/.test(code)) {
        return json({ error: "Enter the 8-character device code.", code: "INVALID_CODE_FORMAT" }, 400);
      }
      const label =
        typeof body.label === "string" ? body.label.trim().slice(0, 60) : "";
      const { data: r, error } = await supabase.rpc("auth_redeem_pairing_code", {
        p_code_hash: await sha256Hex(code),
        p_device_hash: deviceHash,
        p_label: label || null,
      });
      if (error || !r) {
        console.error("Device pairing error:", error?.code || "");
        return json({ error: "Unable to authorise this device right now. Please try again." }, 503);
      }
      authLog("pair", { result: r.result });
      if (r.result === "ok") {
        return json({ success: true, action, data: { authorised: true } });
      }
      if (r.result === "busy") {
        return json({ error: "Please wait a moment and try again.", code: "BUSY", retry_after_seconds: r.retry_after_seconds || 2 }, 429);
      }
      if (r.result === "locked" || Number(r.retry_after_seconds) > 0) {
        return json({
          error: `Too many incorrect device codes. Try again in ${waitMinutes(r.retry_after_seconds)}.`,
          code: "PAIRING_LOCKED",
          retry_after_seconds: r.retry_after_seconds,
        }, 429);
      }
      return json({
        error: "That device code is not valid or has expired.",
        code: "INVALID_CODE",
        attempts_remaining: r.attempts_remaining,
      }, 400);
    }

    // SECURE LOGOUT:
    // Revoke the current bearer session immediately on the server.
    if (action === "session_logout") {
      try {
        const token =
          typeof body.token === "string"
            ? body.token.trim()
            : "";

        if (!token) {
          return json(
            { error: "Session token is required" },
            400
          );
        }

        const tokenHash =
          await sha256Hex(token);

        const { data: session, error: findError } =
          await supabase
            .from("staff_sessions")
            .select("id, revoked_at")
            .eq("token_hash", tokenHash)
            .maybeSingle();

        if (findError) {
          throw findError;
        }

        // Logout is intentionally idempotent:
        // an already-missing/revoked token is treated as signed out.
        if (session && !session.revoked_at) {
          const { error: revokeError } =
            await supabase
              .from("staff_sessions")
              .update({
                revoked_at:
                  new Date().toISOString(),
                last_used_at:
                  new Date().toISOString(),
              })
              .eq("id", session.id);

          if (revokeError) {
            throw revokeError;
          }
        }

        return json({
          success: true,
          action: "session_logout",
          data: {
            signed_out: true,
          },
        });
      } catch (error) {
        console.error(
          "Secure logout error:",
          error
        );

        return json(
          {
            error:
              "Unable to revoke secure session",
          },
          500
        );
      }
    }

    // SESSION STEP 2 TEST:
    // isolated token validation; all existing PIN actions stay unchanged.
    if (action === "session_test") {
      try {
        const token =
          typeof body.token === "string"
            ? body.token.trim()
            : "";

        const result =
          await validateStaffSession(
            supabase,
            token,
            deviceHash
          );

        if (!result.ok) {
          return json(
            {
              success: false,
              action: "session_test",
              error: result.error,
            },
            401
          );
        }

        return json({
          success: true,
          action: "session_test",
          data: {
            staff_id: result.staff.id,
            staff_name: result.staff.name,
            staff_role: result.staff.role,
            department: result.staff.department,
            location: result.staff.location,
          },
          session: {
            expires_at: result.expires_at,
          },
        });
      } catch (error) {
        console.error(
          "Session validation error:",
          error
        );
        return json(
          {
            error:
              "Unable to validate secure session",
          },
          500
        );
      }
    }

    // STAFF MY HOURS:
    // Secure weekly history for the currently signed-in staff member only.
    // STAFF TIME OFF: own holiday / day-off requests (session required).
    if (
      action === "session_leave_list" ||
      action === "session_leave_request" ||
      action === "session_leave_cancel"
    ) {
      try {
        const token =
          typeof body.token === "string" ? body.token.trim() : "";
        const sessionResult =
          await validateStaffSession(supabase, token, deviceHash);
        if (!sessionResult.ok) {
          return json({ success: false, action, error: sessionResult.error }, 401);
        }
        const staffId = sessionResult.staff.id;
        const isDate = (v: unknown) =>
          typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.trim());

        if (action === "session_leave_request") {
          const kind = typeof body.kind === "string" ? body.kind.trim().toUpperCase() : "";
          const start = typeof body.start_date === "string" ? body.start_date.trim() : "";
          const end = typeof body.end_date === "string" && body.end_date.trim() ? body.end_date.trim() : start;
          const note = typeof body.note === "string" ? body.note.trim().slice(0, 200) : "";
          if (!["HOLIDAY", "DAY_OFF"].includes(kind) || !isDate(start) || !isDate(end)) {
            return json({ error: "Choose the type and the dates.", code: "INVALID_INPUT" }, 400);
          }
          const { data, error } = await supabase.rpc("staff_leave_request", {
            p_staff_id: staffId, p_kind: kind, p_start: start, p_end: end, p_note: note || null,
          });
          if (error) return managerDbError(error, "Unable to send the request");
          return json({ success: true, action, data: { request: data } });
        }

        if (action === "session_leave_cancel") {
          const leaveId = typeof body.leave_id === "string" ? body.leave_id.trim() : "";
          if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(leaveId)) {
            return json({ error: "Request not found", code: "LEAVE_NOT_FOUND" }, 404);
          }
          const { data, error } = await supabase.rpc("staff_leave_cancel", {
            p_staff_id: staffId, p_leave_id: leaveId,
          });
          if (error) return managerDbError(error, "Unable to cancel the request");
          return json({ success: true, action, data: { request: data } });
        }

        const { data, error } = await supabase.rpc("staff_leave_list", { p_staff_id: staffId });
        if (error) return managerDbError(error, "Unable to load your requests", 500);
        return json({ success: true, action, data: { requests: data || [] } });
      } catch (error) {
        console.error("Staff leave error:", (error as any)?.code || "");
        return json({ error: "Unable to complete the request" }, 500);
      }
    }

    if (action === "session_my_hours") {
      try {
        const token =
          typeof body.token === "string"
            ? body.token.trim()
            : "";

        const sessionResult =
          await validateStaffSession(supabase, token, deviceHash);

        if (!sessionResult.ok) {
          return json(
            {
              success: false,
              action,
              error: sessionResult.error,
            },
            401
          );
        }

        const requestedWeekDate =
          typeof body.week_start === "string" && body.week_start.trim()
            ? body.week_start.trim()
            : undefined;

        const weekRange =
          getBrisbaneWeekRange(requestedWeekDate);

        const { data: shiftsData, error: shiftsError } =
          await supabase
            .from("shifts")
            .select(`
              id,
              staff_id,
              clock_in,
              clock_out,
              status,
              approved,
              notes,
              breaks (
                id,
                break_start,
                break_end
              )
            `)
            .eq("staff_id", sessionResult.staff.id)
            .gte("clock_in", weekRange.week_start)
            .lt("clock_in", weekRange.week_end)
            .order("clock_in", { ascending: false });

        if (shiftsError) throw shiftsError;

        const shifts = (shiftsData || []).map((shift: any) => {
          const breakMinutes =
            Math.round(
              (shift.breaks || []).reduce(
                (total: number, b: any) => {
                  if (!b.break_start) return total;

                  const start =
                    new Date(b.break_start).getTime();

                  const end =
                    b.break_end
                      ? new Date(b.break_end).getTime()
                      : Date.now();

                  return total + Math.max(0, end - start);
                },
                0
              ) / 60000
            );

          return {
            shift_id: shift.id,
            clock_in: shift.clock_in,
            clock_out: shift.clock_out,
            status: shift.status,
            approved: shift.approved,
            notes: shift.notes,
            break_minutes: breakMinutes,
            hours: Number(calculateHours(shift).toFixed(2)),
          };
        });

        const totalHours =
          Number(
            shifts
              .reduce(
                (total: number, shift: any) =>
                  total + Number(shift.hours || 0),
                0
              )
              .toFixed(2)
          );

        return json({
          success: true,
          action,
          data: {
            staff: {
              id: sessionResult.staff.id,
              name: sessionResult.staff.name,
              department: sessionResult.staff.department,
              location: sessionResult.staff.location,
              role: sessionResult.staff.role,
            },
            week_start: weekRange.week_start,
            week_end: weekRange.week_end,
            week_start_date: weekRange.week_start_date,
            total_hours: totalHours,
            shifts,
          },
          session: {
            expires_at: sessionResult.expires_at,
          },
        });
      } catch (error) {
        console.error("Staff My Hours error:", error);

        if (
          error instanceof Error &&
          error.message === "INVALID_WEEK_DATE"
        ) {
          return json(
            { error: "week_start must be YYYY-MM-DD" },
            400
          );
        }

        return json(
          { error: "Unable to load staff hours" },
          500
        );
      }
    }

    // SESSION STEP 3:
    // Token-authenticated time-clock actions. Existing PIN actions remain unchanged.
    const sessionStaffActions: Record<string, string> = {
      session_status: "staff_status_by_id",
      session_clock_in: "clock_in_by_id",
      session_start_break: "start_break_by_id",
      session_end_break: "end_break_by_id",
      session_clock_out: "clock_out_by_id",
    };

    const sessionRpc = sessionStaffActions[action];

    if (sessionRpc) {
      try {
        const token =
          typeof body.token === "string"
            ? body.token.trim()
            : "";

        const sessionResult =
          await validateStaffSession(supabase, token, deviceHash);

        if (!sessionResult.ok) {
          return json(
            {
              success: false,
              action,
              error: sessionResult.error,
            },
            401
          );
        }

        const { data, error } =
          await supabase.rpc(
            sessionRpc,
            {
              p_staff_id:
                sessionResult.staff.id,
            }
          );

        if (error) {
          const code = dbErrorCode(error);
          console.error(`${sessionRpc} RPC error:`, code || error.code || "");
          return json(
            {
              error: CLOCK_MESSAGES[code] || "Unable to complete action",
              code: code || "ACTION_FAILED",
            },
            400
          );
        }

        return json({
          success: true,
          action,
          data,
          session: {
            expires_at:
              sessionResult.expires_at,
          },
        });
      } catch (error) {
        console.error(
          "Session time-clock error:",
          error
        );
        return json(
          {
            error:
              "Unable to process secure session action",
          },
          500
        );
      }
    }

    const pin =
      typeof body.pin === "string"
        ? body.pin.trim()
        : "";

    if (!action) {
      return json(
        { error: "Action is required" },
        400
      );
    }

    const requestToken =
      typeof body.token === "string"
        ? body.token.trim()
        : "";

    // PIN is required only for legacy/PIN actions.
    // Secure session actions and manager token requests may continue without it.
    if (!pin && !requestToken) {
      return json(
        { error: "PIN or session token is required" },
        400
      );
    }


    // =========================
    // LOGIN (v38)
    // Device check, attempt limits, PIN check against every active person
    // (a PIN shared by two people is refused, never guessed), device
    // authorisation and session creation happen in ONE database transaction:
    // public.auth_pin_login. The PIN is never logged or stored.
    // =========================

    const staffActions: Record<string, true> = { login: true };

    if (action === "login") {
      const sessionToken = createSessionToken();
      const expiresAt = new Date(
        Date.now() + SESSION_HOURS * 60 * 60 * 1000
      ).toISOString();

      const { data: result, error } = await supabase.rpc("auth_pin_login", {
        p_pin: pin,
        p_device_hash: deviceHash,
        p_token_hash: await sha256Hex(sessionToken),
        p_expires_at: expiresAt,
      });

      if (error || !result?.result) {
        console.error("Login error:", error?.code || "no result");
        return json(
          { error: "Unable to sign in right now. Please try again.", code: "LOGIN_UNAVAILABLE" },
          503
        );
      }

      authLog("login", {
        result: result.result,
        device: !deviceHash
          ? "none"
          : result.result === "ok"
            ? (result.device?.newly_approved ? "new" : "approved")
            : (typeof result.device === "string" ? result.device : "n/a"),
      });

      switch (result.result) {
        case "ok":
          return json({
            success: true,
            action,
            data: [result.staff],
            session: { token: sessionToken, expires_at: expiresAt },
          });
        case "invalid_pin":
          if (Number(result.retry_after_seconds) > 0) {
            return pinLockedResponse(result.retry_after_seconds);
          }
          return json(
            { error: "Invalid PIN", code: "INVALID_PIN", attempts_remaining: result.attempts_remaining },
            401
          );
        case "pin_conflict":
          if (Number(result.retry_after_seconds) > 0) {
            return pinLockedResponse(result.retry_after_seconds);
          }
          return json(
            {
              error: "This PIN is used by more than one person. Ask a manager to set a new PIN for you.",
              code: "PIN_CONFLICT",
            },
            409
          );
        case "locked":
          return pinLockedResponse(result.retry_after_seconds);
        case "busy":
          return json(
            { error: "Please wait a moment and try again.", code: "BUSY", retry_after_seconds: result.retry_after_seconds || 2 },
            429
          );
        case "device_not_authorized":
          return json(
            { error: "This device is not authorised yet. Ask a manager for a device code.", code: "DEVICE_NOT_AUTHORIZED" },
            403
          );
        case "device_revoked":
          return json(
            { error: "This device was removed by a manager. Ask a manager for a device code.", code: "DEVICE_REVOKED" },
            403
          );
        default:
          return json({ error: "Unable to sign in right now. Please try again." }, 503);
      }
    }


    // =========================
    // MANAGER ACTIONS
    // =========================

    const managerActions =
      new Set([
        "manager_dashboard",
        "manager_working",
        "manager_team",
        "manager_create_staff",
        "manager_toggle_staff",
        "manager_update_staff",
        "manager_hours",
        "manager_approvals",
        "manager_create_shift",
        "manager_approve_shift",
        "manager_reopen_shift",
        "manager_clock_out_staff",
        "manager_edit_shift",
        "manager_delete_shift",
        "manager_devices",
        "manager_device_code",
        "manager_device_revoke",
        "manager_device_unlock",
        "manager_device_rename",
        "manager_auth_mode",
        "manager_set_student_visa",
        "manager_roster_week",
        "manager_roster_set",
        "manager_leave_list",
        "manager_leave_decide",
        "manager_leave_create",
        "manager_set_roster_info",
        "manager_set_roster_order",
        "manager_create_roster_person",
        "manager_stock_list",
        "manager_stock_item_save",
        "manager_stock_item_remove",
        "manager_stock_supplier_save",
        "manager_stock_count_save",
        "manager_stock_count_close",
        "manager_stock_supplier_rename",
      ]);

    if (!managerActions.has(action)) {

      return json(
        {
          error: "Unknown action",

          allowed_actions: [
            ...Object.keys(
              staffActions
            ),

            ...Array.from(
              managerActions
            ),
          ],
        },
        400
      );
    }


    // Production rule:
    // Manager actions require a valid secure session token.
    let managerStatus: any = null;

    const managerToken =
      typeof body.token === "string"
        ? body.token.trim()
        : "";

    if (!managerToken) {
      return json(
        { error: "Manager session token is required" },
        401
      );
    }

    try {
      const managerSession =
        await validateStaffSession(
          supabase,
          managerToken,
          deviceHash
        );

      if (!managerSession.ok) {
        return json(
          {
            error:
              managerSession.error ||
              "Invalid or expired session",
          },
          401
        );
      }

      if (
        !["manager", "kitchen_manager", "floor_manager"].includes(
          managerSession.staff.role
        )
      ) {
        return json(
          {
            error:
              "Manager access required",
          },
          403
        );
      }

      managerStatus = {
        id: managerSession.staff.id,
        name: managerSession.staff.name,
        role: managerSession.staff.role,
        department:
          managerSession.staff.department,
        location:
          managerSession.staff.location,
        manager_type:
          managerSession.staff.role === "manager"
            ? "general"
            : managerSession.staff.role === "kitchen_manager"
              ? "kitchen"
              : "floor",
      };
    } catch (error) {
      console.error(
        "Manager session validation error:",
        error
      );

      return json(
        {
          error:
            "Unable to validate manager session",
        },
        500
      );
    }

    const location =
      managerStatus.location ||
      "Hawthorne";

    // Server-enforced manager scope.
    // manager = General Manager; scoped managers only see their department.
    const managerDepartmentScope =
      managerStatus.role === "kitchen_manager"
        ? "Kitchen"
        : managerStatus.role === "floor_manager"
          ? "Floor"
          : null;

    const isGeneralManager =
      managerStatus.role === "manager";

    function departmentAllowed(department: string) {
      return !managerDepartmentScope || department === managerDepartmentScope;
    }


    // =========================
    // TEAM
    // =========================

    async function loadTeam() {

      const query = (columns: string) =>
        supabase
          .from("staff")
          .select(columns)
          .eq(
            "location",
            location
          )
          .order(
            "department",
            { ascending: true }
          )
          .order(
            "name",
            { ascending: true }
          );
      const base = `
            id,
            name,
            department,
            location,
            role,
            active,
            created_at,
            pin_conflict_at,
            student_visa,
            visa_course_break`;

      // Roster role and roster-only are read when the database has them; an
      // older database (before 20261021010000) still gets the team.
      let { data, error } = await query(base + ", position, roster_only, roster_order");
      if (error && (error as any).code === "42703") {
        ({ data, error } = await query(base + ", position, roster_only"));
      }
      if (error && (error as any).code === "42703") {
        ({ data, error } = await query(base));
      }

      if (error) {
        throw error;
      }

      const team = data || [];

      // Restricted managers can see staff in their own department
      // plus their own manager account, but never other manager accounts.
      if (managerDepartmentScope) {
        return team.filter((member: any) =>
          member.department === managerDepartmentScope &&
          (
            member.role === "staff" ||
            member.id === managerStatus.id
          )
        );
      }

      // General Manager keeps the full Hawthorne team view.
      return team;
    }


    // =========================
    // PUBLIC HOLIDAYS
    // =========================
    // Queensland holidays from the public_holidays table. Every unit is in the
    // Brisbane area, so Brisbane-only days (Ekka) count too. If the table is
    // missing (older database), the app simply shows no holidays.
    async function loadPublicHolidays(fromDate: string, toDate: string) {
      const { data, error } = await supabase
        .from("public_holidays")
        .select("holiday_date, name, region, part_day")
        .gte("holiday_date", fromDate)
        .lte("holiday_date", toDate)
        .order("holiday_date", { ascending: true });
      if (error) {
        console.error("Public holidays error:", error.code || "");
        return [];
      }
      return data || [];
    }

    // =========================
    // STUDENT VISA HOURS
    // =========================

    async function loadVisaHours(team: any[]) {
      const visaStaff = (team || []).filter((m: any) => m.student_visa && m.active);
      if (!visaStaff.length) return [];

      const now = Date.now();
      // One extra day back so a shift that started before the fortnight and
      // finished inside it is still counted (only the part inside).
      const fetchFrom = new Date(visaFortnightStart(now) - DAY_MS).toISOString();

      const { data, error } = await supabase
        .from("shifts")
        .select(`
          staff_id,
          clock_in,
          clock_out,
          breaks (
            break_start,
            break_end
          )
        `)
        .in("staff_id", visaStaff.map((m: any) => m.id))
        .gte("clock_in", fetchFrom);

      if (error) {
        throw error;
      }

      return computeVisaHours(visaStaff, data || [], now);
    }


    // =========================
    // WHO IS WORKING
    // =========================

    async function loadWorking() {

      const { data, error } =
        await supabase
          .from("shifts")
          .select(`
            id,
            staff_id,
            clock_in,
            clock_out,
            status,
            approved,

            staff!inner (
              id,
              name,
              department,
              location,
              role,
              active
            ),

            breaks (
              id,
              break_start,
              break_end
            )
          `)
          .is(
            "clock_out",
            null
          )
          .in(
            "status",
            [
              "working",
              "break"
            ]
          )
          .eq(
            "staff.location",
            location
          )
          .eq(
            "staff.active",
            true
          )
          .order(
            "clock_in",
            { ascending: true }
          );

      if (error) {
        throw error;
      }

      const scopedWorking = managerDepartmentScope
        ? (data || []).filter((shift: any) =>
            shift.staff?.department === managerDepartmentScope)
        : (data || []);

      return scopedWorking.map(
        (shift: any) => ({

          shift_id:
            shift.id,

          staff_id:
            shift.staff_id,

          name:
            shift.staff?.name ||
            "Staff",

          department:
            shift.staff
              ?.department || "",

          role:
            shift.staff?.role ||
            "staff",

          status:
            shift.status,

          clock_in:
            shift.clock_in,

          hours_so_far:
            Number(
              calculateHours(
                shift
              ).toFixed(2)
            ),
        })
      );
    }


    // =========================
    // STAFF HOURS
    // =========================

    async function loadHours(
      requestedWeekDate?: string
    ) {

      const weekRange =
        getBrisbaneWeekRange(
          requestedWeekDate
        );

      const weekStart =
        weekRange.week_start;

      const weekEnd =
        weekRange.week_end;

      const { data, error } =
        await supabase
          .from("shifts")
          .select(`
            id,
            staff_id,
            clock_in,
            clock_out,
            status,
            approved,
            notes,

            staff!inner (
              id,
              name,
              department,
              location,
              role,
              active
            ),

            breaks (
              id,
              break_start,
              break_end
            )
          `)
          .gte(
            "clock_in",
            weekStart
          )
          .lt(
            "clock_in",
            weekEnd
          )
          .eq(
            "staff.location",
            location
          )
          .eq(
            "staff.active",
            true
          )
          .order(
            "clock_in",
            { ascending: false }
          );

      if (error) {
        throw error;
      }


      const scopedHoursData = managerDepartmentScope
        ? (data || []).filter((shift: any) =>
            shift.staff?.department === managerDepartmentScope)
        : (data || []);

      const shifts =
        scopedHoursData.map(
          (shift: any) => {

            const breakMinutes =
              Math.round(
                (
                  shift.breaks || []
                ).reduce(
                  (
                    total: number,
                    b: any
                  ) => {

                    if (
                      !b.break_start
                    ) {
                      return total;
                    }

                    const start =
                      new Date(
                        b.break_start
                      ).getTime();

                    const end =
                      b.break_end
                        ? new Date(
                            b.break_end
                          ).getTime()
                        : Date.now();

                    return (
                      total +
                      Math.max(
                        0,
                        end - start
                      )
                    );

                  },
                  0
                ) / 60000
              );


            return {

              shift_id:
                shift.id,

              staff_id:
                shift.staff_id,

              name:
                shift.staff?.name ||
                "Staff",

              department:
                shift.staff
                  ?.department ||
                "",

              role:
                shift.staff?.role ||
                "staff",

              clock_in:
                shift.clock_in,

              clock_out:
                shift.clock_out,

              status:
                shift.status,

              approved:
                shift.approved,

              notes:
                shift.notes,

              break_minutes:
                breakMinutes,

              hours:
                Number(
                  calculateHours(
                    shift
                  ).toFixed(2)
                ),
            };
          }
        );


      const staffMap =
        new Map();


      for (
        const shift of shifts
      ) {

        const existing =
          staffMap.get(
            shift.staff_id
          ) || {

            staff_id:
              shift.staff_id,

            name:
              shift.name,

            department:
              shift.department,

            role:
              shift.role,

            total_hours: 0,

            shifts: 0,

            unapproved: 0,
          };


        existing.total_hours +=
          shift.hours;

        existing.shifts += 1;


        if (
          !shift.approved &&
          shift.clock_out
        ) {

          existing.unapproved += 1;
        }


        staffMap.set(
          shift.staff_id,
          existing
        );
      }


      const summary =
        Array.from(
          staffMap.values()
        )
          .map(
            (item: any) => ({
              ...item,

              total_hours:
                Number(
                  item.total_hours
                    .toFixed(2)
                ),
            })
          )
          .sort(
            (a: any, b: any) =>
              a.name.localeCompare(
                b.name
              )
          );


      return {

        week_start:
          weekStart,

        week_end:
          weekEnd,

        week_start_date:
          weekRange.week_start_date,

        summary,

        shifts,
      };
    }


    // =========================
    // APPROVALS
    // =========================

    async function loadApprovals() {

      // Pending approvals must survive week boundaries.
      // Keep every completed, unapproved shift available until a manager resolves it.
      const { data, error } =
        await supabase
          .from("shifts")
          .select(`
            id,
            staff_id,
            clock_in,
            clock_out,
            status,
            approved,
            notes,

            staff!inner (
              id,
              name,
              department,
              location,
              role,
              active
            ),

            breaks (
              id,
              break_start,
              break_end
            )
          `)
          .eq(
            "approved",
            false
          )
          .not(
            "clock_out",
            "is",
            null
          )
          .eq(
            "staff.location",
            location
          )
          .eq(
            "staff.active",
            true
          )
          .order(
            "clock_in",
            { ascending: false }
          );

      if (error) {
        throw error;
      }

      const scopedApprovals = managerDepartmentScope
        ? (data || []).filter((shift: any) =>
            shift.staff?.department === managerDepartmentScope)
        : (data || []);

      return scopedApprovals.map(
        (shift: any) => {

          const breakMinutes =
            Math.round(
              (shift.breaks || []).reduce(
                (
                  total: number,
                  b: any
                ) => {

                  if (!b.break_start) {
                    return total;
                  }

                  const start =
                    new Date(
                      b.break_start
                    ).getTime();

                  const end =
                    b.break_end
                      ? new Date(
                          b.break_end
                        ).getTime()
                      : Date.now();

                  return (
                    total +
                    Math.max(
                      0,
                      end - start
                    )
                  );

                },
                0
              ) / 60000
            );

          return {

            shift_id:
              shift.id,

            staff_id:
              shift.staff_id,

            name:
              shift.staff?.name ||
              "Staff",

            department:
              shift.staff?.department ||
              "",

            clock_in:
              shift.clock_in,

            clock_out:
              shift.clock_out,

            break_minutes:
              breakMinutes,

            hours:
              Number(
                calculateHours(
                  shift
                ).toFixed(2)
              ),

            approved:
              shift.approved,

            notes:
              shift.notes,
          };
        }
      );
    }


    // =========================
    // RETURN MANAGER DATA
    // =========================

    try {

      if (
        action ===
        "manager_approvals"
      ) {

        return json({

          success: true,

          action,

          data: {

            manager:
              managerStatus,

            approvals:
              await loadApprovals(),
          },
        });
      }


      if (
        action ===
        "manager_edit_shift"
      ) {
        const shiftId =
          typeof body.shift_id === "string" ? body.shift_id.trim() : "";
        const clockIn =
          typeof body.clock_in === "string" ? body.clock_in.trim() : "";
        const clockOut =
          typeof body.clock_out === "string" ? body.clock_out.trim() : "";
        const breakMinutes = Number(body.break_minutes ?? 0);

        if (!shiftId) {
          return json({ error: "Shift ID is required" }, 400);
        }
        const clockInDate = new Date(clockIn);
        const clockOutDate = new Date(clockOut);
        if (
          !clockIn ||
          !clockOut ||
          Number.isNaN(clockInDate.getTime()) ||
          Number.isNaN(clockOutDate.getTime())
        ) {
          return json({ error: "Valid Clock In and Clock Out are required" }, 400);
        }
        if (clockOutDate <= clockInDate) {
          return json({ error: "Clock Out must be after Clock In" }, 400);
        }
        if (!Number.isFinite(breakMinutes) || breakMinutes < 0 || breakMinutes > 720) {
          return json({ error: "Break minutes are invalid" }, 400);
        }
        const shiftMinutes =
          (clockOutDate.getTime() - clockInDate.getTime()) / 60000;
        if (breakMinutes >= shiftMinutes) {
          return json({ error: "Break cannot be as long as the whole shift" }, 400);
        }
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(shiftId)) {
          return json({ error: "Shift not found" }, 404);
        }

        // One transaction: lock, scope check, update, breaks, audit.
        const { data: edited, error: editError } = await supabase.rpc(
          "manager_edit_shift",
          {
            p_manager_id: managerStatus.id,
            p_shift_id: shiftId,
            p_clock_in: clockInDate.toISOString(),
            p_clock_out: clockOutDate.toISOString(),
            p_break_minutes: Math.round(breakMinutes),
          }
        );
        if (editError) {
          if (dbErrorCode(editError) === "SHIFT_STILL_OPEN") {
            return json({ error: "Active shifts cannot be edited here" }, 400);
          }
          if (dbErrorCode(editError) === "SHIFT_APPROVED") {
            return json({ error: "Approved shifts cannot be edited here" }, 400);
          }
          return managerDbError(editError, "Unable to edit shift", 500);
        }

        const updatedShift = pickShift(edited.shift, edited.breaks || []);
        return json({
          success: true,
          action,
          data: {
            shift: {
              ...updatedShift,
              break_minutes: Math.round(breakMinutes),
              hours: Number(calculateHours(updatedShift).toFixed(2)),
            },
          },
        });
      }

      if (
        action ===
        "manager_delete_shift"
      ) {
        const shiftId =
          typeof body.shift_id === "string" ? body.shift_id.trim() : "";
        if (!shiftId) {
          return json({ error: "Shift ID is required" }, 400);
        }
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(shiftId)) {
          return json({ error: "Shift not found" }, 404);
        }
        // The audit row keeps the full deleted shift and its breaks.
        const { error: deleteError } = await supabase.rpc(
          "manager_delete_shift",
          { p_manager_id: managerStatus.id, p_shift_id: shiftId }
        );
        if (deleteError) {
          if (dbErrorCode(deleteError) === "SHIFT_STILL_OPEN") {
            return json({ error: "Active shifts cannot be deleted here" }, 400);
          }
          if (dbErrorCode(deleteError) === "SHIFT_APPROVED") {
            return json({ error: "Approved shifts cannot be deleted here" }, 400);
          }
          return managerDbError(deleteError, "Unable to delete shift", 500);
        }
        return json({
          success: true,
          action,
          data: { deleted: true, shift_id: shiftId },
        });
      }

      if (
        action ===
        "manager_create_shift"
      ) {
        const staffId =
          typeof body.staff_id === "string" ? body.staff_id.trim() : "";
        const clockIn =
          typeof body.clock_in === "string" ? body.clock_in.trim() : "";
        const clockOut =
          typeof body.clock_out === "string" ? body.clock_out.trim() : "";
        const breakMinutes = Number(body.break_minutes ?? 0);
        const notes =
          typeof body.notes === "string" ? body.notes.trim() : "";

        if (!staffId || !clockIn || !clockOut) {
          return json({ error: "Employee, clock in and clock out are required" }, 400);
        }
        if (!Number.isFinite(breakMinutes) || breakMinutes < 0 || breakMinutes > 720) {
          return json({ error: "Invalid break duration" }, 400);
        }
        const inDate = new Date(clockIn);
        const outDate = new Date(clockOut);
        if (
          Number.isNaN(inDate.getTime()) ||
          Number.isNaN(outDate.getTime()) ||
          outDate <= inDate
        ) {
          return json({ error: "Clock out must be after clock in" }, 400);
        }
        const grossMinutes =
          Math.floor((outDate.getTime() - inDate.getTime()) / 60000);
        if (breakMinutes >= grossMinutes) {
          return json({ error: "Break must be shorter than the shift" }, 400);
        }
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(staffId)) {
          return json({ error: "Employee not found" }, 404);
        }

        // One transaction: shift + break + audit; overlaps are refused by the database.
        const { data: created, error: createShiftError } = await supabase.rpc(
          "manager_create_shift",
          {
            p_manager_id: managerStatus.id,
            p_staff_id: staffId,
            p_clock_in: inDate.toISOString(),
            p_clock_out: outDate.toISOString(),
            p_break_minutes: Math.round(breakMinutes),
            p_notes: notes,
          }
        );
        if (createShiftError) {
          if (dbErrorCode(createShiftError) === "STAFF_NOT_FOUND") {
            return json({ error: "Employee not found" }, 404);
          }
          return managerDbError(createShiftError, "Unable to create shift", 500);
        }
        const employee = created.employee || {};
        return json({
          success: true,
          action,
          data: {
            shift: pickShift(created.shift, null),
            employee: {
              id: employee.id,
              name: employee.name,
              department: employee.department,
              location: employee.location,
              role: employee.role,
              active: employee.active,
            },
            break_minutes: breakMinutes,
            manually_created: true,
          },
        });
      }

      if (
        action ===
        "manager_approve_shift"
      ) {
        const shiftId =
          typeof body.shift_id === "string" ? body.shift_id.trim() : "";
        if (!shiftId) {
          return json({ error: "Shift ID is required" }, 400);
        }
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(shiftId)) {
          return json({ error: "Shift not found" }, 404);
        }
        const { data: approved, error: approveError } = await supabase.rpc(
          "manager_set_shift_approved",
          { p_manager_id: managerStatus.id, p_shift_id: shiftId, p_approved: true }
        );
        if (approveError) {
          if (dbErrorCode(approveError) === "SHIFT_STILL_OPEN") {
            return json({ error: "Active shifts cannot be approved" }, 400);
          }
          return managerDbError(approveError, "Unable to approve shift", 500);
        }
        const sh = approved.shift;
        return json({
          success: true,
          action,
          data: {
            shift: {
              id: sh.id,
              staff_id: sh.staff_id,
              clock_in: sh.clock_in,
              clock_out: sh.clock_out,
              approved: sh.approved,
            },
          },
        });
      }

      if (
        action ===
        "manager_reopen_shift"
      ) {
        const shiftId =
          typeof body.shift_id === "string" ? body.shift_id.trim() : "";
        if (!shiftId) {
          return json({ error: "Shift ID is required" }, 400);
        }
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(shiftId)) {
          return json({ error: "Shift not found" }, 404);
        }
        const { data: reopened, error: reopenError } = await supabase.rpc(
          "manager_set_shift_approved",
          { p_manager_id: managerStatus.id, p_shift_id: shiftId, p_approved: false }
        );
        if (reopenError) {
          if (dbErrorCode(reopenError) === "SHIFT_STILL_OPEN") {
            return json({ error: "Active shifts cannot be reopened" }, 400);
          }
          return managerDbError(reopenError, "Unable to reopen shift", 500);
        }
        if (!reopened.changed) {
          return json({
            success: true,
            action,
            data: { shift_id: shiftId, approved: false, already_pending: true },
          });
        }
        const sh = reopened.shift;
        return json({
          success: true,
          action,
          data: {
            shift: {
              id: sh.id,
              staff_id: sh.staff_id,
              clock_in: sh.clock_in,
              clock_out: sh.clock_out,
              approved: sh.approved,
            },
          },
        });
      }

      // =========================
      // MANAGER CLOCK OUT STAFF
      // Closes a forgotten open shift. All checks (scope, times, breaks,
      // duplicates, approved state) run again atomically in the database
      // function public.manager_clock_out_staff, with row locks + audit.
      // =========================

      if (
        action ===
        "manager_clock_out_staff"
      ) {
        const shiftId =
          typeof body.shift_id === "string"
            ? body.shift_id.trim()
            : "";

        const clockOutRaw =
          typeof body.clock_out === "string"
            ? body.clock_out.trim()
            : "";

        if (
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            shiftId
          )
        ) {
          return json({ error: "Shift ID is required" }, 400);
        }

        // Require an explicit offset (Z or +10:00) so the time is never
        // interpreted in the server's own time zone.
        if (
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(
            clockOutRaw
          )
        ) {
          return json(
            { error: "A valid Clock Out date and time is required" },
            400
          );
        }

        const clockOutDate = new Date(clockOutRaw);

        if (Number.isNaN(clockOutDate.getTime())) {
          return json(
            { error: "A valid Clock Out date and time is required" },
            400
          );
        }

        if (clockOutDate.getTime() > Date.now() + 60 * 1000) {
          return json(
            { error: "Clock Out cannot be in the future" },
            400
          );
        }

        // Fast pre-check of scope so other departments get a clear 403.
        const { data: targetShift, error: targetShiftError } =
          await supabase
            .from("shifts")
            .select(`
              id,
              staff!inner (
                id,
                role,
                location,
                department,
                active
              )
            `)
            .eq("id", shiftId)
            .eq("staff.location", location)
            .eq("staff.active", true)
            .maybeSingle();

        if (targetShiftError) throw targetShiftError;

        if (!targetShift) {
          return json({ error: "Shift not found" }, 404);
        }

        if (
          managerDepartmentScope &&
          (
            targetShift.staff?.department !== managerDepartmentScope ||
            (
              targetShift.staff?.role !== "staff" &&
              targetShift.staff?.id !== managerStatus.id
            )
          )
        ) {
          return json({ error: "Access denied for this department" }, 403);
        }

        const { data: closed, error: closeError } =
          await supabase.rpc(
            "manager_clock_out_staff",
            {
              p_manager_id: managerStatus.id,
              p_shift_id: shiftId,
              p_clock_out: clockOutDate.toISOString(),
            }
          );

        if (closeError) {
          const code = String(closeError.message || "");

          const known: Record<string, [string, number]> = {
            MANAGER_REQUIRED: ["Manager access required", 403],
            DEPARTMENT_DENIED: ["Access denied for this department", 403],
            SHIFT_NOT_FOUND: ["Shift not found", 404],
            SHIFT_APPROVED: ["Approved shifts cannot be changed", 409],
            SHIFT_ALREADY_CLOSED: ["This shift has already been clocked out", 409],
            CLOCK_OUT_BEFORE_CLOCK_IN: ["Clock Out must be after Clock In", 400],
            CLOCK_OUT_IN_FUTURE: ["Clock Out cannot be in the future", 400],
            CLOCK_OUT_BEFORE_BREAK_END: ["Clock Out must be after the recorded breaks", 400],
            INVALID_INPUT: ["A valid Clock Out date and time is required", 400],
          };

          const match = Object.keys(known).find((key) => code.includes(key));

          if (match) {
            return json(
              { error: known[match][0], code: match },
              known[match][1]
            );
          }

          throw closeError;
        }

        return json({
          success: true,
          action,
          data: {
            shift: closed,
          },
        });
      }


      if (
        action ===
        "manager_create_staff"
      ) {
        const name =
          typeof body.name === "string" ? body.name.trim() : "";
        const staffPin =
          typeof body.staff_pin === "string" ? body.staff_pin.trim() : "";
        const department =
          typeof body.department === "string" ? body.department.trim() : "";

        if (!name) {
          return json({ error: "Name is required" }, 400);
        }
        if (!/^[0-9]{4,6}$/.test(staffPin)) {
          return json({ error: "PIN must contain 4 to 6 numbers" }, 400);
        }
        if (department !== "Kitchen" && department !== "Floor") {
          return json({ error: "Department must be Kitchen or Floor" }, 400);
        }
        if (!departmentAllowed(department)) {
          return json({ error: "Access denied for this department" }, 403);
        }

        // Refuses a PIN that another active person already uses; writes an audit row.
        const { data: createdStaff, error: createStaffError } = await supabase.rpc(
          "manager_create_staff_audited",
          {
            p_manager_id: managerStatus.id,
            p_name: name,
            p_pin: staffPin,
            p_department: department,
          }
        );
        if (createStaffError) {
          const code = dbErrorCode(createStaffError);
          if (code === "PIN_IN_USE" || code === "DEPARTMENT_DENIED") {
            return managerDbError(createStaffError, "Unable to create staff member");
          }
          console.error("Create staff error:", createStaffError.code || "");
          return json({ error: "Unable to create staff member" }, 400);
        }
        return json({
          success: true,
          action,
          data: { staff: createdStaff },
        });
      }

      if (
        action ===
        "manager_update_staff"
      ) {
        const staffId =
          typeof body.staff_id === "string" ? body.staff_id.trim() : "";
        const name =
          typeof body.name === "string" ? body.name.trim() : "";
        const department =
          typeof body.department === "string" ? body.department.trim() : "";
        const newPin =
          typeof body.new_pin === "string" ? body.new_pin.trim() : "";
        const requestedRole =
          typeof body.role === "string" ? body.role.trim() : "";

        if (!staffId) {
          return json({ error: "Staff ID is required" }, 400);
        }
        if (!name) {
          return json({ error: "Name is required" }, 400);
        }
        if (department !== "Kitchen" && department !== "Floor") {
          return json({ error: "Department must be Kitchen or Floor" }, 400);
        }
        if (newPin && !/^[0-9]{4,6}$/.test(newPin)) {
          return json({ error: "PIN must contain 4 to 6 numbers" }, 400);
        }
        if (
          requestedRole &&
          !["staff", "manager", "kitchen_manager", "floor_manager"].includes(requestedRole)
        ) {
          return json({ error: "Invalid account role" }, 400);
        }
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(staffId)) {
          return json({ error: "Staff member not found" }, 404);
        }
        // Department scope is checked here (clear 403) and again in the database.
        if (
          managerDepartmentScope &&
          department !== managerDepartmentScope
        ) {
          return json({ error: "Access denied for this department" }, 403);
        }

        const { data: updated, error: updateStaffError } = await supabase.rpc(
          "manager_update_staff_audited",
          {
            p_manager_id: managerStatus.id,
            p_staff_id: staffId,
            p_name: name,
            p_department: department,
            p_new_pin: newPin || null,
            p_role: requestedRole || null,
          }
        );
        if (updateStaffError) {
          const code = dbErrorCode(updateStaffError);
          if (["PIN_IN_USE", "DEPARTMENT_DENIED", "GM_REQUIRED", "STAFF_NOT_FOUND", "INVALID_ROLE"].includes(code)) {
            return managerDbError(updateStaffError, "Unable to update staff member");
          }
          console.error("Update staff error:", updateStaffError.code || "");
          return json({ error: "Unable to update staff member" }, 400);
        }
        return json({
          success: true,
          action,
          data: {
            staff: {
              id: updated.id,
              name: updated.name,
              department: updated.department,
              location: updated.location,
              role: updated.role,
              active: updated.active,
              created_at: updated.created_at,
            },
          },
        });
      }

      if (
        action ===
        "manager_set_student_visa"
      ) {
        const staffId =
          typeof body.staff_id === "string" ? body.staff_id.trim() : "";
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(staffId)) {
          return json({ error: "Staff member not found" }, 404);
        }
        if (typeof body.student_visa !== "boolean") {
          return json({ error: "student_visa must be true or false" }, 400);
        }
        const { data: visa, error: visaError } = await supabase.rpc(
          "manager_set_student_visa_audited",
          {
            p_manager_id: managerStatus.id,
            p_staff_id: staffId,
            p_student_visa: body.student_visa,
            p_course_break: body.course_break === true,
          }
        );
        if (visaError) {
          const code = dbErrorCode(visaError);
          if (["DEPARTMENT_DENIED", "STAFF_NOT_FOUND"].includes(code)) {
            return managerDbError(visaError, "Unable to update visa details");
          }
          console.error("Student visa error:", visaError.code || "");
          return json({ error: "Unable to update visa details" }, 400);
        }
        return json({ success: true, action, data: { staff: visa } });
      }

      if (
        action ===
        "manager_roster_week"
      ) {
        const requested =
          typeof body.week_start === "string" ? body.week_start.trim() : "";
        const weekStart = requested || getBrisbaneWeekRange().week_start_date;
        if (
          !/^\d{4}-\d{2}-\d{2}$/.test(weekStart) ||
          new Date(`${weekStart}T00:00:00Z`).getUTCDay() !== 1
        ) {
          return json({ error: "Week must start on a Monday", code: "INVALID_INPUT" }, 400);
        }
        const prevStart = addDays(weekStart, -7);

        const [thisWeek, prevWeek] = await Promise.all([
          supabase.rpc("manager_roster_week", {
            p_manager_id: managerStatus.id, p_location: location, p_week_start: weekStart,
          }),
          supabase.rpc("manager_roster_week", {
            p_manager_id: managerStatus.id, p_location: location, p_week_start: prevStart,
          }),
        ]);
        if (thisWeek.error || prevWeek.error) {
          return managerDbError(thisWeek.error || prevWeek.error, "Unable to load the roster", 500);
        }

        const team = (await loadTeam()).filter((m: any) => m.active);
        const visaIds = team.filter((m: any) => m.student_visa).map((m: any) => m.id);

        let shifts: any[] = [];
        if (visaIds.length) {
          const { data: shiftRows, error: shiftError } = await supabase
            .from("shifts")
            .select(`
              staff_id,
              clock_in,
              clock_out,
              breaks (
                break_start,
                break_end
              )
            `)
            .in("staff_id", visaIds)
            .gte("clock_in", new Date(brisbaneDayStart(prevStart) - DAY_MS).toISOString())
            .lt("clock_in", new Date(brisbaneDayStart(weekStart) + 7 * DAY_MS).toISOString());
          if (shiftError) throw shiftError;
          shifts = shiftRows || [];
        }

        // Role service times (Chef, Dishwasher...), best effort: without the
        // table the department times are used, as before.
        let roleServices: any[] = [];
        {
          const { data: rs, error: rsError } = await supabase
            .from("roster_position_services")
            .select("position, service, start_time, end_time")
            .eq("location", thisWeek.data?.location || location);
          if (!rsError) {
            roleServices = (rs || []).map((r: any) => ({
              position: r.position, service: r.service,
              start_time: String(r.start_time || "").slice(0, 5), end_time: String(r.end_time || "").slice(0, 5),
            }));
          }
        }
        const services = [...(thisWeek.data?.services || []), ...roleServices];
        const holidays = await loadPublicHolidays(weekStart, addDays(weekStart, 6));
        const entries = thisWeek.data?.entries || [];
        const hours = computeRosterHours(
          team,
          [...(prevWeek.data?.entries || []), ...entries],
          shifts,
          services,
          weekStart,
          Date.now()
        );

        return json({
          success: true,
          action,
          data: {
            manager: managerStatus,
            location: thisWeek.data?.location || location,
            week_start: weekStart,
            team: team.map((m: any) => ({
              id: m.id,
              name: m.name,
              department: m.department,
              role: m.role,
              student_visa: !!m.student_visa,
              visa_course_break: !!m.visa_course_break,
              position: m.position ?? null,
              roster_only: !!m.roster_only,
              roster_order: m.roster_order ?? null,
            })),
            entries,
            services,
            leave: thisWeek.data?.leave || [],
            holidays,
            planned_hours: hours.planned_hours,
            visa: hours.visa,
          },
        });
      }

      if (
        action ===
        "manager_roster_set"
      ) {
        const staffId =
          typeof body.staff_id === "string" ? body.staff_id.trim() : "";
        const workDate =
          typeof body.work_date === "string" ? body.work_date.trim() : "";
        const code =
          typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
        const startTime =
          typeof body.start_time === "string" ? body.start_time.trim() : "";
        const endTime =
          typeof body.end_time === "string" ? body.end_time.trim() : "";

        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(staffId)) {
          return json({ error: "Staff member not found" }, 404);
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate)) {
          return json({ error: "Invalid date", code: "INVALID_INPUT" }, 400);
        }
        if (code && !["L", "D", "LD", "OFF", "SHIFT"].includes(code)) {
          return json({ error: "Invalid roster code", code: "INVALID_INPUT" }, 400);
        }
        const timeOk = (t: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
        if (code === "SHIFT" && (!timeOk(startTime) || !timeOk(endTime) || startTime === endTime)) {
          return json({ error: "Enter a start and finish time", code: "INVALID_INPUT" }, 400);
        }

        const { data: cell, error: cellError } = await supabase.rpc("manager_roster_set", {
          p_manager_id: managerStatus.id,
          p_staff_id: staffId,
          p_work_date: workDate,
          p_code: code || null,
          p_start: code === "SHIFT" ? startTime : null,
          p_end: code === "SHIFT" ? endTime : null,
        });
        if (cellError) {
          return managerDbError(cellError, "Unable to save the roster");
        }
        return json({ success: true, action, data: { cell } });
      }

      if (
        action === "manager_leave_list" ||
        action === "manager_leave_decide" ||
        action === "manager_leave_create"
      ) {
        const isUuid = (v: string) =>
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
        const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);

        if (action === "manager_leave_decide") {
          const leaveId = typeof body.leave_id === "string" ? body.leave_id.trim() : "";
          const decision = typeof body.decision === "string" ? body.decision.trim().toUpperCase() : "";
          if (!isUuid(leaveId) || !["APPROVE", "DECLINE", "CANCEL"].includes(decision)) {
            return json({ error: "Invalid request", code: "INVALID_INPUT" }, 400);
          }
          const { data, error } = await supabase.rpc("manager_leave_decide", {
            p_manager_id: managerStatus.id, p_leave_id: leaveId, p_decision: decision,
          });
          if (error) return managerDbError(error, "Unable to update the request");
          return json({ success: true, action, data: { request: data } });
        }

        if (action === "manager_leave_create") {
          const staffId = typeof body.staff_id === "string" ? body.staff_id.trim() : "";
          const kind = typeof body.kind === "string" ? body.kind.trim().toUpperCase() : "";
          const start = typeof body.start_date === "string" ? body.start_date.trim() : "";
          const end = typeof body.end_date === "string" && body.end_date.trim() ? body.end_date.trim() : start;
          const note = typeof body.note === "string" ? body.note.trim().slice(0, 200) : "";
          if (!isUuid(staffId) || !["HOLIDAY", "DAY_OFF"].includes(kind) || !isDate(start) || !isDate(end)) {
            return json({ error: "Choose the person, the type and the dates.", code: "INVALID_INPUT" }, 400);
          }
          const { data, error } = await supabase.rpc("manager_leave_create", {
            p_manager_id: managerStatus.id, p_staff_id: staffId, p_kind: kind,
            p_start: start, p_end: end, p_note: note || null,
          });
          if (error) return managerDbError(error, "Unable to add the time off");
          return json({ success: true, action, data: { request: data } });
        }

        // List: everything pending, plus pending/approved from today for 120 days.
        const today = new Date(Date.now() + BRISBANE_OFFSET_MS).toISOString().slice(0, 10);
        const until = new Date(Date.parse(`${today}T00:00:00Z`) + 120 * DAY_MS).toISOString().slice(0, 10);
        const [pending, upcoming] = await Promise.all([
          supabase.rpc("manager_leave_list", {
            p_manager_id: managerStatus.id, p_location: location, p_from: null, p_to: null,
          }),
          supabase.rpc("manager_leave_list", {
            p_manager_id: managerStatus.id, p_location: location, p_from: today, p_to: until,
          }),
        ]);
        if (pending.error || upcoming.error) {
          return managerDbError(pending.error || upcoming.error, "Unable to load time off", 500);
        }
        const team = (await loadTeam())
          .filter((m: any) => m.active)
          .map((m: any) => ({ id: m.id, name: m.name, department: m.department, role: m.role }));
        return json({
          success: true,
          action,
          data: {
            manager: managerStatus,
            location,
            today,
            pending: pending.data || [],
            upcoming: (upcoming.data || []).filter((r: any) => r.status === "APPROVED"),
            team,
          },
        });
      }

      // =========================
      // ROSTER ROLE / ROSTER-ONLY PEOPLE
      // =========================
      if (action === "manager_set_roster_order") {
        const ids = Array.isArray(body.staff_ids) ? body.staff_ids : [];
        const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!ids.length || ids.length > 200 || !ids.every((x: any) => typeof x === "string" && uuid.test(x)) ||
            new Set(ids).size !== ids.length) {
          return json({ error: "Invalid order", code: "INVALID_INPUT" }, 400);
        }
        const { data, error } = await supabase.rpc("manager_set_roster_order_audited", {
          p_manager_id: managerStatus.id, p_staff_ids: ids,
        });
        if (error) return managerDbError(error, "Unable to save the order");
        return json({ success: true, action, data });
      }

      if (action === "manager_set_roster_info" || action === "manager_create_roster_person") {
        const positions: Record<string, string[]> = { Kitchen: ["Chef", "Dishwasher"], Floor: ["Floor", "Bar"] };
        const position = typeof body.position === "string" && body.position.trim() ? body.position.trim() : null;
        if (position && !["Chef", "Dishwasher", "Floor", "Bar"].includes(position)) {
          return json({ error: "Choose Chef, Dishwasher, Floor or Bar.", code: "INVALID_INPUT" }, 400);
        }
        if (action === "manager_set_roster_info") {
          const staffId = typeof body.staff_id === "string" ? body.staff_id.trim() : "";
          if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(staffId)) {
            return json({ error: "Staff member not found" }, 404);
          }
          const { data, error } = await supabase.rpc("manager_set_roster_info_audited", {
            p_manager_id: managerStatus.id, p_staff_id: staffId,
            p_position: position, p_roster_only: body.roster_only === true,
          });
          if (error) return managerDbError(error, "Unable to save the roster details");
          return json({ success: true, action, data: { staff: data } });
        }
        const name = typeof body.name === "string" ? body.name.trim().slice(0, 80) : "";
        const department = managerDepartmentScope ||
          (typeof body.department === "string" ? body.department.trim() : "");
        if (!name || !positions[department] || (position && !positions[department].includes(position))) {
          return json({ error: "Enter the name and choose the department and role.", code: "INVALID_INPUT" }, 400);
        }
        const { data, error } = await supabase.rpc("manager_create_roster_person_audited", {
          p_manager_id: managerStatus.id, p_name: name, p_department: department, p_position: position,
        });
        if (error) return managerDbError(error, "Unable to add the person");
        return json({ success: true, action, data: { staff: data } });
      }

      // =========================
      // STOCK PAR LEVEL
      // =========================
      if (action.startsWith("manager_stock_")) {
        const isUuid = (v: string) =>
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
        const department =
          typeof body.department === "string" && ["Floor", "Kitchen"].includes(body.department.trim())
            ? body.department.trim() : null;
        const num = (v: any) => {
          if (v === null || v === undefined || v === "") return null;
          const n = typeof v === "number" ? v : Number(String(v).trim());
          return Number.isFinite(n) ? n : NaN;
        };
        const text = (v: any, max: number) =>
          typeof v === "string" ? v.trim().slice(0, max) : "";

        if (action === "manager_stock_list") {
          const { data, error } = await supabase.rpc("manager_stock_list", {
            p_manager_id: managerStatus.id, p_location: location, p_department: department,
          });
          if (error) return managerDbError(error, "Unable to load the stock list", 500);
          return json({ success: true, action, data });
        }

        if (action === "manager_stock_item_save") {
          const it = body.item && typeof body.item === "object" ? body.item : {};
          const id = typeof it.id === "string" ? it.id.trim() : "";
          if (id && !isUuid(id)) return json({ error: "Item not found", code: "STOCK_ITEM_NOT_FOUND" }, 404);
          const par = num(it.par), parExtra = num(it.par_extra), caseSize = num(it.case_size), sortOrder = num(it.sort_order);
          const orderBy = it.order_by === "box" ? "box" : "unit";
          const name = text(it.name, 80), group = text(it.group_name, 40);
          const bad = (n: number | null, max: number, whole = false) =>
            n !== null && (Number.isNaN(n) || n < 0 || n > max || (whole && !Number.isInteger(n)));
          if (!name || !group || par === null || bad(par, 9999) || bad(parExtra, 9999) ||
              bad(caseSize, 999, true) || caseSize === 0 || bad(sortOrder, 1000000, true) ||
              (orderBy === "box" && !caseSize)) {
            return json({ error: "Check the item: name, group and par are needed; boxes need a box size.", code: "INVALID_INPUT" }, 400);
          }
          const item = {
            id: id || null,
            department: department ||
              (typeof it.department === "string" && ["Floor", "Kitchen"].includes(it.department) ? it.department : null),
            group_name: group, name,
            supplier: text(it.supplier, 60) || null, unit: text(it.unit, 20) || null,
            case_size: caseSize, order_by: orderBy, par, par_extra: parExtra,
            extra_label: parExtra === null ? null : (text(it.extra_label, 20) || null),
            note: text(it.note, 200) || null, sort_order: sortOrder,
          };
          const { data, error } = await supabase.rpc("manager_stock_item_save", {
            p_manager_id: managerStatus.id, p_location: location, p_item: item,
          });
          if (error) return managerDbError(error, "Unable to save the item");
          return json({ success: true, action, data: { item: data } });
        }

        if (action === "manager_stock_item_remove") {
          const id = typeof body.item_id === "string" ? body.item_id.trim() : "";
          if (!isUuid(id)) return json({ error: "Item not found", code: "STOCK_ITEM_NOT_FOUND" }, 404);
          const { data, error } = await supabase.rpc("manager_stock_item_remove", {
            p_manager_id: managerStatus.id, p_location: location, p_item_id: id,
          });
          if (error) return managerDbError(error, "Unable to remove the item");
          return json({ success: true, action, data: { item: data } });
        }

        if (action === "manager_stock_supplier_save") {
          const name = text(body.name, 60);
          const minOrder = num(body.min_order);
          if (!name || (minOrder !== null && (Number.isNaN(minOrder) || !Number.isInteger(minOrder) || minOrder < 1 || minOrder > 999))) {
            return json({ error: "Enter the supplier name and a minimum order from 1 to 999 (or leave it empty).", code: "INVALID_INPUT" }, 400);
          }
          const { data, error } = await supabase.rpc("manager_stock_supplier_save", {
            p_manager_id: managerStatus.id, p_location: location, p_department: department,
            p_name: name, p_min_order: minOrder, p_note: text(body.note, 200) || null,
          });
          if (error) return managerDbError(error, "Unable to save the supplier");
          return json({ success: true, action, data: { supplier: data } });
        }

        if (action === "manager_stock_supplier_rename") {
          const from = text(body.from, 60), to = text(body.to, 60);
          if (!from || !to) {
            return json({ error: "Enter the new supplier name.", code: "INVALID_INPUT" }, 400);
          }
          const { data, error } = await supabase.rpc("manager_stock_supplier_rename", {
            p_manager_id: managerStatus.id, p_location: location, p_department: department,
            p_old: from, p_new: to,
          });
          if (error) return managerDbError(error, "Unable to rename the supplier");
          return json({ success: true, action, data: { supplier: data } });
        }

        if (action === "manager_stock_count_close") {
          const { data, error } = await supabase.rpc("manager_stock_count_close", {
            p_manager_id: managerStatus.id, p_location: location, p_department: department,
          });
          if (error) return managerDbError(error, "Unable to start a new count");
          return json({ success: true, action, data });
        }

        // manager_stock_count_save
        const raw = Array.isArray(body.lines) ? body.lines : null;
        if (!raw || raw.length > 1000) {
          return json({ error: "Nothing to save", code: "INVALID_INPUT" }, 400);
        }
        const lines: any[] = [];
        for (const l of raw) {
          const itemId = l && typeof l.item_id === "string" ? l.item_id.trim() : "";
          const qty = num(l?.qty), qtyExtra = num(l?.qty_extra);
          if (!isUuid(itemId)) continue;
          for (const n of [qty, qtyExtra]) {
            if (n !== null && (Number.isNaN(n) || n < 0 || n > 99999)) {
              return json({ error: "Counts must be numbers from 0 up.", code: "INVALID_INPUT" }, 400);
            }
          }
          if (qty === null && qtyExtra === null) continue;
          lines.push({ item_id: itemId, qty, qty_extra: qtyExtra });
        }
        if (!lines.length) {
          return json({ error: "Count at least one item before saving.", code: "INVALID_INPUT" }, 400);
        }
        const { data, error } = await supabase.rpc("manager_stock_count_save", {
          p_manager_id: managerStatus.id, p_location: location, p_department: department, p_lines: lines,
        });
        if (error) return managerDbError(error, "Unable to save the count");
        return json({ success: true, action, data: { count: data } });
      }

      if (
        action ===
        "manager_toggle_staff"
      ) {
        const staffId =
          typeof body.staff_id === "string" ? body.staff_id.trim() : "";
        if (!staffId) {
          return json({ error: "Staff ID is required" }, 400);
        }
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(staffId)) {
          return json({ error: "Staff member not found" }, 404);
        }
        const { data: toggled, error: toggleError } = await supabase.rpc(
          "manager_toggle_staff_audited",
          { p_manager_id: managerStatus.id, p_staff_id: staffId }
        );
        if (toggleError) {
          return managerDbError(toggleError, "Unable to update staff member", 500);
        }
        return json({
          success: true,
          action,
          data: {
            staff: {
              id: toggled.id,
              name: toggled.name,
              department: toggled.department,
              location: toggled.location,
              role: toggled.role,
              active: toggled.active,
              created_at: toggled.created_at,
            },
          },
        });
      }

      // =========================
      // AUTHORISED DEVICES (Administrator only, owner's decision 2026-10-20)
      // =========================

      if (
        (action === "manager_devices" ||
          action === "manager_device_code" ||
          action === "manager_device_revoke" ||
          action === "manager_device_unlock" ||
          action === "manager_device_rename") &&
        !isGeneralManager
      ) {
        return json({ error: "Only the Administrator can manage devices", code: "GM_REQUIRED" }, 403);
      }

      if (action === "manager_devices") {
        const { data, error } = await supabase.rpc("auth_list_devices", {
          p_manager_id: managerStatus.id,
          p_current_device_hash: deviceHash,
        });
        if (error) return managerDbError(error, "Unable to load devices", 500);

        // Who signed in on each device in the last 30 days (newest first), so the
        // Administrator can tell a shared tablet (many names) from a phone (one).
        // Read-only and best-effort: if it fails, the list still loads without it.
        try {
          const ids = (data?.devices || []).map((d: any) => d.id).filter(Boolean);
          if (ids.length) {
            const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
            const { data: rows, error: usedError } = await supabase
              .from("staff_sessions")
              .select("device_id, staff_id, created_at")
              .in("device_id", ids)
              .gte("created_at", since)
              .order("created_at", { ascending: false });
            if (usedError) throw usedError;
            const staffIds = [...new Set((rows || []).map((r: any) => r.staff_id))];
            const names: Record<string, string> = {};
            if (staffIds.length) {
              const { data: people, error: peopleError } = await supabase
                .from("staff")
                .select("id, name")
                .in("id", staffIds);
              if (peopleError) throw peopleError;
              for (const p of people || []) names[p.id] = p.name;
            }
            const usedBy: Record<string, string[]> = {};
            const seen: Record<string, Set<string>> = {};
            for (const r of rows || []) {
              const list = (usedBy[r.device_id] ||= []);
              const ids2 = (seen[r.device_id] ||= new Set());
              if (ids2.has(r.staff_id)) continue;
              ids2.add(r.staff_id);
              list.push(names[r.staff_id] || "Staff");
            }
            for (const d of data.devices) {
              d.used_by = usedBy[d.id] || [];
            }
          }
        } catch (usedErr) {
          console.error("Device users unavailable:", (usedErr as any)?.code || "");
        }
        return json({ success: true, action, data });
      }

      if (action === "manager_device_code") {
        const code = createPairingCode();
        const label =
          typeof body.label === "string" ? body.label.trim().slice(0, 60) : "";
        const { data, error } = await supabase.rpc("auth_create_pairing_code", {
          p_manager_id: managerStatus.id,
          p_code_hash: await sha256Hex(code),
          p_label: label || null,
        });
        if (error) return managerDbError(error, "Unable to create a device code", 500);
        authLog("pairing_code", { created: true });
        return json({
          success: true,
          action,
          data: { code: code.slice(0, 4) + "-" + code.slice(4), expires_at: data.expires_at },
        });
      }

      if (
        action === "manager_device_revoke" ||
        action === "manager_device_unlock" ||
        action === "manager_device_rename"
      ) {
        const deviceId =
          typeof body.device_id === "string" ? body.device_id.trim() : "";
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(deviceId)) {
          return json({ error: "Device not found" }, 404);
        }
        const rpcName =
          action === "manager_device_revoke"
            ? "auth_revoke_device"
            : action === "manager_device_unlock"
              ? "auth_unlock_device"
              : "auth_rename_device";
        const args: Record<string, unknown> = {
          p_manager_id: managerStatus.id,
          p_device_id: deviceId,
        };
        if (action === "manager_device_rename") {
          args.p_label = typeof body.label === "string" ? body.label : "";
        }
        const { data, error } = await supabase.rpc(rpcName, args);
        if (error) return managerDbError(error, "Unable to update the device", 500);
        return json({ success: true, action, data });
      }

      if (action === "manager_auth_mode") {
        const mode = typeof body.mode === "string" ? body.mode.trim() : "";
        if (mode !== "grace" && mode !== "enforce") {
          return json({ error: "Mode must be grace or enforce" }, 400);
        }
        const { data, error } = await supabase.rpc("auth_set_mode", {
          p_manager_id: managerStatus.id,
          p_mode: mode,
        });
        if (error) {
          if (dbErrorCode(error) === "GM_REQUIRED") {
            return json({ error: "Only the General Manager can change this setting", code: "GM_REQUIRED" }, 403);
          }
          return managerDbError(error, "Unable to change the setting", 500);
        }
        authLog("mode", { mode });
        return json({ success: true, action, data });
      }

      if (
        action ===
        "manager_team"
      ) {

        return json({

          success: true,

          action,

          data: {

            manager:
              managerStatus,

            ...(await (async () => {
              const team = await loadTeam();
              return { team, visa_hours: await loadVisaHours(team) };
            })()),
          },
        });
      }


      if (
        action ===
        "manager_working"
      ) {

        return json({

          success: true,

          action,

          data: {

            manager:
              managerStatus,

            working:
              await loadWorking(),
          },
        });
      }


      if (
        action ===
        "manager_hours"
      ) {

        return json({

          success: true,

          action,

          data: {

            manager:
              managerStatus,

            ...(await loadHours(
              typeof body.week_start === "string"
                ? body.week_start.trim()
                : undefined
            )),
          },
        });
      }


      // FULL DASHBOARD

      const [
        team,
        working,
        hours,
      ] =
        await Promise.all([

          loadTeam(),

          loadWorking(),

          loadHours(),
        ]);


      return json({

        success: true,

        action:
          "manager_dashboard",

        data: {

          manager:
            managerStatus,

          location,

          generated_at:
            new Date()
              .toISOString(),

          team,

          working,

          hours,

          visa_hours:
            await loadVisaHours(team),

          upcoming_holidays:
            await (async () => {
              const today = new Date(Date.now() + BRISBANE_OFFSET_MS).toISOString().slice(0, 10);
              return loadPublicHolidays(today, addDays(today, 14));
            })(),

          counts: {

            active_staff:
              team.length,

            working_now:
              working.length,

            unapproved_shifts:
              hours.shifts.filter(
                (shift: any) =>
                  !shift.approved &&
                  !!shift.clock_out
              ).length,
          },
        },
      });

    } catch (managerError) {

      console.error(
        "Manager action error:",
        managerError
      );

      if (
        managerError instanceof Error &&
        managerError.message ===
          "INVALID_WEEK_DATE"
      ) {
        return json(
          {
            error:
              "week_start must be YYYY-MM-DD",
          },
          400
        );
      }

      return json(
        {
          error:
            "Unable to load manager data",
        },
        500
      );
    }

  } catch (error) {

    console.error(
      "Unexpected error:",
      error
    );

    return json(
      {
        error:
          "Internal server error",
      },
      500
    );
  }
});
