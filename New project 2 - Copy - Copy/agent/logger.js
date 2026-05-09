const fs = require('fs-extra');
const path = require('path');
const config = require('./config');

function timestampForFile(date = new Date()) {
  return date.toISOString().replace(/:/g, '-').replace(/\..+$/, '');
}

async function ensureLogDir() {
  await fs.ensureDir(config.logDir);
}

async function writeRunLog(entry) {
  await ensureLogDir();
  const file = path.join(config.logDir, `${timestampForFile()}.log`);
  const body = JSON.stringify(
    {
      timestamp: new Date().toISOString(),
      model: config.modelName,
      ...entry
    },
    null,
    2
  );
  await fs.writeFile(file, body, 'utf8');
  return file;
}

async function appendSystemLog(entry) {
  await ensureLogDir();
  const file = path.join(config.logDir, 'system.log');
  await fs.appendFile(file, `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`, 'utf8');
}

module.exports = {
  writeRunLog,
  appendSystemLog
};
