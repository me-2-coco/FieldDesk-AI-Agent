// Runs inside the browser in one call; optional metadata must never wait for a selector.
function readRmaAttachmentItems(root) {
  return [...root.querySelectorAll('.file-detail, .rtxpc-file-detail')]
    .filter(item => item.getClientRects().length > 0 && getComputedStyle(item).visibility !== 'hidden')
    .map(item => ({
      name: item.querySelector('.item-name')?.textContent || '',
      sizeText: item.querySelector('.uploadTime-and-operation span')?.textContent || '',
    }));
}
module.exports = { readRmaAttachmentItems };
