"""Convert one owned GIF/WebP's first frame to a bounded PNG over stdio."""
import io
import sys
import warnings

MAX_BYTES = 10 * 1024 * 1024
MAX_PIXELS = 40_000_000


class OutputTooLarge(Exception):
    pass


class BoundedOutput(io.BytesIO):
    def write(self, data):
        if self.tell() + len(data) > MAX_BYTES:
            raise OutputTooLarge()
        return super().write(data)


def main():
    try:
        from PIL import Image, ImageOps

        Image.MAX_IMAGE_PIXELS = MAX_PIXELS
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        source = sys.stdin.buffer.read(MAX_BYTES + 1)
        if not source or len(source) > MAX_BYTES:
            raise ValueError("input size")
        with Image.open(io.BytesIO(source)) as image:
            if image.format not in {"GIF", "WEBP"}:
                raise ValueError("format")
            width, height = image.size
            if not (0 < width <= 8192 and 0 < height <= 8192 and width * height <= MAX_PIXELS):
                raise ValueError("dimensions")
            image.seek(0)
            frame = ImageOps.exif_transpose(image).convert("RGBA")
            output = BoundedOutput()
            frame.save(output, format="PNG", compress_level=6)
            sys.stdout.buffer.write(output.getvalue())
            sys.stdout.buffer.flush()
        return 0
    except OutputTooLarge:
        sys.stderr.write("OUTPUT_TOO_LARGE\n")
    except Exception:
        # Provider/UI callers receive only a stable error, never a traceback,
        # arbitrary input bytes, local paths, or imported metadata.
        sys.stderr.write("IMAGE_CONVERSION_FAILED\n")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
