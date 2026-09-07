#!/usr/bin/env python3
"""Build desktop icon formats from the code-native brand SVG.
Requires Inkscape and Pillow; the generated PNG/ICO/ICNS are checked in so
packaging and end users need neither tool. Does not process mascot artwork.
"""
from pathlib import Path
import subprocess
from PIL import Image
root = Path(__file__).resolve().parents[1]
subprocess.run(['inkscape', str(root / 'build/icon.svg'), '--export-type=png',
                '--export-width=1024', '--export-filename=' + str(root / 'build/icon.png')], check=True)
with Image.open(root / 'build/icon.png') as icon:
    icon.save(root / 'build/icon.ico', sizes=[(n,n) for n in (16,24,32,48,64,128,256)])
    icon.save(root / 'build/icon.icns')
