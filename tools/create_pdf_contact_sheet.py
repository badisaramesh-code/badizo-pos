from glob import glob
from PIL import Image, ImageOps

files = sorted(glob(r"D:\badizo-pos-main\tmp\pdfs\badizo-guide-*.png"))
pages = [Image.open(file).convert("RGB") for file in files]
thumbs = [ImageOps.contain(page, (300, 425)) for page in pages]
sheet = Image.new("RGB", (600, 1275), "#cccccc")
for index, page in enumerate(thumbs):
    sheet.paste(page, ((index % 2) * 300, (index // 2) * 425))
sheet.save(r"D:\badizo-pos-main\tmp\pdfs\badizo-guide-contact.jpg", quality=65)
