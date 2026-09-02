# Static server for development. Like `python -m http.server` but sends
# Cache-Control: no-store, so a browser never holds stale modules across edits.
import functools
import http.server
import os
import sys


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, fmt, *args):
        pass


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    root = os.path.dirname(os.path.abspath(__file__))
    server = http.server.ThreadingHTTPServer(('127.0.0.1', port), functools.partial(Handler, directory=root))
    print(f'serving {root} on http://localhost:{port}/')
    server.serve_forever()
