import React, { useState, useCallback, useMemo } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import axios from 'axios';
import { useDropzone } from 'react-dropzone';
import { supabase } from '../supabase';

// Lazy-load JSZip from CDN to keep the client bundle small and avoid extra deps.
let _jszipPromise = null;
function loadJSZip() {
  if (window.JSZip) return Promise.resolve(window.JSZip);
  if (_jszipPromise) return _jszipPromise;
  _jszipPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
    s.onload = () => resolve(window.JSZip);
    s.onerror = () => reject(new Error('Failed to load JSZip'));
    document.head.appendChild(s);
  });
  return _jszipPromise;
}
import { motion, AnimatePresence } from 'framer-motion';
import {
  Upload as UploadIcon,
  X,
  CheckCircle2,
  AlertCircle,
  Gamepad2,
  Cpu,
  Zap,
  LayoutGrid,
  Trophy,
  Image as ImageIcon,
  FileCode,
  Eye,
  ArrowLeft,
  Sparkles
} from 'lucide-react';

const AI_TOOLS = [
  'Claude', 'ChatGPT', 'Gemini', 'Copilot', 'v0', 'Bolt', 'Cursor', 'Replit', 'Other'
];

const CATEGORIES = [
  { id: 'action', label: 'Action', icon: Zap },
  { id: 'puzzle', label: 'Puzzle', icon: LayoutGrid },
  { id: 'arcade', label: 'Arcade', icon: Gamepad2 },
  { id: 'rpg', label: 'RPG', icon: Trophy },
  { id: 'simulation', label: 'Simulation', icon: Cpu },
];

function Dropzone({ onDrop, accept, icon: Icon, label, hint, file, error }) {
  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept,
    multiple: false
  });

  return (
    <div
      {...getRootProps()}
      className={`relative border-2 border-dashed rounded-2xl p-10 text-center cursor-pointer transition-all duration-300 group
        ${isDragActive ? 'border-sky-500 bg-sky-500/10' : error ? 'border-rose-500 bg-rose-500/5' : 'border-slate-800 hover:border-sky-500/50 hover:bg-slate-900/50'}
        ${file ? 'border-emerald-500/50 bg-emerald-500/5' : ''}
      `}
    >
      <input {...getInputProps()} />
      <div className="flex flex-col items-center gap-4">
        {file ? (
          <motion.div initial={{ scale: 0.8 }} animate={{ scale: 1 }} className="flex flex-col items-center">
            <div className="w-16 h-16 bg-emerald-500/20 rounded-2xl flex items-center justify-center mb-4">
              <CheckCircle2 className="w-8 h-8 text-emerald-400" />
            </div>
            <p className="text-emerald-400 font-bold mb-1">{file.name}</p>
            <p className="text-slate-500 text-xs">{(file.size / 1024 / 1024).toFixed(2)} MB • Click to change</p>
          </motion.div>
        ) : (
          <>
            <div className={`w-16 h-16 rounded-2xl flex items-center justify-center transition-colors duration-300 ${isDragActive ? 'bg-sky-500 text-white' : 'bg-slate-900 text-slate-500 group-hover:text-sky-400 group-hover:bg-sky-400/10'}`}>
              <Icon className="w-8 h-8" />
            </div>
            <div>
              <p className="text-lg font-bold text-slate-200">{label}</p>
              <p className="text-slate-500 text-sm mt-1">{hint}</p>
            </div>
            <p className="text-sky-500 font-bold text-sm">Drag & drop or click to browse</p>
          </>
        )}
      </div>
    </div>
  );
}

export default function Upload() {
  const navigate = useNavigate();

  const [form, setForm] = useState({
    title: '',
    description: '',
    author: '',
    tags: '',
    aiTool: '',
    category: '',
  });

  const [gameFile, setGameFile] = useState(null);
  const [thumbnail, setThumbnail] = useState(null);
  const [thumbnailPreview, setThumbnailPreview] = useState(null);
  const [gamePreviewUrl, setGamePreviewUrl] = useState(null);

  const [loading, setLoading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [errors, setErrors] = useState({});
  const [serverError, setServerError] = useState('');

  const onGameDrop = useCallback(files => {
    const file = files[0];
    if (file) {
      setGameFile(file);
      setErrors(prev => ({ ...prev, gameFile: null }));
      
      // Live preview for HTML files
      if (file.type === 'text/html') {
        const url = URL.createObjectURL(file);
        setGamePreviewUrl(url);
      } else {
        setGamePreviewUrl(null);
      }
    }
  }, []);

  const onThumbnailDrop = useCallback(files => {
    const file = files[0];
    if (file) {
      setThumbnail(file);
      const reader = new FileReader();
      reader.onload = e => setThumbnailPreview(e.target.result);
      reader.readAsDataURL(file);
    }
  }, []);

  const handleChange = e => {
    const { name, value } = e.target;
    setForm(prev => ({ ...prev, [name]: value }));
    if (errors[name]) setErrors(prev => ({ ...prev, [name]: null }));
  };

  const validate = () => {
    const newErrors = {};
    if (!form.title.trim()) newErrors.title = 'Title is required';
    if (!form.aiTool) newErrors.aiTool = 'Please select which AI tool you used';
    if (!form.category) newErrors.category = 'Please select a category';
    if (!gameFile) newErrors.gameFile = 'A game file is required';
    return newErrors;
  };

  const updateField = (key, val) => {
    setForm(prev => ({ ...prev, [key]: val }));
    if (errors[key]) setErrors(prev => ({ ...prev, [key]: null }));
  };

  const handleSubmit = async e => {
    e.preventDefault();
    const validationErrors = validate();
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }

    setLoading(true);
    setServerError('');
    setUploadProgress(0);

    try {
      // ── 1. Build the file list ──────────────────────────────────────────────
      // For .html uploads we only have a single file named "index.html".
      // For .zip uploads we unzip in-browser so every inner file is uploaded
      // individually straight to Supabase Storage, bypassing the serverless
      // 4.5 MB body limit entirely.
      const ext = gameFile.name.toLowerCase().endsWith('.zip') ? '.zip' : '.html';
      let entries = []; // { rel, blob, size }

      if (ext === '.html') {
        entries.push({ rel: 'index.html', blob: gameFile, size: gameFile.size });
      } else {
        const JSZip = await loadJSZip();
        const zip = await JSZip.loadAsync(gameFile);
        const all = [];
        zip.forEach((relPath, entry) => {
          if (!entry.dir) all.push({ relPath, entry });
        });
        if (all.length === 0) throw new Error('ZIP file is empty');

        // Find the shallowest index.html and strip its parent folder so
        // relative asset paths resolve correctly when served.
        const indexes = all
          .map(x => x.relPath)
          .filter(p => p.split('/').pop().toLowerCase() === 'index.html')
          .sort((a, b) => a.split('/').length - b.split('/').length);
        if (indexes.length === 0) throw new Error('ZIP must contain an index.html file');
        const indexPath = indexes[0];
        const lastSlash = indexPath.lastIndexOf('/');
        const prefix = lastSlash >= 0 ? indexPath.slice(0, lastSlash + 1) : '';

        for (const { relPath, entry } of all) {
          const rel = relPath.startsWith(prefix) ? relPath.slice(prefix.length) : relPath;
          if (!rel) continue;
          const blob = await entry.async('blob');
          entries.push({ rel, blob, size: blob.size });
        }
      }

      // ── 2. Ask the server for signed upload URLs ────────────────────────────
      const signRes = await axios.post('/api/games/sign-upload', {
        files: entries.map(e => ({ path: e.rel, size: e.size })),
        thumbnailExt: thumbnail ? (thumbnail.name.match(/\.(png|jpe?g|webp|gif)$/i)?.[0].toLowerCase() || '.png') : null,
      });
      const { id, files: signedFiles, thumbnail: signedThumb } = signRes.data;
      const urlByRel = Object.fromEntries(signedFiles.map(f => [f.rel, f]));

      // ── 3. Upload every file directly to Supabase Storage ───────────────────
      const totalBytes = entries.reduce((s, e) => s + e.size, 0) + (thumbnail?.size || 0) || 1;
      let uploaded = 0;
      for (const e of entries) {
        const signed = urlByRel[e.rel];
        if (!signed) throw new Error(`Missing signed URL for ${e.rel}`);
        const { error } = await supabase.storage
          .from('games')
          .uploadToSignedUrl(signed.path, signed.token, e.blob, { upsert: true });
        if (error) throw new Error(`Upload failed for ${e.rel}: ${error.message}`);
        uploaded += e.size;
        setUploadProgress(Math.min(99, Math.round((uploaded / totalBytes) * 100)));
      }

      let thumbnailPath = null;
      if (thumbnail && signedThumb) {
        const { error } = await supabase.storage
          .from('games')
          .uploadToSignedUrl(signedThumb.path, signedThumb.token, thumbnail, { upsert: true });
        if (error) throw new Error(`Thumbnail upload failed: ${error.message}`);
        thumbnailPath = signedThumb.path.replace(/^thumbnails\//, '');
      }

      // ── 4. Finalize: create DB record ───────────────────────────────────────
      const res = await axios.post('/api/games/direct', {
        id,
        ...form,
        fileType: ext === '.zip' ? 'zip' : 'html',
        indexPath: 'index.html',
        thumbnailPath,
      });
      setUploadProgress(100);
      navigate(`/games/${res.data.id}`);
    } catch (err) {
      console.error(err);
      setServerError(err.response?.data?.error || err.message || 'Failed to upload game. Please try again.');
      setLoading(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto px-4 py-12">
      {/* Header */}
      <div className="mb-12">
        <Link to="/" className="inline-flex items-center gap-2 text-slate-500 hover:text-white transition-colors font-bold mb-8">
          <ArrowLeft className="w-4 h-4" /> Back to Home
        </Link>
        <div className="flex items-center gap-4 mb-4">
          <div className="p-3 bg-sky-500/10 rounded-2xl">
            <UploadIcon className="w-8 h-8 text-sky-400" />
          </div>
          <h1 className="text-4xl font-black tracking-tight">Upload Your AI Game</h1>
        </div>
        <p className="text-slate-400 text-lg font-medium">Showcase your creation to the world. No account required.</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-8">
        {serverError && (
          <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="p-4 bg-rose-500/10 border border-rose-500/20 rounded-2xl flex items-center gap-3 text-rose-500 font-bold">
            <AlertCircle className="w-5 h-5" /> {serverError}
          </motion.div>
        )}

        {/* Basic Info */}
        <div className="p-8 rounded-3xl bg-slate-900 border border-white/5 space-y-8">
          <h2 className="text-2xl font-black flex items-center gap-3">
            <Sparkles className="w-6 h-6 text-sky-400" /> Game Details
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div className="space-y-2">
              <label className="text-sm font-black uppercase tracking-wider text-slate-500">Game Title *</label>
              <input 
                name="title"
                value={form.title}
                onChange={handleChange}
                placeholder="e.g. Neon Runner, AI Quest..."
                className={`input-field h-14 ${errors.title ? 'border-rose-500' : ''}`}
              />
              {errors.title && <p className="text-xs font-bold text-rose-500">{errors.title}</p>}
            </div>

            <div className="space-y-2">
              <label className="text-sm font-black uppercase tracking-wider text-slate-500">Author Name</label>
              <input 
                name="author"
                value={form.author}
                onChange={handleChange}
                placeholder="Your name or handle"
                className="input-field h-14"
              />
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-black uppercase tracking-wider text-slate-500">Short Description</label>
            <textarea 
              name="description"
              value={form.description}
              onChange={handleChange}
              placeholder="What is your game about? How do you play?"
              className="input-field min-h-[120px] resize-none py-4"
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            {/* AI Tool Selector */}
            <div className="space-y-4">
              <label className="text-sm font-black uppercase tracking-wider text-slate-500">AI Tool Used *</label>
              <div className="grid grid-cols-3 gap-2">
                {AI_TOOLS.map(tool => (
                  <button
                    key={tool}
                    type="button"
                    onClick={() => updateField('aiTool', tool)}
                    className={`px-3 py-3 rounded-xl text-xs font-bold transition-all border ${form.aiTool === tool ? 'bg-sky-500 border-sky-400 text-white' : 'bg-slate-950 border-white/5 text-slate-500 hover:border-white/10 hover:text-slate-300'}`}
                  >
                    {tool}
                  </button>
                ))}
              </div>
              {errors.aiTool && <p className="text-xs font-bold text-rose-500">{errors.aiTool}</p>}
            </div>

            {/* Category Selector */}
            <div className="space-y-4">
              <label className="text-sm font-black uppercase tracking-wider text-slate-500">Game Category *</label>
              <div className="grid grid-cols-2 gap-2">
                {CATEGORIES.map(cat => (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => updateField('category', cat.id)}
                    className={`flex items-center gap-3 px-4 py-3 rounded-xl text-xs font-bold transition-all border ${form.category === cat.id ? 'bg-emerald-500 border-emerald-400 text-white' : 'bg-slate-950 border-white/5 text-slate-500 hover:border-white/10 hover:text-slate-300'}`}
                  >
                    <cat.icon className="w-4 h-4" />
                    {cat.label}
                  </button>
                ))}
              </div>
              {errors.category && <p className="text-xs font-bold text-rose-500">{errors.category}</p>}
            </div>
          </div>
        </div>

        {/* Files Section */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          <div className="p-8 rounded-3xl bg-slate-900 border border-white/5 space-y-6">
            <h3 className="text-xl font-black flex items-center gap-3">
              <FileCode className="w-6 h-6 text-sky-400" /> Game Files *
            </h3>
            <Dropzone 
              onDrop={onGameDrop}
              accept={{
                'text/html': ['.html'],
                'application/zip': ['.zip'],
                'application/x-zip-compressed': ['.zip'],
                'application/octet-stream': ['.zip'],
              }}
              icon={UploadIcon}
              label="Game File (.html, .zip)"
              hint="Single HTML or a ZIP containing index.html + assets — up to 200 MB"
              file={gameFile}
              error={errors.gameFile}
            />
            {errors.gameFile && <p className="text-xs font-bold text-rose-500">{errors.gameFile}</p>}
          </div>

          <div className="p-8 rounded-3xl bg-slate-900 border border-white/5 space-y-6">
            <h3 className="text-xl font-black flex items-center gap-3">
              <ImageIcon className="w-6 h-6 text-emerald-400" /> Thumbnail
            </h3>
            {thumbnailPreview ? (
              <div className="relative aspect-video rounded-2xl overflow-hidden border-2 border-slate-800 group">
                <img src={thumbnailPreview} className="w-full h-full object-cover" alt="Preview" />
                <button 
                  type="button"
                  onClick={() => { setThumbnail(null); setThumbnailPreview(null); }}
                  className="absolute top-2 right-2 p-2 bg-black/60 backdrop-blur-md rounded-full text-white opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <Dropzone 
                onDrop={onThumbnailDrop}
                accept={{ 'image/*': ['.png', '.jpg', '.jpeg', '.webp'] }}
                icon={ImageIcon}
                label="Game Thumbnail"
                hint="Visual identity for your game"
                file={thumbnail}
              />
            )}
          </div>
        </div>

        {/* Live Preview Window */}
        {gamePreviewUrl && (
          <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="p-8 rounded-3xl bg-slate-900 border border-white/5 space-y-6">
            <div className="flex items-center justify-between">
              <h3 className="text-xl font-black flex items-center gap-3">
                <Eye className="w-6 h-6 text-sky-400" /> Live Preview
              </h3>
              <p className="text-xs font-bold text-slate-500 uppercase tracking-widest">Testing Mode</p>
            </div>
            <div className="aspect-video w-full rounded-2xl overflow-hidden bg-black border-2 border-slate-800">
              <iframe src={gamePreviewUrl} className="w-full h-full border-none" title="Preview" />
            </div>
            <p className="text-center text-slate-500 text-sm italic">This is how your game will appear to players.</p>
          </motion.div>
        )}

        {/* Action Bar */}
        <div className="sticky bottom-8 z-40 p-6 rounded-3xl bg-slate-950/80 backdrop-blur-xl border border-white/10 shadow-2xl flex flex-col sm:flex-row items-center justify-between gap-6">
          <div className="flex items-center gap-4">
            {loading && (
              <div className="flex flex-col gap-2 min-w-[200px]">
                <div className="flex justify-between text-xs font-black uppercase tracking-widest text-sky-400">
                  <span>Uploading</span>
                  <span>{uploadProgress}%</span>
                </div>
                <div className="h-2 w-full bg-slate-800 rounded-full overflow-hidden">
                  <motion.div 
                    initial={{ width: 0 }}
                    animate={{ width: `${uploadProgress}%` }}
                    className="h-full bg-sky-500"
                  />
                </div>
              </div>
            )}
            {!loading && (
              <p className="text-sm text-slate-500 font-medium hidden sm:block">
                By publishing, you agree to our Content Guidelines.
              </p>
            )}
          </div>

          <div className="flex items-center gap-4 w-full sm:w-auto">
            <button 
              type="button" 
              onClick={() => navigate('/')}
              className="btn-secondary px-8 flex-1 sm:flex-none"
            >
              Cancel
            </button>
            <button 
              type="submit" 
              disabled={loading}
              className="btn-primary px-12 py-4 flex-1 sm:flex-none disabled:opacity-50"
            >
              {loading ? 'Publishing...' : 'Publish Game'}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
