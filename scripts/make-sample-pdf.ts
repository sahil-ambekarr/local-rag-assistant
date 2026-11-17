// Generates sample-docs/security-handbook.pdf (3 pages) so the corpus includes a
// real PDF with page numbers to cite. Run: npm run make:pdf
import fs from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';

const pages: { title: string; paragraphs: string[] }[] = [
  {
    title: 'Information Security Handbook',
    paragraphs: [
      'Kestrel Lane Software is a fictional company. This handbook is sample data for a demo project.',
      'Data classification. All company information falls into one of four classes: Public, Internal, Confidential and Restricted. Customer data is always Confidential. Payment and identity data is Restricted.',
      'Restricted data may only be stored in the systems approved for it and must never be copied to laptops, chat messages or personal storage. Confidential data may be shared inside the company on a need-to-know basis.',
      'Clean desk. Lock your screen whenever you leave your desk. Screens lock automatically after 5 minutes of inactivity. Printed Confidential documents must be shredded in the locked shredding bins, not thrown in the paper recycling.',
    ],
  },
  {
    title: 'Phishing and incident reporting',
    paragraphs: [
      'Phishing. If you receive a suspicious email, do not click links or open attachments. Use the Report Phishing button in the mail client, which forwards the message to the security team and removes it from your inbox.',
      'Every employee completes a phishing awareness training module within the first 30 days and then once a year. The security team runs simulated phishing campaigns every quarter.',
      'Incident reporting. Report any suspected security incident to the security team within 1 hour, through the security incident form or the on-call phone number on the intranet. Examples include a lost device, a password typed into a suspicious site, or customer data sent to the wrong recipient.',
      'Do not try to investigate an incident yourself and do not delete evidence such as emails or files. The security team will tell you what to do next.',
    ],
  },
  {
    title: 'Access reviews and software',
    paragraphs: [
      'Access reviews. Managers review the system access of their team members every 6 months and remove access that is no longer needed. When an employee leaves, all accounts are disabled within 4 hours of the end of the last working day.',
      'Administrator rights on laptops are not granted by default. Temporary administrator access can be requested through the service desk and expires automatically after 24 hours.',
      'Software and AI tools. Only use software from the approved catalogue. Do not paste Confidential or Restricted data into public AI chat tools; use the company-approved assistant, which does not retain prompts.',
      'Security updates must be installed within 7 days of being released. Laptops that are more than 14 days behind on updates lose access to the VPN until they are updated.',
    ],
  },
];

const out = path.resolve(import.meta.dirname, '..', 'sample-docs', 'security-handbook.pdf');
// Fixed metadata keeps the output stable between runs.
const doc = new PDFDocument({
  size: 'A4',
  margin: 56,
  autoFirstPage: false,
  info: { Title: 'Information Security Handbook', Author: 'Kestrel Lane Software (fictional)', CreationDate: new Date('2026-01-01T00:00:00Z') },
});
doc.pipe(fs.createWriteStream(out));

pages.forEach((page, i) => {
  doc.addPage();
  doc.font('Helvetica-Bold').fontSize(18).text(page.title);
  doc.moveDown(0.8);
  doc.font('Helvetica').fontSize(11);
  for (const paragraph of page.paragraphs) {
    doc.text(paragraph, { align: 'left', lineGap: 2 });
    doc.moveDown(0.8);
  }
  // The footer sits inside the bottom margin; without this pdfkit starts a new page.
  doc.page.margins.bottom = 0;
  doc.fontSize(9).fillColor('#666').text(`Page ${i + 1} of ${pages.length}`, 56, 780, { align: 'center' }).fillColor('#000');
});

doc.end();
process.stdout.write(`Wrote ${out}\n`);
