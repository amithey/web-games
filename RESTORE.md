# Restoring the backend

The Supabase project this app was built against (`wxgnzfnpftvvxyorngho`) no longer
exists — its hostname returns NXDOMAIN, which is what a **deleted** project looks
like (a merely paused one still resolves). That took the database, the storage
bucket, and auth with it, which is why the site loads but the game catalogue is
empty and `/api/games` returns 500.

Everything needed to rebuild it is in this repo. These are the steps.

## How the pieces fit

There are **two** Vercel projects, not one:

| Vercel project | What it is | URL |
| --- | --- | --- |
| `web-games` | The Vite client (static) | https://web-games-mauve.vercel.app |
| `server` | The Express API | https://server-theta-vert.vercel.app |

The client does not proxy to the API — it calls it directly, using `VITE_API_URL`
baked in **at build time**. The `rewrites` block in the root `vercel.json` is
leftover and unused.

That build-time detail matters: changing the client's environment variables does
nothing until the client is **redeployed**, because the old values are compiled
into the JS bundle.

## 1. Create a new Supabase project

At https://supabase.com/dashboard — any region, free tier is fine.

## 2. Load the schema

Open the project's **SQL Editor**, paste the whole of `supabase/schema.sql`, run it.

It creates 9 tables, 7 indexes, and a trigger that auto-creates a `profiles` row
whenever a user signs up. It is idempotent (`IF NOT EXISTS` throughout), so it is
safe to re-run.

## 3. Create the storage bucket

**Storage → New bucket**, named exactly `games`, and marked **public**.

The name is not configurable — `server/storage.js` hardcodes `const BUCKET = 'games'`.
It must be public because uploaded games are served through `getPublicUrl()`, which
produces unsigned URLs.

## 4. Collect three values

From **Project Settings**:

- **Project URL** — `https://<ref>.supabase.co` (Settings → API)
- **anon public key** (Settings → API)
- **Connection string** (Settings → Database) — use the **Session pooler** one on
  port `6543`, and substitute your real database password into it

## 5. Set the environment variables

Only these are actually read by the code. `.env.example` also lists `JWT_SECRET`
and `ADMIN_PASSWORD`, but nothing references them — ignore those two.

**On the `server` project:**

```
SUPABASE_URL=https://<ref>.supabase.co
SUPABASE_ANON_KEY=<anon key>
DATABASE_URL=<session pooler connection string, port 6543>
FRONTEND_URL=https://web-games-mauve.vercel.app
```

**On the `web-games` project:**

```
VITE_SUPABASE_URL=https://<ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon key>
VITE_API_URL=https://server-theta-vert.vercel.app
```

`DATABASE_URL` is whitespace-sensitive in practice — `server/db.js` strips
whitespace defensively precisely because pasting it from the dashboard tends to
introduce newlines.

## 6. Redeploy both projects

The server picks up its variables on redeploy. The client **must** be redeployed
for its `VITE_*` values to take effect, since they are compiled in.

## 7. Verify

```bash
curl -s https://server-theta-vert.vercel.app/api/health
```

A healthy response has `"connection": "ok"` under `db`. While it is broken it
reports the actual failure reason, which is how the deleted project was diagnosed
in the first place.

Then:

```bash
curl -s https://server-theta-vert.vercel.app/api/games
```

should return JSON — an empty array is correct for a fresh database, and means
everything is wired up. Load the site and the catalogue will be empty until games
are uploaded.

## Avoiding a repeat

Supabase pauses free projects after about a week of inactivity and eventually
removes them. If this project is meant to stay reachable, either open the
dashboard periodically or move the database somewhere without idle deletion.
