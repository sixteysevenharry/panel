export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "content-type,x-api-key",
      "Cache-Control": "no-store"
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    if (url.pathname === "/update" && request.method === "POST") {
      const key = request.headers.get("x-api-key") || "";
      if (!env.API_KEY || key !== env.API_KEY) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json", ...cors }
        });
      }

      let body;
      try { body = await request.json(); }
      catch {
        return new Response(JSON.stringify({ error: "Invalid JSON" }), {
          status: 400,
          headers: { "content-type": "application/json", ...cors }
        });
      }

      const placeId = Number(body.placeId);
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

      const k = `snap:${placeId}:${jobId}`;
      await env.LIVE.put(k, JSON.stringify(snapshot));
      await env.LIVE.put("snap_index", JSON.stringify({ touchedAt: Date.now(), lastKey: k }));

      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json", ...cors }
      });
    }

    if (url.pathname === "/players" && request.method === "GET") {
      const now = Date.now();
      const maxAgeMs = 90_000;

      const list = [];
      let cursor = undefined;

      while (true) {
        const page = await env.LIVE.list({ prefix: "snap:", cursor });
        for (const item of page.keys) {
          const json = await env.LIVE.get(item.name);
          if (!json) continue;
          try {
            const snap = JSON.parse(json);
            const t = Date.parse(snap.updatedAt || "");
            if (Number.isFinite(t) && (now - t) <= maxAgeMs) list.push(snap);
          } catch {}
        }
        if (page.list_complete) break;
        cursor = page.cursor;
        if (!cursor) break;
      }

      list.sort((a,b) => (a.placeId - b.placeId) || String(a.jobId).localeCompare(String(b.jobId)));

      return new Response(JSON.stringify({
        updatedAt: new Date().toISOString(),
        servers: list
      }), { headers: { "content-type": "application/json", ...cors }});
    }

    return new Response("Not found", { status: 404, headers: cors });
  }
};
