// Generates every TestPion icon and logo size from two sources, using Chromium's renderer:
//   build/logo/testpion-NxN.png  the app icon, the "TP" test-tube mark (transparent), drawn at 32–1024 px;
//                                those sizes are used as they are, other sizes are scaled from the 1024 one
//   build/wordmark.svg     the TestPion wordmark ("Connect every protocol")
//
// Desktop (apps/desktop/build):
//   icon.png             1024×1024  electron-builder source (macOS .icns is derived from it)
//   icon.ico             16–256     Windows app and installer icon (PNG-compressed entries)
//   icons/NxN.png        16–512     Linux icon set
// Website (docs/public):
//   logo.svg                        nav logo, hero image and SVG favicon
//   favicon.ico          16/32/48   browsers without SVG favicons
//   apple-touch-icon.png 180×180
//   icon-192.png, icon-512.png      web app manifest sizes
//   images/testpion-wordmark.png    1200×400 wordmark for the README and docs
//   images/social-preview.jpg       1280×640 link preview (og:image)
//
// Run: npm run icons -w @testpion/desktop
const { app, BrowserWindow } = require('electron');
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const build = join(__dirname, '..', 'build');
const site = join(__dirname, '..', '..', '..', 'docs', 'public');

const markFile = (size) => join(build, 'logo', `testpion-${size}x${size}.png`);
const markSrc = 'data:image/png;base64,' + readFileSync(markFile(1024)).toString('base64');
const wordmark = 'data:image/svg+xml;base64,' + readFileSync(join(build, 'wordmark.svg')).toString('base64');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  await win.loadURL('data:text/html,<html></html>');

  /** Draw an image (data URL) into a w×h canvas; `fit` letterboxes it on the image's own edge colour, `contain` centres it (transparent around, `pad` of the size). */
  const render = (src, w, h, { fit = false, contain = false, pad = 0, type = 'image/png' } = {}) =>
    win.webContents
      .executeJavaScript(
        `new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => {
            const c = document.createElement('canvas');
            c.width = ${w}; c.height = ${h};
            const g = c.getContext('2d');
            g.imageSmoothingQuality = 'high';
            if (${fit}) {
              // background: a radial gradient in the image's own background colours (sampled away from the text)
              const s = document.createElement('canvas'); s.width = img.naturalWidth; s.height = img.naturalHeight;
              const sg = s.getContext('2d'); sg.drawImage(img, 0, 0);
              const px = (x, y) => { const d = sg.getImageData(Math.round(x), Math.round(y), 1, 1).data; return 'rgb(' + d[0] + ',' + d[1] + ',' + d[2] + ')'; };
              const inner = px(img.naturalWidth / 2, 6), outer = px(4, 4);
              const rg = g.createRadialGradient(${w} / 2, ${h} / 2, 0, ${w} / 2, ${h} / 2, Math.max(${w}, ${h}) * 0.62);
              rg.addColorStop(0, inner); rg.addColorStop(1, outer);
              g.fillStyle = rg; g.fillRect(0, 0, ${w}, ${h});
              // foreground: the whole image, edges feathered into the background
              const scale = Math.min(${w} / img.naturalWidth, ${h} / img.naturalHeight);
              const dw = Math.round(img.naturalWidth * scale), dh = Math.round(img.naturalHeight * scale);
              const f = document.createElement('canvas'); f.width = dw; f.height = dh;
              const fg = f.getContext('2d');
              fg.drawImage(img, 0, 0, dw, dh);
              fg.globalCompositeOperation = 'destination-in';
              const feather = 0.14;
              const v = fg.createLinearGradient(0, 0, 0, dh);
              v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(feather, '#000'); v.addColorStop(1 - feather, '#000'); v.addColorStop(1, 'rgba(0,0,0,0)');
              fg.fillStyle = v; fg.fillRect(0, 0, dw, dh);
              const hz = fg.createLinearGradient(0, 0, dw, 0);
              hz.addColorStop(0, 'rgba(0,0,0,0)'); hz.addColorStop(feather / 2, '#000'); hz.addColorStop(1 - feather / 2, '#000'); hz.addColorStop(1, 'rgba(0,0,0,0)');
              fg.fillStyle = hz; fg.fillRect(0, 0, dw, dh);
              g.drawImage(f, (${w} - dw) / 2, (${h} - dh) / 2);
            } else if (${contain}) {
              // trim the transparent margin first, so the mark fills the square
              const t0 = document.createElement('canvas'); t0.width = img.naturalWidth; t0.height = img.naturalHeight;
              const t0g = t0.getContext('2d'); t0g.drawImage(img, 0, 0);
              const a = t0g.getImageData(0, 0, t0.width, t0.height).data;
              let x0 = t0.width, y0 = t0.height, x1 = 0, y1 = 0;
              for (let y = 0; y < t0.height; y++) for (let x = 0; x < t0.width; x++) if (a[(y * t0.width + x) * 4 + 3] > 16) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
              const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
              const crop = document.createElement('canvas'); crop.width = cw; crop.height = ch;
              crop.getContext('2d').drawImage(t0, x0, y0, cw, ch, 0, 0, cw, ch);
              const box = Math.min(${w}, ${h}) * (1 - 2 * ${pad});
              const scale = Math.min(box / cw, box / ch);
              const dw = cw * scale, dh = ch * scale;
              // big downscales in steps, so small icons stay sharp
              let src = crop, sw = cw, sh = ch;
              while (sw / 2 > dw) {
                const t = document.createElement('canvas'); t.width = Math.round(sw / 2); t.height = Math.round(sh / 2);
                const tg = t.getContext('2d'); tg.imageSmoothingQuality = 'high'; tg.drawImage(src, 0, 0, t.width, t.height);
                src = t; sw = t.width; sh = t.height;
              }
              g.drawImage(src, (${w} - dw) / 2, (${h} - dh) / 2, dw, dh);
            } else g.drawImage(img, 0, 0, ${w}, ${h});
            resolve(c.toDataURL('${type}', 0.9));
          };
          img.onerror = () => reject(new Error('could not load image'));
          img.src = ${JSON.stringify(src)};
        })`,
      )
      .then((url) => Buffer.from(url.split(',')[1], 'base64'));

  // 64 px and up: the drawn size when there is one; smaller (taskbar, title bar, favicon) and missing sizes are
  // scaled from the 1024 px mark with its transparent margin trimmed, so the mark fills the square
  const mark = (size) => (size >= 64 && existsSync(markFile(size)) ? Promise.resolve(readFileSync(markFile(size))) : render(markSrc, size, size, { contain: true, pad: size <= 48 ? 0.01 : 0.04 }));

  /** Render an image to a 24-bit BMP (what the NSIS installer's header and side images must be). */
  const bmp = async (src, w, h) => {
    const b64 = await win.webContents.executeJavaScript(
      `new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const c = document.createElement('canvas'); c.width = ${w}; c.height = ${h};
          const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, ${w}, ${h});
          const d = g.getImageData(0, 0, ${w}, ${h}).data; let s = '';
          for (let i = 0; i < d.length; i += 8192) s += String.fromCharCode.apply(null, d.subarray(i, i + 8192));
          resolve(btoa(s));
        };
        img.onerror = () => reject(new Error('could not load image'));
        img.src = ${JSON.stringify(src)};
      })`,
    );
    const rgba = Buffer.from(b64, 'base64');
    const row = Math.ceil((w * 3) / 4) * 4;
    const out = Buffer.alloc(54 + row * h);
    out.write('BM', 0);
    out.writeUInt32LE(out.length, 2);
    out.writeUInt32LE(54, 10);
    out.writeUInt32LE(40, 14);
    out.writeInt32LE(w, 18);
    out.writeInt32LE(h, 22); // positive height: rows bottom-up
    out.writeUInt16LE(1, 26);
    out.writeUInt16LE(24, 28);
    out.writeUInt32LE(row * h, 34);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const s = (y * w + x) * 4;
        const o = 54 + (h - 1 - y) * row + x * 3;
        out[o] = rgba[s + 2];
        out[o + 1] = rgba[s + 1];
        out[o + 2] = rgba[s];
      }
    return out;
  };

  /** An .ico file whose entries are PNG images (supported since Windows Vista). */
  const ico = (pngs) => {
    const header = Buffer.alloc(6 + 16 * pngs.length);
    header.writeUInt16LE(0, 0);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(pngs.length, 4);
    let offset = header.length;
    pngs.forEach(([size, data], i) => {
      const e = 6 + 16 * i;
      header.writeUInt8(size >= 256 ? 0 : size, e);
      header.writeUInt8(size >= 256 ? 0 : size, e + 1);
      header.writeUInt16LE(1, e + 4); // colour planes
      header.writeUInt16LE(32, e + 6); // bits per pixel
      header.writeUInt32LE(data.length, e + 8);
      header.writeUInt32LE(offset, e + 12);
      offset += data.length;
    });
    return Buffer.concat([header, ...pngs.map(([, d]) => d)]);
  };
  const write = (path, data) => {
    writeFileSync(path, data);
    console.log(`wrote ${path.replace(/\\/g, '/').split('/').slice(-3).join('/')} (${data.length} bytes)`);
  };

  // desktop
  write(join(build, 'icon.png'), await mark(1024));
  const winSizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
  write(join(build, 'icon.ico'), ico(await Promise.all(winSizes.map(async (s) => [s, await mark(s)]))));
  mkdirSync(join(build, 'icons'), { recursive: true });
  for (const s of [16, 24, 32, 48, 64, 128, 256, 512]) write(join(build, 'icons', `${s}x${s}.png`), await mark(s));

  // website
  // the site's logo.svg wraps the mark (nav logo, hero image, SVG favicon)
  const siteMark = 'data:image/png;base64,' + (await mark(256)).toString('base64');
  write(join(site, 'logo.svg'), Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="256" height="256" viewBox="0 0 256 256"><image width="256" height="256" xlink:href="${siteMark}" href="${siteMark}"/></svg>`));
  write(join(site, 'favicon.ico'), ico(await Promise.all([16, 32, 48].map(async (s) => [s, await mark(s)]))));
  write(join(site, 'apple-touch-icon.png'), await mark(180));
  write(join(site, 'icon-192.png'), await mark(192));
  write(join(site, 'icon-512.png'), await mark(512));
  mkdirSync(join(site, 'images'), { recursive: true });
  write(join(site, 'images', 'testpion-wordmark.png'), await render(wordmark, 1200, 400));
  write(join(site, 'images', 'social-preview.jpg'), await render(wordmark, 1280, 640, { fit: true, type: 'image/jpeg' }));
  // the TestPion wordmark without the tagline (gradient "Test", white "Pion", sparkle) for the app's top bar
  // and the website's nav bar; rendered to PNG so the font is the same on every machine. On light
  // backgrounds it sits on a navy badge (CSS), so "Pion" stays white everywhere.
  const nav = readFileSync(join(build, 'wordmark-nav.svg'), 'utf8').replaceAll('PION_COLOR', '#f4f6ff');
  const navPng = await render('data:image/svg+xml;base64,' + Buffer.from(nav).toString('base64'), 600, 150);
  write(join(site, 'wordmark-nav.png'), navPng);
  write(join(build, 'wordmark-nav.png'), navPng);
  // the app's top bar on the light theme: the same wordmark with a dark "Pion", on the bar's own white
  const navLight = readFileSync(join(build, 'wordmark-nav.svg'), 'utf8').replaceAll('PION_COLOR', '#0c1440');
  write(join(build, 'wordmark-nav-light.png'), await render('data:image/svg+xml;base64,' + Buffer.from(navLight).toString('base64'), 600, 150));

  // Windows installer (NSIS): the wordmark in the header (150×57) and on the welcome/finish pages (164×314)
  const navData = 'data:image/png;base64,' + navPng.toString('base64');
  const svgUrl = (svg) => 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
  const header = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="150" height="57" viewBox="0 0 150 57">
    <rect width="150" height="57" fill="#0c1440"/>
    <image xlink:href="${navData}" href="${navData}" x="11" y="12" width="128" height="32"/></svg>`;
  write(join(build, 'installerHeader.bmp'), await bmp(svgUrl(header), 150, 57));
  const side = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="164" height="314" viewBox="0 0 164 314">
    <defs>
      <radialGradient id="bg" cx="0.5" cy="0.4" r="0.9"><stop offset="0" stop-color="#172a6b"/><stop offset="0.55" stop-color="#0c1440"/><stop offset="1" stop-color="#070b26"/></radialGradient>
      <linearGradient id="rule" x1="0" x2="1"><stop offset="0" stop-color="#1e88ff" stop-opacity="0"/><stop offset="0.5" stop-color="#8b5cff"/><stop offset="1" stop-color="#f04fe0" stop-opacity="0"/></linearGradient>
    </defs>
    <rect width="164" height="314" fill="url(#bg)"/>
    <image xlink:href="${navData}" href="${navData}" x="10" y="118" width="144" height="36"/>
    <rect x="22" y="166" width="120" height="1.5" fill="url(#rule)"/>
    <text x="82" y="182" text-anchor="middle" font-family="'Segoe UI', Arial, sans-serif" font-size="8" letter-spacing="1.6" fill="#d7ddf5">CONNECT EVERY PROTOCOL</text></svg>`;
  const sideBmp = await bmp(svgUrl(side), 164, 314);
  write(join(build, 'installerSidebar.bmp'), sideBmp);

  app.quit();
});
