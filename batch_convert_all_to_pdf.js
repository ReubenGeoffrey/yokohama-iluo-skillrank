const fs = require('fs');
const path = require('path');
const app = require('./server.js');

async function main() {
  const outputDir = path.join(__dirname, 'output_pdf');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Load employees
  let employees = [];
  const empFile = path.join(__dirname, 'custom_employees.json');
  if (fs.existsSync(empFile)) {
    try {
      employees = JSON.parse(fs.readFileSync(empFile, 'utf-8'));
    } catch (e) {}
  }
  if (!employees.length) {
    console.error('No employees found to process.');
    process.exit(1);
  }

  console.log(`\n==============================================================`);
  console.log(`🚀 Starting Word-to-PDF conversion for ${employees.length} employees...`);
  console.log(`📁 Target folder: ${outputDir}`);
  console.log(`==============================================================\n`);

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < employees.length; i++) {
    const emp = employees[i];
    const empNo = String(emp.empNo).trim();
    const safeName = (emp.name || empNo).replace(/[\s\\/]+/g, '_');
    const pdfPath = path.join(outputDir, `Yokohama_ILUO_Report_${empNo}_${safeName}.pdf`);

    process.stdout.write(`[${i + 1}/${employees.length}] Converting ${empNo} (${emp.name})... `);

    try {
      const docxBuf = await app.buildDocxBufferForEmployee(empNo);
      const pdfBuf = await app.convertDocxBufferToPdf(docxBuf, empNo);
      fs.writeFileSync(pdfPath, pdfBuf);
      console.log(`✅ OK (${Math.round(pdfBuf.length / 1024)} KB)`);
      successCount++;
    } catch (err) {
      console.log(`❌ FAILED: ${err.message}`);
      failCount++;
    }
  }

  console.log(`\n==============================================================`);
  console.log(`🎉 Batch conversion complete!`);
  console.log(`✅ Successfully generated: ${successCount} PDFs`);
  if (failCount > 0) console.log(`⚠️ Failures: ${failCount}`);
  console.log(`📁 Output directory: ${outputDir}`);
  console.log(`==============================================================\n`);
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal batch error:', err);
  process.exit(1);
});
