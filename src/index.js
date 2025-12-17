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

    const requireAdmin = () => {
      const adminKey = request.headers.get("x-admin-key") || "";
      if (!env.ADMIN_KEY || adminKey !== env.ADMIN_KEY) return false;
      return true;
    };

    const requireApi = () => {
      const key = request.headers.get("x-api-key") || "";
      if (!env.API_KEY || key !== env.API_KEY) return false;
      return true;
    };

    const nowIso = () => new Date().toISOString();

    try {
      const url = new URL(request.url);
      if (request.method === "OPTIONS") return new Response(null, { headers: cors });

      if (!env || !env.LIVE) {
        return json(
          { error: "KV binding LIVE missing (check Worker → Settings → Bindings)" },
          500
        );
      }

      /* =====================================================
         ROBLOX -> UPDATE SERVER SNAPSHOT
         ===================================================== */
      if (url.pathname === "/update" && request.method === "POST") {
        if (!requireApi()) return json({ error: "Unauthorized" }, 401);

        let body;
        try { body = await request.json(); }
        catch { return json({ error: "Invalid JSON" }, 400); }

        const placeId = Number(body.placeId || 0);
        let jobId = String(body.jobId || "");
        const players = Array.isArray(body.players) ? body.players : null;

        if (!jobId) jobId = "studio-" + crypto.randomUUID();

        if (!placeId || !players) {
          return json(
            { error: "Invalid payload", expected: { placeId: "number", jobId: "string", players: "array" } },
            400
          );
        }

        const now = Date.now();
        const serverKey = `srv:${placeId}:${jobId}`;

        const snapshot = {
          placeId,
          jobId,
          serverKey,
          updatedAt: now,
          players: players.map((p) => ({
            userId: Number(p.userId),
            username: String(p.username || ""),
            displayName: String(p.displayName || ""),
            team: p.team ? String(p.team) : ""
          }))
        };

        await env.LIVE.put(serverKey, JSON.stringify(snapshot), { expirationTtl: 240 });

        const index = safeParseObj(await env.LIVE.get("server_index"));
        index[serverKey] = now;

        for (const k in index) {
          if (now - Number(index[k] || 0) > 240000) delete index[k];
        }

        await env.LIVE.put("server_index", JSON.stringify(index));

        return json({ ok: true });
      }

      /* =====================================================
         PUBLIC -> GET SERVERS LIST (Roblox-like)
         ===================================================== */
      if (url.pathname === "/servers" && request.method === "GET") {
        const index = safeParseObj(await env.LIVE.get("server_index"));
        const servers = [];
        const now = Date.now();

        for (const serverKey in index) {
          const raw = await env.LIVE.get(serverKey);
          if (!raw) continue;
          try {
            const snap = JSON.parse(raw);
            const updatedAt = Number(snap.updatedAt || 0);
            if (!updatedAt || (now - updatedAt) > 240000) continue;

            const pcount = Array.isArray(snap.players) ? snap.players.length : 0;

            servers.push({
              serverKey: String(snap.serverKey || serverKey),
              placeId: Number(snap.placeId || 0),
              jobId: String(snap.jobId || ""),
              updatedAt,
              playerCount: pcount
            });
          } catch {}
        }

        servers.sort((a, b) => (b.updatedAt - a.updatedAt) || (b.playerCount - a.playerCount));

        return json({
          updatedAt: nowIso(),
          totalServers: servers.length,
          servers
        });
      }

      /* =====================================================
         PUBLIC -> GET PLAYERS (ALL OR PER SERVER)
         ===================================================== */
      if (url.pathname === "/players" && request.method === "GET") {
        const serverKeyFilter = url.searchParams.get("serverKey");

        if (serverKeyFilter) {
          const raw = await env.LIVE.get(serverKeyFilter);
          if (!raw) {
            return json({ updatedAt: nowIso(), totalPlayers: 0, players: [], server: null });
          }

          try {
            const snap = JSON.parse(raw);
            const players = Array.isArray(snap.players) ? snap.players : [];
            return json({
              updatedAt: nowIso(),
              server: {
                serverKey: String(snap.serverKey || serverKeyFilter),
                placeId: Number(snap.placeId || 0),
                jobId: String(snap.jobId || ""),
                updatedAt: Number(snap.updatedAt || 0),
                playerCount: players.length
              },
              totalPlayers: players.length,
              players: players.map(p => ({
                userId: Number(p.userId),
                username: String(p.username || ""),
                displayName: String(p.displayName || ""),
                team: p.team ? String(p.team) : "",
                placeId: Number(snap.placeId || 0),
                jobId: String(snap.jobId || ""),
                serverKey: String(snap.serverKey || serverKeyFilter)
              }))
            });
          } catch {
            return json({ updatedAt: nowIso(), totalPlayers: 0, players: [], server: null });
          }
        }

        const index = safeParseObj(await env.LIVE.get("server_index"));
        const combined = [];
        const seen = new Set();

        for (const serverKey in index) {
          const raw = await env.LIVE.get(serverKey);
          if (!raw) continue;

          try {
            const snap = JSON.parse(raw);
            const placeId = Number(snap.placeId || 0);
            const jobId = String(snap.jobId || "");
            const sk = String(snap.serverKey || serverKey);

            for (const p of (snap.players || [])) {
              const id = Number(p.userId);
              if (!id || seen.has(id)) continue; // de-dupe across servers
              seen.add(id);

              combined.push({
                userId: Number(p.userId),
                username: String(p.username || ""),
                displayName: String(p.displayName || ""),
                team: p.team ? String(p.team) : "",
                placeId,
                jobId,
                serverKey: sk
              });
            }
          } catch {}
        }

        combined.sort((a, b) =>
          String(a.displayName || a.username).localeCompare(String(b.displayName || b.username))
        );

        return json({
          updatedAt: nowIso(),
          totalPlayers: combined.length,
          players: combined
        });
      }

      /* =====================================================
         PANEL -> CREATE MODERATION COMMAND (+ shared history)
         ===================================================== */
      if (url.pathname === "/admin/moderate" && request.method === "POST") {
        if (!requireAdmin()) return json({ error: "Unauthorized" }, 401);

        let body;
        try { body = await request.json(); }
        catch { return json({ error: "Invalid JSON" }, 400); }

        const action = String(body.action || "");
        const userId = Number(body.userId || 0);
        const reason = String(body.reason || "").slice(0, 180);
        const by = String(body.by || "").slice(0, 40);

        if (!userId || !["kick", "ban", "unban"].includes(action)) {
          return json({ error: "Invalid command" }, 400);
        }

        const id = crypto.randomUUID();
        const now = Date.now();

        await env.LIVE.put(
          `cmd:${id}`,
          JSON.stringify({ id, createdAt: now, action, userId, reason }),
          { expirationTtl: 600 }
        );

        const cmdIndex = safeParseObj(await env.LIVE.get("command_index"));
        cmdIndex[id] = now;
        for (const k in cmdIndex) {
          if (now - Number(cmdIndex[k] || 0) > 600000) delete cmdIndex[k];
        }
        await env.LIVE.put("command_index", JSON.stringify(cmdIndex));

        // Shared moderation history (visible to everyone who has panel access)
        const logItem = {
          id,
          at: now,
          atIso: nowIso(),
          action,
          userId,
          reason,
          by: by || null
        };

        const hist = safeParseArr(await env.LIVE.get("mod_history_v1"));
        hist.unshift(logItem);
        if (hist.length > 250) hist.length = 250;
        await env.LIVE.put("mod_history_v1", JSON.stringify(hist), { expirationTtl: 60 * 60 * 24 * 30 });

        return json({ ok: true, id });
      }

      /* =====================================================
         PANEL -> READ SHARED MODERATION HISTORY
         ===================================================== */
      if (url.pathname === "/admin/history" && request.method === "GET") {
        if (!requireAdmin()) return json({ error: "Unauthorized" }, 401);

        const hist = safeParseArr(await env.LIVE.get("mod_history_v1"));
        return json({
          updatedAt: nowIso(),
          total: hist.length,
          history: hist
        });
      }

      /* =====================================================
         ROBLOX -> GET MODERATION COMMANDS
         ===================================================== */
      if (url.pathname === "/commands" && request.method === "GET") {
        if (!requireApi()) return json({ error: "Unauthorized" }, 401);

        const cmdIndex = safeParseObj(await env.LIVE.get("command_index"));
        const now = Date.now();
        const commands = [];

        for (const id in cmdIndex) {
          if (now - Number(cmdIndex[id] || 0) > 600000) {
            delete cmdIndex[id];
            continue;
          }

          const raw = await env.LIVE.get(`cmd:${id}`);
          if (!raw) continue;

          try { commands.push(JSON.parse(raw)); }
          catch {}
        }

        await env.LIVE.put("command_index", JSON.stringify(cmdIndex));
        return json({ ok: true, commands });
      }

      /* =====================================================
         ROBLOX -> ACK COMMAND
         ===================================================== */
      if (url.pathname === "/ack" && request.method === "POST") {
        if (!requireApi()) return json({ error: "Unauthorized" }, 401);

        let body;
        try { body = await request.json(); }
        catch { body = {}; }

        const id = String(body.id || "");
        if (!id) return json({ error: "Missing id" }, 400);

        await env.LIVE.delete(`cmd:${id}`);

        const cmdIndex = safeParseObj(await env.LIVE.get("command_index"));
        delete cmdIndex[id];
        await env.LIVE.put("command_index", JSON.stringify(cmdIndex));

        return json({ ok: true });
      }

      return new Response("Not found", { status: 404, headers: cors });

    } catch (e) {
      return new Response(
        JSON.stringify({ error: "Worker exception", message: String(e?.message || e) }),
        { status: 500, headers: { "content-type": "application/json" } }
      );
    }
  }
};
