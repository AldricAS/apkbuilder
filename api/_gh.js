// Helper kecil untuk memanggil GitHub API (file berawalan "_" tidak dijadikan endpoint oleh Vercel)
export const gh = (path, opts = {}) =>
  fetch(`https://api.github.com/repos/${process.env.GH_REPO}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${process.env.GH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.headers || {}),
    },
  });
