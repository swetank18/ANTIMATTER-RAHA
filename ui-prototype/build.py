"""Builds ui-prototype/index.html: one offline file with koottu.css and the Anek fonts inlined.
Run from the repo root after `npm install`:  python3 ui-prototype/build.py
"""
import base64, os
here = os.path.dirname(os.path.abspath(__file__))
nm = os.path.join(here, '..', 'node_modules', '@fontsource-variable')
fonts = {  # placeholder in koottu.css -> font file
    '/_blob/4c9f34dc924c45dbad6e9c914d973298': 'anek-latin/files/anek-latin-latin-wdth-normal.woff2',
    '/_blob/7faf0d1715fe27c1ce80ccd170b0a4a3': 'anek-tamil/files/anek-tamil-tamil-wdth-normal.woff2',
    '/_blob/ec42d6e3a62a93289dc6cf5b3df9db69': 'anek-devanagari/files/anek-devanagari-devanagari-wdth-normal.woff2',
}
css = open(os.path.join(here, 'src', 'koottu.css'), encoding='utf-8').read()
for key, rel in fonts.items():
    data = base64.b64encode(open(os.path.join(nm, rel), 'rb').read()).decode()
    css = css.replace(key, 'data:font/woff2;base64,' + data)
src = open(os.path.join(here, 'src', 'page.html'), encoding='utf-8').read().replace('/*KOOTTU_CSS*/', css)
i = src.index('</style>') + len('</style>')
out = ('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
       '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
       + src[:i] + '\n</head>\n<body style="margin:0">\n' + src[i:] + '\n</body>\n</html>\n')
open(os.path.join(here, 'index.html'), 'w', encoding='utf-8').write(out)
print('Wrote ui-prototype/index.html,', len(out) // 1024, 'KB')
