'use strict';
module.exports = async function routes(app, kit) {
  for (const m of ['assets', 'api', 'pages']) await require(`./${m}`)(app, kit);
};
