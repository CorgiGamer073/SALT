'use strict';

const QUIET_ASSET_EXTENSION = /\.(?:avif|css|gif|ico|jpe?g|js|json|map|png|svg|webp|woff2?|ttf|eot)$/i;

function shouldLogRequest(req = {}) {
  const method = String(req.method || '').toUpperCase();
  const requestPath = typeof req.path === 'string' ? req.path : '';
  const normalizedPath = requestPath.toLowerCase();

  if (method !== 'GET' && method !== 'HEAD') return true;
  if (normalizedPath.startsWith('/api/') || normalizedPath.startsWith('/auth/')) return true;
  if (normalizedPath === '/health' || normalizedPath === '/favicon.ico') return false;
  return !QUIET_ASSET_EXTENSION.test(normalizedPath);
}

module.exports = { shouldLogRequest };
