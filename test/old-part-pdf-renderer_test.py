import base64
import importlib.util
import io
from pathlib import Path
import unittest
from reportlab.pdfgen import canvas
from reportlab.lib.units import mm
from reportlab.graphics.barcode.code128 import Code128
from PIL import Image

spec = importlib.util.spec_from_file_location('labels', Path(__file__).parents[1] / 'scripts/render-old-part-pdf.py')
labels = importlib.util.module_from_spec(spec)
spec.loader.exec_module(labels)
RMA = 'JXTH209901010001'
SERVICE = 'FWD209901010001'


def source(codes=('P1',), rma=RMA, size=(80, 60)):
    output = io.BytesIO()
    pdf = canvas.Canvas(output, pagesize=(size[0]*mm, size[1]*mm))
    for code in codes:
        for text, y in [(SERVICE + code, 44), (rma, 18)]:
            barcode = Code128(text, barHeight=9*mm, barWidth=.3*mm, humanReadable=True)
            pdf.saveState()
            pdf.translate(4*mm, y*mm)
            pdf.scale(min(1,72*mm/barcode.width),1)
            barcode.drawOn(pdf,0,0)
            pdf.restoreState()
        pdf.showPage()
    pdf.save()
    return output.getvalue()


def request(raw, parts=None):
    return {'pdfBase64':base64.b64encode(raw).decode(), 'expected':{
        'rmaNo':RMA, 'serviceOrderNo':SERVICE,
        'parts':parts or [{'partCode':'P1','quantity':1}]}}


class RendererTest(unittest.TestCase):
    def test_original_codes_preserved_after_rotation(self):
        result=labels.render(request(source()))
        self.assertEqual(len(result['pages']),1)
        page=result['pages'][0]
        image=Image.open(io.BytesIO(base64.b64decode(page['payloadBase64'])))
        self.assertLess(image.width,image.height)
        self.assertEqual(labels.decode_codes(image),{RMA,SERVICE+'P1'})
        self.assertEqual((page['widthMm'],page['heightMm']),(60,80))

    def test_multiple_parts_and_quantity(self):
        result=labels.render(request(source(('P1','P2','P2')),
            [{'partCode':'P1','quantity':1},{'partCode':'P2','quantity':2}]))
        self.assertEqual([p['partCode'] for p in result['pages']],['P1','P2','P2'])

    def test_wrong_order_refused(self):
        with self.assertRaisesRegex(ValueError,'BARCODE_MISMATCH'):
            labels.render(request(source(rma='JXTH209901019999')))

    def test_missing_page_refused(self):
        with self.assertRaisesRegex(ValueError,'PAGE_COUNT_MISMATCH'):
            labels.render(request(source(),[{'partCode':'P1','quantity':2}]))

    def test_wrong_size_refused(self):
        with self.assertRaisesRegex(ValueError,'PAGE_SIZE_MISMATCH'):
            labels.render(request(source(size=(210,297))))

    def test_html_refused(self):
        with self.assertRaisesRegex(ValueError,'INVALID'):
            labels.render(request(b'<html>login required</html>'))

if __name__=='__main__': unittest.main()
