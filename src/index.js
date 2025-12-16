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
        return new Response(JSON.stringify({ error: "KV binding LIVE is missing" }), {
          status: 500,
          headers: { "content-type": "application/json", ...cors }
        });
      }

      // ---------- ROBLOX -> update snapshot per server ----------
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

        const snapshot = {
          updatedAt: new Date().toISOString(),
          placeId,
          jobId,
          players: players.map(p => ({
            userId: Number(p.userId),
            username: String(p.username || ""),
            displayName: String(p.displayName || ""),
            team: p.team ? String(p.team) : null
          }))
        };

        // store per-server, expire if server goes dead
        await env.LIVE.put(`snap:${placeId}:${jobId}`, JSON.stringify(snapshot), { expirationTtl: 180 });

        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json", ...cors }
        });
      }

      // ---------- WEBSITE -> combined players ----------
      if (url.pathname === "/players" && request.method === "GET") {
        const now = Date.now();
        const maxAgeMs = 180_000; // 3 minutes

        const servers = [];
        let cursor = undefined;

        while (true) {
          const page = await env.LIVE.list({ prefix: "snap:", cursor });
          for (const item of page.keys) {
            const json = await env.LIVE.get(item.name);
            if (!json) continue;
            try {
              const snap = JSON.parse(json);
              const t = Date.parse(snap.updatedAt || "");
              if (Number.isFinite(t) && (now - t) <= maxAgeMs) servers.push(snap);
            } catch {}
          }
          if (page.list_complete) break;
          cursor = page.cursor;
          if (!cursor) break;
        }

        // combine into one list for your panel
        const combined = [];
        const seen = new Set();
        for (const s of servers) {
          for (const p of (s.players || [])) {
            const id = Number(p.userId);
            if (!id || seen.has(id)) continue;
            seen.add(id);
            combined.push(p);
          }
        }

        combined.sort((a, b) =>
          String(a.displayName || a.username).localeCompare(String(b.displayName || b.username))
        );

        return new Response(JSON.stringify({
          updatedAt: new Date().toISOString(),
          totalServers: servers.length,
          totalPlayers: combined.length,
          players: combined,
          servers
        }), { headers: { "content-type": "application/json", ...cors }});
      }

      // ---------- MODERATION endpoints (if you already had them) ----------
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
          createdAt: new Date().toISOString(),
          action,
          userId,
          reason: reason.slice(0, 180),
          placeId: body.placeId ? Number(body.placeId) : null
        };

        await env.LIVE.put(`cmd:${cmd.id}`, JSON.stringify(cmd), { expirationTtl: 600 });

        return new Response(JSON.stringify({ ok: true, cmd }), {
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

        const placeId = Number(url.searchParams.get("placeId") || 0);
        const list = await env.LIVE.list({ prefix: "cmd:" });

        const cmds = [];
        for (const k of list.keys) {
          const json = await env.LIVE.get(k.name);
          if (!json) continue;
          try {
            const c = JSON.parse(json);
            if (c.placeId && placeId && Number(c.placeId) !== placeId) continue;
            cmds.push(c);
          } catch {}
        }

        cmds.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
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
        const id = String(body.id || "");
        if (!id) {
          return new Response(JSON.stringify({ error: "Missing id" }), {
            status: 400,
            headers: { "content-type": "application/json", ...cors }
          });
        }

        await env.LIVE.delete(`cmd:${id}`);
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json", ...cors }
        });
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
