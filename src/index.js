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

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    const kvPutWithRetry = async (key, value, options = {}) => {
      let delay = 150;
      for (let i = 0; i < 6; i++) {
        try {
          await env.LIVE.put(key, value, options);
          return true;
        } catch (e) {
          const msg = String(e?.message || e);
          const is429 = msg.includes("429") || msg.toLowerCase().includes("too many requests");
          if (!is429) throw e;
          await sleep(delay);
          delay = Math.min(delay * 2, 2000);
        }
      }
      return false;
    };

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
        const key = request.headers.get("x-api-key") || "";
        if (!env.API_KEY || key !== env.API_KEY) {
          return json({ error: "Unauthorized" }, 401);
        }

        let body;
        try {
          body = await request.json();
        } catch {
          return json({ error: "Invalid JSON" }, 400);
        }

        const placeId = Number(body.placeId || 0);
        let jobId = String(body.jobId || "");
        const players = Array.isArray(body.players) ? body.players : null;

        // allow Studio (empty JobId)
        if (!jobId) jobId = "studio-" + crypto.randomUUID();

        if (!placeId || !players) {
          return json(
            {
              error: "Invalid payload",
              expected: {
                placeId: "number",
                jobId: "string",
                players: "array"
              }
            },
            400
          );
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

        // Snapshot write (needed)
        await kvPutWithRetry(serverKey, JSON.stringify(snapshot), { expirationTtl: 180 });

        // ✅ THROTTLE server_index writes (this is a hot KV PUT otherwise)
        // Only update index if last index update was > 20s ago
        const lastIdxKey = "server_index_last_write";
        const lastWriteRaw = await env.LIVE.get(lastIdxKey);
        const lastWrite = Number(lastWriteRaw || 0);

        if (now - lastWrite > 20000) {
          const index = safeParseObj(await env.LIVE.get("server_index"));
          index[serverKey] = now;

          for (const k in index) {
            if (now - Number(index[k] || 0) > 180000) delete index[k];
          }

          await kvPutWithRetry("server_index", JSON.stringify(index));
          await kvPutWithRetry(lastIdxKey, String(now), { expirationTtl: 300 });
        }

        return json({ ok: true });
      }

      /* =====================================================
         WEBSITE -> GET ALL ACTIVE PLAYERS
         ===================================================== */
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
          String(a.displayName || a.username)
            .localeCompare(String(b.displayName || b.username))
        );

        return json({
          updatedAt: new Date().toISOString(),
          totalPlayers: combined.length,
          players: combined
        });
      }

      /* =====================================================
         PANEL -> CREATE MODERATION COMMAND
         ===================================================== */
      if (url.pathname === "/admin/moderate" && request.method === "POST") {
        const adminKey = request.headers.get("x-admin-key") || "";
        if (!env.ADMIN_KEY || adminKey !== env.ADMIN_KEY) {
          return json({ error: "Unauthorized" }, 401);
        }

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

        // store command (needed)
        await kvPutWithRetry(
          `cmd:${id}`,
          JSON.stringify({ id, createdAt: now, action, userId, reason }),
          { expirationTtl: 600 }
        );

        // ✅ Make command_index a LIST not an object map (smaller + cheaper),
        // and only written when admin issues a command (low frequency).
        const rawList = await env.LIVE.get("command_index_v2");
        const list = safeParseArr(rawList);

        list.push({ id, t: now });

        // prune old
        const cutoff = now - 600000;
        const pruned = list.filter((x) => x && x.id && Number(x.t) >= cutoff);

        await kvPutWithRetry("command_index_v2", JSON.stringify(pruned), { expirationTtl: 900 });

        return json({ ok: true, id });
      }

      /* =====================================================
         ROBLOX -> GET MODERATION COMMANDS
         ===================================================== */
      if (url.pathname === "/commands" && request.method === "GET") {
        const key = request.headers.get("x-api-key") || "";
        if (!env.API_KEY || key !== env.API_KEY) {
          return json({ error: "Unauthorized" }, 401);
        }

        // ✅ READ-ONLY: do NOT KV.put here (this was causing your 429s)
        const now = Date.now();
        const idx = safeParseArr(await env.LIVE.get("command_index_v2"));

        const cutoff = now - 600000;
        const commands = [];

        for (const item of idx) {
          if (!item || !item.id) continue;
          if (Number(item.t) < cutoff) continue;

          const raw = await env.LIVE.get(`cmd:${item.id}`);
          if (!raw) continue;

          try {
            commands.push(JSON.parse(raw));
          } catch {}
        }

        return json({ ok: true, commands });
      }

      /* =====================================================
         ROBLOX -> ACK COMMAND
         ===================================================== */
      if (url.pathname === "/ack" && request.method === "POST") {
        const key = request.headers.get("x-api-key") || "";
        if (!env.API_KEY || key !== env.API_KEY) {
          return json({ error: "Unauthorized" }, 401);
        }

        // ✅ NO-OP ACK (no KV deletes / puts)
        // Roblox already de-dupes command ids client-side, so this is safe.
        return json({ ok: true });
      }

      return new Response("Not found", { status: 404, headers: cors });

    } catch (e) {
      return json(
        { error: "Worker exception", message: String(e?.message || e) },
        500
      );
    }
  }
};
