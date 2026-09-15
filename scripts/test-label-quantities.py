import ast
import collections
from pathlib import Path

# Exercise the pure quantity policy without creating or altering any PDFs.
tree = ast.parse(Path(__file__).with_name('render-old-part-pdf.py').read_text())
function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'expand_label_quantities')
scope = {'collections': collections}
exec(compile(ast.Module(body=[function], type_ignores=[]), '<quantity-policy>', 'exec'), scope)
expand = scope['expand_label_quantities']
page = {'partCode': 'LAB-P1', 'sourcePage': 1, 'payloadBase64': 'unchanged'}
assert expand([page], {'LAB-P1': 2}) == [page, page]
assert len(expand([page, page], {'LAB-P1': 2})) == 2
assert len(expand([page, {'partCode': 'LAB-P2', 'sourcePage': 2}], {'LAB-P1': 2, 'LAB-P2': 1})) == 3
for pages, counts in [([page, page], {'LAB-P1': 3}), ([page], {'LAB-P2': 1}), ([], {'LAB-P1': 2}), ([page]*3, {'LAB-P1': 2})]:
    try:
        expand(pages, counts)
        raise AssertionError('must reject incomplete/extra labels')
    except ValueError:
        pass
print('Label quantity policy passed')
