// The OCR engine and language data ship with the app, so reading a screenshot needs no internet.
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';

const out = 'src/web/public/ocr';
mkdirSync(out, { recursive: true });
copyFileSync('node_modules/tesseract.js/dist/worker.min.js', `${out}/worker.min.js`);
for (const f of readdirSync('node_modules/tesseract.js-core')) {
  if (/^tesseract-core.*lstm\.wasm\.js$/.test(f)) copyFileSync(`node_modules/tesseract.js-core/${f}`, `${out}/${f}`);
}
copyFileSync('node_modules/@tesseract.js-data/eng/4.0.0/eng.traineddata.gz', `${out}/eng.traineddata.gz`);
