const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const app = require('./server.js');

async function main() {
  const empsFile = path.join(__dirname, 'custom_employees.json');
  if (!fs.existsSync(empsFile)) {
    console.error('custom_employees.json not found');
    process.exit(1);
  }

  const emps = JSON.parse(fs.readFileSync(empsFile, 'utf-8'));
  console.log(`Found ${emps.length} employees to generate.`);

  const tempDocxDir = path.join(__dirname, 'temp_all_docx');
  const targetPdfDir = path.join(__dirname, 'pdf_reports');

  if (!fs.existsSync(tempDocxDir)) fs.mkdirSync(tempDocxDir, { recursive: true });
  if (!fs.existsSync(targetPdfDir)) fs.mkdirSync(targetPdfDir, { recursive: true });

  console.log(`Generating ${emps.length} official DOCX templates...`);
  const t0 = Date.now();

  let count = 0;
  for (const emp of emps) {
    const empNo = String(emp.empNo).trim();
    try {
      const docxBuf = await app.buildDocxBufferForEmployee(empNo);
      fs.writeFileSync(path.join(tempDocxDir, `Yokohama_ILUO_Report_${empNo}.docx`), docxBuf);
      count++;
    } catch (err) {
      console.error(`Error generating DOCX for ${empNo}:`, err.message);
    }
  }

  console.log(`Generated ${count} DOCX files in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
  console.log(`Now converting all DOCX files to 100% exact Native Word PDFs using Word COM...`);

  const psScript = path.join(__dirname, 'batch_convert_folder.ps1');
  const ps = execFile('powershell', [
    '-ExecutionPolicy', 'Bypass',
    '-File', psScript,
    '-srcFolder', tempDocxDir,
    '-dstFolder', targetPdfDir
  ]);

  ps.stdout.on('data', (d) => process.stdout.write(d));
  ps.stderr.on('data', (d) => process.stderr.write(d));

  ps.on('close', (code) => {
    console.log(`\nWord COM conversion process exited with code ${code}`);
    try {
      const pdfFiles = fs.readdirSync(targetPdfDir).filter(f => f.endsWith('.pdf'));
      console.log(`Total PDFs created in pdf_reports: ${pdfFiles.length}`);
      
      // Calculate total size
      let totalBytes = 0;
      pdfFiles.forEach(f => {
        totalBytes += fs.statSync(path.join(targetPdfDir, f)).size;
      });
      console.log(`Total folder size: ${(totalBytes / (1024 * 1024)).toFixed(2)} MB`);
      
      // Clean up temp docx folder
      fs.rmSync(tempDocxDir, { recursive: true, force: true });
      console.log(`Cleaned up temporary DOCX files.`);
    } catch(e) {
      console.error('Cleanup error:', e.message);
    }
    process.exit(code);
  });
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
