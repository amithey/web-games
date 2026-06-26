const { createClient } = require('@supabase/supabase-js');
const path = require('path');

// --- Sanitize and Log ---
const rawUrl = (process.env.SUPABASE_URL || '').replace(/\s+/g, '').replace(/\/+$/, '');
const rawKey = (process.env.SUPABASE_ANON_KEY || '').replace(/\s+/g, '');

// Validate URL format before passing to createClient
let supabaseUrl = rawUrl;
let supabaseKey = rawKey;
let initError = null;

if (!supabaseUrl || !supabaseKey) {
  initError = 'SUPABASE_URL or SUPABASE_ANON_KEY is missing from environment variables';
  console.error(`FATAL: ${initError}`);
} else {
  try {
    // Basic check for protocol
    if (!supabaseUrl.startsWith('http')) {
      supabaseUrl = `https://${supabaseUrl}`;
    }
    new URL(supabaseUrl);
  } catch (e) {
    initError = `SUPABASE_URL is not a valid URL: "${supabaseUrl}"`;
    console.error(`FATAL: ${initError}`);
  }
}

if (!initError) {
  const maskedUrl = supabaseUrl.replace(/^(https?:\/\/)[^.]+/, '$1***');
  console.log(`[Supabase] Initializing with URL: ${maskedUrl}`);
}

const supabase = createClient(
  supabaseUrl || 'https://placeholder.supabase.co',
  supabaseKey || 'placeholder'
);

const BUCKET = 'games';

/** Map file extension → MIME type for correct Content-Type in Storage */
function getMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const map = {
    '.html': 'text/html',
    '.css':  'text/css',
    '.js':   'application/javascript',
    '.mjs':  'application/javascript',
    '.json': 'application/json',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif':  'image/gif',
    '.webp': 'image/webp',
    '.svg':  'image/svg+xml',
    '.ico':  'image/x-icon',
    '.wav':  'audio/wav',
    '.mp3':  'audio/mpeg',
    '.ogg':  'audio/ogg',
    '.mp4':  'video/mp4',
    '.webm': 'video/webm',
    '.wasm': 'application/wasm',
    '.woff': 'font/woff',
    '.woff2':'font/woff2',
    '.ttf':  'font/ttf',
    '.otf':  'font/otf',
  };
  return map[ext] || 'application/octet-stream';
}

/**
 * Upload a buffer to Supabase Storage and return its public URL.
 */
async function uploadFile(storagePath, buffer, contentType) {
  if (initError) throw new Error(`Storage not configured: ${initError}`);

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, buffer, {
      contentType: contentType || getMimeType(storagePath),
      upsert: true,
    });
  if (error) throw new Error(`Storage upload failed: ${error.message}`);

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);
  return data.publicUrl;
}

/**
 * Delete all files under a "folder" prefix in the bucket.
 */
async function deleteFolder(prefix) {
  if (initError) return;
  const { data } = await supabase.storage.from(BUCKET).list(prefix, { limit: 1000 });
  if (data && data.length > 0) {
    const paths = data.map(f => `${prefix}/${f.name}`);
    await supabase.storage.from(BUCKET).remove(paths);
  }
}

/** Returns null if storage is healthy, or an error string */
function getStorageStatus() {
  return initError;
}

/**
 * Create a signed upload URL that lets the client PUT a file directly to
 * Supabase Storage, bypassing the serverless body size limit.
 */
async function createSignedUploadUrl(storagePath) {
  if (initError) throw new Error(`Storage not configured: ${initError}`);
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUploadUrl(storagePath);
  if (error) throw new Error(`Failed to create signed upload URL: ${error.message}`);
  const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);
  return {
    path: storagePath,
    signedUrl: data.signedUrl,
    token: data.token,
    publicUrl: pub.publicUrl,
  };
}

function getPublicUrl(storagePath) {
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);
  return data.publicUrl;
}

module.exports = { supabase, uploadFile, deleteFolder, getMimeType, getStorageStatus, createSignedUploadUrl, getPublicUrl };
