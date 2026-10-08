import { gh } from './_gh.js';

export const config = { api: { bodyParser: { sizeLimit: '4mb' } } };

const BRANCH = 'builds';
const NAME_RE = /^[A-Za-z0-9 _-]{1,40}$/;
const PKG_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const SAFE_URL_RE = /^https:\/\/[^\s'"`$\\<>|;&(){}]+$/;

async function ensureBranch() {
  if ((await gh(`/git/ref/heads/${BRANCH}`)).ok) return;
  const repo = await (await gh('')).json();
  const base = await (await gh(`/git/ref/heads/${repo.default_branch}`)).json();
  const r = await gh('/git/refs', {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/heads/${BRANCH}`, sha: base.object.sha }),
  });
  if (!r.ok) throw new Error('Gagal membuat branch builds: ' + (await r.text()));
}

async function putFile(path, contentBase64, message) {
  const r = await gh(`/contents/${path}`, {
    method: 'PUT',
    body: JSON.stringify({ message, content: contentBase64, branch: BRANCH }),
  });
  if (!r.ok) throw new Error(`Gagal menyimpan ${path}: ${await r.text()}`);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Gunakan POST.' });
  if (!process.env.GH_REPO || !process.env.GH_TOKEN)
    return res.status(500).json({ error: 'GH_REPO / GH_TOKEN belum diisi di Vercel.' });

  const { contentBase64, type, url, appName, appId } = req.body || {};

  if (!['android', 'web', 'link'].includes(type))
    return res.status(400).json({ error: 'Tipe proyek tidak valid.' });

  // proyek web dan link web sama-sama dibungkus Capacitor, jadi butuh nama & package id
  if (type !== 'android' && (!NAME_RE.test(appName || '') || !PKG_RE.test(appId || '')))
    return res.status(400).json({
      error: 'Nama app hanya huruf/angka/spasi, dan package id seperti com.nama.app (huruf kecil).',
    });

  let siteUrl = '';
  if (type === 'link') {
    siteUrl = String(url || '').trim();
    if (siteUrl.length > 500 || !SAFE_URL_RE.test(siteUrl))
      return res.status(400).json({ error: 'Link harus diawali https://, contoh https://situskamu.vercel.app' });
  } else if (typeof contentBase64 !== 'string' || !contentBase64.startsWith('UEsD')) {
    return res.status(400).json({ error: 'File harus berupa .zip.' });
  }

  try {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const meta = { type, url: siteUrl, appName: appName || 'App', appId: appId || 'com.example.app' };

    await ensureBranch();
    // zip dulu (kalau ada), json terakhir: workflow jalan saat json masuk
    if (type !== 'link') await putFile(`uploads/${id}.zip`, contentBase64, `zip ${id}`);
    await putFile(`uploads/${id}.json`, Buffer.from(JSON.stringify(meta)).toString('base64'), `upload ${id}`);

    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
      }
