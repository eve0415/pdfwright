# Synthetic CMYK printer characterisation: Yule-Nielsen modified Demichel/Neugebauer model over
# 16 primaries formed multiplicatively from per-ink XYZ transmittance ratios, plus a tone-value-increase curve.
# Every number below is chosen for this fixture; no measured characterisation data is used.
import itertools, math, sys
D50 = (96.422, 100.0, 82.521)
FLARE = 0.008    # first-surface reflection as a fraction of the illuminant, sets a realistic darkest black
def lab2xyz(L, a, b):
    fy = (L + 16) / 116; fx = fy + a / 500; fz = fy - b / 200
    f = lambda t: t**3 if t**3 > 216/24389 else (116*t - 16) / (24389/27)
    return tuple(w * f(v) for w, v in zip(D50, (fx, fy, fz)))
def xyz2lab(X, Y, Z):
    f = lambda t: t**(1/3) if t > 216/24389 else (24389/27*t + 16) / 116
    fx, fy, fz = (f(v / w) for v, w in zip((X, Y, Z), D50))
    return 116*fy - 16, 500*(fx - fy), 200*(fy - fz)
paper = tuple(p - FLARE * w for p, w in zip(lab2xyz(95, 0, -2), D50))
solids = {'c': (56, -36, -48), 'm': (48, 72, -4), 'y': (88, -6, 90), 'k': (18, 0, 1)}
trans = {k: tuple((s - FLARE * w) / p for s, p, w in zip(lab2xyz(*v), paper, D50)) for k, v in solids.items()}
N = 1.8          # Yule-Nielsen n
TVI50 = 0.14     # tone value increase at 50 %
def tvi(a):      # parabolic dot gain peaking at 50 %
    return a + 4 * TVI50 * a * (1 - a)
def model(c, m, y, k):
    cov = [tvi(v) for v in (c, m, y, k)]
    acc = [0.0, 0.0, 0.0]
    for bits in itertools.product((0, 1), repeat=4):
        w = 1.0
        refl = list(paper)
        for on, a, ink in zip(bits, cov, 'cmyk'):
            w *= a if on else (1 - a)
            if on:
                refl = [r * t for r, t in zip(refl, trans[ink])]
        for i in range(3):
            acc[i] += w * refl[i] ** (1 / N)
    return tuple(v ** N + FLARE * w for v, w in zip(acc, D50))
# read the targen .ti1 patch list, write a .ti3 with modelled XYZ and Lab
lines = open(sys.argv[1]).read().split('\n')
start = lines.index('BEGIN_DATA') + 1; end = lines.index('END_DATA')
fmt = lines[lines.index('BEGIN_DATA_FORMAT') + 1].split()
ci = [fmt.index(n) for n in ('CMYK_C', 'CMYK_M', 'CMYK_Y', 'CMYK_K')]
out = ['CTI3', '', 'DESCRIPTOR "pdfwright synthetic CMYK model (not a printing condition)"',
       'ORIGINATOR "pdfwright synth.py"', 'KEYWORD "DEVICE_CLASS"', 'DEVICE_CLASS "OUTPUT"',
       'KEYWORD "COLOR_REP"', 'COLOR_REP "CMYK_XYZ"', '', 'NUMBER_OF_FIELDS 11', 'BEGIN_DATA_FORMAT',
       'SAMPLE_ID CMYK_C CMYK_M CMYK_Y CMYK_K XYZ_X XYZ_Y XYZ_Z LAB_L LAB_A LAB_B', 'END_DATA_FORMAT',
       f'NUMBER_OF_SETS {end - start}', 'BEGIN_DATA']
for n, row in enumerate(lines[start:end], 1):
    f = row.split(); cmyk = [float(f[i]) for i in ci]
    X, Y, Z = model(*(v / 100 for v in cmyk)); L, A, B = xyz2lab(X, Y, Z)
    out.append(f'{n} ' + ' '.join(f'{v:.4f}' for v in cmyk) + f' {X:.5f} {Y:.5f} {Z:.5f} {L:.4f} {A:.4f} {B:.4f}')
out.append('END_DATA')
open(sys.argv[2], 'w').write('\n'.join(out) + '\n')
for name, cm in [('paper', (0,0,0,0)), ('C', (1,0,0,0)), ('M', (0,1,0,0)), ('Y', (0,0,1,0)), ('K', (0,0,0,1)), ('CMY', (1,1,1,0)), ('CMYK400', (1,1,1,1)), ('K50', (0,0,0,.5))]:
    print(name, ['%.2f' % v for v in xyz2lab(*model(*cm))])
