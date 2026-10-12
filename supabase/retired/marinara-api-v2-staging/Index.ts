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


const MAX_PIN_ATTEMPTS = 5;
const PIN_LOCK_MINUTES = 10;

// This is intentionally a global PIN-entry guard for this first production
// hardening step. It never stores the PIN itself.
const PIN_ATTEMPT_KEY = "hawthorne-pin-entry";

async function getPinAttemptState(supabase: any) {
  const { data, error } = await supabase
    .from("pin_attempts")
    .select("failed_attempts, locked_until, last_attempt_at")
    .eq("attempt_key", PIN_ATTEMPT_KEY)
    .maybeSingle();

  if (error) throw error;

  return data || {
    failed_attempts: 0,
    locked_until: null,
    last_attempt_at: null,
  };
}

async function checkPinLock(supabase: any) {
  const state = await getPinAttemptState(supabase);

  if (!state.locked_until) {
    return { locked: false, retry_after_seconds: 0 };
  }

  const remainingMs =
    new Date(state.locked_until).getTime() - Date.now();

  if (remainingMs <= 0) {
    await supabase
      .from("pin_attempts")
      .upsert(
        {
          attempt_key: PIN_ATTEMPT_KEY,
          failed_attempts: 0,
          locked_until: null,
          last_attempt_at: new Date().toISOString(),
        },
        { onConflict: "attempt_key" }
      );

    return { locked: false, retry_after_seconds: 0 };
  }

  return {
    locked: true,
    retry_after_seconds: Math.ceil(remainingMs / 1000),
  };
}

async function recordFailedPin(supabase: any) {
  const state = await getPinAttemptState(supabase);
  const nextFailedAttempts =
    Number(state.failed_attempts || 0) + 1;

  const shouldLock =
    nextFailedAttempts >= MAX_PIN_ATTEMPTS;

  const lockedUntil = shouldLock
    ? new Date(
        Date.now() +
          PIN_LOCK_MINUTES * 60 * 1000
      ).toISOString()
    : null;

  const { error } = await supabase
    .from("pin_attempts")
    .upsert(
      {
        attempt_key: PIN_ATTEMPT_KEY,
        failed_attempts: shouldLock
          ? MAX_PIN_ATTEMPTS
          : nextFailedAttempts,
        locked_until: lockedUntil,
        last_attempt_at: new Date().toISOString(),
      },
      { onConflict: "attempt_key" }
    );

  if (error) throw error;

  return {
    locked: shouldLock,
    attempts_remaining: shouldLock
      ? 0
      : MAX_PIN_ATTEMPTS - nextFailedAttempts,
    retry_after_seconds: shouldLock
      ? PIN_LOCK_MINUTES * 60
      : 0,
  };
}

async function clearFailedPins(supabase: any) {
  const { error } = await supabase
    .from("pin_attempts")
    .upsert(
      {
        attempt_key: PIN_ATTEMPT_KEY,
        failed_attempts: 0,
        locked_until: null,
        last_attempt_at: new Date().toISOString(),
      },
      { onConflict: "attempt_key" }
    );

  if (error) throw error;
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

async function createStaffSession(
  supabase: any,
  staffId: string
) {
  const token =
    createSessionToken();

  const tokenHash =
    await sha256Hex(token);

  const expiresAt =
    new Date(
      Date.now() +
      SESSION_HOURS * 60 * 60 * 1000
    ).toISOString();

  const { error } =
    await supabase
      .from("staff_sessions")
      .insert({
        staff_id: staffId,
        token_hash: tokenHash,
        expires_at: expiresAt,
        last_used_at:
          new Date().toISOString(),
      });

  if (error) throw error;

  return {
    token,
    expires_at: expiresAt,
  };
}


async function validateStaffSession(
  supabase: any,
  token: string
) {
  if (!token) {
    return { ok: false, error: "Session token is required" };
  }

  const tokenHash = await sha256Hex(token);
  const nowIso = new Date().toISOString();

  const { data: session, error: sessionError } =
    await supabase
      .from("staff_sessions")
      .select("id, staff_id, expires_at, revoked_at")
      .eq("token_hash", tokenHash)
      .is("revoked_at", null)
      .gt("expires_at", nowIso)
      .maybeSingle();

  if (sessionError) throw sessionError;
  if (!session) {
    return { ok: false, error: "Invalid or expired session" };
  }

  const { data: staff, error: staffError } =
    await supabase
      .from("staff")
      .select("id, name, department, location, role, active")
      .eq("id", session.staff_id)
      .eq("active", true)
      .maybeSingle();

  if (staffError) throw staffError;
  if (!staff) {
    return { ok: false, error: "Staff account is inactive or unavailable" };
  }

  const { error: touchError } =
    await supabase
      .from("staff_sessions")
      .update({ last_used_at: nowIso })
      .eq("id", session.id);

  if (touchError) throw touchError;

  return {
    ok: true,
    staff,
    expires_at: session.expires_at,
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
            token
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
    if (action === "session_my_hours") {
      try {
        const token =
          typeof body.token === "string"
            ? body.token.trim()
            : "";

        const sessionResult =
          await validateStaffSession(supabase, token);

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
          await validateStaffSession(supabase, token);

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
          console.error(
            `${sessionRpc} RPC error:`,
            error.message
          );
          return json(
            { error: error.message },
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
    // PIN ATTEMPT PROTECTION
    // =========================

    // Only check the PIN lock when this request is actually using a PIN.
    if (pin) {
    try {
      const pinLock =
        await checkPinLock(supabase);

      if (pinLock.locked) {
        return pinLockedResponse(
          pinLock.retry_after_seconds
        );
      }
    } catch (pinProtectionError) {
      console.error(
        "PIN protection check error:",
        pinProtectionError
      );

      return json(
        { error: "Unable to validate PIN safely" },
        500
      );
    }
    }


    // =========================
    // NORMAL TIME CLOCK ACTIONS
    // =========================

    // Production rule:
    // PIN is used only to establish a secure session.
    // All time-clock operations use the session_* token routes above.
    const staffActions: Record<
      string,
      {
        functionName: string;
        parameterName: string;
      }
    > = {
      login: {
        functionName: "login_with_pin",
        parameterName: "p_pin",
      },
    };

    const selectedAction =
      staffActions[action];

    if (selectedAction) {

      const { data, error } =
        await supabase.rpc(
          selectedAction.functionName,
          {
            [selectedAction.parameterName]:
              pin,
          }
        );

      if (error) {

        console.error(
          `${selectedAction.functionName} RPC error:`,
          error.message
        );

        if (
          error.message.includes(
            "INVALID_PIN"
          ) ||
          error.message
            .toLowerCase()
            .includes("invalid pin")
        ) {

          try {
            const failure =
              await recordFailedPin(supabase);

            if (failure.locked) {
              return pinLockedResponse(
                failure.retry_after_seconds
              );
            }

            return json(
              {
                error: "Invalid PIN",
                attempts_remaining:
                  failure.attempts_remaining,
              },
              401
            );
          } catch (pinProtectionError) {
            console.error(
              "PIN protection write error:",
              pinProtectionError
            );

            return json(
              { error: "Invalid PIN" },
              401
            );
          }
        }

        return json(
          {
            error:
              "Unable to complete action",
          },
          400
        );
      }

      try {
        await clearFailedPins(supabase);
      } catch (pinProtectionError) {
        console.error(
          "PIN protection reset error:",
          pinProtectionError
        );
      }

      if (action === "login") {
        function extractStaffId(value: any): string | null {
          if (!value) return null;

          if (Array.isArray(value)) {
            for (const item of value) {
              const found = extractStaffId(item);
              if (found) return found;
            }
            return null;
          }

          if (typeof value === "object") {
            if (typeof value.staff_id === "string" && value.staff_id) {
              return value.staff_id;
            }

            if (value.staff && typeof value.staff.id === "string" && value.staff.id) {
              return value.staff.id;
            }

            if (typeof value.id === "string" && value.id) {
              return value.id;
            }

            if (value.data) {
              const found = extractStaffId(value.data);
              if (found) return found;
            }
          }

          return null;
        }

        const staffId = extractStaffId(data);

        if (!staffId) {
          console.error(
            "Unable to create session: login response has no staff ID"
          );

          return json(
            { error: "Unable to create secure session" },
            500
          );
        }

        try {
          const session =
            await createStaffSession(
              supabase,
              staffId
            );

          return json({
            success: true,
            action,
            data,
            session,
          });
        } catch (sessionError) {
          console.error(
            "Create session error:",
            sessionError
          );

          return json(
            { error: "Unable to create secure session" },
            500
          );
        }
      }

      return json({
        success: true,
        action,
        data,
      });
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
          managerToken
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

      const { data, error } =
        await supabase
          .from("staff")
          .select(`
            id,
            name,
            department,
            location,
            role,
            active,
            created_at
          `)
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
          typeof body.shift_id === "string"
            ? body.shift_id.trim()
            : "";

        const clockIn =
          typeof body.clock_in === "string"
            ? body.clock_in.trim()
            : "";

        const clockOut =
          typeof body.clock_out === "string"
            ? body.clock_out.trim()
            : "";

        const breakMinutes =
          Number(body.break_minutes ?? 0);

        if (!shiftId) {
          return json(
            { error: "Shift ID is required" },
            400
          );
        }

        const clockInDate = new Date(clockIn);
        const clockOutDate = new Date(clockOut);

        if (
          !clockIn ||
          !clockOut ||
          Number.isNaN(clockInDate.getTime()) ||
          Number.isNaN(clockOutDate.getTime())
        ) {
          return json(
            { error: "Valid Clock In and Clock Out are required" },
            400
          );
        }

        if (clockOutDate <= clockInDate) {
          return json(
            { error: "Clock Out must be after Clock In" },
            400
          );
        }

        if (
          !Number.isFinite(breakMinutes) ||
          breakMinutes < 0 ||
          breakMinutes > 720
        ) {
          return json(
            { error: "Break minutes are invalid" },
            400
          );
        }

        const shiftMinutes =
          (clockOutDate.getTime() - clockInDate.getTime()) / 60000;

        if (breakMinutes >= shiftMinutes) {
          return json(
            { error: "Break cannot be as long as the whole shift" },
            400
          );
        }

        const {
          data: existingShift,
          error: existingShiftError,
        } = await supabase
          .from("shifts")
          .select(`
            id,
            staff_id,
            clock_in,
            clock_out,
            approved,

            staff!inner (
              location,
              department,
              active
            )
          `)
          .eq("id", shiftId)
          .eq("staff.location", location)
          .eq("staff.active", true)
          .maybeSingle();

        if (existingShiftError) {
          throw existingShiftError;
        }

        if (!existingShift) {
          return json(
            { error: "Shift not found" },
            404
          );
        }

        if (
          managerDepartmentScope &&
          existingShift.staff?.department !== managerDepartmentScope
        ) {
          return json({ error: "Access denied for this department" }, 403);
        }

        if (!existingShift.clock_out) {
          return json(
            { error: "Active shifts cannot be edited here" },
            400
          );
        }

        if (existingShift.approved) {
          return json(
            { error: "Approved shifts cannot be edited here" },
            400
          );
        }

        const { error: updateShiftError } =
          await supabase
            .from("shifts")
            .update({
              clock_in: clockInDate.toISOString(),
              clock_out: clockOutDate.toISOString(),
              status: "completed",
            })
            .eq("id", shiftId);

        if (updateShiftError) {
          throw updateShiftError;
        }

        const { error: deleteBreakError } =
          await supabase
            .from("breaks")
            .delete()
            .eq("shift_id", shiftId);

        if (deleteBreakError) {
          throw deleteBreakError;
        }

        if (breakMinutes > 0) {
          const breakEnd =
            new Date(clockOutDate.getTime());

          const breakStart =
            new Date(
              breakEnd.getTime() -
              breakMinutes * 60000
            );

          const { error: insertBreakError } =
            await supabase
              .from("breaks")
              .insert({
                shift_id: shiftId,
                break_start: breakStart.toISOString(),
                break_end: breakEnd.toISOString(),
              });

          if (insertBreakError) {
            throw insertBreakError;
          }
        }

        const {
          data: updatedShift,
          error: updatedShiftError,
        } = await supabase
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
          .eq("id", shiftId)
          .single();

        if (updatedShiftError) {
          throw updatedShiftError;
        }

        return json({
          success: true,
          action,
          data: {
            shift: {
              ...updatedShift,
              break_minutes: Math.round(breakMinutes),
              hours: Number(
                calculateHours(updatedShift).toFixed(2)
              ),
            },
          },
        });
      }


      if (
        action ===
        "manager_delete_shift"
      ) {

        const shiftId =
          typeof body.shift_id === "string"
            ? body.shift_id.trim()
            : "";

        if (!shiftId) {
          return json(
            { error: "Shift ID is required" },
            400
          );
        }

        const {
          data: shift,
          error: shiftError,
        } = await supabase
          .from("shifts")
          .select(`
            id,
            staff_id,
            clock_in,
            clock_out,
            approved,

            staff!inner (
              location,
              department,
              active
            )
          `)
          .eq("id", shiftId)
          .eq("staff.location", location)
          .maybeSingle();

        if (shiftError) {
          throw shiftError;
        }

        if (!shift) {
          return json(
            { error: "Shift not found" },
            404
          );
        }

        if (
          managerDepartmentScope &&
          shift.staff?.department !== managerDepartmentScope
        ) {
          return json({ error: "Access denied for this department" }, 403);
        }

        if (!shift.clock_out) {
          return json(
            { error: "Active shifts cannot be deleted here" },
            400
          );
        }

        if (shift.approved) {
          return json(
            { error: "Approved shifts cannot be deleted here" },
            400
          );
        }

        const { error: deleteError } =
          await supabase
            .from("shifts")
            .delete()
            .eq("id", shiftId);

        if (deleteError) {
          throw deleteError;
        }

        return json({
          success: true,
          action,
          data: {
            deleted: true,
            shift_id: shiftId,
          },
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

        if (
          !Number.isFinite(breakMinutes) ||
          breakMinutes < 0 ||
          breakMinutes > 720
        ) {
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

        const { data: employee, error: employeeError } =
          await supabase
            .from("staff")
            .select("id,name,department,location,role,active")
            .eq("id", staffId)
            .eq("location", location)
            .eq("active", true)
            .maybeSingle();

        if (employeeError) throw employeeError;

        if (!employee) {
          return json({ error: "Employee not found" }, 404);
        }

        if (
          managerDepartmentScope &&
          employee.department !== managerDepartmentScope
        ) {
          return json({ error: "Access denied for this department" }, 403);
        }

        const manualNote =
          notes
            ? `[MANUALLY CREATED] ${notes}`
            : "[MANUALLY CREATED]";

        const { data: createdShift, error: createShiftError } =
          await supabase
            .from("shifts")
            .insert({
              staff_id: staffId,
              clock_in: inDate.toISOString(),
              clock_out: outDate.toISOString(),
              status: "completed",
              approved: false,
              notes: manualNote,
            })
            .select("id,staff_id,clock_in,clock_out,status,approved,notes")
            .single();

        if (createShiftError) throw createShiftError;

        if (breakMinutes > 0) {
          const breakStartMs =
            inDate.getTime() +
            Math.floor(
              ((outDate.getTime() - inDate.getTime()) -
                breakMinutes * 60000) / 2
            );

          const breakStart = new Date(breakStartMs);
          const breakEnd = new Date(
            breakStartMs + breakMinutes * 60000
          );

          const { error: breakError } =
            await supabase
              .from("breaks")
              .insert({
                shift_id: createdShift.id,
                break_start: breakStart.toISOString(),
                break_end: breakEnd.toISOString(),
              });

          if (breakError) {
            await supabase
              .from("shifts")
              .delete()
              .eq("id", createdShift.id);
            throw breakError;
          }
        }

        return json({
          success: true,
          action,
          data: {
            shift: createdShift,
            employee,
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
          typeof body.shift_id === "string"
            ? body.shift_id.trim()
            : "";

        if (!shiftId) {

          return json(
            {
              error:
                "Shift ID is required",
            },
            400
          );
        }

        const {
          data: shift,
          error: shiftError,
        } = await supabase
          .from("shifts")
          .select(`
            id,
            staff_id,
            clock_in,
            clock_out,
            approved,

            staff!inner (
              location,
              department,
              active
            )
          `)
          .eq(
            "id",
            shiftId
          )
          .eq(
            "staff.location",
            location
          )
          .eq(
            "staff.active",
            true
          )
          .maybeSingle();

        if (shiftError) {
          throw shiftError;
        }

        if (!shift) {

          return json(
            {
              error:
                "Shift not found",
            },
            404
          );
        }

        if (
          managerDepartmentScope &&
          shift.staff?.department !== managerDepartmentScope
        ) {
          return json({ error: "Access denied for this department" }, 403);
        }

        if (
          managerDepartmentScope &&
          shift.staff?.department !== managerDepartmentScope
        ) {
          return json({ error: "Access denied for this department" }, 403);
        }

        if (!shift.clock_out) {

          return json(
            {
              error:
                "Active shifts cannot be approved",
            },
            400
          );
        }

        const {
          data: approvedShift,
          error: approveError,
        } = await supabase
          .from("shifts")
          .update({
            approved: true,
          })
          .eq(
            "id",
            shiftId
          )
          .select(`
            id,
            staff_id,
            clock_in,
            clock_out,
            approved
          `)
          .single();

        if (approveError) {
          throw approveError;
        }

        return json({

          success: true,

          action,

          data: {

            shift:
              approvedShift,
          },
        });
      }


      if (
        action ===
        "manager_reopen_shift"
      ) {
        const shiftId =
          typeof body.shift_id === "string"
            ? body.shift_id.trim()
            : "";

        if (!shiftId) {
          return json({ error: "Shift ID is required" }, 400);
        }

        const { data: shift, error: shiftError } = await supabase
          .from("shifts")
          .select(`
            id,
            staff_id,
            clock_in,
            clock_out,
            approved,
            staff!inner (
              location,
              department,
              active
            )
          `)
          .eq("id", shiftId)
          .eq("staff.location", location)
          .eq("staff.active", true)
          .maybeSingle();

        if (shiftError) throw shiftError;
        if (!shift) return json({ error: "Shift not found" }, 404);

        if (
          managerDepartmentScope &&
          shift.staff?.department !== managerDepartmentScope
        ) {
          return json({ error: "Access denied for this department" }, 403);
        }

        if (!shift.clock_out) {
          return json({ error: "Active shifts cannot be reopened" }, 400);
        }

        if (!shift.approved) {
          return json({
            success: true,
            action,
            data: { shift_id: shiftId, approved: false, already_pending: true },
          });
        }

        const { data: reopenedShift, error: reopenError } = await supabase
          .from("shifts")
          .update({ approved: false })
          .eq("id", shiftId)
          .select("id,staff_id,clock_in,clock_out,approved")
          .single();

        if (reopenError) throw reopenError;

        return json({
          success: true,
          action,
          data: { shift: reopenedShift },
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
          typeof body.name === "string"
            ? body.name.trim()
            : "";

        const staffPin =
          typeof body.staff_pin === "string"
            ? body.staff_pin.trim()
            : "";

        const department =
          typeof body.department === "string"
            ? body.department.trim()
            : "";

        if (!name) {
          return json(
            { error: "Name is required" },
            400
          );
        }

        if (!/^[0-9]{4,6}$/.test(staffPin)) {
          return json(
            { error: "PIN must contain 4 to 6 numbers" },
            400
          );
        }

        if (
          department !== "Kitchen" &&
          department !== "Floor"
        ) {
          return json(
            { error: "Department must be Kitchen or Floor" },
            400
          );
        }

        if (!departmentAllowed(department)) {
          return json({ error: "Access denied for this department" }, 403);
        }

        const {
          data: createdStaff,
          error: createStaffError,
        } = await supabase.rpc(
          "manager_create_staff",
          {
            p_name: name,
            p_pin: staffPin,
            p_department: department,
            p_location: location,
          }
        );

        if (createStaffError) {
          console.error(
            "Create staff error:",
            createStaffError.message
          );

          return json(
            { error: "Unable to create staff member" },
            400
          );
        }

        return json({
          success: true,
          action,
          data: {
            staff:
              Array.isArray(createdStaff)
                ? createdStaff[0] || null
                : createdStaff,
          },
        });
      }


      if (
        action ===
        "manager_update_staff"
      ) {

        const staffId =
          typeof body.staff_id === "string"
            ? body.staff_id.trim()
            : "";

        const name =
          typeof body.name === "string"
            ? body.name.trim()
            : "";

        const department =
          typeof body.department === "string"
            ? body.department.trim()
            : "";

        const newPin =
          typeof body.new_pin === "string"
            ? body.new_pin.trim()
            : "";

        const requestedRole =
          typeof body.role === "string"
            ? body.role.trim()
            : "";

        if (!staffId) {
          return json(
            { error: "Staff ID is required" },
            400
          );
        }

        if (!name) {
          return json(
            { error: "Name is required" },
            400
          );
        }

        if (
          department !== "Kitchen" &&
          department !== "Floor"
        ) {
          return json(
            { error: "Department must be Kitchen or Floor" },
            400
          );
        }

        if (
          newPin &&
          !/^[0-9]{4,6}$/.test(newPin)
        ) {
          return json(
            { error: "PIN must contain 4 to 6 numbers" },
            400
          );
        }

        if (
          requestedRole &&
          !["staff", "manager", "kitchen_manager", "floor_manager"].includes(requestedRole)
        ) {
          return json({ error: "Invalid account role" }, 400);
        }

        const {
          data: targetStaff,
          error: targetStaffError,
        } = await supabase
          .from("staff")
          .select(`
            id,
            location,
            department,
            role
          `)
          .eq("id", staffId)
          .eq("location", location)
          .maybeSingle();

        if (targetStaffError) {
          throw targetStaffError;
        }

        if (!targetStaff) {
          return json(
            { error: "Staff member not found" },
            404
          );
        }

        if (
          managerDepartmentScope &&
          (
            targetStaff.department !== managerDepartmentScope ||
            department !== managerDepartmentScope
          )
        ) {
          return json({ error: "Access denied for this department" }, 403);
        }

        if (targetStaff.role !== "staff" && !isGeneralManager) {
          return json({ error: "Only the General Manager can manage manager accounts" }, 403);
        }

        const {
          data: updatedStaff,
          error: updateStaffError,
        } = await supabase.rpc(
          "manager_update_staff",
          {
            p_staff_id: staffId,
            p_name: name,
            p_department: department,
            p_new_pin: newPin || null,
          }
        );

        if (updateStaffError) {
          console.error(
            "Update staff error:",
            updateStaffError.message
          );

          return json(
            { error: "Unable to update staff member" },
            400
          );
        }

        let staff =
          Array.isArray(updatedStaff)
            ? updatedStaff[0] || null
            : updatedStaff;

        if (
          isGeneralManager &&
          requestedRole &&
          staff &&
          requestedRole !== staff.role
        ) {
          const { data: roleUpdated, error: roleUpdateError } =
            await supabase
              .from("staff")
              .update({ role: requestedRole })
              .eq("id", staffId)
              .eq("location", location)
              .select("id,name,department,location,role,active,created_at")
              .single();

          if (roleUpdateError) throw roleUpdateError;
          staff = roleUpdated;
        }

        if (!staff) {
          return json(
            { error: "Staff member not found" },
            404
          );
        }

        return json({
          success: true,
          action,
          data: {
            staff,
          },
        });
      }


      if (
        action ===
        "manager_toggle_staff"
      ) {

        const staffId =
          typeof body.staff_id === "string"
            ? body.staff_id.trim()
            : "";

        if (!staffId) {
          return json(
            { error: "Staff ID is required" },
            400
          );
        }

        const {
          data: targetStaff,
          error: targetStaffError,
        } = await supabase
          .from("staff")
          .select(`
            id,
            name,
            department,
            location,
            role,
            active,
            created_at
          `)
          .eq("id", staffId)
          .eq("location", location)
          .maybeSingle();

        if (targetStaffError) {
          throw targetStaffError;
        }

        if (!targetStaff) {
          return json(
            { error: "Staff member not found" },
            404
          );
        }

        if (
          managerDepartmentScope &&
          targetStaff.department !== managerDepartmentScope
        ) {
          return json({ error: "Access denied for this department" }, 403);
        }

        if (
          targetStaff.role !== "staff" &&
          !isGeneralManager
        ) {
          return json(
            { error: "Only the General Manager can manage manager accounts" },
            403
          );
        }

        if (targetStaff.id === managerStatus.id) {
          return json(
            { error: "You cannot deactivate your own manager account" },
            400
          );
        }

        const {
          data: updatedStaff,
          error: updateStaffError,
        } = await supabase
          .from("staff")
          .update({
            active: !targetStaff.active,
          })
          .eq("id", staffId)
          .eq("location", location)
          .select(`
            id,
            name,
            department,
            location,
            role,
            active,
            created_at
          `)
          .single();

        if (updateStaffError) {
          throw updateStaffError;
        }

        return json({
          success: true,
          action,
          data: {
            staff: updatedStaff,
          },
        });
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

            team:
              await loadTeam(),
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