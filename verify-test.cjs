const { chromium } = require('./node_modules/playwright');
const fs = require('fs');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  const consoleLogs = [];
  page.on('console', msg => consoleLogs.push(`${msg.type()}: ${msg.text()}`));

  await page.goto('http://localhost:5175', { waitUntil: 'networkidle', timeout: 30000 });

  const openscadCode = [
    'difference() {',
    '    cube([40, 40, 20]);',
    '    translate([20, 20, 10])',
    '        cylinder(h=10, r=8, $fn=32);',
    '    translate([20, 20, 0])',
    '        cylinder(h=14, r=4, $fn=32);',
    '    translate([0, 15, 14])',
    '        cube([40, 10, 6]);',
    '    translate([15, 0, 14])',
    '        cube([10, 40, 6]);',
    '}',
  ].join('\n');

  await page.waitForSelector('.monaco-editor', { timeout: 15000 });
  await page.evaluate((code) => {
    const editors = window.monaco?.editor?.getEditors?.() ?? [];
    if (editors.length > 0) editors[0].setValue(code);
  }, openscadCode);

  await page.click('button:has-text("Compile")');
  console.log('Compiling...');
  await page.waitForTimeout(45000);

  await page.screenshot({ path: 'C:/Users/jbrooks/AppData/Local/Temp/verify-final.png', fullPage: true });

  // Download G-code
  const downloadBtn = await page.$('button:has-text("Download")');
  if (!downloadBtn) { console.log('No Download button found'); await browser.close(); return; }

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    downloadBtn.click(),
  ]);
  const tmpPath = await download.path();
  const gcodeContent = fs.readFileSync(tmpPath, 'utf8');
  const savePath = 'C:/Users/jbrooks/AppData/Local/Temp/verify-gcode-output.nc';
  fs.writeFileSync(savePath, gcodeContent);
  console.log(`Saved G-code to ${savePath} (${gcodeContent.length} chars, ${gcodeContent.split('\n').length} lines)`);

  await browser.close();

  // Parse the G-code
  const lines = gcodeContent.split('\n');
  const headers = lines.map((l, i) => [i, l]).filter(([, l]) => l.trim().startsWith('; ==='));
  console.log('\nSECTION HEADERS:');
  headers.forEach(([i, l]) => console.log(`  line ${i}: ${l}`));

  headers.forEach(([i, h]) => {
    console.log(`\n--- ${h.trim()} (line ${i}) ---`);
    lines.slice(i, i + 16).forEach(l => console.log(l));
  });

  const errors = consoleLogs.filter(l => l.toLowerCase().includes('error'));
  if (errors.length) { console.log('\nCONSOLE ERRORS:'); errors.forEach(l => console.log(l)); }
  else console.log('\nNo console errors.');
})();
