Upload these files to your GitHub repo exactly like this:

/
  index.html
  wrangler.jsonc
  /src
    index.js

If you are deploying the Worker with Wrangler:
- Create a KV namespace and bind it as LIVE
- Add secret API_KEY

Worker endpoints:
- POST /update (Roblox sends data)
- GET  /players (Website reads data)

GitHub Pages serves index.html (frontend). Cloudflare Worker serves /players and /update (backend).
