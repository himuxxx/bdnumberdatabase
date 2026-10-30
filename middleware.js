// middleware.js  —  Vercel edge middleware
// Blocks direct browser access to /data.json.
// Allows only same-origin fetch() calls made by our own page.

export const config = {
  matcher: '/data.json'
};

function block() {
  return new Response('403 forbidden', {
    status: 403,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}

export default function middleware(request) {
  const secFetchMode = request.headers.get('sec-fetch-mode') || '';
  const secFetchDest = request.headers.get('sec-fetch-dest') || '';
  const referer      = request.headers.get('referer') || '';
  const host         = request.headers.get('host') || '';

  // 1) Anything that looks like a real page navigation → kill it.
  //    (typing the URL, clicking a link, "open in new tab", etc.)
  if (secFetchMode === 'navigate' || secFetchDest === 'document') {
    return block();
  }

  // 2) Allow only same-origin XHR / fetch.
  //    Browsers send sec-fetch-mode: same-origin for fetch() from our own page,
  //    and referer will be our own host. Curl / wget / scrapers send neither.
  const sameOriginReferer = referer !== '' && referer.includes(host);
  const sameOriginMode    = secFetchMode === 'same-origin';

  if (!sameOriginReferer && !sameOriginMode) {
    return block();
  }

  return; // fall through → static file served normally
}
