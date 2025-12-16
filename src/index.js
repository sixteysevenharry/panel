export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "content-type,x-api-key,x-admin-key",
      "Cache-Control": "no-store"
    };

    try {
      const url = new URL(request.url);
      if (request.method === "OPTIONS") {
        return new Response(null, { headers: cors });
      }

      if (!env?.LIVE) {
        return new Response(JSON.stringify({ error: "KV binding LIVE missing" }), {
          status: 500,
          headers: { "content-type": "application/json", ...cors }
        });
      }

      /* =========================================================
         ROBLOX -> UPDATE SERVER SNAPSHOT
         ========================================================= */
      if (url.pathname === "/update" && request.method === "POST") {
        const key = request.headers.get("x-api-key") || "";
        if (!env.API_KEY || key !== env.API_KEY) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: { "content-type": "application/json", ...cors }
          });
        }

        const body = await request.json();
        const placeId = Number(body.placeId);
        const jobId = String(body.jobId || "");
        const players = Array.isArray(body.players) ? body.players : null;

        if (!placeId || !jobId || !players) {
          return new Response(JSON.stringify({ error: "Invalid payload" }), {
            status: 400,
            headers: { "content-type": "application/json", ...cors }
          });
        }

        const now = Date.now();
        const serverKey = `srv:${placeId}:${jobId}`;

        await env.LIVE.put(serverKey, JSON.stringify({
          placeId,
          jobId,
          updatedAt: now,
          players
        }), { expirationTtl: 180 });

        const rawIndex = await env.LIVE.get("server_index");
        const index = rawIndex ? JSON.parse(rawIndex) : {};
        index[serverKey] = now;

        for (const k in index) {
          if (now - index[k] > 180000) delete index[k];
        }

        await env.LIVE.put("server_index", JSON.stringify(index));

        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json", ...cors }
        });
      }

      /* =========================================================
         WEBSITE -> GET ALL PLAYERS
         ========================================================= */
      if (url.pathname === "/players" && request.method === "GET") {
        const rawIndex = await env.LIVE.get("server_index");
        if (!rawIndex) {
          return new Response(JSON.stringify({
            updatedAt: null,
            totalPlayers: 0,
            players: []
          }), { headers: { "content-type": "application/json", ...cors }});
        }

        const index = JSON.parse(rawIndex);
        const combined = [];
        const seen = new Set();

        for (const serverKey in index) {
          const raw = await env.LIVE.get(serverKey);
          if (!raw) continue;

          const snap = JSON.parse(raw);
          for (const p of snap.players || []) {
            if (!seen.has(p.userId)) {
              seen.add(p.userId);
              combined.push(p);
            }
          }
        }

        return new Response(JSON.stringify({
          updatedAt: new Date().toISOString(),
          totalPlayers: combined.length,
          players: combined
        }), { headers: { "content-type": "application/json", ...cors }});
      }

      /* =========================================================
         PANEL -> CREATE MODERATION COMMAND
         ========================================================= */
      if (url.pathname === "/admin/moderate" && request.method === "POST") {
        const adminKey = request.headers.get("x-admin-key") || "";
        if (!env.ADMIN_KEY || adminKey !== env.ADMIN_KEY) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: { "content-type": "application/json", ...cors }
          });
        }

        const body = await request.json();
        const action = body.action;
        const userId = Number(body.userId);
        const reason = String(body.reason || "");

        if (!userId || !["kick", "ban", "unban"].includes(action)) {
          return new Response(JSON.stringify({ error: "Invalid command" }), {
            status: 400,
            headers: { "content-type": "application/json", ...cors }
          });
        }

        const id = crypto.randomUUID();
        const now = Date.now();

        await env.LIVE.put(`cmd:${id}`, JSON.stringify({
          id, action, userId, reason, createdAt: now
        }), { expirationTtl: 600 });

        const raw = await env.LIVE.get("command_index");
        const index = raw ? JSON.parse(raw) : {};
        index[id] = now;
        await env.LIVE.put("command_index", JSON.stringify(index));

        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json", ...cors }
        });
      }

      /* =========================================================
         ROBLOX -> GET COMMANDS (NO KV.list)
         ========================================================= */
      if (url.pathname === "/commands" && request.method === "GET") {
        const key = request.headers.get("x-api-key") || "";
        if (!env.API_KEY || key !== env.API_KEY) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: { "content-type": "application/json", ...cors }
          });
        }

        const raw = await env.LIVE.get("command_index");
        if (!raw) {
          return new Response(JSON.stringify({ ok: true, commands: [] }), {
            headers: { "content-type": "application/json", ...cors }
          });
        }

        const index = JSON.parse(raw);
        const now = Date.now();
        const commands = [];

        for (const id in index) {
          if (now - index[id] > 600000) {
            delete index[id];
            continue;
          }
          const rawCmd = await env.LIVE.get(`cmd:${id}`);
          if (rawCmd) commands.push(JSON.parse(rawCmd));
        }

        await env.LIVE.put("command_index", JSON.stringify(index));

        return new Response(JSON.stringify({ ok: true, commands }), {
          headers: { "content-type": "application/json", ...cors }
        });
      }

      /* =========================================================
         ROBLOX -> ACK COMMAND
         ========================================================= */
      if (url.pathname === "/ack" && request.method === "POST") {
        const key = request.headers.get("x-api-key") || "";
        if (!env.API_KEY || key !== env.API_KEY) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: { "content-type": "application/json", ...cors }
          });
        }

        const body = await request.json();
        if (body.id) {
          await env.LIVE.delete(`cmd:${body.id}`);
        }

        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json", ...cors }
        });
      }

      return new Response("Not found", { status: 404, headers: cors });

    } catch (e) {
      return new Response(JSON.stringify({
        error: "Worker exception",
        message: String(e?.message || e)
      }), {
        status: 500,
        headers: { "content-type": "application/json", ...cors }
      });
    }
  }
};
