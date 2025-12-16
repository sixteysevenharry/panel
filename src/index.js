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

      // ----- PUBLIC: website reads players -----
      if (url.pathname === "/players" && request.method === "GET") {
        const json = await env.LIVE.get("snapshot");
        return new Response(
          json || JSON.stringify({ updatedAt: null, placeId: null, jobId: null, players: [] }),
          { headers: { "content-type": "application/json", ...cors } }
        );
      }

      // ----- ROBLOX: game writes players -----
      if (url.pathname === "/update" && request.method === "POST") {
        const key = request.headers.get("x-api-key") || "";
        if (!env.API_KEY || key !== env.API_KEY) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: { "content-type": "application/json", ...cors }
          });
        }

        const body = await request.json();
        if (!Array.isArray(body.players)) {
          return new Response(JSON.stringify({ error: "Invalid payload" }), {
            status: 400,
            headers: { "content-type": "application/json", ...cors }
          });
        }

        const snapshot = {
          updatedAt: new Date().toISOString(),
          placeId: body.placeId ?? null,
          jobId: body.jobId ?? null,
          players: body.players.map(p => ({
            userId: Number(p.userId),
            username: String(p.username || ""),
            displayName: String(p.displayName || ""),
            team: p.team ? String(p.team) : null
          }))
        };

        await env.LIVE.put("snapshot", JSON.stringify(snapshot));
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json", ...cors }
        });
      }

      // ----- PANEL: create moderation command (kick/ban/unban) -----
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
          // optional: target a specific place (send placeId from the panel if you want)
          placeId: body.placeId ? Number(body.placeId) : null
        };

        // Store command for up to 10 minutes
        await env.LIVE.put(`cmd:${cmd.id}`, JSON.stringify(cmd), { expirationTtl: 600 });

        return new Response(JSON.stringify({ ok: true, cmd }), {
          headers: { "content-type": "application/json", ...cors }
        });
      }

      // ----- ROBLOX: poll commands -----
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

      // ----- ROBLOX: acknowledge command processed -----
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
