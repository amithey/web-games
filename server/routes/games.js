const express  = require('express');
const router   = express.Router();
const multer   = require('multer');
const path     = require('path');
const AdmZip   = require('adm-zip');
const { v4: uuidv4 } = require('uuid');
const db       = require('../db');
const { uploadFile, deleteFolder, getMimeType, createSignedUploadUrl, getPublicUrl } = require('../storage');
const { uploadLimiter, interactionLimiter } = require('../middleware/rateLimiter');
const { optionalAuth } = require('../middleware/auth');

// ─── Input sanitization helpers ──────────────────────────────────────────────

function sanitizeText(value, maxLen) {
  if (!value || typeof value !== 'string') return '';
  return value.trim().slice(0, maxLen);
}

// ─── Multer ──────────────────────────────────────────────────────────────────
// Vercel serverless has a ~4.5 MB body limit; keep multer limit at 4 MB to stay safe.

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'gameFile') {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(ext === '.html' || ext === '.zip' ? null : new Error('Only .html and .zip files are allowed'), ext === '.html' || ext === '.zip');
    } else if (file.fieldname === 'thumbnail') {
      cb(file.mimetype.startsWith('image/') ? null : new Error('Only image files are allowed for thumbnails'), file.mimetype.startsWith('image/'));
    } else {
      cb(null, true);
    }
  },
});

/** Multer error handler — returns user-friendly messages for file issues */
function handleMulterError(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'File too large. Maximum size is 4 MB.' });
    }
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  }
  if (err && err.message) {
    return res.status(400).json({ error: err.message });
  }
  next(err);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Map a DB row (snake_case + computed cols) → camelCase API response */
function formatGame(row) {
  return {
    id:           row.id,
    title:        row.title,
    description:  row.description || '',
    author:       row.author || '',
    tags:         row.tags ? (typeof row.tags === 'string' ? JSON.parse(row.tags) : row.tags) : [],
    thumbnail:    row.thumbnail || null,
    thumbnailUrl: row.thumbnail_url || null,
    playCount:    row.play_count   || 0,
    weeklyPlays:  row.weekly_plays || 0,
    fileType:     row.file_type    || 'html',
    likes:        row.likes        || 0,
    featured:     row.featured     || false,
    isTrending:   row.is_trending  || false,
    aiTool:       row.ai_tool      || null,
    category:     row.category     || null,
    createdAt:    row.created_at,
    fileUrl:      row.file_url     || null,
    avgRating:    row.avg_rating   ? parseFloat(row.avg_rating)   : 0,
    ratingCount:  row.rating_count ? parseInt(row.rating_count)   : 0,
  };
}

/** SELECT that always includes avg rating + count */
const GAME_SELECT = `
  SELECT g.*,
    COALESCE(AVG(r.rating)::numeric(3,1), 0)  AS avg_rating,
    COUNT(DISTINCT r.id)::int                  AS rating_count
  FROM games g
  LEFT JOIN ratings r ON r.game_id = g.id
`;

/** Upload all entries of an in-memory ZIP to Supabase Storage under files/<id>/
 *  Handles any directory depth — finds the shallowest index.html and uses its
 *  folder as the root so relative asset paths always resolve correctly.
 */
async function uploadZip(buffer, id) {
  const zip     = new AdmZip(buffer);
  const entries = zip.getEntries().filter(e => !e.isDirectory);

  // Find the shallowest index.html anywhere in the ZIP
  const indexPaths = entries
    .map(e => e.entryName)
    .filter(p => p.split('/').pop().toLowerCase() === 'index.html')
    .sort((a, b) => a.split('/').length - b.split('/').length);

  if (indexPaths.length === 0) throw new Error('ZIP file must contain an index.html file');

  const indexPath = indexPaths[0];
  const lastSlash = indexPath.lastIndexOf('/');
  const prefix    = lastSlash >= 0 ? indexPath.slice(0, lastSlash + 1) : '';

  let indexUrl = null;
  for (const entry of entries) {
    const rel = entry.entryName.startsWith(prefix)
      ? entry.entryName.slice(prefix.length)
      : entry.entryName;
    if (!rel) continue;
    const url = await uploadFile(`files/${id}/${rel}`, entry.getData(), getMimeType(rel));
    if (rel.toLowerCase() === 'index.html') indexUrl = url;
  }
  if (!indexUrl) throw new Error('Failed to upload index.html');
  return indexUrl;
}

// ─── GET /api/games ───────────────────────────────────────────────────────────
// Query params: sort, search, tag (multi), minLikes, minPlays

router.get('/', async (req, res) => {
  try {
    const sort     = req.query.sort || 'recent';
    const search   = req.query.search?.trim() || '';
    const tags     = [req.query.tag].flat().filter(Boolean);
    const minLikes = parseInt(req.query.minLikes) || 0;
    const minPlays = parseInt(req.query.minPlays) || 0;
    const aiTool   = req.query.aiTool;
    const category = req.query.category;

    const sortMap = {
      liked:  'g.likes DESC, g.created_at DESC',
      played: 'g.play_count DESC, g.created_at DESC',
      recent: 'g.created_at DESC',
      alpha:  'g.title ASC',
      rated:  'avg_rating DESC, rating_count DESC',
      trending: 'g.weekly_plays DESC, g.created_at DESC',
    };
    const orderBy = sortMap[sort] || sortMap.recent;

    // Build dynamic WHERE clause
    const conditions = ['TRUE'];
    const params     = [];
    let   p          = 1;

    if (search) {
      conditions.push(`(g.title ILIKE $${p} OR g.description ILIKE $${p})`);
      params.push(`%${search}%`);
      p++;
    }
    if (minLikes > 0) {
      conditions.push(`g.likes >= $${p}`);
      params.push(minLikes);
      p++;
    }
    if (minPlays > 0) {
      conditions.push(`g.play_count >= $${p}`);
      params.push(minPlays);
      p++;
    }
    if (aiTool) {
      conditions.push(`g.ai_tool = $${p}`);
      params.push(aiTool);
      p++;
    }
    if (category) {
      conditions.push(`g.category = $${p}`);
      params.push(category);
      p++;
    }

    const sql = `
      ${GAME_SELECT}
      WHERE ${conditions.join(' AND ')}
      GROUP BY g.id
      ORDER BY g.featured DESC, ${orderBy}
    `;

    let { rows } = await db.query(sql, params);

    // Tag filtering
    if (tags.length > 0) {
      rows = rows.filter(row => {
        const gameTags = row.tags ? (typeof row.tags === 'string' ? JSON.parse(row.tags) : row.tags) : [];
        return tags.every(t => gameTags.includes(t));
      });
    }

    res.json(rows.map(formatGame));
  } catch (err) {
    console.error('Error fetching games:', err);
    res.status(500).json({ error: 'Failed to fetch games' });
  }
});

// ─── POST /api/games — upload a new game ─────────────────────────────────────

router.post('/', uploadLimiter, optionalAuth, upload.fields([{ name: 'gameFile', maxCount: 1 }, { name: 'thumbnail', maxCount: 1 }]), handleMulterError, async (req, res) => {
  const title       = sanitizeText(req.body.title, 100);
  const description = sanitizeText(req.body.description, 500);
  const author      = sanitizeText(req.body.author, 80);
  const tags        = sanitizeText(req.body.tags, 200);
  const aiTool      = sanitizeText(req.body.aiTool, 50);
  const category    = sanitizeText(req.body.category, 50);

  if (!title) return res.status(400).json({ error: 'Title is required' });
  if (!req.files?.gameFile) return res.status(400).json({ error: 'A game file (.html or .zip) is required' });

  const gameFile = req.files.gameFile[0];
  const ext      = path.extname(gameFile.originalname).toLowerCase();
  
  const id = uuidv4();
  let fileUrl = null, thumbnailUrl = null;

  try {
    fileUrl = ext === '.html'
      ? await uploadFile(`files/${id}/index.html`, gameFile.buffer, 'text/html')
      : await uploadZip(gameFile.buffer, id);

    if (req.files.thumbnail?.[0]) {
      const thumb    = req.files.thumbnail[0];
      const thumbExt = path.extname(thumb.originalname).toLowerCase() || '.png';
      thumbnailUrl   = await uploadFile(`thumbnails/${id}${thumbExt}`, thumb.buffer, thumb.mimetype);
    }

    const tagsArray = tags
      ? tags.split(',').map(t => t.trim()).filter(Boolean).slice(0, 10)
      : [];

    const userId = req.user?.userId || null;
    await db.query(
      `INSERT INTO games (id, title, description, author, tags, thumbnail, thumbnail_url, file_type, file_url, ai_tool, category, user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, title, description, author, JSON.stringify(tagsArray), thumbnailUrl, thumbnailUrl, ext.slice(1), fileUrl, aiTool, category, userId]
    );

    const { rows: [game] } = await db.query(
      `${GAME_SELECT} WHERE g.id = $1 GROUP BY g.id`, [id]
    );
    res.status(201).json(formatGame(game));
  } catch (err) {
    if (id) await deleteFolder(`files/${id}`).catch(() => {});
    console.error('Error uploading game:', err);
    res.status(500).json({ error: err.message || 'Failed to upload game' });
  }
});

// ─── POST /api/games/sign-upload — get signed URLs for direct-to-Storage upload
// Lets the client bypass the 4.5MB serverless body limit by PUT-ing files
// straight to Supabase Storage. Returns a freshly-minted game id and a signed
// URL per requested path (plus an optional thumbnail signed URL).

const MAX_DIRECT_UPLOAD_FILES = 500;
const MAX_DIRECT_UPLOAD_TOTAL_BYTES = 200 * 1024 * 1024; // 200 MB total
const ALLOWED_FILE_EXTS = new Set([
  '.html','.htm','.css','.js','.mjs','.json','.txt','.md','.map',
  '.png','.jpg','.jpeg','.gif','.webp','.svg','.ico','.bmp',
  '.wav','.mp3','.ogg','.m4a','.flac',
  '.mp4','.webm','.mov',
  '.wasm','.data','.mem',
  '.woff','.woff2','.ttf','.otf','.eot',
  '.glb','.gltf','.obj','.mtl','.fbx',
  '.xml','.csv','.atlas','.fnt',
]);

function isSafeRelPath(rel) {
  if (!rel || typeof rel !== 'string') return false;
  if (rel.length > 300) return false;
  if (rel.startsWith('/') || rel.includes('..') || rel.includes('\\')) return false;
  if (/[\0<>:"|?*]/.test(rel)) return false;
  return true;
}

router.post('/sign-upload', uploadLimiter, optionalAuth, async (req, res) => {
  try {
    const { files, thumbnailExt } = req.body || {};
    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: 'files array is required' });
    }
    if (files.length > MAX_DIRECT_UPLOAD_FILES) {
      return res.status(400).json({ error: `Too many files (max ${MAX_DIRECT_UPLOAD_FILES})` });
    }

    // Validate + require an index.html somewhere
    let totalBytes = 0;
    let hasIndex = false;
    const normalized = [];
    for (const f of files) {
      const rel = (f && f.path || '').trim().replace(/^\/+/, '');
      const size = Number(f && f.size) || 0;
      if (!isSafeRelPath(rel)) {
        return res.status(400).json({ error: `Invalid file path: ${rel}` });
      }
      const ext = path.extname(rel).toLowerCase();
      if (!ALLOWED_FILE_EXTS.has(ext)) {
        return res.status(400).json({ error: `File type not allowed: ${rel}` });
      }
      if (rel.toLowerCase().split('/').pop() === 'index.html') hasIndex = true;
      totalBytes += size;
      normalized.push({ rel, size });
    }
    if (!hasIndex) {
      return res.status(400).json({ error: 'At least one file must be named index.html' });
    }
    if (totalBytes > MAX_DIRECT_UPLOAD_TOTAL_BYTES) {
      return res.status(413).json({ error: `Total size exceeds ${MAX_DIRECT_UPLOAD_TOTAL_BYTES / (1024*1024)} MB` });
    }

    const id = uuidv4();
    const signedFiles = [];
    for (const { rel } of normalized) {
      const storagePath = `files/${id}/${rel}`;
      const entry = await createSignedUploadUrl(storagePath);
      signedFiles.push({ rel, ...entry });
    }

    let thumbnail = null;
    if (thumbnailExt) {
      const ext = String(thumbnailExt).toLowerCase();
      if (!/^\.(png|jpg|jpeg|webp|gif)$/.test(ext)) {
        return res.status(400).json({ error: 'Invalid thumbnail extension' });
      }
      thumbnail = await createSignedUploadUrl(`thumbnails/${id}${ext}`);
    }

    res.json({ id, files: signedFiles, thumbnail });
  } catch (err) {
    console.error('sign-upload error:', err);
    res.status(500).json({ error: err.message || 'Failed to sign upload' });
  }
});

// ─── POST /api/games/direct — finalize a direct-upload game ───────────────────
// Called after the client has successfully PUT all files to the signed URLs.
// Inserts the DB record pointing at the already-uploaded index.html.

router.post('/direct', uploadLimiter, optionalAuth, async (req, res) => {
  const {
    id,
    indexPath,
    fileType,
    thumbnailPath,
  } = req.body || {};

  const title       = sanitizeText(req.body.title, 100);
  const description = sanitizeText(req.body.description, 500);
  const author      = sanitizeText(req.body.author, 80);
  const tags        = sanitizeText(req.body.tags, 200);
  const aiTool      = sanitizeText(req.body.aiTool, 50);
  const category    = sanitizeText(req.body.category, 50);

  if (!title) return res.status(400).json({ error: 'Title is required' });
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'Invalid id' });
  if (!indexPath || !isSafeRelPath(indexPath)) return res.status(400).json({ error: 'Invalid indexPath' });
  if (indexPath.toLowerCase().split('/').pop() !== 'index.html') {
    return res.status(400).json({ error: 'indexPath must point to an index.html file' });
  }

  try {
    const fileUrl = getPublicUrl(`files/${id}/${indexPath}`);
    let thumbnailUrl = null;
    if (thumbnailPath && isSafeRelPath(thumbnailPath)) {
      thumbnailUrl = getPublicUrl(`thumbnails/${thumbnailPath}`);
    }

    const tagsArray = tags
      ? tags.split(',').map(t => t.trim()).filter(Boolean).slice(0, 10)
      : [];

    const ft = (fileType === 'html' || fileType === 'zip') ? fileType : 'zip';
    const userId = req.user?.userId || null;

    await db.query(
      `INSERT INTO games (id, title, description, author, tags, thumbnail, thumbnail_url, file_type, file_url, ai_tool, category, user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, title, description, author, JSON.stringify(tagsArray), thumbnailUrl, thumbnailUrl, ft, fileUrl, aiTool, category, userId]
    );

    const { rows: [game] } = await db.query(
      `${GAME_SELECT} WHERE g.id = $1 GROUP BY g.id`, [id]
    );
    res.status(201).json(formatGame(game));
  } catch (err) {
    await deleteFolder(`files/${id}`).catch(() => {});
    console.error('direct upload finalize error:', err);
    res.status(500).json({ error: err.message || 'Failed to create game' });
  }
});

// ─── GET /api/games/:id ───────────────────────────────────────────────────────

router.get('/:id', async (req, res) => {
  try {
    const { rows: [game] } = await db.query(
      `${GAME_SELECT} WHERE g.id = $1 GROUP BY g.id`, [req.params.id]
    );
    if (!game) return res.status(404).json({ error: 'Game not found' });
    res.json(formatGame(game));
  } catch (err) {
    console.error('Error fetching game:', err);
    res.status(500).json({ error: 'Failed to fetch game' });
  }
});

// ─── GET /api/games/:id/play ──────────────────────────────────────────────────

router.get('/:id/play', async (req, res) => {
  try {
    const { rows: [game] } = await db.query('SELECT file_url FROM games WHERE id = $1', [req.params.id]);
    if (!game)           return res.status(404).json({ error: 'Game not found' });
    if (!game.file_url)  return res.status(404).json({ error: 'Game file not found' });
    res.redirect(game.file_url);
  } catch (err) {
    console.error('Error serving game:', err);
    res.status(500).json({ error: 'Failed to serve game' });
  }
});

// ─── GET /api/games/:id/like-status ──────────────────────────────────────────

router.get('/:id/like-status', optionalAuth, async (req, res) => {
  try {
    if (!req.user) return res.json({ liked: false });
    const { rows } = await db.query(
      'SELECT 1 FROM user_likes WHERE user_id = $1 AND game_id = $2',
      [req.user.userId, req.params.id]
    );
    res.json({ liked: rows.length > 0 });
  } catch (err) {
    console.error('Error checking like status:', err);
    res.status(500).json({ error: 'Failed to check like status' });
  }
});

// ─── POST /api/games/:id/like ─────────────────────────────────────────────────

router.post('/:id/like', interactionLimiter, optionalAuth, async (req, res) => {
  try {
    // If logged in, track per-user and prevent duplicates
    if (req.user) {
      const { rows: existing } = await db.query(
        'SELECT 1 FROM user_likes WHERE user_id = $1 AND game_id = $2',
        [req.user.userId, req.params.id]
      );
      if (existing.length > 0) {
        return res.status(409).json({ error: 'Already liked' });
      }
      await db.query(
        'INSERT INTO user_likes (user_id, game_id) VALUES ($1, $2)',
        [req.user.userId, req.params.id]
      );

      // Create notification for game author
      try {
        const { rows: [game] } = await db.query(
          'SELECT author FROM games WHERE id = $1', [req.params.id]
        );
        if (game?.author) {
          const { rows: [owner] } = await db.query(
            'SELECT id FROM users WHERE LOWER(username) = LOWER($1)', [game.author]
          );
          if (owner && owner.id !== req.user.userId) {
            await db.query(
              'INSERT INTO notifications (user_id, type, message, game_id) VALUES ($1, $2, $3, $4)',
              [owner.id, 'like', `${req.user.username} liked your game`, req.params.id]
            );
          }
        }
      } catch { /* notification failure is non-critical */ }
    }

    const { rows: [updated] } = await db.query(
      'UPDATE games SET likes = likes + 1 WHERE id = $1 RETURNING likes',
      [req.params.id]
    );
    if (!updated) return res.status(404).json({ error: 'Game not found' });
    res.json({ likes: updated.likes });
  } catch (err) {
    console.error('Error liking game:', err);
    res.status(500).json({ error: 'Failed to like game' });
  }
});

// ─── POST /api/games/:id/unlike ───────────────────────────────────────────────

router.post('/:id/unlike', interactionLimiter, optionalAuth, async (req, res) => {
  try {
    if (req.user) {
      await db.query(
        'DELETE FROM user_likes WHERE user_id = $1 AND game_id = $2',
        [req.user.userId, req.params.id]
      );
    }

    const { rows: [updated] } = await db.query(
      'UPDATE games SET likes = GREATEST(likes - 1, 0) WHERE id = $1 RETURNING likes',
      [req.params.id]
    );
    if (!updated) return res.status(404).json({ error: 'Game not found' });
    res.json({ likes: updated.likes });
  } catch (err) {
    console.error('Error unliking game:', err);
    res.status(500).json({ error: 'Failed to unlike game' });
  }
});

// ─── PATCH /api/games/:id/increment ──────────────────────────────────────────

router.patch('/:id/increment', async (req, res) => {
  try {
    const { rows: [updated] } = await db.query(
      'UPDATE games SET play_count = play_count + 1 WHERE id = $1 RETURNING *',
      [req.params.id]
    );
    if (!updated) return res.status(404).json({ error: 'Game not found' });
    res.json(formatGame(updated));
  } catch (err) {
    console.error('Error incrementing play count:', err);
    res.status(500).json({ error: 'Failed to increment play count' });
  }
});

// ─── POST /api/games/:id/rate ─────────────────────────────────────────────────

router.post('/:id/rate', interactionLimiter, async (req, res) => {
  try {
    const rating = parseInt(req.body.rating);
    if (!rating || rating < 1 || rating > 5)
      return res.status(400).json({ error: 'Rating must be between 1 and 5' });

    const { rows: [game] } = await db.query('SELECT id FROM games WHERE id = $1', [req.params.id]);
    if (!game) return res.status(404).json({ error: 'Game not found' });

    await db.query('INSERT INTO ratings (game_id, rating) VALUES ($1, $2)', [req.params.id, rating]);

    const { rows: [result] } = await db.query(
      `SELECT COALESCE(AVG(rating)::numeric(3,1), 0)::float AS average,
              COUNT(*)::int                                  AS count
       FROM ratings WHERE game_id = $1`,
      [req.params.id]
    );
    res.json({ average: result.average, count: result.count });
  } catch (err) {
    console.error('Error rating game:', err);
    res.status(500).json({ error: 'Failed to rate game' });
  }
});

// ─── GET /api/games/:id/rating ────────────────────────────────────────────────

router.get('/:id/rating', async (req, res) => {
  try {
    const { rows: [result] } = await db.query(
      `SELECT COALESCE(AVG(rating)::numeric(3,1), 0)::float AS average,
              COUNT(*)::int                                  AS count
       FROM ratings WHERE game_id = $1`,
      [req.params.id]
    );
    res.json({ average: result.average, count: result.count });
  } catch (err) {
    console.error('Error fetching rating:', err);
    res.status(500).json({ error: 'Failed to fetch rating' });
  }
});

// ─── GET /api/games/:id/comments ─────────────────────────────────────────────

router.get('/:id/comments', async (req, res) => {
  try {
    const { rows: [game] } = await db.query('SELECT id FROM games WHERE id = $1', [req.params.id]);
    if (!game) return res.status(404).json({ error: 'Game not found' });
    const { rows } = await db.query(
      'SELECT * FROM comments WHERE game_id = $1 ORDER BY created_at DESC',
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    console.error('Error fetching comments:', err);
    res.status(500).json({ error: 'Failed to fetch comments' });
  }
});

// ─── POST /api/games/:id/comments ────────────────────────────────────────────

router.post('/:id/comments', interactionLimiter, async (req, res) => {
  try {
    const { rows: [game] } = await db.query('SELECT id FROM games WHERE id = $1', [req.params.id]);
    if (!game) return res.status(404).json({ error: 'Game not found' });

    const content     = sanitizeText(req.body.content, 1000);
    const author_name = sanitizeText(req.body.author_name, 80) || 'Anonymous';
    const parent_id   = req.body.parentId ? parseInt(req.body.parentId) : null;
    
    if (!content) return res.status(400).json({ error: 'Comment content is required' });

    const { rows: [comment] } = await db.query(
      'INSERT INTO comments (game_id, author_name, content, parent_id) VALUES ($1,$2,$3,$4) RETURNING *',
      [req.params.id, author_name, content, parent_id]
    );

    // Notify game owner
    try {
      const { rows: [g] } = await db.query('SELECT user_id, title FROM games WHERE id = $1', [req.params.id]);
      if (g?.user_id) {
        await db.query(
          'INSERT INTO notifications (user_id, type, message, game_id) VALUES ($1, $2, $3, $4)',
          [g.user_id, 'comment', `${author_name} commented on your game "${g.title}"`, req.params.id]
        );
      }
    } catch { /* non-critical */ }

    res.status(201).json(comment);
  } catch (err) {
    console.error('Error posting comment:', err);
    res.status(500).json({ error: 'Failed to post comment' });
  }
});

// ─── POST /api/games/:id/report ───────────────────────────────────────────────

router.post('/:id/report', interactionLimiter, async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ error: 'Reason is required' });
    
    const { rows: [game] } = await db.query('SELECT id FROM games WHERE id = $1', [req.params.id]);
    if (!game) return res.status(404).json({ error: 'Game not found' });

    await db.query(
      'INSERT INTO reports (game_id, reason) VALUES ($1, $2)',
      [req.params.id, reason]
    );
    res.json({ success: true, message: 'Report submitted' });
  } catch (err) {
    console.error('Error reporting game:', err);
    res.status(500).json({ error: 'Failed to report game' });
  }
});

// ─── POST /api/games/comments/:commentId/react ───────────────────────────────

router.post('/comments/:commentId/react', interactionLimiter, async (req, res) => {
  try {
    const { emoji } = req.body;
    if (!emoji) return res.status(400).json({ error: 'Emoji is required' });

    const { rows: [comment] } = await db.query('SELECT reactions FROM comments WHERE id = $1', [req.params.commentId]);
    if (!comment) return res.status(404).json({ error: 'Comment not found' });

    const reactions = comment.reactions || {};
    reactions[emoji] = (reactions[emoji] || 0) + 1;

    const { rows: [updated] } = await db.query(
      'UPDATE comments SET reactions = $1 WHERE id = $2 RETURNING reactions',
      [JSON.stringify(reactions), req.params.commentId]
    );
    res.json({ reactions: updated.reactions });
  } catch (err) {
    console.error('Error reacting to comment:', err);
    res.status(500).json({ error: 'Failed to react to comment' });
  }
});

module.exports = router;
