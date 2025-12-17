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

    const safeParseArr = (raw) => {
      if (!raw || typeof raw !== "string") return [];
      try {
        const v = JSON.parse(raw);
        return Array.isArray(v) ? v : [];
      } catch {
        return [];
      }
    };

    const LOG_KEY = "moderation_log_v2"; // verified-only log
    const MAX_LOG = 900;

    try {
      const url = new URL(request.url);
      if (request.method === "OPTIONS") return new Response(null, { headers: cors });

      if (!env || !env.LIVE) {
        return json(
          { error: "KV binding LIVE missing (check Worker → Settings → Bindings)" },
          500
        );
      }

      if (url.pathname === "/update" && request.method === "POST") {
        const key = request.headers.get("x-api-key") || "";
        if (!env.API_KEY || key !== env.API_KEY) return json({ error: "Unauthorized" }, 401);

        let body;
        try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

        const placeId = Number(body.placeId || 0);
        let jobId = String(body.jobId || "");
        const players = Array.isArray(body.players) ? body.players : null;
        if (!jobId) jobId = "studio-" + crypto.randomUUID();

        if (!placeId || !players) {
          return json({ error: "Invalid payload", expected: { placeId: "number", jobId: "string", players: "array" } }, 400);
        }

        const now = Date.now();
        const serverKey = `srv:${placeId}:${jobId}`;

        const snapshot = {
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

        await env.LIVE.put(serverKey, JSON.stringify(snapshot), { expirationTtl: 180 });

        const index = safeParseObj(await env.LIVE.get("server_index"));
        index[serverKey] = now;
        for (const k in index) if (now - Number(index[k] || 0) > 180000) delete index[k];
        await env.LIVE.put("server_index", JSON.stringify(index));

        return json({ ok: true });
      }

      if (url.pathname === "/players" && request.method === "GET") {
        const index = safeParseObj(await env.LIVE.get("server_index"));

        const combined = [];
        const seen = new Set();

        for (const serverKey in index) {
          const raw = await env.LIVE.get(serverKey);
          if (!raw) continue;
          try {
            const snap = JSON.parse(raw);
            const pid = Number(snap.placeId || 0);
            for (const p of snap.players || []) {
              const id = Number(p.userId);
              if (!id) continue;
              const unique = `${id}:${pid}`;
              if (seen.has(unique)) continue;
              seen.add(unique);

              combined.push({
                userId: Number(p.userId),
                username: String(p.username || ""),
                displayName: String(p.displayName || ""),
                team: p.team ? String(p.team) : "",
                placeId: pid
              });
            }
          } catch {}
        }

        combined.sort((a, b) =>
          String(a.displayName || a.username).localeCompare(String(b.displayName || b.username))
        );

        return json({ updatedAt: new Date().toISOString(), totalPlayers: combined.length, players: combined });
      }

      // Create command (NO LOG HERE)
      if (url.pathname === "/admin/moderate" && request.method === "POST") {
        const adminKey = request.headers.get("x-admin-key") || "";
        if (!env.ADMIN_KEY || adminKey !== env.ADMIN_KEY) return json({ error: "Unauthorized" }, 401);

        let body;
        try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

        const action = String(body.action || "");
        const userId = Number(body.userId || 0);
        const reason = String(body.reason || "").slice(0, 180);
        const by = String(body.by || "").slice(0, 60);
        const username = String(body.username || "").slice(0, 40);
        const displayName = String(body.displayName || "").slice(0, 60);

        if (!userId || !["kick", "ban", "unban"].includes(action)) return json({ error: "Invalid command" }, 400);

        const id = crypto.randomUUID();
        const now = Date.now();

        const cmd = { id, createdAt: now, action, userId, reason, by, username, displayName };

        await env.LIVE.put(`cmd:${id}`, JSON.stringify(cmd), { expirationTtl: 600 });

        const cmdIndex = safeParseObj(await env.LIVE.get("command_index"));
        cmdIndex[id] = now;
        await env.LIVE.put("command_index", JSON.stringify(cmdIndex));

        await env.LIVE.put(`hist:${id}`, JSON.stringify({ ...cmd, status: "pending", ok: null, message: "", appliedAt: null }), { expirationTtl: 3600 });

        return json({ ok: true, id });
      }

      if (url.pathname === "/commands" && request.method === "GET") {
        const key = request.headers.get("x-api-key") || "";
        if (!env.API_KEY || key !== env.API_KEY) return json({ error: "Unauthorized" }, 401);

        const cmdIndex = safeParseObj(await env.LIVE.get("command_index"));
        const now = Date.now();
        const commands = [];

        for (const id in cmdIndex) {
          if (now - Number(cmdIndex[id] || 0) > 600000) { delete cmdIndex[id]; continue; }
          const raw = await env.LIVE.get(`cmd:${id}`);
          if (!raw) continue;
          try { commands.push(JSON.parse(raw)); } catch {}
        }

        await env.LIVE.put("command_index", JSON.stringify(cmdIndex));
        return json({ ok: true, commands });
      }

      if (url.pathname === "/ack" && request.method === "POST") {
        const key = request.headers.get("x-api-key") || "";
        if (!env.API_KEY || key !== env.API_KEY) return json({ error: "Unauthorized" }, 401);

        let body;
        try { body = await request.json(); } catch { body = {}; }

        const id = String(body.id || "");
        if (!id) return json({ error: "Missing id" }, 400);

        await env.LIVE.delete(`cmd:${id}`);

        const cmdIndex = safeParseObj(await env.LIVE.get("command_index"));
        delete cmdIndex[id];
        await env.LIVE.put("command_index", JSON.stringify(cmdIndex));

        return json({ ok: true });
      }

      // Roblox posts result here AFTER enforcement. Only then we add to shared log.
      if (url.pathname === "/apply" && request.method === "POST") {
        const key = request.headers.get("x-api-key") || "";
        if (!env.API_KEY || key !== env.API_KEY) return json({ error: "Unauthorized" }, 401);

        let body;
        try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

        const id = String(body.id || "");
        const ok = body.ok === true;
        const message = String(body.message || "").slice(0, 180);
        if (!id) return json({ error: "Missing id" }, 400);

        const raw = await env.LIVE.get(`hist:${id}`);
        if (!raw) return json({ error: "Unknown id" }, 404);

        let hist = null;
        try { hist = JSON.parse(raw); } catch { hist = null; }
        if (!hist) return json({ error: "Bad history" }, 500);

        hist.status = "applied";
        hist.ok = ok;
        hist.message = message || "";
        hist.appliedAt = Date.now();
        await env.LIVE.put(`hist:${id}`, JSON.stringify(hist), { expirationTtl: 3600 });

        if (ok) {
          const log = safeParseArr(await env.LIVE.get(LOG_KEY));
          log.unshift({
            id: hist.id,
            createdAt: hist.createdAt,
            appliedAt: hist.appliedAt,
            action: hist.action,
            userId: hist.userId,
            reason: hist.reason,
            by: hist.by,
            username: hist.username,
            displayName: hist.displayName
          });
          if (log.length > MAX_LOG) log.length = MAX_LOG;
          await env.LIVE.put(LOG_KEY, JSON.stringify(log));
        }

        return json({ ok: true });
      }

      if (url.pathname === "/moderated" && request.method === "GET") {
        const log = safeParseArr(await env.LIVE.get(LOG_KEY));
        return json({ ok: true, items: log });
      }

      if (url.pathname === "/history" && request.method === "GET") {
        const id = url.searchParams.get("id") || "";
        if (!id) return json({ error: "Missing id" }, 400);
        const raw = await env.LIVE.get(`hist:${id}`);
        const item = raw ? safeParseObj(raw) : null;
        return json({ ok: true, item: item && Object.keys(item).length ? item : null });
      }

      return new Response("Not found", { status: 404, headers: cors });

    } catch (e) {
      return json({ error: "Worker exception", message: String(e?.message || e) }, 500);
    }
  }
};
