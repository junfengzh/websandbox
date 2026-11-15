'use strict';
// Storefront routes ("One Stop Market", shopping.wa). URL schemes follow Magento 2 / Luma so
// converted WebArena tasks change minimally; every route is listed in ../../ROUTES.md.
module.exports = async function storefront(app, kit, ctx) {
  await require('./customer')(app, kit, ctx);
  await require('./checkout')(app, kit, ctx);
  await require('./sales')(app, kit, ctx);
  await require('./misc')(app, kit, ctx);
  await require('./catalog')(app, kit, ctx); // last: owns the catch-all /<url-key>.html route
};
