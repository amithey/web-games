# WebGames

A modern community platform for uploading, sharing, and playing browser-based games. Built with React, Node.js, and Supabase.

**[Live Demo](https://web-games-mauve.vercel.app)**

---

## Features

- **Game Discovery** -- Browse, search, filter by tags, and sort by popularity, rating, recency, or featured status.
- **Seamless Playback** -- Games run in sandboxed iframes with keyboard event isolation for an uninterrupted experience.
- **Upload** -- Upload single HTML files or multi-file ZIP archives (up to 200MB / 500 files) via direct-to-Supabase signed URLs, with optional thumbnails.
- **Ratings & Likes** -- 1-5 star rating system and like/unlike toggle for every game.
- **Comments** -- Community discussion on each game page.
- **Creator Profiles** -- Dedicated pages per author with aggregated stats (total games, likes, plays).
- **Leaderboard** -- Global ranking of top creators and games.
- **Admin Dashboard** -- Secure JWT-authenticated portal for content moderation, featured toggling, and platform analytics.
- **About Page** -- Platform info and credits.

---

## Tech Stack

| Layer | Technology |
|---|---|
| **Frontend** | React 18, Vite, TailwindCSS, Axios |
| **Backend** | Node.js, Express.js |
| **Database** | Supabase (PostgreSQL via `pg` pool) |
| **Storage** | Supabase Storage (public bucket for game assets) |
| **Security** | JWT, Helmet.js, express-rate-limit, bcryptjs, CORS |
| **Deployment** | Vercel |

---

## Security

- **JWT Authentication** for admin access with timing-safe password comparison.
- **Rate Limiting** -- General API (200/15min), admin login (10/15min), uploads (10/hr), interactions (30/min).
- **Helmet.js** -- Strict Content Security Policy and security headers.
- **CORS** -- Origin-based access control restricted to the frontend domain.
- **Payload Limits** -- 1MB cap on JSON/URL-encoded bodies.

---

## Project Structure

```text
WebGames/
├── client/                  # React frontend (Vite)
│   ├── src/
│   │   ├── pages/           # Home, Game, Upload, Creator, Leaderboard, Admin, About
│   │   └── main.jsx         # Entry point & API base URL config
│   └── vercel.json          # SPA routing
├── server/                  # Express backend
│   ├── middleware/           # Rate limiting
│   ├── routes/              # games, creators, admin
│   ├── db.js                # PostgreSQL connection pool
│   ├── storage.js           # Supabase Storage helpers
│   └── app.js               # Express app setup
├── supabase/
│   └── schema.sql           # Database schema (games, comments, ratings)
└── vercel.json              # Root Vercel config (frontend build + CSP headers)
```

---

## Database Schema

| Table | Description |
|---|---|
| **games** | id, title, description, author, tags, thumbnail, play_count, file_type, likes, featured, created_at, file_url |
| **comments** | id, game_id, author_name, content, created_at |
| **ratings** | id, game_id, rating (1-5), created_at |

---

## API Endpoints

### Games
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/games` | List games (sort, search, tag filter) |
| POST | `/api/games` | Upload a game (multipart) |
| GET | `/api/games/:id` | Game details with avg rating |
| POST | `/api/games/:id/like` | Like a game |
| POST | `/api/games/:id/unlike` | Unlike a game |
| POST | `/api/games/:id/rate` | Rate a game (1-5) |
| GET | `/api/games/:id/comments` | Get comments |
| POST | `/api/games/:id/comments` | Post a comment |

### Creators
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/creators/:name` | Creator profile & stats |

### Admin
| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/admin/login` | Login (returns JWT) |
| GET | `/api/admin/stats` | Platform analytics |
| GET | `/api/admin/games` | All games (admin view) |
| DELETE | `/api/admin/games/:id` | Delete a game |
| PATCH | `/api/admin/games/:id/feature` | Toggle featured |

---

## Local Development

### 1. Install Dependencies

```bash
npm install
npm run install:all
```

### 2. Environment Setup

Create a `.env` file in `server/`:

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
DATABASE_URL=postgresql://postgres:password@db.ref.supabase.co:5432/postgres
JWT_SECRET=your-long-random-secret
ADMIN_PASSWORD=your-secure-admin-password
FRONTEND_URL=http://localhost:5173
```

### 3. Database Setup

Run `supabase/schema.sql` in the Supabase SQL Editor. Create a public storage bucket named `games`.

### 4. Run

```bash
npm run dev
```

Frontend: `http://localhost:5173` | Backend: `http://localhost:3001`

---

## Deployment (Vercel)

1. **Backend** -- Import repo, set root directory to `server/`. Add all `.env` variables.
2. **Frontend** -- Import repo, set root directory to root (`/`). Add `VITE_API_URL` pointing to the backend Vercel URL.

---

## Limitations

- Vercel Serverless has a ~4.5MB payload limit, so game files are uploaded **directly** to Supabase Storage via signed URLs (client unzips in-browser with JSZip). Current caps: 200MB total / 500 files per game.
- Vercel Hobby tier has a 10s function timeout.
- Cold starts may add 1-2s delay on first request.
