'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { createApp } = require('./app');

const port = Number(process.env.PORT) || 3000;
const dbFile = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'app.db');
if (dbFile !== ':memory:') fs.mkdirSync(path.dirname(dbFile), { recursive: true });

createApp({ dbFile }).listen(port, () => {
  console.log(`Schedule sharing app running at http://localhost:${port}`);
});
