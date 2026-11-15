'use strict';
// Admin main menu (Magento 2 admin sidebar), only entries that exist here.
const MENU = [
  { id: 'dashboard', label: 'Dashboard', href: '/admin/dashboard/' },
  { id: 'sales', label: 'Sales', groups: [
    ['Operations', [['Orders', '/admin/sales/order/'], ['Invoices', '/admin/sales/invoice/'], ['Shipments', '/admin/sales/shipment/'], ['Credit Memos', '/admin/sales/creditmemo/']]],
  ] },
  { id: 'catalog', label: 'Catalog', groups: [
    ['Inventory', [['Products', '/admin/catalog/product/'], ['Categories', '/admin/catalog/category/']]],
  ] },
  { id: 'customer', label: 'Customers', groups: [
    [null, [['All Customers', '/admin/customer/index/'], ['Customer Groups', '/admin/customer/group/']]],
  ] },
  { id: 'marketing', label: 'Marketing', groups: [
    ['Promotions', [['Catalog Price Rule', '/admin/catalog_rule/promo_catalog/'], ['Cart Price Rules', '/admin/sales_rule/promo_quote/']]],
    ['Communications', [['Newsletter Templates', '/admin/newsletter/template/'], ['Newsletter Queue', '/admin/newsletter/queue/'], ['Newsletter Subscribers', '/admin/newsletter/subscriber/']]],
    ['SEO & Search', [['Search Terms', '/admin/search/term/index/'], ['Search Synonyms', '/admin/search/synonyms/']]],
    ['User Content', [['All Reviews', '/admin/review/product/'], ['Pending Reviews', '/admin/review/product/pending/']]],
  ] },
  { id: 'content', label: 'Content', groups: [
    ['Elements', [['Pages', '/admin/cms/page/'], ['Blocks', '/admin/cms/block/']]],
    ['Design', [['Configuration', '/admin/theme/design_config/'], ['Themes', '/admin/admin/system_design_theme/']]],
  ] },
  { id: 'reports', label: 'Reports', groups: [
    ['Marketing', [['Products in Cart', '/admin/reports/report_shopcart/product/'], ['Search Terms', '/admin/search/term/report/'], ['Abandoned Carts', '/admin/reports/report_shopcart/abandoned/']]],
    ['Reviews', [['By Customers', '/admin/reports/report_review/customer/'], ['By Products', '/admin/reports/report_review/product/']]],
    ['Sales', [['Orders', '/admin/reports/report_sales/sales/'], ['Tax', '/admin/reports/report_sales/tax/'], ['Invoiced', '/admin/reports/report_sales/invoiced/'], ['Shipping', '/admin/reports/report_sales/shipping/'], ['Refunds', '/admin/reports/report_sales/refunded/'], ['Coupons', '/admin/reports/report_sales/coupons/']]],
    ['Customers', [['Order Total', '/admin/reports/report_customer/totals/'], ['Order Count', '/admin/reports/report_customer/orders/'], ['New', '/admin/reports/report_customer/accounts/']]],
    ['Products', [['Views', '/admin/reports/report_product/viewed/'], ['Bestsellers', '/admin/reports/report_sales/bestsellers/'], ['Low Stock', '/admin/reports/report_product/lowstock/'], ['Ordered', '/admin/reports/report_product/sold/']]],
    ['Statistics', [['Refresh Statistics', '/admin/reports/report_statistics/']]],
  ] },
  { id: 'stores', label: 'Stores', groups: [
    ['Settings', [['All Stores', '/admin/admin/system_store/'], ['Configuration', '/admin/admin/system_config/'], ['Order Status', '/admin/sales/order_status/']]],
    ['Taxes', [['Tax Zones and Rates', '/admin/tax/rate/']]],
    ['Attributes', [['Product', '/admin/catalog/product_attribute/'], ['Attribute Set', '/admin/catalog/product_set/'], ['Rating', '/admin/review/rating/']]],
  ] },
  { id: 'system', label: 'System', groups: [
    ['Permissions', [['All Users', '/admin/admin/user/'], ['User Roles', '/admin/admin/user_role/']]],
    ['Tools', [['Cache Management', '/admin/admin/cache/'], ['Index Management', '/admin/indexer/indexer/list/']]],
  ] },
];

// which top-level section a URL belongs to (highlights the sidebar)
function sectionOf(url) {
  const p = String(url).split('?')[0].replace(/^\/admin/, '');
  const rules = [
    [/^\/(dashboard|admin\/dashboard)?\/?$/, 'dashboard'],
    [/^\/(sales\/(order|invoice|shipment|creditmemo|order_invoice|order_creditmemo|transactions)|admin\/order_shipment)/, 'sales'],
    [/^\/catalog\/(product(?!_attribute|_set)|category)/, 'catalog'],
    [/^\/customer\//, 'customer'],
    [/^\/(catalog_rule|sales_rule|newsletter|review\/product|search\/(term\/index|term\/edit|term\/new|synonyms))/, 'marketing'],
    [/^\/(cms|theme|admin\/system_design_theme)/, 'content'],
    [/^\/(reports|search\/term\/report)/, 'reports'],
    [/^\/(admin\/system_store|admin\/system_config|sales\/order_status|tax|catalog\/product_attribute|catalog\/product_set|review\/rating)/, 'stores'],
    [/^\/(admin\/user|admin\/cache|indexer|admin\/user_role)/, 'system'],
  ];
  for (const [re, id] of rules) if (re.test(p)) return id;
  return null;
}

module.exports = { MENU, sectionOf };
