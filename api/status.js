import { gh } from './_gh.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const id = String(req.query.id || '');
  if (!/^[a-z0-9]{6,24}$/.test(id)) return res.status(400).json({ error: 'id tidak valid' });

  try {
    // 1) Sudah ada release? berarti APK siap
    const rel = await gh(`/releases/tags/build-${id}`);
    if (rel.ok) {
      const a = (await rel.json()).assets?.[0];
      if (a) return res.json({ state: 'done', apk: a.browser_download_url, name: a.name, size: a.size });
    }

    // 2) Cari run workflow untuk upload ini
    const runs = (await (await gh(`/actions/runs?branch=builds&per_page=30`)).json()).workflow_runs || [];
    const run = runs.find((r) => r.display_title === `upload ${id}`);

    if (!run) return res.json({ state: 'queued' });
    if (run.status === 'completed' && run.conclusion !== 'success')
      return res.json({ state: 'failed', logUrl: run.html_url });
    if (run.status === 'in_progress' || run.status === 'completed')
      return res.json({ state: 'building', logUrl: run.html_url });
    return res.json({ state: 'queued', logUrl: run.html_url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
