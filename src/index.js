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
      if (request.method === "OPTIONS") return new Response(null, { headers: cors });

      if (!env?.LIVE) {
        return new Response(JSON.stringify({ error: "KV binding LIVE missing" }), {
          status: 500,
          headers: { "content-type": "application/json", ...cors }
        });
      }

      /* ================================
         ROBLOX -> UPDATE SNAPSHOT
         ================================ */
      if (url.pathname === "/update" && request.method === "POST") {
        const key = request.headers.get("x-api-key") || "";
        if (!env.API_KEY || key !== env.API_KEY) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: { "content-type": "application/json", ...cors }
          });
        }

        const body = await request.json();
        const placeId = Number(body.placeId || 0);
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

        const snapshot = {
          placeId,
          jobId,
          updatedAt: now,
          players: players.map(p => ({
            userId: Number(p.userId),
            username: String(p.username || ""),
            displayName: String(p.displayName || ""),
            team: p.team ? String(p.team) : null
          }))
        };

        // Store server snapshot (auto-expires)
        await env.LIVE.put(serverKey, JSON.stringify(snapshot), {
          expirationTtl: 180
        });

        // Update server index (single key)
        const indexRaw = await env.LIVE.get("server_index");
        let index = indexRaw ? JSON.parse(indexRaw) : {};
        index[serverKey] = now;

        // Prune dead servers
        for (const k in index) {
          if (now - index[k] > 180000) delete index[k];
        }

        await env.LIVE.put("server_index", JSON.stringify(index));

        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json", ...cors }
        });
      }

      /* ================================
         WEBSITE -> GET PLAYERS
         ================================ */
      if (url.pathname === "/players" && request.method === "GET") {
        const indexRaw = await env.LIVE.get("server_index");
        if (!indexRaw) {
          return new Response(JSON.stringify({
            updatedAt: null,
            totalPlayers: 0,
            players: []
          }), { headers: { "content-type": "application/json", ...cors }});
        }

        const index = JSON.parse(indexRaw);
        const combined = [];
        const seen = new Set();

        for (const serverKey in index) {
          const raw = await env.LIVE.get(serverKey);
          if (!raw) continue;

          try {
            const snap = JSON.parse(raw);
            for (const p of snap.players || []) {
              const id = Number(p.userId);
              if (!id || seen.has(id)) continue;
              seen.add(id);
              combined.push(p);
            }
          } catch {}
        }

        combined.sort((a, b) =>
          String(a.displayName || a.username)
            .localeCompare(String(b.displayName || b.username))
        );

        return new Response(JSON.stringify({
          updatedAt: new Date().toISOString(),
          totalPlayers: combined.length,
          players: combined
        }), { headers: { "content-type": "application/json", ...cors }});
      }

      /* ================================
         MODERATION ENDPOINTS (UNCHANGED)
         ================================ */

      if (url.pathname === "/admin/moderate" && request.method === "POST") {
        const adminKey = request.headers.get("x-admin-key") || "";
        if (!env.ADMIN_KEY || adminKey !== env.ADMIN_KEY) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: { "content-type": "application/json", ...cors }
          });
        }

        const body = await request.json();
        const action = String(body.action || "");
        const userId = Number(body.userId);
        const reason = String(body.reason || "");

        if (!userId || !["kick", "ban", "unban"].includes(action)) {
          return new Response(JSON.stringify({ error: "Invalid command" }), {
            status: 400,
            headers: { "content-type": "application/json", ...cors }
          });
        }

        const cmd = {
          id: crypto.randomUUID(),
          createdAt: Date.now(),
          action,
          userId,
          reason: reason.slice(0, 180)
        };

        await env.LIVE.put(`cmd:${cmd.id}`, JSON.stringify(cmd), {
          expirationTtl: 600
        });

        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json", ...cors }
        });
      }

      if (url.pathname === "/commands" && request.method === "GET") {
        const key = request.headers.get("x-api-key") || "";
        if (!env.API_KEY || key !== env.API_KEY) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: { "content-type": "application/json", ...cors }
          });
        }

        const indexRaw = await env.LIVE.get("server_index");
        const listRaw = await env.LIVE.list({ prefix: "cmd:" });
        const cmds = [];

        for (const k of listRaw.keys) {
          const raw = await env.LIVE.get(k.name);
          if (!raw) continue;
          try { cmds.push(JSON.parse(raw)); } catch {}
        }

        return new Response(JSON.stringify({ ok: true, commands: cmds }), {
          headers: { "content-type": "application/json", ...cors }
        });
      }

      if (url.pathname === "/ack" && request.method === "POST") {
        const key = request.headers.get("x-api-key") || "";
        if (!env.API_KEY || key !== env.API_KEY) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: { "content-type": "application/json", ...cors }
          });
        }

        const body = await request.json();
        if (body.id) await env.LIVE.delete(`cmd:${body.id}`);

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
