// Single Vercel function for every Hype House API route.
import { handler } from '../../dist/vercel.js';
export default function apiRouter(req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const routePath = url.searchParams.get('__hypehouse_path');
  if (routePath === null) return handler(req, res);
  const segments = routePath.split('/');
  const valid = routePath.length > 0 && segments.every(segment =>
    segment.length > 0 && segment !== '.' && segment !== '..' && /^[A-Za-z0-9._~-]+$/.test(segment)
  );
  if (!valid) {
    res.statusCode = 400;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ code: 'bad_request', message: 'Invalid API path' }));
    return;
  }
  url.searchParams.delete('__hypehouse_path');
  req.url = '/api/v1/' + routePath + url.search;
  return handler(req, res);
}