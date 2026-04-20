# Problem 4 - Investigation and Stabilization Report

## Quick summary

I found that the main outage was not a random Docker issue. The biggest problem was a simple but critical port mismatch between nginx and the API. On top of that, the stack was missing a few basic reliability pieces, so once something went wrong, it stayed wrong longer than it should have.

## What problems I found

1. The time values were coming from different systems.
- the API was using `Date.now()` while the database was using `NOW()`
- if those machines are not perfectly aligned, the timestamps will not match exactly
- for production, I would keep everything in UTC or the same timezone and rely on one system only to generate time, usually the database

2. The API could leak DB connections on errors.
- the DB client was not guaranteed to be released if something failed after `connect()`
- over time, that can cause pool exhaustion and more 500s

3. nginx was sending `/api/` traffic to the wrong API port.
- nginx was proxying to `api:3001`
- the API was actually listening on `3000`
- that means requests could fail even though the service itself was running

4. The services could start in the wrong order.
- `depends_on` only controls start order, not readiness
- API could come up before Postgres or Redis were ready
- that makes the app look flaky during startup or restarts

5. There was no automatic recovery if a container crashed.
- without a restart policy, one crash can leave the stack broken until someone manually fixes it

6. Postgres had a very low connection limit.
- `max_connections = 20` is pretty tight even for a small setup
- under load, that can become another source of failures

7. The Postgres init script was not being applied.
- `init.sql` existed, but it was not mounted into the container
- so the setting in that file would not actually take effect

8. nginx proxy settings were too minimal.
- missing headers and timeout tuning makes failures harder to debug
- it also makes the proxy less resilient when upstream services are slow

## How I diagnosed it

I started by comparing the nginx config with the API code. That immediately showed the port mismatch: nginx was pointing to 3001 while the app listened on 3000.

I also saw this behavior in the browser/curl flow:

```bash
curl -s http://localhost:8080/api/users
```

At first, it could return a successful response like:

```json
{"ok":true,"time":{"now":"2026-04-15T15:48:08.485Z"}}
```

But after a while, when nginx kept proxying to `api:3001`, it would fail with:

```html
<html>
<head><title>502 Bad Gateway</title></head>
<body>
<center><h1>502 Bad Gateway</h1></center>
<hr><center>nginx/1.25.5</center>
</body>
</html>
```

That was a strong sign that the proxy path was the real problem, not the route itself.

Then I checked the Compose setup and noticed there were no health-based checks, so the API could race ahead of Postgres and Redis. For the reliability side, I checked the logic code first because the result itself was not showing anything obvious, and that is where the DB connection leak showed up. For the accessibility side, I checked the deployment pieces directly: the code, config, and settings, since that is what controls whether nginx can actually reach the API.

Finally, I checked whether the Postgres init file was actually wired into the container. It was not, so that file was effectively dead code.

## What I would change

If I were fixing this in the repo, I would make these changes:

1. For time handling, keep a single source of truth for timestamps, ideally the database, and make sure the system uses UTC or a consistent timezone everywhere.
2. In `src/problem4/api/src/index.js`, keep the DB release in a `finally` block and use env vars for DB/Redis settings.
3. In `src/problem4/nginx/conf.d/default.conf`, point nginx to `api:3000` instead of `api:3001`.
4. In `src/problem4/docker-compose.yml`, add health checks and make API start only after Postgres and Redis are healthy.
5. In `src/problem4/docker-compose.yml`, add `restart: unless-stopped` so the stack can recover from temporary crashes.
6. In `src/problem4/postgres/init.sql`, raise `max_connections` to something more realistic for this setup.
7. In `src/problem4/docker-compose.yml`, mount `src/problem4/postgres/init.sql` into `/docker-entrypoint-initdb.d/` so Postgres actually uses it.
8. In the same nginx file, add normal proxy headers and timeout settings.

## What monitoring and alerts I would add

1. A simple uptime check for `GET /` and `GET /api/users`.
- this would catch the port mismatch immediately

2. Alerts for unhealthy containers and restart spikes.
- if a service keeps restarting, I want to know right away

3. API latency and 5xx alerts.
- if the DB starts slowing down or leaking connections, the error rate will usually move first

4. Postgres connection usage alerts.
- if connections are getting close to the limit, that is an early warning sign

5. Redis connectivity checks.
- even if Redis is not the main issue here, it should still be tracked because the API depends on it

## How I would prevent this in production

1. Add config validation in CI.
- I would check that reverse proxy targets match real service ports before deployment

2. Make health checks mandatory.
- start order is not enough; services should wait for readiness

3. Add restart policy standards.
- every long-running service should have a recovery strategy

4. Keep runtime settings in environment variables.
- hardcoded ports and credentials are easy to miss and painful to maintain

5. Run smoke tests after deploy.
- a quick check against the main endpoints would have caught this issue early

## Final note

I was not able to run the Docker Compose stack directly in this environment because command execution was skipped, so I validated the findings from the code and config instead. Even so, the root cause is pretty clear: one hard routing bug caused the main outage, and the rest of the issues made the service less stable than it should be.