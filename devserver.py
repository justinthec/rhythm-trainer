#!/usr/bin/env python3
# Minimal static server for local dev that disables caching, so editing a JS
# module and reloading always serves the latest file (Python's stock
# http.server sends no cache headers, which makes browsers heuristically cache
# ES modules and serve stale code across reloads).
import os
import sys
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

# Serve this script's own directory (the app root) no matter the launch cwd.
os.chdir(os.path.dirname(os.path.abspath(__file__)))


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8123
    ThreadingHTTPServer(('127.0.0.1', port), NoCacheHandler).serve_forever()
