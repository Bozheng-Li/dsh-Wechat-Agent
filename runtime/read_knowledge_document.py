"""Bounded document text extraction. Input/output use stdin/stdout; no paths or network."""
import io
import json
import sys
import zipfile
import xml.etree.ElementTree as ET

MAX_BYTES = 12 * 1024 * 1024
MAX_CHARS = 500000

def main():
    data = sys.stdin.buffer.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError("DOCUMENT_TOO_LARGE")
    kind = sys.argv[1] if len(sys.argv) == 2 else ""
    sections = []
    if kind == "pdf":
        from pypdf import PdfReader
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted:
            raise ValueError("DOCUMENT_ENCRYPTED")
        if len(reader.pages) > 250:
            raise ValueError("DOCUMENT_TOO_MANY_PAGES")
        length = 0
        for number, page in enumerate(reader.pages, 1):
            if len(page.get_contents().get_data() if page.get_contents() else b"") > 16 * 1024 * 1024:
                raise ValueError("DOCUMENT_PAGE_TOO_LARGE")
            text = page.extract_text() or ""
            length += len(text)
            if length > MAX_CHARS:
                raise ValueError("DOCUMENT_TOO_MUCH_TEXT")
            sections.append({"label": "第 %s 页" % number, "text": text})
    elif kind == "docx":
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            if len(archive.infolist()) > 3000 or sum(x.file_size for x in archive.infolist()) > 32 * 1024 * 1024:
                raise ValueError("DOCUMENT_ARCHIVE_TOO_LARGE")
            item = archive.getinfo("word/document.xml")
            if item.file_size > 8 * 1024 * 1024:
                raise ValueError("DOCUMENT_TOO_MUCH_TEXT")
            xml = archive.read(item)
            declaration_bytes = xml.upper().replace(b"\x00", b"")
            if b"<!DOCTYPE" in declaration_bytes or b"<!ENTITY" in declaration_bytes:
                raise ValueError("DOCUMENT_INVALID_XML")
            root = ET.fromstring(xml)
            ns = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
            paragraphs = []
            for paragraph in root.iter(ns + "p"):
                fragments = []
                for node in paragraph.iter():
                    if node.tag == ns + "t":
                        fragments.append(node.text or "")
                    elif node.tag == ns + "tab":
                        fragments.append("\t")
                    elif node.tag in (ns + "br", ns + "cr"):
                        fragments.append("\n")
                paragraphs.append("".join(fragments))
            text = "\n".join(paragraphs)
            sections = [{"label": "正文", "text": text}]
    else:
        raise ValueError("DOCUMENT_UNSUPPORTED")
    if sum(len(x["text"]) for x in sections) > MAX_CHARS:
        raise ValueError("DOCUMENT_TOO_MUCH_TEXT")
    if not any(x["text"].strip() for x in sections):
        raise ValueError("DOCUMENT_NO_TEXT")
    sys.stdout.buffer.write(json.dumps({"sections": sections}, ensure_ascii=False).encode("utf-8"))

if __name__ == "__main__":
    try:
        main()
    except ImportError:
        sys.stderr.write("DOCUMENT_DEPENDENCY_MISSING")
        sys.exit(1)
    except Exception as error:
        code = str(error)
        sys.stderr.write(code if code.startswith("DOCUMENT_") and len(code) < 80 else "DOCUMENT_READ_FAILED")
        sys.exit(1)
