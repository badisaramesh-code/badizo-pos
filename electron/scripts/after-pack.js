const path = require('path');
const rcedit = require('rcedit');

exports.default = async function embedBadizoIcon(context) {
  if (context.electronPlatformName !== 'win32') return;
  const exePath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  const iconPath = path.join(__dirname, '..', 'assets', 'badizo.ico');
  await rcedit(exePath, { icon: iconPath });
  console.log(`Badizo B icon embedded in ${exePath}`);
};