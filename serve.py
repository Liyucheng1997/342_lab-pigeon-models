"""本地开发服务器：静态文件 + 禁用缓存（修改代码后刷新即可生效）。

用法：python serve.py [端口]，默认 8342，然后打开 http://localhost:8342
"""
import http.server
import socketserver
import sys
import os


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.js': 'text/javascript'}

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        super().end_headers()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8342
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(('', port), NoCacheHandler) as httpd:
        print(f'鸽子生态模拟：http://localhost:{port}  （模型检视：http://localhost:{port}/viewer.html）')
        httpd.serve_forever()


if __name__ == '__main__':
    main()
