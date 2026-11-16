"""将 Lucide Workflow 主图导出为应用、安装包、网页图标。

先运行 node tools/sync_lucide_icons.mjs 同步网络图标的 SVG / PNG 源资源。
运行 python tools/make_icon.py 生成多尺寸 ICO 和桌面平台 PNG / ICNS。
"""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent


def main():
    assets = ROOT / 'assets'
    icons = ROOT / 'frontend/src-tauri/icons'
    public = ROOT / 'frontend/public'
    for path in (icons, public):
        path.mkdir(parents=True, exist_ok=True)
    master = Image.open(assets / 'AutoTool.png').convert('RGBA')
    sizes = [(s, s) for s in (16, 24, 32, 48, 64, 128, 256)]
    for path in (assets / 'AutoTool.ico', public / 'favicon.ico', icons / 'icon.ico'):
        master.save(path, format='ICO', sizes=sizes)
    for name, size in {'icon.png':512, '128x128@2x.png':256, '128x128.png':128, '32x32.png':32}.items():
        master.resize((size, size), Image.Resampling.LANCZOS).save(icons / name)
    master.save(icons / 'icon.icns', format='ICNS')
    print('Application and installer icons exported from Lucide Workflow')


if __name__ == '__main__':
    main()
