# Static server for development, plus a place for the page to save its state.
#
# Like `python -m http.server` but it sends Cache-Control: no-store, so a browser never
# holds stale modules across edits, and it accepts POST /save/<name>, writing the body
# into ./runs/. That is how a running soup ends up on disk where it can be reloaded, read
# and worked on outside the browser. A published copy of the page has no such endpoint,
# and the page treats saving as optional.
import functools
import http.server
import json
import os
import re
import sys

RUNS = 'runs'
SAFE_NAME = re.compile(r'^[A-Za-z0-9._-]{1,80}$')
MAX_BODY = 32 * 1024 * 1024


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_GET(self):
        # A listing of what has been saved, so the page can offer them without the
        # visitor hunting through a folder.
        if self.path.rstrip('/') == '/saves':
            root = os.path.dirname(os.path.abspath(__file__))
            directory = os.path.join(root, RUNS)
            saves = []
            if os.path.isdir(directory):
                for name in sorted(os.listdir(directory)):
                    if not name.endswith('.json'):
                        continue
                    full = os.path.join(directory, name)
                    saves.append({'name': name, 'bytes': os.path.getsize(full),
                                  'modified': int(os.path.getmtime(full))})
            payload = json.dumps(saves).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        super().do_GET()

    def do_POST(self):
        if not self.path.startswith('/save/'):
            self.send_error(404, 'only /save/<name> accepts POST')
            return
        name = self.path[len('/save/'):]
        if not SAFE_NAME.match(name) or not name.endswith(('.json', '.jsonl', '.txt')):
            self.send_error(400, 'name must be a simple .json, .jsonl or .txt filename')
            return
        try:
            length = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            self.send_error(400, 'bad Content-Length')
            return
        if length <= 0 or length > MAX_BODY:
            self.send_error(413, 'body must be between 1 byte and 32 MB')
            return

        body = self.rfile.read(length)
        root = os.path.dirname(os.path.abspath(__file__))
        directory = os.path.join(root, RUNS)
        os.makedirs(directory, exist_ok=True)
        path = os.path.join(directory, name)
        # Written whole, then moved into place, so a reader never sees half a file.
        tmp = path + '.part'
        with open(tmp, 'wb') as f:
            f.write(body)
        os.replace(tmp, path)

        payload = json.dumps({'saved': f'{RUNS}/{name}', 'bytes': len(body)}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, fmt, *args):
        pass


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    root = os.path.dirname(os.path.abspath(__file__))
    server = http.server.ThreadingHTTPServer(('127.0.0.1', port), functools.partial(Handler, directory=root))
    print(f'serving {root} on http://localhost:{port}/  (POST /save/<name>.json writes to {RUNS}/)')
    server.serve_forever()
