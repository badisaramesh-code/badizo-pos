from pathlib import Path
from pypdf import PdfReader
p=Path(r'D:\badizo-pos-main\output\pdf\BADIZO_NEW_STORE_2026-09-20_TELUGU_ENGLISH.pdf')
for i,x in enumerate(PdfReader(p).pages):print(i+1,x.extract_text().replace('\n',' ')[:170])
