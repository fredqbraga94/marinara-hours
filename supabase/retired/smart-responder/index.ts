import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    if (req.method !== "POST") {
      return json({ error: "Method not allowed" }, 405);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !serviceRoleKey) {
      return json({ error: "Server configuration error" }, 500);
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    const body = await req.json();
    const action = body?.action;
    const pin = String(body?.pin ?? "");

    if (!/^\d{4,6}$/.test(pin)) {
      return json({ error: "Invalid PIN" }, 400);
    }

    let functionName: string;

    switch (action) {
      case "login":
        functionName = "login_with_pin";
        break;

      case "clock_in":
        functionName = "clock_in_with_pin";
        break;

      case "start_break":
        functionName = "start_break_with_pin";
        break;

      case "end_break":
        functionName = "end_break_with_pin";
        break;

      case "clock_out":
        functionName = "clock_out_with_pin";
        break;

      default:
        return json({ error: "Invalid action" }, 400);
    }

    const { data, error } = await supabase.rpc(functionName, {
      p_pin: pin,
    });

    if (error) {
      console.error(error);
      return json({ error: "Unable to complete action" }, 400);
    }

    if (action === "login") {
      if (!data || data.length === 0) {
        return json({ error: "Invalid PIN" }, 401);
      }

      return json({
        success: true,
        staff: data[0],
      });
    }

    return json({
      success: true,
      data,
    });
  } catch (error) {
    console.error(error);
    return json({ error: "Unexpected server error" }, 500);
  }
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}