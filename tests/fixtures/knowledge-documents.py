"""Synthetic document bytes for import boundary tests; no filesystem or network."""
import base64
import io
import json
import zipfile

from pypdf import PdfWriter
from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject


def pdf(kind):
    writer = PdfWriter()
    page = writer.add_blank_page(width=595, height=842)
    if kind == "text":
        font = DictionaryObject({NameObject("/Type"): NameObject("/Font"), NameObject("/Subtype"): NameObject("/Type1"), NameObject("/BaseFont"): NameObject("/Helvetica")})
        page[NameObject("/Resources")] = DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/F1"): writer._add_object(font)})})
        stream = DecodedStreamObject()
        stream.set_data(b"BT /F1 12 Tf 40 780 Td (Refund requests must arrive within seven days.) Tj ET")
        page[NameObject("/Contents")] = writer._add_object(stream)
    elif kind == "encrypted":
        writer.encrypt("synthetic-test-only")
    elif kind == "many":
        for _ in range(250):
            writer.add_blank_page(width=595, height=842)
    data = io.BytesIO()
    writer.write(data)
    return data.getvalue()


def docx(xml, padding=0):
    data = io.BytesIO()
    with zipfile.ZipFile(data, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
        archive.writestr("word/document.xml", xml)
        if padding:
            archive.writestr("padding.bin", b"0" * padding)
    return data.getvalue()


document = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>退款期限为七天。松石三号。</w:t></w:r></w:p><w:p><w:r><w:t>价格</w:t><w:tab/><w:t>120 元</w:t><w:br/><w:t>需要订单号。</w:t></w:r></w:p></w:body></w:document>'
entity = '<?xml version="1.0" encoding="UTF-16"?><!DOCTYPE w:document [<!ENTITY injected "not allowed">]>' + document.replace("松石三号", "&injected;")
fixtures = {
    "guide.pdf": pdf("text"), "scan.pdf": pdf("blank"), "locked.pdf": pdf("encrypted"), "many-pages.pdf": pdf("many"),
    "broken.pdf": b"%PDF-1.4\nbroken", "guide.docx": docx(document.encode("utf-8")), "entity.docx": docx(entity.encode("utf-16")),
    "archive-limit.docx": docx(document.encode("utf-8"), 33 * 1024 * 1024),
    "text-limit.docx": docx(document.replace("松石三号", "字" * 500001).encode("utf-8")), "broken.docx": b"PKbroken",
}
print(json.dumps({name: base64.b64encode(data).decode("ascii") for name, data in fixtures.items()}))
