export function findExactSaleProduct(products, searchValue) {
  const key = String(searchValue || '').trim().toUpperCase();
  if (!key || !Array.isArray(products)) return null;

  return products.find((product) => (
    String(product?.barcode || '').trim().toUpperCase() === key
  )) || products.find((product) => (
    String(product?.product_code || '').trim().toUpperCase() === key
  )) || null;
}