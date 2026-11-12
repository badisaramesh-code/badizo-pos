const PRICE_FIELDS = ['mrp', 'sale_price', 'wholesale_price', 'qty_3_price', 'qty_6_price', 'qty_12_price'];

export function isConfirmedPriceChange(error) {
  return !error?.checkoutJournalError && error?.response?.status === 409
    && error?.response?.data?.code === 'PRICE_CHANGED';
}

// Always bypass the scanner's short-lived price cache. Refresh all bill lines
// together, retaining quantity and customer/cart data even if a lookup fails.
export async function refreshCheckoutPrices(cart, lookup) {
  const barcodes = [...new Set(cart.map(item => String(item.barcode).trim()))];
  const products = new Map();
  for (let start = 0; start < barcodes.length; start += 6) {
    await Promise.all(barcodes.slice(start, start + 6).map(async barcode => {
      const product = await lookup(barcode);
      if (!product || String(product.barcode).trim() !== barcode) {
        throw new Error(`Unable to refresh rate for ${barcode}. The bill is retained; try Complete Sale again.`);
      }
      products.set(barcode, product);
    }));
  }
  return cart.map(item => {
    const product = products.get(String(item.barcode).trim());
    const updated = { ...item };
    for (const field of PRICE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(product, field)) updated[field] = product[field];
    }
    return updated;
  });
}
