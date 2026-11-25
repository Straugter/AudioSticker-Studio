const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const www = path.join(root, 'www');
fs.mkdirSync(www, { recursive: true });
fs.mkdirSync(path.join(www, 'vendor'), { recursive: true });

const filesToCopy = [
  'index.html',
  'styles.css',
  'app.bundle.js',
  'manifest.json',
  'sw.js',
  'icon-192.png',
  'icon-512.png',
  path.join('vendor', 'lame.min.js')
];

for (const f of filesToCopy) {
  const src = path.join(root, f);
  const dst = path.join(www, f);
  if (fs.existsSync(src)) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}

// Sync wa-main-sender.js into Android assets for embedded WhatsAppSenderActivity
const androidAssets = path.join(root, 'android', 'app', 'src', 'main', 'assets');
const waSenderSrc = path.join(root, 'chrome-extension', 'wa-main-sender.js');
if (fs.existsSync(androidAssets) && fs.existsSync(waSenderSrc)) {
  fs.copyFileSync(waSenderSrc, path.join(androidAssets, 'wa-main-sender.js'));
  console.log('✅ Synced wa-main-sender.js to Android assets');
}

// Replace default Capacitor Android mipmap launcher icons with our AudioSticker Studio icon
const resDir = path.join(root, 'android', 'app', 'src', 'main', 'res');
const icon192 = path.join(root, 'icon-192.png');
const icon512 = path.join(root, 'icon-512.png');
if (fs.existsSync(resDir) && fs.existsSync(icon192)) {
  const densities = ['mipmap-mdpi', 'mipmap-hdpi', 'mipmap-xhdpi', 'mipmap-xxhdpi', 'mipmap-xxxhdpi'];
  for (const d of densities) {
    const dir = path.join(resDir, d);
    if (!fs.existsSync(dir)) continue;
    const srcIcon = (d === 'mipmap-xxxhdpi' && fs.existsSync(icon512)) ? icon512 : icon192;
    fs.copyFileSync(srcIcon, path.join(dir, 'ic_launcher.png'));
    fs.copyFileSync(srcIcon, path.join(dir, 'ic_launcher_round.png'));
    fs.copyFileSync(srcIcon, path.join(dir, 'ic_launcher_foreground.png'));
  }
  console.log('✅ Updated Android launcher icons');
}

console.log('✅ Synced web assets (offline CSS + vendor LameJS + bundle) to www/');
