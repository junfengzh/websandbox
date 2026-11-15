# Public demo deployment

All five sites in one container behind one port, served at
**https://websandbox.pystem.com** (landing page) and `shop.` (store, back office at `/admin`),
`forum.`, `code.`, `wiki.`, `map.websandbox.pystem.com`. Runs as one Docker container behind a TLS reverse proxy.

## What happens at every container start

The image (`Dockerfile`: node 20, git, build tools, python3 + huggingface_hub, zstd) only holds
`bootstrap.sh`. On start it:

1. fetches `github.com/junfengzh/websandbox` at `WSB_REF` (default `main`) into `/srv/repo`
   (shallow, no credentials) and runs that checkout's `deploy/start.sh`, which
2. runs `npm ci --omit=dev` in `kit/` and the sites only when their `package*.json` (or the node
   version) changed -- `node_modules` stay in the volume, so a restart takes seconds;
3. syncs the data from the public HF dataset `junfengzhou/websandbox` at `WSB_HF_REV` into
   `/srv/data` (`sync-data.py`: `snapshot_download`, changed files only; every file checked
   against its site's `SHA256SUMS`, hashes cached by size/mtime/inode; `media.tar` /
   `static.tar.zst` re-extracted only when their sha changed); first start downloads ~21 GB;
4. starts the sites with `tasks/tools/sites.sh up --bind ports --base 7700 --tenants 1 --workers 1`
   on 127.0.0.1 (map: 1 route worker, 2 geocoder threads) with a control token generated once
   into `/srv/state/control-token`;
5. execs `router.js` on :8080: routes by Host, serves the landing page (`landing.html`) and
   `/__status` (site health, last/next reset; no secrets), refuses `/__rl/*` on every host
   (the sites trust loopback, and the router's upstream requests come from loopback), drops
   `X-WSB-*` request headers, resets every site each `WSB_RESET_MINUTES` (60, on the hour)
   through the control API, and applies abuse limits: per-IP token buckets (30 req/s, burst
   400; writes 1/s, burst 40; bodies > 256 KB 30/hour), 32 in-flight requests per IP, 5 MB body
   cap. A site unhealthy for ~3 minutes makes the router exit, and the container restarts.
   HTTPS fix-up: the map's `/style.json` and the wiki's opensearch answer carry absolute
   `http://host` URLs; the router rewrites them to `https://` when the proxy says the request was HTTPS.

Volume `./srv`: `repo/`, `data/`,
`state/` (`control-token`, `sites/*.log`).

## Refresh / redeploy

```bash
ssh <docker host>
docker compose up -d --force-recreate     # restart: latest GitHub WSB_REF + HF data, ~1 min when nothing changed
docker compose logs -f     # bootstrap / sync / router log
tail ./srv/state/sites/*.log   # per-site server logs (sudo may be needed)
curl -s http://localhost:8080/__status
```

Pin a code or data version: change `WSB_REF` (branch, tag or commit sha) or `WSB_HF_REV` in the
app's compose (`compose.yaml`), then redeploy.

Rebuild the image (only when `Dockerfile` or `bootstrap.sh` change):

```bash
docker build -t websandbox:latest deploy
docker compose pull && docker compose up -d
```

Create it from scratch: `docker compose up -d` in `deploy/`.

## Reverse proxy

Six proxy hosts, each to the container port, Websockets on, Block common exploits on, SSL:
new Let's Encrypt certificate (HTTP-01), Force SSL, HTTP/2: `websandbox.pystem.com`,
`shop.websandbox.pystem.com`, `forum.websandbox.pystem.com`, `code.websandbox.pystem.com`,
`wiki.websandbox.pystem.com`, `map.websandbox.pystem.com` (one host with all six names and one
certificate works too). Uploads are capped at 5 MB by the router; the proxy's default
`client_max_body_size` is larger.

## Memory

1 tenant per site, 1 worker each: see "RAM" in the deploy report / `docker stats`; the map's
routing graph (~2 GB) dominates. `mem_limit: 7g` in `compose.yaml`.
