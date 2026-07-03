// Vercel serverless entry. Catches every /api/* request and delegates to the
// shared handler. Static files (public/) are served by Vercel directly.
import { handleApi } from '../server/handler.js';

export default async function handler(req, res) {
  const handled = await handleApi(req, res);
  if (!handled) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }
}
