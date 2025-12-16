export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "content-type,x-api-key,x-admin-key",
      "Cache-Control": "no-store"
    };

    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), {
        status,
        headers: { "content-type": "application/json", ...cors }
      });

    const safeParseObj = (raw) => {
      if (!raw || typeof raw !== "string") return {};
      try {
        const v = JSON.parse(raw);
        return v && typeof v === "object" ? v : {};
      } catch {
        return {};
      }
    };

    try {
      const url = new URL(request.url);
      if (request.method === "OPTIONS") return new Response(null, { headers: cors });

      if (!env || !env.LIVE) {
        return json({ error: "KV binding LIVE missing (check Worker Settings → Bindings)" }, 500);
      }

      /* =======================
         /update (Roblox -> Worker)
         ======================= */
      if (url.pathname === "/update" && request.method === "POST") {
        const key = request.headers.get("x-api-key") || "";
        if (!env.API_KEY || key !== env.API_KEY) return json({ error: "Unauthorized" }, 401);

        let body;
        try {
          body = await request.json();
        } catch {
          return json({ error: "Invalid JSON" }, 400);
        }

        const placeId = Number(body.placeId || 0);
        const jobId = String(body.jobId || "");
        const players = Array.isArray(body.players) ? body.players : null;

        if (!placeId || !jobId || !players) {
          return json({ error: "Invalid payload", expected: { placeId: "number", jobId: "string", players: "array" } }, 400);
        }

        const now = Date.now();
        const serverKey = `srv:${placeId}:${jobId}`;

        const snap = {
          placeId,
          jobId,
          updatedAt: now,
          players: players.map((p) => ({
            userId: Number(p.userId),
            username: String(p.username || ""),
            displayName: String(p.displayName || ""),
            team: p.team ? String(p.team) : ""
          }))
        };

        await env.LIVE.put(serverKey, JSON.stringify(snap), { expirationTtl: 180 });

        const index = safeParseObj(await env.LIVE.get("server_index"));
        index[serverKey] = now;

        for (const k in index) {
          if (now - Number(index[k] || 0) > 180000) delete index[k];
        }

        await env.LIVE.put("server_index", JSON.stringify(index));
        return json({ ok: true });
      }

      /* =======================
         /players (Website -> Worker)
         ======================= */
      if (url.pathname === "/players" && request.method === "GET") {
        const index = safeParseObj(await env.LIVE.get("server_index"));

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
          String(a.displayName || a.username).localeCompare(String(b.displayName || b.username))
        );

        return json({
          updatedAt: new Date().toISOString(),
          totalPlayers: combined.length,
          players: combined
        });
      }

      /* =======================
         /admin/moderate (Panel -> Worker)
         ======================= */
      if (url.pathname === "/admin/moderate" && request.method === "POST") {
        const adminKey = request.headers.get("x-admin-key") || "";
        if (!env.ADMIN_KEY || adminKey !== env.ADMIN_KEY) return json({ error: "Unauthorized" }, 401);

        let body;
        try {
          body = await request.json();
        } catch {
          return json({ error: "Invalid JSON" }, 400);
        }

        const action = String(body.action || "");
        const userId = Number(body.userId || 0);
        const reason = String(body.reason || "").slice(0, 180);

        if (!userId || !["kick", "ban", "unban"].includes(action)) {
          return json({ error: "Invalid command" }, 400);
        }

        const id = crypto.randomUUID();
        const now = Date.now();

        await env.LIVE.put(`cmd:${id}`, JSON.stringify({ id, createdAt: now, action, userId, reason }), { expirationTtl: 600 });

        const idx = safeParseObj(await env.LIVE.get("command_index"));
        idx[id] = now;
        await env.LIVE.put("command_index", JSON.stringify(idx));

        return json({ ok: true, id });
      }

      /* =======================
         /commands (Roblox polls)
         ======================= */
      if (url.pathname === "/commands" && request.method === "GET") {
        const key = request.headers.get("x-api-key") || "";
        if (!env.API_KEY || key !== env.API_KEY) return json({ error: "Unauthorized" }, 401);

        const idx = safeParseObj(await env.LIVE.get("command_index"));
        const now = Date.now();
        const commands = [];

        for (const id in idx) {
          if (now - Number(idx[id] || 0) > 600000) {
            delete idx[id];
            continue;
          }
          const raw = await env.LIVE.get(`cmd:${id}`);
          if (!raw) continue;
          try { commands.push(JSON.parse(raw)); } catch {}
        }

        await env.LIVE.put("command_index", JSON.stringify(idx));
        return json({ ok: true, commands });
      }

      /* =======================
         /ack (Roblox -> Worker)
         ======================= */
      if (url.pathname === "/ack" && request.method === "POST") {
        const key = request.headers.get("x-api-key") || "";
        if (!env.API_KEY || key !== env.API_KEY) return json({ error: "Unauthorized" }, 401);

        let body;
        try { body = await request.json(); } catch { body = {}; }

        const id = String(body.id || "");
        if (!id) return json({ error: "Missing id" }, 400);

        await env.LIVE.delete(`cmd:${id}`);

        const idx = safeParseObj(await env.LIVE.get("command_index"));
        delete idx[id];
        await env.LIVE.put("command_index", JSON.stringify(idx));

        return json({ ok: true });
      }

      return new Response("Not found", { status: 404, headers: cors });
    } catch (e) {
      return new Response(JSON.stringify({ error: "Worker exception", message: String(e?.message || e) }), {
        status: 500,
        headers: { "content-type": "application/json", ...cors }
      });
    }
  }
};
