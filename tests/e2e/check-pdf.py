"""Inspect actual downloaded PDF files; run after pdf.e2e.mjs."""
import sys
from pathlib import Path
import pdfplumber
engine = sys.argv[1] if len(sys.argv) > 1 else 'chromium'
for suffix in ['', '-large']:
    path = Path('tmp/pdfs') / f'{engine}{suffix}.pdf'
    with pdfplumber.open(path) as pdf:
        texts = [page.extract_text() or '' for page in pdf.pages]
        text = '\n'.join(texts)
        assert all(abs(page.width - 841.89) < 1 and abs(page.height - 595.28) < 1 for page in pdf.pages)
        assert 'Back to Marinara Hours' not in text and 'Share PDF' not in text
        assert all('APPROVED' in page_text for page_text in texts), 'Blank or orphan-total page'
        for page in pdf.pages:
            assert all(0 <= word['top'] < word['bottom'] <= page.height for word in page.extract_words())
        if suffix:
            assert text.count('Weekly Total') == 40
            assert text.count('APPROVED') == 373
            assert '750h 00m' in text and text.count('52h 30m') == 39
            assert len(pdf.pages) > 1
        else:
            assert len(pdf.pages) == 1 and text.count('7h 30m') == 2
            assert 'Ana Silva' in text and '30 min' in text
        print(f'{path}: {len(pdf.pages)} A4 landscape pages; content and totals verified')
