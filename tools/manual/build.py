"""/work（docs/manual/）の *.md を、マニュアルごとにPDFにする。

各マニュアルは `<名前>.md`。先頭の `# タイトル` を表紙の題に、`<!-- subtitle: ... -->` を副題に使う。
目次（ページ番号つき）・ページ番号・ヘッダーは style.css が付ける。画像は /work からの相対パス。
"""
import glob
import os
import re
import sys

import markdown
from weasyprint import HTML

WORK = os.environ.get('MANUAL_DIR', '/work')
CSS = '/opt/manual/style.css'
EXT = ['tables', 'fenced_code', 'toc', 'sane_lists', 'attr_list', 'admonition', 'codehilite']


def build(path):
    text = open(path, encoding='utf-8').read()
    title = re.search(r'^# (.+)$', text, re.M).group(1)
    sub = (re.search(r'<!--\s*subtitle:\s*(.+?)\s*-->', text) or [None, ''])[1]
    body = markdown.markdown(text, extensions=EXT, extension_configs={'toc': {'toc_depth': '2-3'}, 'codehilite': {'guess_lang': False, 'noclasses': True}})
    # 先頭の見出し（表紙の題と重複する）を本文から外す
    body = re.sub(r'^<h1[^>]*>.*?</h1>', '', body, count=1, flags=re.S)
    toc = build_toc(body)
    html = f"""<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>{title}</title></head><body>
<section class="cover"><div class="cover-brand">Free-Networking-labs</div><h1>{title}</h1><p class="cover-sub">{sub}</p>
<p class="cover-note">OSS版CML — containerlabで動くネットワーク演習環境</p></section>
<nav class="toc"><h2>目次</h2>{toc}</nav>
<main>{body}</main></body></html>"""
    out = os.path.splitext(path)[0] + '.pdf'
    HTML(string=html, base_url=WORK).write_pdf(out, stylesheets=[CSS])
    print('wrote', out)


def build_toc(body):
    items = []
    for m in re.finditer(r'<h([23]) id="([^"]+)">(.*?)</h\1>', body, re.S):
        level, anchor, label = m.groups()
        items.append(f'<li class="toc-l{level}"><a href="#{anchor}">{re.sub("<[^>]+>", "", label)}</a></li>')
    return '<ul>' + ''.join(items) + '</ul>'


if __name__ == '__main__':
    files = sys.argv[1:] or sorted(f for f in glob.glob(os.path.join(WORK, '*.md')) if not os.path.basename(f).startswith(('_', 'README')))
    if not files:
        sys.exit('マニュアルのmdがありません')
    for f in files:
        build(f)
