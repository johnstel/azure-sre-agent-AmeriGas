'use strict';

const { cliMain } = require('./readiness');

(async () => {
  try {
    const exitCode = await cliMain(process.argv.slice(2));
    process.exit(exitCode);
  } catch (error) {
    console.error(error && error.message ? error.message : 'Readiness request failed.');
    process.exit(2);
  }
})();
