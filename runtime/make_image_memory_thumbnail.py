"""Read an image over stdio and return its first frame as a small PNG."""
import io
import sys
import warnings


def main():
    try:
        from PIL import Image, ImageOps

        Image.MAX_IMAGE_PIXELS = 40_000_000
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        data = sys.stdin.buffer.read(10 * 1024 * 1024 + 1)
        if not data or len(data) > 10 * 1024 * 1024:
            raise ValueError("input size")
        with Image.open(io.BytesIO(data)) as image:
            if image.format not in {"PNG", "JPEG", "GIF", "WEBP"}:
                raise ValueError("format")
            if image.width * image.height > 40_000_000:
                raise ValueError("dimensions")
            image.seek(0)
            frame = ImageOps.exif_transpose(image).convert("RGBA")
            frame.thumbnail((384, 384), Image.Resampling.LANCZOS)
            output = io.BytesIO()
            frame.save(output, format="PNG", compress_level=6)
            data = output.getvalue()
            if len(data) > 1024 * 1024:
                raise ValueError("output size")
            sys.stdout.buffer.write(data)
        return 0
    except Exception:
        sys.stderr.write("IMAGE_THUMBNAIL_FAILED\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
