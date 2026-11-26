const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

test('BUILD PIPELINE: npm run build outputs complete dist directory with essential frontend assets', () => {
  const distDir = path.join(__dirname, '..', 'dist');
  // Clean dist before test to ensure build creates it
  if (fs.existsSync(distDir)) {
    fs.rmSync(distDir, { recursive: true, force: true });
  }

  execSync('node build.js', { cwd: path.join(__dirname, '..'), stdio: 'pipe' });
  assert.ok(fs.existsSync(distDir), 'dist/ directory must exist');
  assert.ok(fs.existsSync(path.join(distDir, 'index.html')), 'dist/index.html must exist');
  assert.ok(fs.existsSync(path.join(distDir, 'employee.html')), 'dist/employee.html must exist');
  assert.ok(fs.existsSync(path.join(distDir, 'app.js')), 'dist/app.js must exist');
  assert.ok(fs.existsSync(path.join(distDir, 'employee.js')), 'dist/employee.js must exist');
  assert.ok(fs.existsSync(path.join(distDir, 'styles.css')), 'dist/styles.css must exist');
  assert.ok(fs.existsSync(path.join(distDir, 'public', 'templates', 'production_template.xlsx')), 'production_template.xlsx must exist in dist');
  assert.ok(fs.existsSync(path.join(distDir, 'public', 'templates', 'qa_template.xlsx')), 'qa_template.xlsx must exist in dist');
});
