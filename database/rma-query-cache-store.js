const path = require('node:path');
const { PendingReceiptStore, DEFAULT_CAPACITY } = require('./pending-receipt-store');

class RmaQueryCacheStore extends PendingReceiptStore {
  constructor(
    filePath = path.join(__dirname, 'data', 'rma-query-cache.json'),
    options = {}
  ) {
    super(filePath, {
      capacity: options.capacity || process.env.RMA_QUERY_CACHE_CAPACITY || DEFAULT_CAPACITY,
    });
  }
}

module.exports = { RmaQueryCacheStore };
