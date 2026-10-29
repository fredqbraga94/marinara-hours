"""Inspect the real downloaded 7-employee / 21-shift PDF (run after pdf-seven.e2e.mjs).

Checks: exactly one A4 landscape page, all 7 names, 21 shift rows, 7 weekly totals
with the correct values, every word inside the page and above the footer rule,
and nothing overlapping (no clipped/overprinted rows).
"""
import json
import sys
from pathlib import Path

import pdfplumber

engine = sys.argv[1] if len(sys.argv) > 1 else 'chromium'
path = Path('tmp/pdfs') / f'{engine}-seven.pdf'
expected = json.loads(Path('tmp/pdfs/seven-expected.json').read_text())

with pdfplumber.open(path) as pdf:
    pages = pdf.pages
    assert len(pages) == 1, f'expected 1 page, got {len(pages)}'
    page = pages[0]
    assert abs(page.width - 841.89) < 1 and abs(page.height - 595.28) < 1, 'not A4 landscape'
    text = page.extract_text() or ''
    words = page.extract_words()

    # Footer rule sits at 199 mm; table content must stay above it.
    footer_top = 199 * 72 / 25.4
    footer_words = {'MARINARA', 'HAWTHORNE', 'Marinara', 'Ristorante', 'Cafe', '·', '1', '/'}
    for w in words:
        assert 0 <= w['x0'] < w['x1'] <= page.width and 0 <= w['top'] < w['bottom'] <= page.height, f'word outside page: {w}'
        if w['top'] < footer_top:
            continue
        assert w['text'] in footer_words, f'content below the footer rule: {w["text"]!r}'

    assert text.count('APPROVED') == 21, f'expected 21 shift rows, got {text.count("APPROVED")}'
    assert text.count('Weekly Total') == 7, f'expected 7 weekly totals, got {text.count("Weekly Total")}'
    lines = text.splitlines()
    for person in expected:
        assert person['name'] in text, f'missing employee {person["name"]}'
        total_line = [l for l in lines if l.startswith(person['name']) and 'Weekly Total' in l]
        assert total_line, f'no weekly total row for {person["name"]}'
        assert person['total'] in total_line[0], f'{person["name"]}: expected {person["total"]}, row was {total_line[0]!r}'

    # No two text lines overprint each other inside the table body.
    # Words of one table row differ by < 2 pt (mixed font sizes); cluster them first.
    tops = sorted(w['top'] for w in words if 38 * 72 / 25.4 < w['top'] < footer_top)
    rows = [tops[0]]
    for t in tops[1:]:
        if t - rows[-1] >= 2.0:
            rows.append(t)
    gaps = [b - a for a, b in zip(rows, rows[1:])]
    assert min(gaps) >= 5.0, f'rows too close / overlapping: min gap {min(gaps):.2f} pt'

    sizes = sorted({round(c['size'], 2) for c in page.chars if 40 * 72 / 25.4 < c['top'] < footer_top})
    print(f'{path}: 1 A4 landscape page; 7 employees, 21 shifts, 7 correct weekly totals; '
          f'body font sizes {sizes} pt; min line spacing {min(gaps):.1f} pt')
