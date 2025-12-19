export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "content-type,x-api-key,x-admin-key,x-admin-user",
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

    const MOD_LOG_KEY = "moderation_log_v1";
    const MAX_LOG = 600;

    // Active bans (current bans only)
    const BAN_STATE_KEY = "ban_state_v1"; // { "<userId>": {userId, reason, by, bannedAt, lastId} }

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
        if (!env.API_KEY || key !== env.API_KEY) return json({ error: "Unauthorized" }, 401);

        let body;
        try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

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

        for (const k in index) {
          if (now - Number(index[k] || 0) > 180000) delete index[k];
        }

        await env.LIVE.put("server_index", JSON.stringify(index));
        return json({ ok: true });
      }

      /* =====================================================
         WEBSITE -> GET ALL ACTIVE PLAYERS (with placeId)
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
        if (!env.ADMIN_KEY || adminKey !== env.ADMIN_KEY) return json({ error: "Unauthorized" }, 401);

        let body;
        try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

        const action = String(body.action || "");
        const userId = Number(body.userId || 0);
        const reason = String(body.reason || "").slice(0, 180);
        const by = String(body.by || "").slice(0, 60);

        if (!userId || !["kick", "ban", "unban"].includes(action)) {
          return json({ error: "Invalid command" }, 400);
        }

        const id = crypto.randomUUID();
        const now = Date.now();

        await env.LIVE.put(
          `cmd:${id}`,
          JSON.stringify({ id, createdAt: now, action, userId, reason, by }),
          { expirationTtl: 600 }
        );

        const cmdIndex = safeParseObj(await env.LIVE.get("command_index"));
        cmdIndex[id] = now;
        await env.LIVE.put("command_index", JSON.stringify(cmdIndex));

        // Shared moderation history (all users)
        const log = safeParseArr(await env.LIVE.get(MOD_LOG_KEY));
        log.unshift({
          id,
          createdAt: now,
          action,
          userId,
          reason,
          by,
          status: "pending"
        });
        if (log.length > MAX_LOG) log.length = MAX_LOG;
        await env.LIVE.put(MOD_LOG_KEY, JSON.stringify(log));

        return json({ ok: true, id });
      }

      /* =====================================================
         PANEL -> CLEAR ALL MODERATION LOGS (SPECIMEN ONLY)
         ===================================================== */
      if (url.pathname === "/admin/clearLogs" && request.method === "POST") {
        const adminKey = request.headers.get("x-admin-key") || "";
        if (!env.ADMIN_KEY || adminKey !== env.ADMIN_KEY) return json({ error: "Unauthorized" }, 401);

        let body; try { body = await request.json(); } catch { body = {}; }

        const whoRaw = String((body && (body.user || body.by)) || "").trim() || String(request.headers.get("x-admin-user") || "").trim();
        const who = whoRaw.toLowerCase();
        if (who !== "specimen") return json({ error: "Specimen only" }, 403);

await env.LIVE.delete(MOD_LOG_KEY);
        await env.LIVE.delete(BAN_STATE_KEY);

        return json({ ok: true });
      }
      /* =====================================================
         WEBSITE/ROBLOX -> GAME LOCK STATE
         ===================================================== */
      if (url.pathname === "/lockState" && request.method === "GET") {
        const raw = await env.LIVE.get("game_lock_v1");
        let state = {};
        try { state = raw ? JSON.parse(raw) : {}; } catch { state = {}; }
        const locked = state.locked === true;
        return json({ ok: true, locked, by: String(state.by || ""), at: Number(state.at || 0) });
      }

      /* =====================================================
         PANEL -> SET GAME LOCK (ALL ADMINS; 2 MIN COOLDOWN EACH)
         Body: { locked: boolean }
         ===================================================== */
      if (url.pathname === "/admin/setLock" && request.method === "POST") {
        const adminKey = request.headers.get("x-admin-key") || "";
        if (!env.ADMIN_KEY || adminKey !== env.ADMIN_KEY) return json({ error: "Unauthorized" }, 401);

        let body; try { body = await request.json(); } catch { body = {}; }
        const whoRaw = String(body.user || request.headers.get("x-admin-user") || "").trim();
        if (!whoRaw) return json({ error: "Missing user" }, 400);
        const who = whoRaw.slice(0, 60);

        const cdKey = "lock_cd:" + who.toLowerCase();
        const now = Date.now();
        const lastRaw = await env.LIVE.get(cdKey);
        const last = Number(lastRaw || 0);

        if (last && (now - last) < 120000) {
          const waitMs = 120000 - (now - last);
          return json({ error: "Cooldown", waitMs }, 429);
        }

        const locked = body.locked === true;

        const newState = { locked, by: who, at: now };
        await env.LIVE.put("game_lock_v1", JSON.stringify(newState));

        // store cooldown for this admin
        await env.LIVE.put(cdKey, String(now), { expirationTtl: 180 });

        return json({ ok: true, locked, by: who, at: now });
      }



      /* =====================================================
         WEBSITE -> CURRENTLY BANNED USERS (ACTIVE ONLY)
         ===================================================== */
      if (url.pathname === "/moderated" && request.method === "GET") {
        const state = safeParseObj(await env.LIVE.get(BAN_STATE_KEY));
        const items = Object.values(state || {})
          .filter(Boolean)
          .map((x) => ({
            userId: Number(x.userId),
            reason: String(x.reason || ""),
            by: String(x.by || ""),
            bannedAt: Number(x.bannedAt || 0),
            lastId: String(x.lastId || "")
          }))
          .sort((a, b) => Number(b.bannedAt || 0) - Number(a.bannedAt || 0));

        return json({ ok: true, items });
      }

      /* =====================================================
         WEBSITE -> FULL MODERATION HISTORY
         ===================================================== */
      if (url.pathname === "/history" && request.method === "GET") {
        const log = safeParseArr(await env.LIVE.get(MOD_LOG_KEY));
        return json({ ok: true, items: log });
      }

      /* =====================================================
         ROBLOX -> GET MODERATION COMMANDS
         ===================================================== */
      if (url.pathname === "/commands" && request.method === "GET") {
        const key = request.headers.get("x-api-key") || "";
        if (!env.API_KEY || key !== env.API_KEY) return json({ error: "Unauthorized" }, 401);

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

          try { commands.push(JSON.parse(raw)); } catch {}
        }

        await env.LIVE.put("command_index", JSON.stringify(cmdIndex));
        return json({ ok: true, commands });
      }

      /* =====================================================
         ROBLOX -> ACK COMMAND (CONFIRMATION)
         Body: { id, action, userId, ok }
         ===================================================== */
      if (url.pathname === "/ack" && request.method === "POST") {
        const key = request.headers.get("x-api-key") || "";
        if (!env.API_KEY || key !== env.API_KEY) return json({ error: "Unauthorized" }, 401);

        let body;
        try { body = await request.json(); } catch { body = {}; }

        const id = String(body.id || "");
        const action = String(body.action || "");
        const userId = Number(body.userId || 0);
        const ok = (body.ok === true || body.ok === "true" || body.ok === 1 || body.ok === "1");

        if (!id) return json({ error: "Missing id" }, 400);

        await env.LIVE.delete(`cmd:${id}`);

        const cmdIndex = safeParseObj(await env.LIVE.get("command_index"));
        delete cmdIndex[id];
        await env.LIVE.put("command_index", JSON.stringify(cmdIndex));

        // Update history status for this command id
        const log = safeParseArr(await env.LIVE.get(MOD_LOG_KEY));
        const idx = log.findIndex((x) => String(x?.id || "") === id);
        if (idx >= 0) {
          log[idx].status = ok ? "applied" : "failed";
          log[idx].ackedAt = Date.now();
          await env.LIVE.put(MOD_LOG_KEY, JSON.stringify(log));
        }

        // Update ACTIVE bans only when Roblox confirms
        if (ok && userId > 0 && (action === "ban" || action === "unban")) {
          const state = safeParseObj(await env.LIVE.get(BAN_STATE_KEY));

          if (action === "ban") {
            state[String(userId)] = {
              userId,
              reason: idx >= 0 ? String(log[idx]?.reason || "") : "",
              by: idx >= 0 ? String(log[idx]?.by || "") : "",
              bannedAt: Date.now(),
              lastId: id
            };
          }

          if (action === "unban") {
            delete state[String(userId)];
          }

          await env.LIVE.put(BAN_STATE_KEY, JSON.stringify(state));
        }

        return json({ ok: true });
      }

      
/* =====================================================
   WEBSITE -> GROUP INFO (public)
   /groupInfo?groupId=123
   ===================================================== */

      /* =====================================================
         WEBSITE -> GROUP INFO (proxy)
         GET /groupInfo?groupId=123
         ===================================================== */
      if (url.pathname === "/groupInfo" && request.method === "GET") {
        const groupId = Number(url.searchParams.get("groupId") || 0);
        if (!groupId) return json({ error: "Missing groupId" }, 400);

        const cacheKey = `grpinfo:${groupId}`;
        const cached = await env.LIVE.get(cacheKey);
        if (cached) {
          try { return json(JSON.parse(cached)); } catch {}
        }

        const r = await fetch(`https://groups.roblox.com/v1/groups/${groupId}`, {
          headers: { "accept": "application/json" }
        });

        const bodyText = await r.text();
        if (!r.ok) {
          // pass-through error body from Roblox, but keep CORS headers
          return new Response(bodyText || JSON.stringify({ error: "Upstream error" }), {
            status: r.status,
            headers: { "content-type": "application/json", ...cors }
          });
        }

        let body;
        try { body = JSON.parse(bodyText); } catch { body = {}; }

        // short cache to reduce 429s
        await env.LIVE.put(cacheKey, JSON.stringify(body), { expirationTtl: 60 });

        return json(body);
      }


/* =====================================================
   WEBSITE -> GROUP MEMBERS (public; cursor pagination)
   /groupMembers?groupId=123&limit=100&cursor=...
   ===================================================== */

      /* =====================================================
         WEBSITE -> GROUP MEMBERS (proxy)
         GET /groupMembers?groupId=123&cursor=
         ===================================================== */
      if (url.pathname === "/groupMembers" && request.method === "GET") {
        const groupId = Number(url.searchParams.get("groupId") || 0);
        const cursor = String(url.searchParams.get("cursor") || "");
        if (!groupId) return json({ error: "Missing groupId" }, 400);

        // Cache per cursor briefly to avoid spam while still updating on refresh
        const cacheKey = `grpmem:${groupId}:${cursor || "first"}`;
        const cached = await env.LIVE.get(cacheKey);
        if (cached) {
          try { return json(JSON.parse(cached)); } catch {}
        }

        const qs = new URLSearchParams({ limit: "100" });
        if (cursor) qs.set("cursor", cursor);

        const r = await fetch(`https://groups.roblox.com/v1/groups/${groupId}/users?${qs.toString()}`, {
          headers: { "accept": "application/json" }
        });

        const bodyText = await r.text();
        if (!r.ok) {
          return new Response(bodyText || JSON.stringify({ error: "Upstream error" }), {
            status: r.status,
            headers: { "content-type": "application/json", ...cors }
          });
        }

        let body;
        try { body = JSON.parse(bodyText); } catch { body = {}; }

        // short cache to reduce 429s
        await env.LIVE.put(cacheKey, JSON.stringify(body), { expirationTtl: 60 });

        return json(body);
      }



      /* =====================================================
         WEBSITE -> THUMBNAILS PROXY (avoids CORS)
         GET /thumbs?userIds=1,2,3&size=420x420&format=Png&isCircular=false
         ===================================================== */
      if (url.pathname === "/thumbs" && request.method === "GET") {
        const userIdsRaw = String(url.searchParams.get("userIds") || "");
        const size = String(url.searchParams.get("size") || "420x420");
        const format = String(url.searchParams.get("format") || "Png");
        const isCircular = String(url.searchParams.get("isCircular") || "false");

        const ids = userIdsRaw.split(",")
          .map(s => Number(String(s).trim()))
          .filter(n => Number.isFinite(n) && n > 0)
          .slice(0, 100);

        if (!ids.length) return json({ error: "Missing userIds" }, 400);

        const rawKey = `${ids.join(",")}|${size}|${format}|${isCircular}`;
        const hashBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawKey));
        const hashHex = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2,"0")).join("");
        const cacheKey = `thumbs:${hashHex}`;
        const cached = await env.LIVE.get(cacheKey);
        if (cached) {
          try { return json(JSON.parse(cached)); } catch {}
        }

        const upstream = "https://thumbnails.roblox.com/v1/users/avatar-headshot"
          + "?userIds=" + encodeURIComponent(ids.join(","))
          + "&size=" + encodeURIComponent(size)
          + "&format=" + encodeURIComponent(format)
          + "&isCircular=" + encodeURIComponent(isCircular);

        const r = await fetch(upstream, { headers: { "accept": "application/json" } });
        const bodyText = await r.text();

        if (!r.ok) {
          return new Response(bodyText || JSON.stringify({ error: "Upstream error" }), {
            status: r.status,
            headers: { "content-type": "application/json", ...cors }
          });
        }

        let body;
        try { body = JSON.parse(bodyText); } catch { body = {}; }

        // Cache (KV minimum 60s)
        await env.LIVE.put(cacheKey, JSON.stringify(body), { expirationTtl: 300 });

        return json(body);
      }

      /* =====================================================
         WEBSITE -> USER CREATED DATE PROXY (avoids CORS)
         GET /usersCreated?userIds=1,2,3
         Returns: { ok:true, data:[{userId, created}] }
         ===================================================== */
      if (url.pathname === "/usersCreated" && request.method === "GET") {
        const userIdsRaw = String(url.searchParams.get("userIds") || "");
        const ids = userIdsRaw.split(",")
          .map(s => Number(String(s).trim()))
          .filter(n => Number.isFinite(n) && n > 0)
          .slice(0, 80);

        if (!ids.length) return json({ error: "Missing userIds" }, 400);

        const out = [];
        for (const id of ids) {
          const ck = `ucreated:${id}`;
          const cached = await env.LIVE.get(ck);
          if (cached) {
            out.push({ userId: id, created: String(cached) });
            continue;
          }

          const r = await fetch(`https://users.roblox.com/v1/users/${id}`, {
            headers: { "accept": "application/json" }
          });

          if (!r.ok) {
            // If one fails, just skip it (still return others)
            continue;
          }

          let body = null;
          try { body = await r.json(); } catch { body = null; }

          const created = body && body.created ? String(body.created) : "";
          if (created) {
            out.push({ userId: id, created });
            // Cache 24h (KV minimum 60s)
            await env.LIVE.put(ck, created, { expirationTtl: 86400 });
          }
        }

        return json({ ok: true, data: out });
      }

      
      /* =====================================================
         WEBSITE -> PROFILE PFP UPLOAD (shared)
         POST /profile/pfp  (requires x-admin-key)
         Body: { user: "name", dataUrl: "data:image/png;base64,..." }
         ===================================================== */
      if (url.pathname === "/profile/pfp" && request.method === "POST") {
        const adminKey = request.headers.get("x-admin-key") || "";
        if (!env.ADMIN_KEY || adminKey !== env.ADMIN_KEY) return json({ error: "Unauthorized" }, 401);

        let body;
        try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

        const user = String(body.user || "").trim().toLowerCase();
        const dataUrl = String(body.dataUrl || "");

        if (!user) return json({ error: "Missing user" }, 400);
        if (!dataUrl.startsWith("data:image/") || dataUrl.indexOf("base64,") === -1) {
          return json({ error: "Invalid image" }, 400);
        }

        // Size guard (base64 string length)
        if (dataUrl.length > 600000) return json({ error: "Image too large" }, 413);

        const mime = dataUrl.slice(5, dataUrl.indexOf(";")) || "image/png";
        const b64 = dataUrl.split("base64,")[1] || "";

        // Basic base64 sanity
        if (!b64 || b64.length < 20) return json({ error: "Invalid image" }, 400);

        const key = `profile_v1:${user}`;
        const payload = { user, mime, b64, updatedAt: Date.now() };

        await env.LIVE.put(key, JSON.stringify(payload));
        return json({ ok: true });
      }

      /* =====================================================
         WEBSITE -> GET PROFILE (json)
         GET /profile?user=name
         ===================================================== */
      if (url.pathname === "/profile" && request.method === "GET") {
        const user = String(url.searchParams.get("user") || "").trim().toLowerCase();
        if (!user) return json({ ok: true, user: "", hasPfp: false });

        const raw = await env.LIVE.get(`profile_v1:${user}`);
        if (!raw) return json({ ok: true, user, hasPfp: false });

        let obj = null;
        try { obj = JSON.parse(raw); } catch { obj = null; }
        const hasPfp = !!(obj && obj.b64 && obj.mime);

        return json({
          ok: true,
          user,
          hasPfp,
          updatedAt: Number(obj?.updatedAt || 0),
          pfpUrl: hasPfp ? (new URL(request.url).origin + `/pfp?user=${encodeURIComponent(user)}`) : ""
        });
      }

      /* =====================================================
         WEBSITE -> BATCH PROFILE LOOKUP (json)
         GET /profiles?users=a,b,c
         ===================================================== */
      if (url.pathname === "/profiles" && request.method === "GET") {
        const rawUsers = String(url.searchParams.get("users") || "");
        const users = rawUsers.split(",")
          .map(s => String(s || "").trim().toLowerCase())
          .filter(Boolean)
          .slice(0, 120);

        const out = {};
        const origin = new URL(request.url).origin;

        for (const u of users) {
          const raw = await env.LIVE.get(`profile_v1:${u}`);
          if (!raw) continue;
          try {
            const obj = JSON.parse(raw);
            if (obj && obj.b64 && obj.mime) {
              out[u] = { pfpUrl: origin + `/pfp?user=${encodeURIComponent(u)}`, updatedAt: Number(obj.updatedAt || 0) };
            }
          } catch {}
        }

        return json({ ok: true, items: out });
      }

      /* =====================================================
         WEBSITE -> PFP IMAGE (binary)
         GET /pfp?user=name
         ===================================================== */
      if (url.pathname === "/pfp" && request.method === "GET") {
        const user = String(url.searchParams.get("user") || "").trim().toLowerCase();
        if (!user) return new Response("Not found", { status: 404, headers: cors });

        const raw = await env.LIVE.get(`profile_v1:${user}`);
        if (!raw) return new Response("Not found", { status: 404, headers: cors });

        let obj = null;
        try { obj = JSON.parse(raw); } catch { obj = null; }
        if (!obj || !obj.b64) return new Response("Not found", { status: 404, headers: cors });

        const mime = String(obj.mime || "image/png");
        const b64 = String(obj.b64 || "");

        // base64 -> bytes
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

        return new Response(bytes, {
          status: 200,
          headers: {
            "content-type": mime,
            "cache-control": "public, max-age=300",
            ...cors
          }
        });
      }

      return new Response("Not found", { status: 404, headers: cors });
    } catch (e) {
      return json({ error: "Worker exception", message: String(e?.message || e) }, 500);
    }
  }
};
