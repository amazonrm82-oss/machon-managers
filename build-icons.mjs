/* Regenerates the app icons from logo.svg.
 * Run after replacing logo.svg:  node build-icons.mjs
 * Requires: pip install cairosvg   (or regenerate them however you prefer)
 */
import { execFileSync } from 'node:child_process';

const script = `
import cairosvg, re, os
inner = re.sub(r'<title>.*?</title>', '',
        re.search(r'<svg[^>]*>(.*)</svg>', open('logo.svg', encoding='utf-8').read(), re.S).group(1), flags=re.S)
GROUND = '#FBFAF7'
def icon(size, pad, out, radius=None):
    box = 400; inset = box*pad; scale = (box-2*inset)/box
    rect = f'<rect width="{box}" height="{box}" rx="{radius}" fill="{GROUND}"/>' if radius else f'<rect width="{box}" height="{box}" fill="{GROUND}"/>'
    svg = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {box} {box}">{rect}<g transform="translate({inset},{inset}) scale({scale})">{inner}</g></svg>'
    cairosvg.svg2png(bytestring=svg.encode(), write_to=out, output_width=size, output_height=size)
    print(out, size)
icon(512, 0.10, 'icon-512.png', 76)
icon(192, 0.10, 'icon-192.png', 28)
icon(180, 0.10, 'icon-180.png', 26)
icon(32,  0.06, 'icon-32.png')
icon(512, 0.22, 'icon-maskable.png')
`;
execFileSync('python3', ['-c', script], { stdio: 'inherit' });
