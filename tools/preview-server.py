#!/usr/bin/env python3
"""Tiny, uncached static server for the demo page.

    python3 tools/preview-server.py [port]

Serves the repository root (so ../fonts and ../icons resolve from demo/) and
sends the bare root to the current version of /demo/. Reloading always fetches
fresh HTML and scripts, even if a previous preview cached the same URL.
"""
import http.server
import json
import os
import sys
from urllib.parse import urlsplit

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def current_version():
    # Release bumps should reach an already-running preview too.
    with open(os.path.join(ROOT, 'manifest.json'), encoding='utf-8') as manifest:
        return json.load(manifest)['version']


VERSION = current_version()


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        # This is a development preview, not a cacheable production site.
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def send_head(self):
        # send_head serves both GET and HEAD, including versioned root URLs.
        if urlsplit(self.path).path in ('/', '/index.html'):
            self.send_response(302)
            self.send_header('Location', '/demo/?v=' + current_version())
            self.send_header('Content-Length', '0')
            self.end_headers()
            return None

        # A browser may still have a cached response from the old server.
        # Return the actual file, never 304 with an already-loaded old script.
        for header in ('If-Modified-Since', 'If-None-Match'):
            if header in self.headers:
                del self.headers[header]
        return super().send_head()

    def log_message(self, fmt, *args):
        sys.stderr.write('%s - %s\n' % (self.address_string(), fmt % args))


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    http.server.ThreadingHTTPServer(('0.0.0.0', port), Handler).serve_forever()


if __name__ == '__main__':
    main()
