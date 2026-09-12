"""Render original Recloud labels, never recreate their text or barcodes.

JSON stdin/stdout only. Business documents stay in memory. Errors omit data.
"""
import base64
import collections
import hashlib
import io
import json
import sys

import pypdfium2 as pdfium
import zxingcpp
from PIL import Image, ImageOps


def decode_codes(image):
    # Table borders and labels touch barcode quiet zones in the manufacturer's
    # PDF. Read dense vertical-bar strips with white padding, without changing
    # the image that will actually be printed.
    found = {item.text for item in zxingcpp.read_barcodes(image)}
    for candidate in [image, image.transpose(Image.Transpose.ROTATE_90)]:
        gray = candidate.convert("L")
        groups = []
        for y in range(gray.height):
            row = gray.crop((0, y, gray.width, y + 1)).tobytes()
            edges = [x for x in range(1, len(row)) if (row[x] < 128) != (row[x - 1] < 128)]
            if len(edges) > 45:
                if groups and y == groups[-1][-1] + 1:
                    groups[-1].append(y)
                else:
                    groups.append([y])
        for ys in groups:
            if len(ys) < 12:
                continue
            row = gray.crop((0, ys[len(ys) // 2], gray.width, ys[len(ys) // 2] + 1)).tobytes()
            edges = [x for x in range(1, len(row)) if (row[x] < 128) != (row[x - 1] < 128)]
            clusters = []
            for x in edges:
                if clusters and x - clusters[-1][-1] < max(12, gray.width * 0.025):
                    clusters[-1].append(x)
                else:
                    clusters.append([x])
            for xs in clusters:
                if len(xs) < 40:
                    continue
                decoded = set()
                # A table's vertical rule can be adjacent to the first/last bar.
                # Try bounded edge exclusions for recognition only.
                for left in (0, 4, 8, 12, 16, 20, 24):
                    for right in (0, 4, 8, 12, 16):
                        crop = gray.crop((max(0, xs[0] - 3 + left), ys[0] + 2,
                                          min(gray.width, xs[-1] + 3 - right), ys[-1] - 1))
                        padded = ImageOps.expand(crop, border=40, fill=255)
                        scaled = padded.resize((padded.width * 2, padded.height * 2))
                        decoded = {item.text for item in zxingcpp.read_barcodes(scaled)}
                        if decoded:
                            break
                    if decoded:
                        break
                found.update(decoded)
    return found


def printer_bitmap(image, expected_codes):
    # XP-420B: 8 dots/mm, 72 x 96 mm. Threshold rather than dither so bars
    # remain solid. Reject conversion if either original barcode is lost.
    gray = image.convert("L").resize((576, 768), Image.Resampling.LANCZOS)
    # Fractional barcode module widths can alias at the printer resolution.
    # Try bounded thresholds; accept only a complete match to the source codes.
    for threshold in (128, 150, 100, 180, 110):
        raster = gray.point(lambda value: 255 if value >= threshold else 0, mode="1")
        if decode_codes(raster) == expected_codes:
            # PIL mode 1: MSB-first, 0=black, 1=white (TSPL BITMAP mode 0).
            return raster.tobytes()
    raise ValueError("PRINT_PDF_PRINTER_BARCODE_MISMATCH")


def render(request):
    raw = base64.b64decode(request["pdfBase64"], validate=True)
    if not raw.startswith(b"%PDF-") or len(raw) > 8 * 1024 * 1024:
        raise ValueError("PRINT_PDF_INVALID")
    expected = request["expected"]
    rma = expected["rmaNo"]
    service = expected["serviceOrderNo"]
    counts = collections.Counter()
    for part in expected["parts"]:
        quantity = int(part["quantity"])
        if quantity < 1 or quantity > 20:
            raise ValueError("PRINT_PDF_QUANTITY_INVALID")
        counts[str(part["partCode"])] += quantity
    if not rma or not service or not counts or sum(counts.values()) > 40:
        raise ValueError("PRINT_PDF_EXPECTATION_INVALID")
    pdf = pdfium.PdfDocument(raw)
    try:
        if len(pdf) != sum(counts.values()):
            raise ValueError("PRINT_PDF_PAGE_COUNT_MISMATCH")
        pages = []
        observed = collections.Counter()
        for index in range(len(pdf)):
            page = pdf[index]
            try:
                width, height = [v * 25.4 / 72 for v in page.get_size()]
                if abs(width - 80) > 1 or abs(height - 60) > 1:
                    raise ValueError("PRINT_PDF_PAGE_SIZE_MISMATCH")
                bitmap = page.render(scale=300 / 72)
                try:
                    image = bitmap.to_pil().convert("RGB")
                finally:
                    bitmap.close()
                codes = decode_codes(image)
                matches = [code for code in counts if service + code in codes]
                if len(matches) != 1 or codes != {rma, service + matches[0]}:
                    raise ValueError("PRINT_PDF_BARCODE_MISMATCH")
                observed[matches[0]] += 1
                # Portrait 76 x 130 stock: rotate, never stretch the 80 x 60 PDF.
                image = image.transpose(Image.Transpose.ROTATE_90)
                if decode_codes(image) != codes:
                    raise ValueError("PRINT_PDF_ROTATION_BARCODE_MISMATCH")
                output = io.BytesIO()
                image.save(output, format="PNG")
                pages.append({"payloadBase64": base64.b64encode(output.getvalue()).decode(),
                              "widthMm": 72, "heightMm": 96, "partCode": matches[0],
                              "rasterWidth": 576, "rasterHeight": 768,
                              "rasterBase64": base64.b64encode(printer_bitmap(image, codes)).decode()})
            finally:
                page.close()
        if observed != counts:
            raise ValueError("PRINT_PDF_PART_QUANTITY_MISMATCH")
        return {"sha256": hashlib.sha256(raw).hexdigest(), "pages": pages}
    finally:
        pdf.close()


if __name__ == "__main__":
    try:
        data = sys.stdin.buffer.read(12 * 1024 * 1024 + 1)
        if len(data) > 12 * 1024 * 1024:
            raise ValueError("PRINT_PDF_TOO_LARGE")
        print(json.dumps(render(json.loads(data))))
    except Exception as error:
        code = str(error)
        if not code.startswith("PRINT_PDF_") or len(code) > 80:
            code = "PRINT_PDF_RENDER_FAILED"
        print(json.dumps({"error": code}))
        sys.exit(1)
