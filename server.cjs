// PathScore server bootstrap
'use strict';

const { createServer } = require('./src/server/index.cjs');

const { app, config } = createServer();
app.listen(config.port, () => {
  console.log(`PathScore running on http://localhost:${config.port}`);
});
