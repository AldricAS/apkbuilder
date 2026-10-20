import { gh } from './_gh.js';

// Body mentah (bukan JSON), supaya potongan 3 MB tidak membengkak jadi base64 dan muat di batas 4,5 MB Vercel
export const config = { api: { bodyParser: false } };

const MAX_CHUNK = 3 * 1024 * 1024 + 1024;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Gunakan POST.' });
  if (!process.env.GH_REPO || !process.env.GH_TOKEN)
    return res.status(500).json({ error: 'GH_REPO / GH_TOKEN belum diisi di Vercel.' });

  try {
    const bufs = [];
    let total = 0;
    for await (const c of req) {
      total += c.length;
      if (total > MAX_CHUNK) return res.status(413).json({ error: 'Potongan file terlalu besar.' });
      bufs.push(c);
    }
    const buf = Buffer.concat(bufs);
    if (!buf.length) return res.status(400).json({ error: 'Potongan file kosong.' });

    // potongan pertama harus diawali tanda zip "PK\x03\x04"
    if (req.query.first === '1' && !(buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04))
      return res.status(400).json({ error: 'File harus berupa .zip.' });

    const r = await gh('/git/blobs', {
      method: 'POST',
      body: JSON.stringify({ content: buf.toString('base64'), encoding: 'base64' }),
    });
    if (!r.ok) return res.status(502).json({ error: 'Gagal menyimpan potongan: ' + (await r.text()) });
    res.json({ sha: (await r.json()).sha });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
