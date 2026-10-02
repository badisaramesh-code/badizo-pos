from pathlib import Path
p=Path(r'D:\badizo-pos-main\scripts\new-store-20260920\create-guide.py')
lines=p.read_text(encoding='utf8').splitlines()
for i,l in enumerate(lines):
 if l.startswith("pair('3. Enter the existing"):
  lines[i]="pair('3. Enter the MySQL password locally. New application credentials are saved in C:/BadizoPOS/NEW_STORE_CREDENTIALS.txt (Administrator only).','3. MySQL password setupలోనే ఇవ్వండి. కొత్త application credentials NEW_STORE_CREDENTIALS.txtలో ఉంటాయి; Administrator మాత్రమే చదవగలరు.')"
p.write_text('\n'.join(lines),encoding='utf8')
