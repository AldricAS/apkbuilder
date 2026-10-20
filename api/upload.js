import { gh } from './_gh.js';

export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };

const BRANCH = 'builds';
const NAME_RE = /^[A-Za-z0-9 _-]{1,40}$/;
const PKG_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const MAX_LOGO_B64 = 600_000; // sekitar 450 KB, logo sudah diperkecil di browser
const SAFE_URL_RE = /^https:\/\/[^\s'"`$\\<>|;&(){}]+$/;
const MAX_ZIP = 25 * 1024 * 1024; // 25 MB
const CHUNK = 3 * 1024 * 1024; // harus sama dengan CHUNK di index.html
const MAX_PARTS = Math.ceil(MAX_ZIP / CHUNK);

async function must(r, what) {
  if (!r.ok) throw new Error(`${what}: ${await r.text()}`);
  return r.json();
}

async function ensureBranch() {
  if ((await gh(`/git/ref/heads/${BRANCH}`)).ok) return;
  const repo = await must(await gh(''), 'Gagal membaca repo');
  const base = await must(await gh(`/git/ref/heads/${repo.default_branch}`), 'Gagal membaca branch utama');
  const r = await gh('/git/refs', {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/heads/${BRANCH}`, sha: base.object.sha }),
  });
  if (!r.ok) throw new Error('Gagal membuat branch builds: ' + (await r.text()));
}

// Satu commit berisi semua file (potongan zip, logo, json). Workflow jalan sekali, saat commit masuk.
async function commitFiles(entries, message) {
  for (let attempt = 0; attempt < 4; attempt++) {
    await ensureBranch();
    const ref = await must(await gh(`/git/ref/heads/${BRANCH}`), 'Gagal membaca branch builds');
    const head = ref.object.sha;
    const headCommit = await must(await gh(`/git/commits/${head}`), 'Gagal membaca commit');
    const tree = await must(
      await gh('/git/trees', { method: 'POST', body: JSON.stringify({ base_tree: headCommit.tree.sha, tree: entries }) }),
      'Gagal membuat tree'
    );
    const commit = await must(
      await gh('/git/commits', { method: 'POST', body: JSON.stringify({ message, tree: tree.sha, parents: [head] }) }),
      'Gagal membuat commit'
    );
    const upd = await gh(`/git/refs/heads/${BRANCH}`, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha }) });
    if (upd.ok) return;
    if (upd.status !== 422 && upd.status !== 409) throw new Error('Gagal memperbarui branch: ' + (await upd.text()));
    // branch baru saja berubah (upload lain masuk), ulangi dari head terbaru
  }
  throw new Error('Repo sedang sibuk, coba kirim ulang sebentar lagi.');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Gunakan POST.' });
  if (!process.env.GH_REPO || !process.env.GH_TOKEN)
    return res.status(500).json({ error: 'GH_REPO / GH_TOKEN belum diisi di Vercel.' });

  const { parts, size, type, url, appName, appId, logoBase64, themeColor } = req.body || {};

  if (!['android', 'web', 'link'].includes(type))
    return res.status(400).json({ error: 'Tipe proyek tidak valid.' });

  // proyek web dan link web sama-sama dibungkus Capacitor, jadi butuh nama & package id
  if (type !== 'android' && (!NAME_RE.test(appName || '') || !PKG_RE.test(appId || '')))
    return res.status(400).json({
      error: 'Nama app hanya huruf/angka/spasi, dan package id seperti com.nama.app (huruf kecil).',
    });

  let siteUrl = '';
  let shas = [];
  let zipSize = 0;
  if (type === 'link') {
    siteUrl = String(url || '').trim();
    if (siteUrl.length > 500 || !SAFE_URL_RE.test(siteUrl))
      return res.status(400).json({ error: 'Link harus diawali https://, contoh https://situskamu.vercel.app' });
  } else {
    if (!Array.isArray(parts) || parts.length < 1 || parts.length > MAX_PARTS || !parts.every((p) => SHA_RE.test(p)))
      return res.status(400).json({ error: 'File harus berupa .zip dan maksimal 25 MB.' });
    zipSize = Number(size);
    if (!Number.isInteger(zipSize) || zipSize <= (parts.length - 1) * CHUNK || zipSize > parts.length * CHUNK || zipSize > MAX_ZIP)
      return res.status(400).json({ error: 'Ukuran zip tidak cocok atau lebih dari 25 MB.' });
    shas = parts;
  }

  // logo dan tema hanya untuk mode web dan link (proyek Android sudah punya ikon sendiri)
  let theme = '';
  let logo = '';
  if (type !== 'android') {
    if (themeColor) {
      if (!COLOR_RE.test(String(themeColor))) return res.status(400).json({ error: 'Warna tema tidak valid.' });
      theme = String(themeColor).toUpperCase();
    }
    if (logoBase64) {
      // "iVBORw0KGgo" = tanda awal file PNG
      if (typeof logoBase64 !== 'string' || !logoBase64.startsWith('iVBOR') || logoBase64.length > MAX_LOGO_B64)
        return res.status(400).json({ error: 'Logo harus PNG dan tidak terlalu besar.' });
      logo = logoBase64;
    }
  }

  try {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const meta = {
      type,
      url: siteUrl,
      appName: appName || 'App',
      appId: appId || 'com.example.app',
      themeColor: theme,
      hasLogo: !!logo,
      parts: shas.length,
      zipSize,
    };

    const entries = shas.map((sha, i) => ({
      path: `uploads/${id}.part${String(i).padStart(3, '0')}`,
      mode: '100644',
      type: 'blob',
      sha,
    }));
    if (logo) {
      const b = await must(
        await gh('/git/blobs', { method: 'POST', body: JSON.stringify({ content: logo, encoding: 'base64' }) }),
        'Gagal menyimpan logo'
      );
      entries.push({ path: `uploads/${id}.png`, mode: '100644', type: 'blob', sha: b.sha });
    }
    entries.push({ path: `uploads/${id}.json`, mode: '100644', type: 'blob', content: JSON.stringify(meta) });

    // judul commit harus persis "upload <id>", dipakai api/status.js untuk mencari run workflow
    await commitFiles(entries, `upload ${id}`);

    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
