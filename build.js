'use strict';

/**
 * Yokohama ILUO Portal Production Build Script
 * Compiles and validates frontend assets into dist/
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('⚡ Starting Yokohama ILUO Portal Build Pipeline...');
const startTime = Date.now();

const ROOT_DIR = __dirname;
const DIST_DIR = path.join(ROOT_DIR, 'dist');

// 1. Lint / Syntax Check on core JS files
const filesToCheck = [
  'server.js',
  'excel_sync_engine.js',
  'app.js',
  'employee.js',
  'shared_constants.js',
  'docx_generator.js',
  'report_html_generator.js'
];

console.log('🔍 Validating JavaScript syntax...');
for (const file of filesToCheck) {
  const filePath = path.join(ROOT_DIR, file);
  if (fs.existsSync(filePath)) {
    try {
      execSync(`node --check "${filePath}"`, { stdio: 'pipe' });
    } catch (err) {
      console.error(`❌ Syntax error in ${file}:`, err.message);
      process.exit(1);
    }
  }
}
console.log('✅ All JavaScript files passed syntax verification.');

// 2. Clean & Recreate dist/ directory
if (fs.existsSync(DIST_DIR)) {
  fs.rmSync(DIST_DIR, { recursive: true, force: true });
}
fs.mkdirSync(DIST_DIR, { recursive: true });

// 3. Static files to bundle into dist/
const STATIC_FILES = [
  'index.html',
  'employee.html',
  'app.js',
  'employee.js',
  'styles.css',
  'shared_constants.js',
  'docx_generator.js',
  'report_html_generator.js',
  'master_excel_b64.js',
  'data.js',
  'ojt_templates_data.js',
  'seed_data.js',
  'xlsx.full.min.js',
  'jszip.min.js',
  'docx-preview.min.js',
  'mammoth.browser.min.js',
  'html2pdf.bundle.min.js',
  'atg_logo.png',
  'yokohama_logo.png',
  'favicon.ico',
  'manifest.json'
];

let copiedFileCount = 0;
for (const relPath of STATIC_FILES) {
  const src = path.join(ROOT_DIR, relPath);
  const dest = path.join(DIST_DIR, relPath);
  if (fs.existsSync(src)) {
    const parent = path.dirname(dest);
    if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
    fs.copyFileSync(src, dest);
    copiedFileCount++;
  }
}

// 4. Recursive directories to copy into dist/
const DIRS_TO_COPY = [
  'QC_templates',
  'public',
  'assets'
];

function copyDirRecursive(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return;
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
      copiedFileCount++;
    }
  }
}

for (const dir of DIRS_TO_COPY) {
  copyDirRecursive(path.join(ROOT_DIR, dir), path.join(DIST_DIR, dir));
}

const duration = Date.now() - startTime;
console.log(`📦 Build complete! Bundled ${copiedFileCount} assets into dist/ in ${duration}ms.`);
